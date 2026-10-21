import { describe, expect, it } from "vitest";
import { cutToWindow, splitAt } from "@/lib/core/window";
import { traderStats } from "@/lib/core/pnl";
import { rankRealized } from "@/lib/core/rank";
import type { OwnerEvent } from "@/lib/solana/tx";

let slot = 0;
const ev = (wallet: string, mint: string, kind: OwnerEvent["kind"], sol: number, t: number | null): OwnerEvent => ({
  signature: `s${++slot}`, slot, blockTime: t, owner: wallet, mint, kind,
  tokens: 1_000_000n, decimals: 6, lamports: BigInt(Math.round(sol * 1e9)), tokenAccount: "ata",
});

describe("window", () => {
  it("cutToWindow keeps only events inside [from, to] and drops undated ones", () => {
    const e = [ev("W", "A", "buy", 1, 5), ev("W", "A", "sell", 2, 10), ev("W", "B", "buy", 1, 20), ev("W", "B", "sell", 1, null)];
    expect(cutToWindow(e, { from: 10, to: 20 }).map((x) => x.blockTime)).toEqual([10, 20]);
  });

  it("splitAt puts every event in exactly one half and the halves equal the input", () => {
    const e = [ev("W", "A", "buy", 1, 5), ev("W", "A", "sell", 2, 10), ev("W", "B", "buy", 1, 11), ev("W", "B", "sell", 1, null)];
    const { before, after } = splitAt(e, 10);
    expect(before.length + after.length).toBe(e.length);
    expect(new Set([...before, ...after]).size).toBe(e.length);
    expect(after.every((x) => x.blockTime != null && x.blockTime >= 10)).toBe(true);
    expect(before.every((x) => x.blockTime == null || x.blockTime < 10)).toBe(true);
  });

  it("after the cut, stats and rank order do not depend on older events", () => {
    const window = { from: 100, to: 1000 };
    const mk = (w: string, older: boolean, gain: number): OwnerEvent[] => [
      ...(older ? [ev(w, "OLD", "buy", 1, 10), ev(w, "OLD", "sell", 50, 20)] : []),
      ...[0, 1, 2, 3, 4].flatMap((i) => [ev(w, `M${i}`, "buy", 1, 200 + i * 10), ev(w, `M${i}`, "sell", 1 + gain, 900 + i * 10)]),
    ];
    const opts = { now: 1e6, openGraceHours: 0, txsRead: 1, historyComplete: true };
    const run = (older: boolean) => {
      const items = [["P", 0.1], ["Q", 0.5], ["R", 0.3]].map(([w, g]) => ({
        wallet: w as string,
        stats: traderStats(cutToWindow(mk(w as string, older, g as number), window), opts),
      }));
      return { items, order: rankRealized(items, { minClosed: 3 }).ranked.map((r) => r.wallet) };
    };
    const a = run(false), b = run(true);
    expect(b.items.map((i) => i.stats)).toEqual(a.items.map((i) => i.stats));
    expect(b.order).toEqual(a.order);
    expect(a.order).toEqual(["Q", "R", "P"]);
  });
});
