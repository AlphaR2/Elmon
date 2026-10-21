import { describe, expect, it } from "vitest";
import { getDb, json, resetDbForTests } from "@/lib/db";
import { createRun, executeRun, getRun } from "@/lib/pipeline/run";
import { loadHistoryEvents } from "@/lib/pipeline/cache";
import { exportRows } from "@/lib/queries";
import { buildOperators } from "@/lib/core/operators";
import { rankRealized } from "@/lib/core/rank";
import type { TraderStats } from "@/lib/core/pnl";
import type { OperatorInput, WalletListSummary } from "@/lib/core/walletList.types";
import { FakeRpc } from "./helpers";
import { NOW, world } from "./world";

const SETTINGS = { earlyBuyers: 20, minClosedPositions: 5, funderScope: "all" } as const;

describe("wallet list junction: real pipeline, real core", () => {
  it("saves real evidence, an operator summary that matches buildOperators, and exports in rankRealized order", async () => {
    await resetDbForTests();
    const { id } = await createRun("tokens", ["M1", "M2", "M3"], SETTINGS);
    await executeRun(id, new FakeRpc(world(), { gtfa: true }), { now: () => NOW });
    expect((await getRun(id))!.status).toBe("done");

    const db = await getDb();
    const rows = await db.q<{ wallet: string; cluster_id: number | null; stats: string }>(
      "SELECT wallet, cluster_id, stats FROM wallets WHERE run_id = $1 AND role IN ('candidate','input') AND history_status = 'done' AND stats IS NOT NULL ORDER BY wallet",
      [id],
    );
    expect(rows.length).toBeGreaterThan(0);
    const scored = rows.map((r) => ({ wallet: r.wallet, clusterId: r.cluster_id, stats: JSON.parse(r.stats) as TraderStats }));
    for (const r of scored) {
      expect(r.stats.operatorId).toMatch(/^op:/);
      expect(typeof r.stats.excludedProfitSol).toBe("number");
      expect(r.stats.excludedByReason).toBeDefined();
      expect(r.stats.truncated === null || typeof r.stats.truncated === "boolean").toBe(true);
    }

    // operatorCount equals buildOperators on the same inputs, over the ranked wallets
    const inputs: OperatorInput[] = [];
    for (const r of scored) {
      const ev = (await loadHistoryEvents(r.wallet)) ?? [];
      inputs.push({
        wallet: r.wallet,
        clusterId: r.clusterId,
        botLike: r.stats.botLike,
        buys: ev.filter((e) => e.kind === "buy" && e.blockTime != null && !["M1", "M2", "M3"].includes(e.mint)).map((e) => ({ mint: e.mint, time: e.blockTime as number })),
      });
    }
    const ops = buildOperators(inputs);
    const opOf = new Map(ops.flatMap((o) => o.wallets.map((w) => [w, o.operatorId] as const)));
    const ranked = rankRealized(scored.map((r) => ({ wallet: r.wallet, stats: r.stats })), { minClosed: 5 }).ranked;
    const progress = json<{ walletList?: WalletListSummary }>((await getRun(id))!.progress, {});
    expect(progress.walletList?.walletsRanked).toBe(ranked.length);
    expect(progress.walletList?.operatorCount).toBe(new Set(ranked.map((r) => opOf.get(r.wallet))).size);
    for (const r of scored) expect(r.stats.operatorId).toBe(opOf.get(r.wallet));

    // the export lists eligible wallets in rank order (the two copies of the eligibility rule agree)
    const exported = (await exportRows(id, "traders")).filter((r) => r.net_sol != null);
    const eligible = new Set(ranked.map((r) => r.wallet));
    const exportedEligible = exported.map((r) => String(r.wallet)).filter((w) => eligible.has(w));
    expect(exportedEligible).toEqual(ranked.map((r) => r.wallet));
  });
});
