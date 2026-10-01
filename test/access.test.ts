import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import {
  checkInviteCode, createInviteCode, holdInvite, isAdminEmail, MAX_ATTEMPTS, normCode, redeemPendingInvite, removeMember, revokeInviteCode, roleFor, tooManyAttempts,
} from "@/lib/access";
import { getAppSettings, parseAppSettings, saveAppSettings } from "@/lib/appSettings";
import { createRun } from "@/lib/pipeline/run";
import { claimNext } from "@/lib/worker";

// Sign-in is mocked: `who.email` is the verified email the "session" carries (null = signed out).
const who = vi.hoisted(() => ({ email: null as string | null }));
vi.mock("@/lib/supabase/server", () => ({
  supabaseEnv: () => ({ url: "https://x.supabase.co", key: "anon" }),
  supabaseServer: async () => ({
    auth: {
      getClaims: async () => (who.email ? { data: { claims: { sub: `uid-${who.email}`, email: who.email } }, error: null } : { data: null, error: null }),
    },
  }),
}));

const ADMIN = "boss@team.io";

beforeEach(async () => {
  await resetDbForTests();
  process.env.ELMON_ADMIN_EMAILS = `${ADMIN}, Second@Team.io`;
  delete process.env.ELMON_DEV_NO_AUTH;
  who.email = null;
});
afterEach(() => {
  delete process.env.ELMON_ADMIN_EMAILS;
});

async function codeRow(id: number) {
  const db = await getDb();
  return (await db.one<{ uses: number; code_hash: string }>("SELECT uses, code_hash FROM invite_codes WHERE id = $1", [id]))!;
}

describe("invite codes", () => {
  it("are shown once and stored only as a fingerprint", async () => {
    const { id, code } = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 7 });
    expect(code).toMatch(/^ELMN-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    const row = await codeRow(id);
    expect(row.code_hash).not.toContain(normCode(code));
    expect((await checkInviteCode(code, "new@x.io")).ok).toBe(true);
    expect((await checkInviteCode(code.toLowerCase().replace(/-/g, " "), "new@x.io")).ok).toBe(true); // typed loosely
    expect((await checkInviteCode("ELMN-AAAA-AAAA", "new@x.io")).ok).toBe(false);
  });

  it("a use is counted only after the email is confirmed", async () => {
    const { id, code } = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 7 });
    const c = await checkInviteCode(code, "new@x.io");
    if (!c.ok) throw new Error("code should be valid");
    await holdInvite("new@x.io", c.id);
    expect((await codeRow(id)).uses).toBe(0); // entering the code costs nothing
    expect(await roleFor("new@x.io")).toBeNull();
    expect(await redeemPendingInvite("New@X.io", "uid-1")).toBe("joined"); // clicked the link
    expect((await codeRow(id)).uses).toBe(1);
    expect(await roleFor("new@x.io")).toBe("member");
    expect(await redeemPendingInvite("new@x.io", "uid-1")).toBe("already");
    expect((await codeRow(id)).uses).toBe(1);
  });

  it("racing redemptions never exceed the code's uses", async () => {
    const { id, code } = await createInviteCode(ADMIN, { maxUses: 2, expiresInDays: 7 });
    const emails = ["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io"];
    for (const e of emails) {
      const c = await checkInviteCode(code, e);
      if (c.ok) await holdInvite(e, c.id);
    }
    const results = await Promise.all(emails.map((e) => redeemPendingInvite(e, null)));
    expect(results.filter((r) => r === "joined")).toHaveLength(2);
    expect(results.filter((r) => r === "code-gone")).toHaveLength(3);
    expect((await codeRow(id)).uses).toBe(2);
  });

  it("expired, revoked and other-email codes are refused, even after they were entered", async () => {
    const bound = await createInviteCode(ADMIN, { maxUses: 1, expiresInDays: 7, boundEmail: "only@x.io" });
    expect((await checkInviteCode(bound.code, "someone@x.io")).ok).toBe(false);
    expect((await checkInviteCode(bound.code, "ONLY@x.io")).ok).toBe(true);

    const r = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 7 });
    const c = await checkInviteCode(r.code, "late@x.io");
    if (!c.ok) throw new Error("valid");
    await holdInvite("late@x.io", c.id);
    expect(await revokeInviteCode(ADMIN, r.id)).toBe(true);
    expect(await redeemPendingInvite("late@x.io", null)).toBe("code-gone"); // revoked between form and link
    expect((await checkInviteCode(r.code, "x@x.io")).ok).toBe(false);

    const e = await createInviteCode(ADMIN, { maxUses: 5, expiresInDays: 1 });
    const db = await getDb();
    await db.run("UPDATE invite_codes SET expires_at = $1 WHERE id = $2", [Date.now() - 1, e.id]);
    expect((await checkInviteCode(e.code, "x@x.io")).ok).toBe(false);

    await expect(createInviteCode(ADMIN, { maxUses: 0, expiresInDays: 7 })).rejects.toThrow(/Uses/);
  });

  it("every admin action lands in the activity log", async () => {
    const r = await createInviteCode(ADMIN, { maxUses: 1, expiresInDays: null, label: "Debbie" });
    await revokeInviteCode(ADMIN, r.id);
    const db = await getDb();
    const rows = await db.q<{ action: string; actor: string }>("SELECT action, actor FROM audit_log ORDER BY id");
    expect(rows).toEqual([
      { action: "code.created", actor: ADMIN },
      { action: "code.revoked", actor: ADMIN },
    ]);
  });
});

describe("roles", () => {
  it("admins come only from the environment; members can be removed and are locked out at once", async () => {
    expect(isAdminEmail("SECOND@team.io")).toBe(true);
    expect(await roleFor(ADMIN)).toBe("admin");
    const { code } = await createInviteCode(ADMIN, { maxUses: 1, expiresInDays: 7 });
    const c = await checkInviteCode(code, "m@x.io");
    if (!c.ok) throw new Error("valid");
    await holdInvite("m@x.io", c.id);
    await redeemPendingInvite("m@x.io", "uid-m");
    expect(await roleFor("m@x.io")).toBe("member");
    expect(await removeMember(ADMIN, "m@x.io")).toBe(true);
    expect(await roleFor("m@x.io")).toBeNull();
    // A members row can never make someone admin
    const db = await getDb();
    await db.run("INSERT INTO members (email, joined_at) VALUES ('fake-admin@x.io', 0)");
    expect(await roleFor("fake-admin@x.io")).toBe("member");
  });

  it("sign-in attempts are limited per email", async () => {
    for (let i = 0; i < MAX_ATTEMPTS.email; i++) expect(await tooManyAttempts("1.2.3.4", "spam@x.io")).toBe(false);
    expect(await tooManyAttempts("1.2.3.4", "spam@x.io")).toBe(true);
    expect(await tooManyAttempts("5.6.7.8", "other@x.io")).toBe(false);
  });
});

describe("admin settings", () => {
  it("are validated, stored, and fall back to defaults", async () => {
    expect((await getAppSettings()).maxLiveMember).toBe(2);
    expect(() => parseAppSettings({ maxLiveMember: 0 })).toThrow(/maxLiveMember/);
    expect(() => parseAppSettings({ defaultPreset: "huge" })).toThrow(/defaultPreset/);
    await saveAppSettings(parseAppSettings({ maxBudgetMember: 30000, pauseNewRuns: true }, await getAppSettings()));
    const s = await getAppSettings();
    expect(s.maxBudgetMember).toBe(30000);
    expect(s.pauseNewRuns).toBe(true);
    expect(s.maxLiveAdmin).toBe(5);
  });

  it("admin runs go first; pausing stops queued runs from starting", async () => {
    const member = await createRun("tokens", ["M1", "M2"], {}, { userId: "m" });
    const admin = await createRun("tokens", ["M3", "M4"], {}, { userId: "a", priority: 1 });
    await saveAppSettings(parseAppSettings({ pauseNewRuns: true }, await getAppSettings()));
    expect(await claimNext()).toBeNull();
    await saveAppSettings(parseAppSettings({ pauseNewRuns: false }, await getAppSettings()));
    expect(await claimNext()).toBe(admin.id);
    expect(await claimNext()).toBe(member.id);
  });
});

describe("API access", () => {
  it("admin routes say 'not found' to members and strangers, and work for admins", async () => {
    const { GET } = await import("@/app/api/admin/route");
    who.email = null;
    expect((await GET()).status).toBe(404);
    const db = await getDb();
    await db.run("INSERT INTO members (email, joined_at) VALUES ('m@x.io', 0)");
    who.email = "m@x.io";
    expect((await GET()).status).toBe(404);
    who.email = "nobody@x.io";
    expect((await GET()).status).toBe(404);
    who.email = ADMIN;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members.map((m: { email: string }) => m.email)).toEqual(["m@x.io"]);
    expect(body.admins).toContain(ADMIN);
  });

  it("members are held to their limits; pause stops them but not admins; strangers are refused", async () => {
    const { POST } = await import("@/app/api/runs/route");
    const db = await getDb();
    await db.run("INSERT INTO members (email, joined_at) VALUES ('m@x.io', 0)");
    const req = (budget: number, inputs = ["DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP", "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx"]) =>
      new Request("http://x/api/runs", { method: "POST", body: JSON.stringify({ mode: "tokens", inputs, settings: { runBudget: budget } }) });

    who.email = "stranger@x.io";
    expect((await POST(req(10_000))).status).toBe(401);

    who.email = "m@x.io";
    const over = await POST(req(100_000));
    expect(over.status).toBe(400);
    expect((await over.json()).error).toMatch(/at most 60,000/);
    expect((await POST(req(40_000))).status).toBe(200);

    await saveAppSettings(parseAppSettings({ pauseNewRuns: true }, await getAppSettings()));
    expect((await POST(req(30_000))).status).toBe(503);
    who.email = ADMIN;
    const a = await POST(req(150_000)); // admin: paused does not apply, and a bigger budget is allowed
    expect(a.status).toBe(200);
    const run = await db.one<{ created_by_email: string; priority: number }>("SELECT created_by_email, priority FROM runs WHERE id = $1", [(await a.json()).id]);
    expect(run).toEqual({ created_by_email: ADMIN, priority: 1 });
  });

  it("an admin can open anyone's run; a member only their own", async () => {
    const { GET } = await import("@/app/api/runs/[id]/route");
    const db = await getDb();
    await db.run("INSERT INTO members (email, joined_at) VALUES ('m@x.io', 0), ('n@x.io', 0)");
    const { id } = await createRun("tokens", ["M1", "M2"], {}, { userId: "uid-m@x.io", userEmail: "m@x.io" });
    const call = () => GET(new Request(`http://x/api/runs/${id}`), { params: Promise.resolve({ id: String(id) }) });
    who.email = "n@x.io";
    expect((await call()).status).toBe(404);
    who.email = "m@x.io";
    expect((await call()).status).toBe(200);
    who.email = ADMIN;
    expect((await call()).status).toBe(200);
  });
});
