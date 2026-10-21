import { describe, expect, it } from "vitest";
import { rankRealized } from "@/lib/core/rank";
import type { TraderStats } from "@/lib/core/pnl";
import type { RankInput } from "@/lib/core/walletList.types";

const ZERO = { count: 0, proceedsSol: 0 };
const stats = (o: Partial<TraderStats>): TraderStats => ({
  txsRead: 100, windowStart: 0, windowEnd: 1, windowDays: 1, positions: 10, closed: 10, open: 0, excluded: 0, wins: 5, winRate: 0.5,
  netSol: 1, closedPnlSol: 1, realizedSol: 1, spentSol: 1, medianMultiple: 1, bigWinShare: 0, medianHoldMin: 5, avgBuySol: 1,
  tradesPerDay: 1, botLike: false, lastTradeTime: 1, profitableWeeksShare: 0.5, maxDrawdownSol: 0, pnlCurve: [], best: null, worst: null, top: [],
  excludedProfitSol: 0, excludedCount: 0, excludedByReason: { "transfer-in": ZERO, "sold-before-buy": ZERO, "transferred-out": ZERO },
  topTradeShare: 0.2, truncated: false, operatorId: null, ...o,
});
const item = (wallet: string, o: Partial<TraderStats>): RankInput => ({ wallet, stats: stats(o) });

describe("rankRealized", () => {
  it("orders by netSol descending", () => {
    const r = rankRealized([item("a", { netSol: 1 }), item("b", { netSol: 9 }), item("c", { netSol: 5 })], { minClosed: 5 });
    expect(r.ranked.map((x) => x.wallet)).toEqual(["b", "c", "a"]);
  });

  it("drops by reason: too few closed, bot, top trade (> 0.5 only)", () => {
    const r = rankRealized(
      [item("few", { closed: 2 }), item("bot", { botLike: true }), item("one", { topTradeShare: 0.51 }), item("edge", { topTradeShare: 0.5 }), item("null", { topTradeShare: null })],
      { minClosed: 5 },
    );
    expect(r.ranked.map((x) => x.wallet)).toEqual(["edge", "null"]);
    expect(Object.fromEntries(r.dropped.map((d) => [d.wallet, d.reason]))).toEqual({ few: "too-few-closed", bot: "bot", one: "top-trade" });
  });

  it("keeps input order on ties and never mutates the input", () => {
    const input = [item("x", { netSol: 2 }), item("y", { netSol: 2 }), item("z", { netSol: 2 })];
    const copy = [...input];
    expect(rankRealized(input, { minClosed: 5 }).ranked.map((x) => x.wallet)).toEqual(["x", "y", "z"]);
    expect(input).toEqual(copy);
  });

  it("handles empty input", () => {
    expect(rankRealized([], { minClosed: 5 })).toEqual({ ranked: [], dropped: [] });
  });
});
