import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import { BudgetError, CreditGuard, MONTH_CAP_SHARE, monthlyCreditsUsed, runCreditsUsed } from "@/lib/credits";

async function setMonthly(n: number | null) {
  const db = await getDb();
  await db.run("UPDATE app_config SET value = $1 WHERE key = 'monthly_credits'", [JSON.stringify(n)]);
}

describe("credit guard", () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("stops at the run budget", async () => {
    const g = await new CreditGuard(null, 25).init();
    await g.take("getTransactionsForAddress", 10);
    await g.take("getTransactionsForAddress", 10);
    await expect(g.take("getTransactionsForAddress", 10)).rejects.toBeInstanceOf(BudgetError);
    expect(g.used).toBe(20);
    await g.release();
  });

  it("gives back unspent reservation and records exactly what was spent", async () => {
    const db = await getDb();
    await db.run("INSERT INTO runs (id, created_at, mode, inputs, settings, settings_hash, status, dedupe_key, expires_at) VALUES (7, 0, 'tokens', '[]', '{}', 'x', 'running', 'k', 0)");
    const g = await new CreditGuard(7, 10_000).init();
    g.stage = "launch";
    await g.take("getTransactionsForAddress", 10);
    g.stage = "history";
    await g.take("getSignaturesForAddress", 1);
    const refund = await g.take("getTransaction", 1);
    refund(); // node rejected it before doing work
    refund(); // refunds are idempotent
    await g.release();
    expect(await monthlyCreditsUsed()).toBe(11);
    expect(await runCreditsUsed(7)).toBe(11);
    const byStage = await db.q<{ stage: string; c: number }>("SELECT stage, SUM(credits) AS c FROM credit_ledger GROUP BY stage ORDER BY stage");
    expect(byStage).toEqual([{ stage: "history", c: 1 }, { stage: "launch", c: 10 }]);
    // A resumed run starts from what it already spent
    expect((await new CreditGuard(7, 10_000).init()).used).toBe(11);
  });

  it("two runs racing for the last credits of the month never overshoot the cap", async () => {
    await setMonthly(1000);
    const cap = Math.floor(1000 * MONTH_CAP_SHARE);
    const a = await new CreditGuard(null, 1e9, 64).init();
    const b = await new CreditGuard(null, 1e9, 64).init();
    let spent = 0;
    let stopped = 0;
    const spend = async (g: CreditGuard) => {
      for (;;) {
        try {
          await g.take("getTransactionsForAddress", 10);
          spent += 10;
        } catch (e) {
          if (!(e instanceof BudgetError)) throw e;
          stopped++;
          return;
        }
      }
    };
    await Promise.all([spend(a), spend(a), spend(b), spend(b)]);
    await a.release();
    await b.release();
    expect(stopped).toBe(4);
    expect(spent).toBeLessThanOrEqual(cap);
    expect(spent).toBeGreaterThan(cap - 20 * 2); // each guard can strand less than one call's worth
    expect(await monthlyCreditsUsed()).toBe(spent);
  });

  it("uses HELIUS_MONTHLY_CREDITS unless ops set a limit in the database", async () => {
    const saved = process.env.HELIUS_MONTHLY_CREDITS;
    process.env.HELIUS_MONTHLY_CREDITS = "50";
    try {
      const g = await new CreditGuard(null, 1e9).init();
      await expect(g.take("x", 100)).rejects.toThrow(/Monthly credit limit/);
      await setMonthly(10_000);
      await expect(g.take("x", 100)).resolves.toBeTypeOf("function");
      await g.release();
    } finally {
      if (saved === undefined) delete process.env.HELIUS_MONTHLY_CREDITS;
      else process.env.HELIUS_MONTHLY_CREDITS = saved;
    }
  });
});
