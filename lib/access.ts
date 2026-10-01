import { createHash, randomInt } from "node:crypto";
import { getDb, type Db } from "./db";

// Who may use Elmon:
//   * admins: emails in ELMON_ADMIN_EMAILS (environment only; the database cannot grant admin)
//   * members: rows in `members`, created when someone redeems an invite code AND confirms their email
// Everything here is plain server code (no Next imports) so the worker, CLI and tests can use it.

export type Role = "admin" | "member";

export const normEmail = (e: string) => e.trim().toLowerCase();

export function adminEmails(): Set<string> {
  return new Set((process.env.ELMON_ADMIN_EMAILS ?? "").split(/[,\s]+/).map(normEmail).filter(Boolean));
}
export const isAdminEmail = (email: string | null | undefined) => !!email && adminEmails().has(normEmail(email));

// Role for a verified email, or null if it has no access. Touches last_seen at most every 5 minutes.
export async function roleFor(email: string, userId?: string | null): Promise<Role | null> {
  const e = normEmail(email);
  if (isAdminEmail(e)) return "admin";
  const db = await getDb();
  const m = await db.one<{ last_seen: number | null; user_id: string | null }>("SELECT last_seen, user_id FROM members WHERE email = $1", [e]);
  if (!m) return null;
  const now = Date.now();
  if (m.last_seen == null || now - m.last_seen > 5 * 60_000 || (userId && !m.user_id)) {
    await db.run("UPDATE members SET last_seen = $2, user_id = COALESCE(user_id, $3) WHERE email = $1", [e, now, userId ?? null]);
  }
  return "member";
}

export async function audit(actor: string, action: string, target?: string | null, detail?: unknown, db?: Db) {
  const d = db ?? (await getDb());
  await d.run("INSERT INTO audit_log (ts, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5)", [
    Date.now(), actor, action, target ?? null, detail === undefined ? null : JSON.stringify(detail),
  ]);
}

// ---------- invite codes ----------

// ELMN-XXXX-XXXX from an alphabet without look-alikes (no 0/O, 1/I/L). 8 random characters = about 40 bits; with
// the attempt limit below, guessing is hopeless.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^ELMN/, "");
const hashCode = (c: string) => createHash("sha256").update(`elmon-invite:${normCode(c)}`).digest("hex");

export interface NewCode {
  maxUses: number;
  expiresInDays: number | null;
  label?: string | null;
  boundEmail?: string | null;
}

export async function createInviteCode(admin: string, o: NewCode): Promise<{ id: number; code: string }> {
  if (!Number.isInteger(o.maxUses) || o.maxUses < 1 || o.maxUses > 1000) throw new Error("Uses must be between 1 and 1000");
  if (o.expiresInDays != null && (!(o.expiresInDays > 0) || o.expiresInDays > 365)) throw new Error("Expiry must be between 1 and 365 days, or never");
  const bound = o.boundEmail ? normEmail(o.boundEmail) : null;
  if (bound && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bound)) throw new Error("That email does not look right");
  const db = await getDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    const code = `ELMN-${raw.slice(0, 4)}-${raw.slice(4)}`;
    const r = await db.one<{ id: number }>(
      `INSERT INTO invite_codes (code_hash, hint, label, bound_email, max_uses, expires_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (code_hash) DO NOTHING RETURNING id`,
      [
        hashCode(code), raw.slice(4), o.label?.slice(0, 60) || null, bound, o.maxUses,
        o.expiresInDays != null ? Date.now() + o.expiresInDays * 86_400_000 : null, normEmail(admin), Date.now(),
      ],
    );
    if (r) {
      await audit(admin, "code.created", `…${raw.slice(4)}`, { uses: o.maxUses, days: o.expiresInDays, label: o.label ?? null, boundEmail: bound });
      return { id: r.id, code };
    }
  }
  throw new Error("Could not create a code. Try again.");
}

export async function revokeInviteCode(admin: string, id: number): Promise<boolean> {
  const db = await getDb();
  const r = await db.one<{ hint: string }>("UPDATE invite_codes SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING hint", [id, Date.now()]);
  if (r) await audit(admin, "code.revoked", `…${r.hint}`);
  return !!r;
}

type CodeRow = { id: number; max_uses: number; uses: number; expires_at: number | null; revoked_at: number | null; bound_email: string | null };

// Is this code usable by this email right now? Does not consume a use.
export async function checkInviteCode(code: string, email: string): Promise<{ ok: true; id: number } | { ok: false }> {
  if (normCode(code).length !== 8) return { ok: false };
  const db = await getDb();
  const c = await db.one<CodeRow>("SELECT * FROM invite_codes WHERE code_hash = $1", [hashCode(code)]);
  const now = Date.now();
  if (!c || c.revoked_at != null || (c.expires_at != null && c.expires_at <= now) || c.uses >= c.max_uses) return { ok: false };
  if (c.bound_email && c.bound_email !== normEmail(email)) return { ok: false };
  return { ok: true, id: c.id };
}

// Step 1, at the sign-in form: remember that this email presented a valid code. Nothing is consumed yet.
export async function holdInvite(email: string, codeId: number): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO pending_invites (email, code_id, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET code_id = excluded.code_id, expires_at = excluded.expires_at`,
    [normEmail(email), codeId, Date.now() + 2 * 3_600_000],
  );
}

// Step 2, after the magic link proved the email: consume one use atomically and make them a member. The
// conditional UPDATE is what stops two people taking the last use at once.
export async function redeemPendingInvite(email: string, userId: string | null): Promise<"joined" | "already" | "none" | "code-gone"> {
  const e = normEmail(email);
  const db = await getDb();
  return db.tx(async (t) => {
    if (await t.one("SELECT 1 FROM members WHERE email = $1", [e])) return "already";
    const p = await t.one<{ code_id: number; expires_at: number }>("SELECT code_id, expires_at FROM pending_invites WHERE email = $1", [e]);
    if (!p) return "none";
    await t.run("DELETE FROM pending_invites WHERE email = $1", [e]);
    const now = Date.now();
    if (p.expires_at <= now) return "code-gone";
    const used = await t.one<{ hint: string }>(
      `UPDATE invite_codes SET uses = uses + 1
       WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) AND uses < max_uses
         AND (bound_email IS NULL OR bound_email = $3)
       RETURNING hint`,
      [p.code_id, now, e],
    );
    if (!used) return "code-gone";
    await t.run("INSERT INTO members (email, user_id, joined_at, last_seen, invite_code_id) VALUES ($1, $2, $3, $3, $4) ON CONFLICT (email) DO NOTHING", [
      e, userId, now, p.code_id,
    ]);
    await audit(e, "member.joined", e, { code: `…${used.hint}` }, t);
    return "joined";
  });
}

export async function removeMember(admin: string, email: string): Promise<boolean> {
  const e = normEmail(email);
  const db = await getDb();
  const n = await db.run("DELETE FROM members WHERE email = $1", [e]);
  await db.run("DELETE FROM pending_invites WHERE email = $1", [e]);
  if (n) await audit(admin, "member.removed", e);
  return n > 0;
}

// ---------- sign-in attempt limit ----------

export const ATTEMPT_WINDOW_MS = 15 * 60_000;
export const MAX_ATTEMPTS = { ip: 20, email: 6 };

// Records an attempt and says whether it is over the limit. Old rows are pruned as we go.
export async function tooManyAttempts(ip: string | null, email: string): Promise<boolean> {
  const db = await getDb();
  const now = Date.now();
  const keys: [string, number][] = [[`email:${normEmail(email)}`, MAX_ATTEMPTS.email]];
  if (ip) keys.push([`ip:${ip}`, MAX_ATTEMPTS.ip]);
  if (Math.random() < 0.05) await db.run("DELETE FROM login_attempts WHERE ts < $1", [now - 86_400_000]);
  let over = false;
  for (const [key, max] of keys) {
    const r = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM login_attempts WHERE key = $1 AND ts > $2", [key, now - ATTEMPT_WINDOW_MS]);
    if ((r?.n ?? 0) >= max) over = true;
  }
  if (!over) for (const [key] of keys) await db.run("INSERT INTO login_attempts (key, ts) VALUES ($1, $2)", [key, now]);
  return over;
}
