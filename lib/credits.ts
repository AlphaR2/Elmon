import { getDb, json, type Db } from "./db";

// Credit guard. Two limits, both hard:
//   * the run budget: this run may not spend more than its setting. Counted in memory: only the worker that owns
//     the run spends for it, so the count is exact.
//   * the month: all runs together stop at 98% of the plan. Several workers may run at once, so the month is a
//     shared counter. A worker reserves credits in blocks with one conditional UPDATE (used + n <= cap), which is
//     atomic in Postgres, so two workers can never both take the last credits. Unspent reservation goes back when
//     the run ends. If a worker dies holding a block, at most BLOCK credits stay counted as used (conservative).
// The ledger (who spent what, per run, stage and method) is accounting only and is written in batches.

export class BudgetError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BudgetError";
  }
}

const BLOCK = 200;
export const MONTH_CAP_SHARE = 0.98;
export const month = (d = new Date()) => d.toISOString().slice(0, 7);

export async function monthlyLimit(db?: Db): Promise<number> {
  const d = db ?? (await getDb());
  const row = await d.one<{ value: string }>("SELECT value FROM app_config WHERE key = 'monthly_credits'");
  const fromDb = json<number | null>(row?.value, null);
  if (typeof fromDb === "number" && fromDb > 0) return fromDb;
  return Number(process.env.HELIUS_MONTHLY_CREDITS ?? 1_000_000);
}

export async function monthlyCreditsUsed(db?: Db): Promise<number> {
  const d = db ?? (await getDb());
  const r = await d.one<{ used: number }>("SELECT used FROM credit_month WHERE month = $1", [month()]);
  return r?.used ?? 0;
}

export async function runCreditsUsed(runId: number, db?: Db): Promise<number> {
  const d = db ?? (await getDb());
  const r = await d.one<{ c: number }>("SELECT COALESCE(SUM(credits), 0) AS c FROM credit_ledger WHERE run_id = $1", [runId]);
  return r?.c ?? 0;
}

export class CreditGuard {
  used = 0; // this run, including earlier attempts of it
  private reserved = 0;
  private reservedMonth = month();
  private reserving: Promise<void> | null = null;
  private buffer = new Map<string, { stage: string | null; method: string; calls: number; credits: number }>();
  private lastFlush = Date.now();
  stage: string | null = null;

  constructor(
    public runId: number | null,
    public runBudget: number,
    private block = BLOCK,
  ) {}

  async init(): Promise<this> {
    if (this.runId != null) this.used = await runCreditsUsed(this.runId);
    return this;
  }

  // Takes `cost` credits or throws BudgetError. Returns a refund for calls the node rejected before doing work.
  async take(method: string, cost: number): Promise<() => void> {
    if (this.used + cost > this.runBudget) throw new BudgetError(`Run budget of ${this.runBudget.toLocaleString()} credits reached`);
    while (this.reserved < cost) {
      if (!this.reserving) this.reserving = this.reserve(Math.max(this.block, cost)).finally(() => (this.reserving = null));
      await this.reserving;
    }
    // Re-check after awaiting: another call in this run may have spent in the meantime.
    if (this.used + cost > this.runBudget) throw new BudgetError(`Run budget of ${this.runBudget.toLocaleString()} credits reached`);
    this.reserved -= cost;
    this.used += cost;
    const stage = this.stage;
    this.add(stage, method, 1, cost);
    if (Date.now() - this.lastFlush > 3000) void this.flush().catch(() => {});
    let refunded = false;
    return () => {
      if (refunded) return;
      refunded = true;
      this.used -= cost;
      this.reserved += cost;
      this.add(stage, method, -1, -cost);
    };
  }

  private add(stage: string | null, method: string, calls: number, credits: number) {
    const k = `${stage}|${method}`;
    const cur = this.buffer.get(k) ?? { stage, method, calls: 0, credits: 0 };
    cur.calls += calls;
    cur.credits += credits;
    this.buffer.set(k, cur);
  }

  private async reserve(n: number): Promise<void> {
    const db = await getDb();
    const m = month();
    const cap = Math.floor((await monthlyLimit(db)) * MONTH_CAP_SHARE);
    await db.run("INSERT INTO credit_month (month, used) VALUES ($1, 0) ON CONFLICT (month) DO NOTHING", [m]);
    let got = await db.one("UPDATE credit_month SET used = used + $1 WHERE month = $2 AND used + $1 <= $3 RETURNING used", [n, m, cap]);
    if (got) {
      this.reserved += n;
      this.reservedMonth = m;
      return;
    }
    // Not a full block left: take whatever remains, if it covers at least one call.
    const left = await db.one<{ left: number }>("SELECT $2::bigint - used AS left FROM credit_month WHERE month = $1", [m, cap]);
    const rest = Math.max(0, left?.left ?? 0);
    if (rest > 0) {
      got = await db.one("UPDATE credit_month SET used = used + $1 WHERE month = $2 AND used + $1 <= $3 RETURNING used", [rest, m, cap]);
      if (got) {
        this.reserved += rest;
        this.reservedMonth = m;
        if (this.reserved > 0) return;
      }
    }
    throw new BudgetError(`Monthly credit limit nearly used (${cap.toLocaleString()} of ${(await monthlyLimit(db)).toLocaleString()})`);
  }

  async flush(): Promise<void> {
    if (this.buffer.size === 0) return;
    const rows = [...this.buffer.values()].filter((r) => r.calls !== 0 || r.credits !== 0);
    this.buffer.clear();
    this.lastFlush = Date.now();
    if (rows.length === 0) return;
    const db = await getDb();
    const now = Date.now(), m = month();
    for (const r of rows) {
      await db.run(
        "INSERT INTO credit_ledger (ts, month, run_id, stage, method, calls, credits) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [now, m, this.runId, r.stage, r.method, r.calls, r.credits],
      );
    }
  }

  // End of run (or of a CLI call): write the ledger and give back what was reserved but not spent.
  async release(): Promise<void> {
    await this.reserving?.catch(() => {});
    await this.flush();
    if (this.reserved > 0) {
      const n = this.reserved;
      this.reserved = 0;
      const db = await getDb();
      await db.run("UPDATE credit_month SET used = GREATEST(0, used - $1) WHERE month = $2", [n, this.reservedMonth]);
    }
  }
}
