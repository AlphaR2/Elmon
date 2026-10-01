import { describe, expect, it } from "vitest";
import { classifyPosition, runnerScore, runnerStats } from "@/lib/core/runners";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { Position } from "@/lib/core/pnl";
import { MAX_PLAUSIBLE_PEAK_USD, type TokenFacts } from "@/lib/tokens";

// Property tests over random inputs from a fixed seed (reproducible failures).
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const DAY = 86400;
const T = 1_790_000_000;
const sol = () => 150;
const S = DEFAULT_SETTINGS;

function pos(r: () => number, mint = "A"): Position {
  const bought = 10 + r() * 1e6;
  const spent = 0.05 + r() * 20;
  const soldPct = r() < 0.3 ? 0 : r();
  const proceeds = soldPct * spent * (r() * 50);
  const closed = soldPct >= 0.99;
  return {
    mint, status: closed ? "closed" : "open", firstBuy: T, lastSell: soldPct > 0 ? T + Math.floor(r() * 5 * DAY) : null,
    buys: 1, sells: soldPct > 0 ? 1 : 0, spentSol: spent, proceedsSol: proceeds, boughtTokens: bought, pnlSol: proceeds - spent,
    realizedSol: 0, multiple: closed ? proceeds / spent : null, holdMinutes: null, soldPct, buyTimes: [T], sellTimes: [],
  };
}
function facts(r: () => number, mint = "A", peakPrice?: number): TokenFacts {
  const price = peakPrice ?? r() * 10;
  return {
    mint, symbol: null, name: null, supply: 1e9 * (0.001 + r()), priceUsd: null, mcapUsd: r() * 1e6, launchpad: null,
    graduatedAt: null, createdAt: T - DAY, holders: 1000, infoAt: T, pool: "p",
    candles: [[Math.floor(T / DAY) * DAY + DAY, price, price / 3, 50_000]], peakAt: T, peakStatus: "fetched",
  };
}

describe("runner math (properties)", () => {
  it("capture is always within [0, 1] and the score within [0, 100]", () => {
    const r = rng(1);
    for (let i = 0; i < 3000; i++) {
      const ps = Array.from({ length: 1 + Math.floor(r() * 12) }, (_, k) => pos(r, `M${k}`));
      const fs = new Map(ps.map((p) => [p.mint, facts(r, p.mint)]));
      const st = runnerStats(ps, fs, sol, S, T + 30 * DAY);
      for (const h of st.hits) if (h.capture != null) expect(h.capture).toBeGreaterThanOrEqual(0), expect(h.capture).toBeLessThanOrEqual(1);
      if (st.score != null) expect(st.score).toBeGreaterThanOrEqual(0), expect(st.score).toBeLessThanOrEqual(100);
      expect(st.runners).toBeLessThanOrEqual(st.judged);
    }
  });

  it("a higher peak never turns a runner into a non-runner", () => {
    const r = rng(2);
    let runners = 0;
    for (let i = 0; i < 3000; i++) {
      const p = pos(r);
      const f = facts(r);
      const base = classifyPosition(p, f, sol, S, T + 30 * DAY);
      if (base.status !== "runner") continue;
      runners++;
      const hi = { ...f, candles: f.candles!.map((c) => [c[0], c[1] * (1 + r() * 20), c[2], c[3]] as [number, number, number, number]) };
      const status = classifyPosition(p, hi, sol, S, T + 30 * DAY).status;
      // Past the plausibility cap ($100B) the peak is bad data: unknown, never a proven miss.
      if (hi.candles[0][1] * hi.supply! > MAX_PLAUSIBLE_PEAK_USD) expect(status).not.toBe("no");
      else expect(status).toBe("runner");
    }
    expect(runners).toBeGreaterThan(50); // the property was actually exercised
  });

  it("the score never drops when a wallet catches more (weighted) runners", () => {
    const r = rng(3);
    for (let i = 0; i < 3000; i++) {
      const judged = 3 + Math.floor(r() * 50);
      const runners = Math.floor(r() * judged);
      const base = {
        judged, unknown: 0, runners, weighted: runners * (1 + r() * 3), hitRate: runners / judged, medianEntryMcapUsd: 3000 + r() * 297_000,
        medianCapture: r(), convictionCount: Math.floor(r() * runners), biggestPeakUsd: null, medianEntryAllUsd: null, medianSecsAfterLaunch: null, hits: [],
      };
      const more = { ...base, weighted: base.weighted + r() * 5 };
      expect(runnerScore(more, S)!).toBeGreaterThanOrEqual(runnerScore(base, S)!);
    }
  });

  it("an estimated peak that fails the test is unknown, never a proven miss (when the entry qualified)", () => {
    const r = rng(4);
    let checked = 0;
    for (let i = 0; i < 1000; i++) {
      const p = pos(r);
      const f: TokenFacts = { ...facts(r), candles: null, peakStatus: "missing", mcapUsd: r() * 1000 };
      const c = classifyPosition(p, f, sol, S, T + 30 * DAY);
      if ((c.entryMcapUsd ?? 0) > S.runnerEntryMaxUsd) continue; // covered by the next test
      checked++;
      expect(c.status).not.toBe("no");
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("bought above the entry cap is a definite no, with or without price history", () => {
    const r = rng(7);
    let checked = 0;
    for (let i = 0; i < 1000; i++) {
      const p = pos(r);
      for (const f of [facts(r), { ...facts(r), candles: null, peakStatus: "missing" }] as TokenFacts[]) {
        const c = classifyPosition(p, f, sol, S, T + 30 * DAY);
        if (c.entryMcapUsd == null || c.entryMcapUsd <= S.runnerEntryMaxUsd) continue;
        checked++;
        expect(c.status).toBe("no");
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("selling early still counts as a catch (paperhands are what we want to find)", () => {
    const p: Position = { ...pos(rng(5)), spentSol: 1, boughtTokens: 1_000_000, proceedsSol: 1.5, soldPct: 1, status: "closed", multiple: 1.5, lastSell: T + 600 };
    // entry: 1 SOL / 1M tokens * $150 * 1B supply = $150k; peak $10M
    const f: TokenFacts = { ...facts(rng(6)), supply: 1e9, candles: [[Math.floor(T / DAY) * DAY + DAY, 0.01, 0.005, 1e6]] };
    const c = classifyPosition(p, f, sol, S, T + 30 * DAY);
    expect(c.status).toBe("runner");
    expect(c.hit!.capture!).toBeCloseTo(1.5 / (10_000_000 / 150_000), 5);
  });
});
