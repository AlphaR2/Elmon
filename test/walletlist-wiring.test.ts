import { beforeEach, describe, expect, it } from "vitest";
import { getDb, json, resetDbForTests } from "@/lib/db";
import { computeWalletList, createRun, executeRun, getRun, TOKEN_STAGES } from "@/lib/pipeline/run";
import { exportRows, runDetail } from "@/lib/queries";
import type { TraderStats } from "@/lib/core/pnl";
import type { OperatorInput, OperatorResult, RankInput, RankResult, WalletListSummary } from "@/lib/core/walletList.types";
import { FakeRpc } from "./helpers";
import { NOW, world } from "./world";

const SETTINGS = { earlyBuyers: 20, minClosedPositions: 5, funderScope: "all" } as const;

async function statsOf(runId: number, wallet: string) {
  const db = await getDb();
  const r = await db.one<{ stats: string | null }>("SELECT stats FROM wallets WHERE run_id = $1 AND wallet = $2", [runId, wallet]);
  return json<(TraderStats & { operatorId?: string | null }) | null>(r?.stats, null);
}
async function progressOf(runId: number) {
  return json<{ credits?: number; walletList?: WalletListSummary }>((await getRun(runId))!.progress, {});
}
async function run(deps: Parameters<typeof executeRun>[2] = {}) {
  await resetDbForTests();
  const { id } = await createRun("tokens", ["M1", "M2", "M3"], SETTINGS);
  await executeRun(id, new FakeRpc(world(), { gtfa: true }), { now: () => NOW, ...deps });
  return id;
}

// Fakes that make the wiring visible: S1 and S2 are one operator, everyone else is alone; the ranking keeps S1 and
// S2 and drops every other wallet as a bot.
const calls: { operators: OperatorInput[][]; rank: { items: RankInput[]; minClosed: number }[] } = { operators: [], rank: [] };
const fakeOperators = (ws: OperatorInput[]): OperatorResult[] => {
  calls.operators.push(ws);
  const merged = ws.filter((w) => w.wallet === "S1" || w.wallet === "S2").map((w) => w.wallet);
  return [
    ...(merged.length ? [{ operatorId: "op:shared", wallets: merged }] : []),
    ...ws.filter((w) => !merged.includes(w.wallet)).map((w) => ({ operatorId: `op:${w.wallet}`, wallets: [w.wallet] })),
  ];
};
const fakeRank = (items: RankInput[], o: { minClosed: number }): RankResult => {
  calls.rank.push({ items, minClosed: o.minClosed });
  return {
    ranked: items.filter((i) => i.wallet === "S1" || i.wallet === "S2"),
    dropped: items.filter((i) => i.wallet !== "S1" && i.wallet !== "S2").map((i) => ({ wallet: i.wallet, reason: "bot" as const })),
  };
};

describe("wallet list wiring", () => {
  beforeEach(() => {
    calls.operators = [];
    calls.rank = [];
  });

  it("saves operatorId in wallets.stats and the operator summary in runs.progress", async () => {
    const id = await run({ walletList: { operators: fakeOperators, rank: fakeRank } });
    expect((await getRun(id))!.status).toBe("done");

    const s1 = await statsOf(id, "S1");
    const s2 = await statsOf(id, "S2");
    expect(s1?.operatorId).toBe("op:shared");
    expect(s2?.operatorId).toBe("op:shared");
    expect(s1?.closed).toBe(8); // the rest of the stats are untouched
    expect(s1?.pnlCurve?.length).toBeGreaterThan(0);

    const p = await progressOf(id);
    expect(p.credits).toBeGreaterThan(0);
    expect(p.walletList).toBeDefined();
    // two wallets ranked but ONE operator: the unit is the operator
    expect(p.walletList!.walletsRanked).toBe(2);
    expect(p.walletList!.operatorCount).toBe(1);
    expect(p.walletList!.status).toBe("fewer_than_10_operators");
    expect(p.walletList!.droppedByReason.bot).toBeGreaterThan(0);
    expect(p.walletList!.droppedByReason["top-trade"]).toBe(0);

    // the pasted tokens are not part of an operator's trade signature, and settings are passed through
    for (const batch of calls.operators) for (const w of batch) expect(w.buys.some((b) => ["M1", "M2", "M3"].includes(b.mint))).toBe(false);
    expect(calls.rank.every((c) => c.minClosed === 5)).toBe(true);
    // a bot-like wallet (if any were scored) never gets handed over as not bot-like
    const s1Input = calls.operators[0].find((w) => w.wallet === "S1")!;
    expect(s1Input.buys.length).toBeGreaterThan(0);
    expect(s1Input.botLike).toBe(false);
  });

  it("a resumed run gives the same result", async () => {
    const deps = { walletList: { operators: fakeOperators, rank: fakeRank } };
    const id = await run(deps);
    const before = await progressOf(id);
    const beforeStats = await statsOf(id, "S1");
    // back to the queue after every stage except finalize, as after a worker restart
    const db = await getDb();
    await db.run("UPDATE runs SET status = 'queued', owner = NULL, heartbeat = NULL, stages_done = $1 WHERE id = $2", [
      JSON.stringify(TOKEN_STAGES.filter((s) => s !== "finalize")),
      id,
    ]);
    await executeRun(id, new FakeRpc(world(), { gtfa: true }), { now: () => NOW, ...deps });
    const after = await progressOf(id);
    expect((await getRun(id))!.status).toBe("done");
    expect(after.walletList).toEqual(before.walletList);
    expect(await statsOf(id, "S1")).toEqual(beforeStats);
  });

  it("works with the default modules, and old stats without the new fields still read and export", async () => {
    const id = await run(); // lib/core stubs
    const p = await progressOf(id);
    expect(p.walletList?.status).toBe("fewer_than_10_operators");

    // strip everything this change added, as in a row saved before it
    const db = await getDb();
    for (const w of await db.q<{ wallet: string; stats: string }>("SELECT wallet, stats FROM wallets WHERE run_id = $1 AND stats IS NOT NULL", [id])) {
      const s = JSON.parse(w.stats) as Record<string, unknown>;
      for (const k of ["operatorId", "excludedProfitSol", "excludedCount", "excludedByReason", "topTradeShare", "truncated"]) delete s[k];
      await db.run("UPDATE wallets SET stats = $1 WHERE run_id = $2 AND wallet = $3", [JSON.stringify(s), id, w.wallet]);
    }
    await db.run("UPDATE runs SET progress = $1 WHERE id = $2", [JSON.stringify({ stage: "done", done: 1, total: 1, credits: 5 }), id]);

    const d = await runDetail(id, null);
    expect(d).not.toBeNull();
    const s1 = d!.wallets.find((w) => w.wallet === "S1")!;
    expect(s1.stats?.operatorId).toBeUndefined();
    expect(d!.run.progress.walletList).toBeUndefined();
    const rows = await exportRows(id, "traders");
    const row = rows.find((r) => r.wallet === "S1")!;
    expect(row.net_sol).toBeGreaterThan(15);
    expect(row.operator_id ?? null).toBeNull();
    expect(row.excluded_profit_sol ?? null).toBeNull();
    // and the summary can be recomputed from old rows
    const again = await computeWalletList(id, { ...(JSON.parse((await getRun(id))!.settings) as object), minClosedPositions: 5 } as never, ["M1", "M2", "M3"]);
    expect(again.status).toBe("fewer_than_10_operators");
  });
});
