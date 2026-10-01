import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import { createInviteCode, removeMember } from "@/lib/access";

// A fake Supabase: accounts (email -> id, password) and the current browser session.
const sb = vi.hoisted(() => ({
  users: new Map<string, { id: string; password: string }>(),
  session: null as string | null,
  iat: 0, // when the current session was issued (seconds)
  nextId: 1,
}));
vi.mock("@/lib/supabase/server", () => ({
  supabaseEnv: () => ({ url: "https://x.supabase.co", key: "anon" }),
  supabaseServer: async () => ({
    auth: {
      getClaims: async () =>
        sb.session ? { data: { claims: { sub: sb.users.get(sb.session)!.id, email: sb.session, iat: sb.iat } }, error: null } : { data: null, error: null },
      signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
        const u = sb.users.get(email);
        if (!u || u.password !== password) return { data: { user: null }, error: { message: "Invalid login credentials" } };
        sb.session = email;
        sb.iat = Math.floor(Date.now() / 1000);
        return { data: { user: { id: u.id, email } }, error: null };
      },
      signOut: async () => {
        sb.session = null;
        return { error: null };
      },
      updateUser: async ({ password }: { password: string }) => {
        if (!sb.session) return { error: { message: "not signed in" } };
        sb.users.get(sb.session)!.password = password;
        return { data: {}, error: null };
      },
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    auth: {
      admin: {
        createUser: async ({ email, password }: { email: string; password: string }) => {
          if (sb.users.has(email)) return { data: { user: null }, error: { code: "email_exists", message: "already registered" } };
          const id = `uid-${sb.nextId++}`;
          sb.users.set(email, { id, password });
          return { data: { user: { id, email } }, error: null };
        },
        deleteUser: async (id: string) => {
          for (const [e, u] of sb.users) if (u.id === id) sb.users.delete(e);
          return { error: null };
        },
        updateUserById: async (id: string, { password }: { password: string }) => {
          for (const u of sb.users.values()) if (u.id === id) u.password = password;
          return { data: {}, error: null };
        },
      },
    },
  }),
  findUserIdByEmail: async (email: string) => sb.users.get(email)?.id ?? null,
}));

const ADMIN = "boss@team.io";
const post = (url: string, body: unknown) => new Request(`http://x${url}`, { method: "POST", body: JSON.stringify(body) });

beforeEach(async () => {
  await resetDbForTests();
  process.env.ELMON_ADMIN_EMAILS = ADMIN;
  process.env.ELMON_ADMIN_SETUP_CODE = "owner-only-setup-code-123";
  delete process.env.ELMON_DEV_NO_AUTH;
  sb.users.clear();
  sb.session = null;
});
afterEach(() => {
  delete process.env.ELMON_ADMIN_EMAILS;
  delete process.env.ELMON_ADMIN_SETUP_CODE;
});

const signup = async (body: unknown) => (await import("@/app/api/auth/signup/route")).POST(post("/api/auth/signup", body));
const login = async (body: unknown) => (await import("@/app/api/auth/login/route")).POST(post("/api/auth/login", body));

describe("password sign-in with invite codes", () => {
  it("a valid code creates a confirmed account, makes a member, uses the code once, and signs them in", async () => {
    const { id, code } = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 7 });
    const r = await signup({ email: "New@X.io", password: "correct horse 1", code });
    expect(r.status).toBe(200);
    expect(sb.users.get("new@x.io")).toBeDefined();
    expect(sb.session).toBe("new@x.io");
    const db = await getDb();
    expect((await db.one<{ uses: number }>("SELECT uses FROM invite_codes WHERE id = $1", [id]))!.uses).toBe(1);
    expect(await db.one("SELECT email, user_id FROM members WHERE email = 'new@x.io'")).toEqual({ email: "new@x.io", user_id: sb.users.get("new@x.io")!.id });
  });

  it("refuses a bad code, a weak password, and nobody gets an account", async () => {
    expect((await signup({ email: "a@x.io", password: "correct horse 1", code: "ELMN-AAAA-AAAA" })).status).toBe(400);
    const { code } = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 7 });
    const weak = await signup({ email: "a@x.io", password: "short", code });
    expect(weak.status).toBe(400);
    expect((await weak.json()).error).toMatch(/at least 10/);
    expect(sb.users.size).toBe(0);
  });

  it("nobody can claim an admin email without the owner's setup code", async () => {
    expect((await signup({ email: ADMIN, password: "attacker pass 1" })).status).toBe(400);
    expect((await signup({ email: ADMIN, password: "attacker pass 1", code: "guess-guess-guess" })).status).toBe(400);
    const { code } = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 7 });
    expect((await signup({ email: ADMIN, password: "attacker pass 1", code })).status).toBe(400); // a member code is not enough
    delete process.env.ELMON_ADMIN_SETUP_CODE; // unset: admin sign-up is closed entirely
    expect((await signup({ email: ADMIN, password: "attacker pass 1", code: "owner-only-setup-code-123" })).status).toBe(400);
    expect(sb.users.size).toBe(0);
  });

  it("admins sign up with the setup code and are not stored as members", async () => {
    expect((await signup({ email: ADMIN, password: "admin password 1", code: "owner-only-setup-code-123" })).status).toBe(200);
    const db = await getDb();
    expect(await db.one("SELECT 1 FROM members WHERE email = $1", [ADMIN])).toBeUndefined();
    sb.session = null;
    expect((await login({ email: ADMIN, password: "admin password 1" })).status).toBe(200);
  });

  it("when two people race for the last use, one gets in and the other's account is removed again", async () => {
    const { code } = await createInviteCode(ADMIN, { maxUses: 1, expiresInDays: 7 });
    const [a, b] = await Promise.all([
      signup({ email: "a@x.io", password: "password one 1", code }),
      signup({ email: "b@x.io", password: "password two 2", code }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(sb.users.size).toBe(1);
    const db = await getDb();
    expect((await db.q("SELECT email FROM members")).length).toBe(1);
  });

  it("sign-in: wrong password is refused; a removed member is signed straight out", async () => {
    const { code } = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 7 });
    await signup({ email: "m@x.io", password: "member pass 1", code });
    sb.session = null;
    expect((await login({ email: "m@x.io", password: "wrong password" })).status).toBe(400);
    expect((await login({ email: "nobody@x.io", password: "whatever 123" })).status).toBe(400); // same answer
    expect((await login({ email: "m@x.io", password: "member pass 1" })).status).toBe(200);
    await removeMember(ADMIN, "m@x.io");
    sb.session = null;
    const r = await login({ email: "m@x.io", password: "member pass 1" });
    expect(r.status).toBe(403);
    expect(sb.session).toBeNull();
  });

  it("a removed member can come back with a new code, but only with their own password", async () => {
    const c1 = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 7 });
    await signup({ email: "m@x.io", password: "member pass 1", code: c1.code });
    await removeMember(ADMIN, "m@x.io");
    sb.session = null;
    const c2 = await createInviteCode(ADMIN, { maxUses: 1, expiresInDays: 7 });
    expect((await signup({ email: "m@x.io", password: "someone elses 1", code: c2.code })).status).toBe(400);
    expect((await signup({ email: "m@x.io", password: "member pass 1", code: c2.code })).status).toBe(200);
  });
});

describe("admin password reset", () => {
  it("gives a one-time temporary password, forces a change, and is logged", async () => {
    const { code } = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 7 });
    await signup({ email: "m@x.io", password: "member pass 1", code });
    const reset = (await import("@/app/api/admin/members/password/route")).POST;

    sb.session = "m@x.io"; // a member cannot reset anyone
    expect((await reset(post("/api/admin/members/password", { email: "m@x.io" }))).status).toBe(404);

    sb.users.set(ADMIN, { id: "uid-admin", password: "admin password 1" });
    sb.session = ADMIN;
    const r = await reset(post("/api/admin/members/password", { email: "m@x.io" }));
    expect(r.status).toBe(200);
    const { password } = await r.json();
    expect(password).toMatch(/^[\w]{4}-[\w]{4}-[\w]{4}$/);
    expect(sb.users.get("m@x.io")!.password).toBe(password);

    sb.session = null;
    expect((await login({ email: "m@x.io", password: "member pass 1" })).status).toBe(400); // old one is dead
    const l = await login({ email: "m@x.io", password });
    expect(await l.json()).toMatchObject({ ok: true, mustChangePassword: true });

    const change = (await import("@/app/api/auth/password/route")).POST;
    expect((await change(post("/api/auth/password", { current: "wrong", next: "my own pass 2" }))).status).toBe(400);
    expect((await change(post("/api/auth/password", { current: password, next: "my own pass 2" }))).status).toBe(200);
    const db = await getDb();
    expect((await db.one<{ must_change_password: boolean }>("SELECT must_change_password FROM members WHERE email = 'm@x.io'"))!.must_change_password).toBe(false);
    expect((await db.q<{ action: string }>("SELECT action FROM audit_log WHERE action = 'member.password_reset'")).length).toBe(1);
  });
});

describe("hardening", () => {
  it("a password reset signs the member out everywhere they were signed in", async () => {
    const { code } = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 7 });
    await signup({ email: "m@x.io", password: "member pass 1", code });
    const { currentUser } = await import("@/lib/auth");
    sb.session = "m@x.io";
    sb.iat = Math.floor(Date.now() / 1000) - 3600; // a session from an hour ago (e.g. someone else's laptop)
    expect(await currentUser()).toMatchObject({ email: "m@x.io", role: "member" });
    const { cutOffSessions } = await import("@/lib/access");
    await cutOffSessions("m@x.io"); // what the reset does
    expect(await currentUser()).toBeNull();
    sb.iat = Math.floor(Date.now() / 1000) + 1; // signing in again afterwards works
    expect(await currentUser()).toMatchObject({ email: "m@x.io" });
  });

  it("refuses data-changing API calls from other sites", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const call = (origin: string | null) =>
      proxy(new NextRequest("https://elmon.app/api/runs", { method: "POST", headers: { host: "elmon.app", ...(origin ? { origin } : {}) } }));
    expect((await call("https://evil.example")).status).toBe(403);
    expect((await call("not a url")).status).toBe(403);
    expect((await call("https://elmon.app")).status).not.toBe(403);
    expect((await call(null)).status).not.toBe(403); // same-origin fetches and server calls
  });
});
