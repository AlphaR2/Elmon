import { getDb, json } from "./db";
import { adminEmails } from "./access";
import { getAppSettings } from "./appSettings";
import { month, monthlyCreditsUsed, monthlyLimit, MONTH_CAP_SHARE } from "./credits";

// Everything the admin page shows, in one read.

const monthStartMs = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

export async function adminOverview() {
  const db = await getDb();
  const now = Date.now();
  const since = monthStartMs();
  const m = month();

  const members = await db.q<{ email: string; joined_at: number; last_seen: number | null; runs_month: number; credits_month: number; code_hint: string | null }>(
    `SELECT mb.email, mb.joined_at, mb.last_seen, ic.hint AS code_hint,
       (SELECT COUNT(*) FROM runs r WHERE r.created_by_email = mb.email AND r.created_at >= $1) AS runs_month,
       (SELECT COALESCE(SUM(l.credits), 0) FROM credit_ledger l JOIN runs r ON r.id = l.run_id WHERE r.created_by_email = mb.email AND l.month = $2) AS credits_month
     FROM members mb LEFT JOIN invite_codes ic ON ic.id = mb.invite_code_id
     ORDER BY mb.joined_at DESC`,
    [since, m],
  );

  const codesRaw = await db.q<{
    id: number; hint: string; label: string | null; bound_email: string | null; max_uses: number; uses: number;
    expires_at: number | null; revoked_at: number | null; created_by: string; created_at: number;
  }>("SELECT id, hint, label, bound_email, max_uses, uses, expires_at, revoked_at, created_by, created_at FROM invite_codes ORDER BY created_at DESC LIMIT 200");
  const redeemers = await db.q<{ invite_code_id: number; email: string }>("SELECT invite_code_id, email FROM members WHERE invite_code_id IS NOT NULL");
  const codes = codesRaw.map((c) => ({
    ...c,
    status: c.revoked_at != null ? "revoked" : c.expires_at != null && c.expires_at <= now ? "expired" : c.uses >= c.max_uses ? "used up" : "active",
    redeemedBy: redeemers.filter((r) => r.invite_code_id === c.id).map((r) => r.email),
  }));

  const runs = await db.q<{
    id: number; created_at: number; created_by_email: string | null; label: string | null; mode: string; inputs: string; status: string;
    progress: string; error: string | null; priority: number; credits: number;
  }>(
    `SELECT r.id, r.created_at, r.created_by_email, r.label, r.mode, r.inputs, r.status, r.progress, r.error, r.priority,
       (SELECT COALESCE(SUM(l.credits), 0) FROM credit_ledger l WHERE l.run_id = r.id) AS credits
     FROM runs r ORDER BY (r.status IN ('queued', 'running', 'cancelling')) DESC, r.id DESC LIMIT 100`,
  );

  const beat = await db.one<{ value: string; updated_at: number }>("SELECT value, updated_at FROM app_config WHERE key = 'worker_heartbeat'");
  const w = json<{ helius?: boolean; birdeye?: boolean; worker?: string }>(beat?.value, {});
  const limit = await monthlyLimit(db);
  const used = await monthlyCreditsUsed(db);

  const topRuns = await db.q<{ run_id: number; credits: number; label: string | null; email: string | null }>(
    `SELECT l.run_id, SUM(l.credits) AS credits, r.label, r.created_by_email AS email
     FROM credit_ledger l LEFT JOIN runs r ON r.id = l.run_id
     WHERE l.month = $1 AND l.run_id IS NOT NULL GROUP BY l.run_id, r.label, r.created_by_email ORDER BY credits DESC LIMIT 10`,
    [m],
  );
  const byStage = await db.q<{ stage: string | null; credits: number }>(
    "SELECT stage, SUM(credits) AS credits FROM credit_ledger WHERE month = $1 GROUP BY stage ORDER BY credits DESC",
    [m],
  );

  const auditRows = await db.q<{ id: number; ts: number; actor: string; action: string; target: string | null; detail: string | null }>(
    "SELECT id, ts, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT 100",
  );

  return {
    admins: [...adminEmails()],
    members,
    codes,
    runs: runs.map((r) => ({ ...r, inputs: json<string[]>(r.inputs, []).length, progress: json<Record<string, unknown>>(r.progress, {}) })),
    system: {
      workerOnline: !!beat && now - beat.updated_at < 90_000,
      workerSeenAt: beat?.updated_at ?? null,
      helius: !!w.helius,
      birdeye: !!w.birdeye,
      queued: runs.filter((r) => r.status === "queued").length,
      running: runs.filter((r) => r.status === "running").length,
    },
    credits: { month: m, used, limit, cap: Math.floor(limit * MONTH_CAP_SHARE), topRuns, byStage },
    settings: await getAppSettings(db),
    audit: auditRows.map((a) => ({ ...a, detail: json<unknown>(a.detail, null) })),
  };
}

export type AdminOverview = Awaited<ReturnType<typeof adminOverview>>;
