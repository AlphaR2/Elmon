import { describe, expect, it } from "vitest";
import { buildPositions, isBotLike, traderScore, traderStats } from "@/lib/core/pnl";
import type { OwnerEvent } from "@/lib/solana/tx";

let slot = 0;
const ev = (mint: string, kind: OwnerEvent["kind"], tokens: number, sol: number, t: number): OwnerEvent => ({
  signature: `s${++slot}`, slot, blockTime: t, owner: "W", mint, kind,
  tokens: BigInt(Math.round(tokens * 1e6)), decimals: 6, lamports: BigInt(Math.round(sol * 1e9)), tokenAccount: "ata",
});

describe("positions", () => {
  it("uses average cost across partial sells and closes at 99%", () => {
    const [p] = buildPositions([
      ev("M", "buy", 100, 1, 0),
      ev("M", "buy", 100, 3, 10), // avg cost 0.02/token
      ev("M", "sell", 100, 4, 20), // cost of sold = 2, realized +2
      ev("M", "sell", 99.5, 1, 30), // cost of sold ~1.99
    ]);
    expect(p.status).toBe("closed");
    expect(p.spentSol).toBeCloseTo(4);
    expect(p.proceedsSol).toBeCloseTo(5);
    expect(p.pnlSol).toBeCloseTo(1);
    expect(p.realizedSol).toBeCloseTo(2 + (1 - 1.99), 2);
    expect(p.multiple).toBeCloseTo(1.25);
    expect(p.holdMinutes).toBeCloseTo(0.5);
  });

  it("keeps a half-sold position open", () => {
    const [p] = buildPositions([ev("M", "buy", 100, 1, 0), ev("M", "sell", 50, 3, 10)]);
    expect(p.status).toBe("open");
    expect(p.pnlSol).toBeCloseTo(2);
    expect(p.multiple).toBeNull();
  });

  it("excludes sells with no buy seen, and tokens that arrived by transfer", () => {
    const ps = buildPositions([
      ev("A", "sell", 100, 5, 0),
      ev("B", "transfer_in", 100, 0, 0),
      ev("B", "sell", 100, 5, 10),
      ev("C", "buy", 100, 1, 0),
      ev("C", "sell", 300, 6, 10), // sold 3x what was bought
    ]);
    const by = Object.fromEntries(ps.map((p) => [p.mint, p]));
    expect(by.A.excludedReason).toBe("sold-before-buy");
    expect(by.B.excludedReason).toBe("transfer-in");
    expect(by.C.excludedReason).toBe("sold-before-buy");
  });

  it("excludes positions mostly moved to another wallet", () => {
    const [p] = buildPositions([ev("M", "buy", 100, 1, 0), ev("M", "transfer_out", 80, 0, 5)]);
    expect(p.excludedReason).toBe("transferred-out");
  });
});

describe("trader stats", () => {
  const now = 10 * 86400;
  const winners = (n: number, mult: number, start: number) =>
    Array.from({ length: n }, (_, i) => [ev(`W${start + i}`, "buy", 100, 1, i * 3600), ev(`W${start + i}`, "sell", 100, mult, i * 3600 + 600)]).flat();

  it("counts unsold bags as losses and leaves recent opens out", () => {
    const events = [
      ...winners(4, 3, 0), // +2 each
      ev("Bag", "buy", 100, 2, 3600), // old open bag: -2
      ev("New", "buy", 100, 5, now - 3600), // too new to judge
      ev("Pasted", "buy", 100, 1, 0), ev("Pasted", "sell", 100, 50, 60), // excluded mint
    ];
    const s = traderStats(events, { excludeMints: new Set(["Pasted"]), now, openGraceHours: 24, txsRead: 12 });
    expect(s.closed).toBe(4);
    expect(s.open).toBe(1);
    expect(s.positions).toBe(5);
    expect(s.winRate).toBe(1);
    expect(s.netSol).toBeCloseTo(8 - 2, 5);
    expect(s.medianMultiple).toBeCloseTo(3, 2);
    expect(s.bigWinShare).toBe(1);
    expect(s.best?.pnlSol).toBeCloseTo(2);
    expect(s.worst?.mint).toBe("Bag");
  });

  it("scores only with enough closed trades, and shrinks small samples toward 50", () => {
    const few = traderStats(winners(3, 3, 0), { now, openGraceHours: 24, txsRead: 6 });
    expect(traderScore(few, 5)).toBeNull();
    const five = traderStats(winners(5, 3, 0), { now, openGraceHours: 24, txsRead: 10 });
    const fifty = traderStats(winners(50, 3, 100), { now, openGraceHours: 24, txsRead: 100 });
    const a = traderScore(five, 5)!, b = traderScore(fifty, 5)!;
    expect(a).toBeGreaterThan(50);
    expect(b).toBeGreaterThan(a); // more evidence and more profit
    const losers = traderStats(winners(20, 0.3, 200), { now, openGraceHours: 24, txsRead: 40 });
    expect(traderScore(losers, 5)!).toBeLessThan(30);
  });

  it("flags bots by fast round trips", () => {
    const events = Array.from({ length: 6 }, (_, i) => [ev(`B${i}`, "buy", 1, 0.1, i * 100), ev(`B${i}`, "sell", 1, 0.11, i * 100 + 2)]).flat();
    expect(isBotLike(buildPositions(events))).toBe(true);
    expect(isBotLike(buildPositions(winners(10, 2, 0)))).toBe(false);
  });

  it("score is bounded and monotonic in profit (property)", () => {
    for (let i = 0; i < 200; i++) {
      const closed = 5 + Math.floor(Math.random() * 100);
      const base = {
        txsRead: 0, windowStart: 0, windowEnd: 0, windowDays: 1, positions: closed, closed, open: 0, excluded: 0,
        wins: 0, winRate: Math.random(), closedPnlSol: 0, realizedSol: 0, spentSol: 0,
        medianMultiple: Math.random() * 20, bigWinShare: 0, medianHoldMin: 1, avgBuySol: 1, tradesPerDay: 1,
        botLike: false, best: null, worst: null, top: [], lastTradeTime: 0, profitableWeeksShare: null, maxDrawdownSol: 0, pnlCurve: [],
      };
      const x = (Math.random() - 0.5) * 200;
      const lo = traderScore({ ...base, netSol: x }, 5)!;
      const hi = traderScore({ ...base, netSol: x + 5 }, 5)!;
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(100);
      expect(hi).toBeGreaterThanOrEqual(lo);
    }
  });
});
