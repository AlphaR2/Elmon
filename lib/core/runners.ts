import { runnerWeight, type RunSettings } from "../settings";
import { peakMcapAfter, type TokenFacts } from "../tokens";
import type { Position } from "./pnl";

// "How many runners did this wallet catch?" A runner is a token the wallet bought at or below the entry cap that
// later reached both the multiple and the minimum peak. Selling early (paperhands) still counts as a catch.
// Bigger peaks weigh more (runnerWeight). Capture = what the wallet made vs what was there. Conviction = how far
// into the run it kept holding.

export type RunnerStatus = "runner" | "no" | "unknown";

export interface RunnerHit {
  mint: string;
  symbol: string | null;
  firstBuy: number | null;
  entryMcapUsd: number;
  peakMcapUsd: number;
  peakMultiple: number; // peak / entry
  exitMultiple: number | null; // proceeds / spent (unsold valued at zero); null while nothing sold
  capture: number | null; // exitMultiple / peakMultiple
  heldToMultiple: number | null; // highest multiple reached while still holding
  open: boolean;
  weight: number;
  estimated: boolean; // peak is a lower bound (no price history)
}

export interface RunnerStats {
  judged: number; // positions whose runner status is known
  unknown: number;
  runners: number;
  weighted: number;
  hitRate: number | null;
  medianEntryMcapUsd: number | null; // on runners
  medianCapture: number | null;
  convictionCount: number; // runners held past the conviction multiple
  biggestPeakUsd: number | null;
  medianEntryAllUsd: number | null; // entry style over every judged position
  medianSecsAfterLaunch: number | null;
  hits: RunnerHit[]; // top 30 by weight
  score: number | null;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function classifyPosition(
  p: Position,
  f: TokenFacts | undefined,
  solUsd: (ts: number) => number | null,
  s: Pick<RunSettings, "runnerEntryMaxUsd" | "runnerMinMultiple" | "runnerMinPeakUsd">,
  now: number,
): { status: RunnerStatus; hit?: RunnerHit; entryMcapUsd?: number } {
  if (!f || p.firstBuy == null || p.boughtTokens <= 0 || p.spentSol <= 0) return { status: "unknown" };
  const supply = f.supply;
  const sol = solUsd(p.firstBuy);
  if (!supply || !sol) return { status: "unknown" };
  const entryMcapUsd = (p.spentSol / p.boughtTokens) * sol * supply;
  // Bought above the entry cap: not a runner catch, however high it went. No price history needed.
  if (entryMcapUsd > s.runnerEntryMaxUsd) return { status: "no", entryMcapUsd };

  // Peak after entry: price history if we have it, else lower bounds (now, or the wallet's own best exit).
  let peak = peakMcapAfter(f, p.firstBuy);
  let estimated = false;
  if (peak == null) {
    if (f.peakStatus?.startsWith("skip:never-graduated") || f.peakStatus === "skip:tiny" || f.peakStatus === "skip:no-market") {
      return { status: "no", entryMcapUsd }; // never left its curve / never traded meaningfully
    }
    const sold = p.soldPct * p.boughtTokens;
    const exitMcap = sold > 0 && p.lastSell != null ? (p.proceedsSol / sold) * (solUsd(p.lastSell) ?? sol) * supply : 0;
    const lower = Math.max(f.mcapUsd ?? 0, exitMcap);
    if (lower <= 0) return { status: "unknown", entryMcapUsd };
    peak = lower;
    estimated = true;
  }
  const isRunner = entryMcapUsd <= s.runnerEntryMaxUsd && peak >= s.runnerMinPeakUsd && peak >= s.runnerMinMultiple * entryMcapUsd;
  if (!isRunner) {
    // A lower bound that fails the test does not prove the token did not run.
    return { status: estimated ? "unknown" : "no", entryMcapUsd };
  }
  const exitMultiple = p.proceedsSol > 0 ? p.proceedsSol / p.spentSol : null;
  const peakMultiple = peak / entryMcapUsd;
  const holdUntil = p.status === "closed" && p.lastSell != null ? p.lastSell : now;
  const heldPeak = peakMcapAfter(f, p.firstBuy, holdUntil);
  return {
    status: "runner",
    entryMcapUsd,
    hit: {
      mint: p.mint,
      symbol: f.symbol,
      firstBuy: p.firstBuy,
      entryMcapUsd,
      peakMcapUsd: peak,
      peakMultiple,
      exitMultiple,
      capture: exitMultiple != null ? Math.min(1, exitMultiple / peakMultiple) : null,
      heldToMultiple: heldPeak != null ? heldPeak / entryMcapUsd : null,
      open: p.status !== "closed",
      weight: runnerWeight(peak),
      estimated,
    },
  };
}

// Runner Score, 0-100. Main term is weighted runners; the rest reward picking well, holding, and getting in early.
//   55%  weighted runners, saturating: 1 - e^(-W/4)   (4 weighted runners = 63% of this term)
//   20%  hit rate, full marks at 20% of judged tokens
//   15%  share of runners held past the conviction multiple
//   10%  earliness: median runner entry, $3k = full, $300k = none (log scale)
export function runnerScore(r: Omit<RunnerStats, "score">, s: Pick<RunSettings, "runnerEntryMaxUsd">): number | null {
  if (r.judged < 3) return null;
  const w = 1 - Math.exp(-r.weighted / 4);
  const hr = Math.min(1, (r.hitRate ?? 0) / 0.2);
  const conv = r.runners ? r.convictionCount / r.runners : 0;
  const early = r.medianEntryMcapUsd != null ? Math.min(1, Math.max(0, Math.log10(s.runnerEntryMaxUsd / r.medianEntryMcapUsd) / 2)) : 0;
  return Math.round(1000 * (0.55 * w + 0.2 * hr + 0.15 * conv + 0.1 * early)) / 10;
}

export function runnerStats(
  positions: Position[],
  facts: Map<string, TokenFacts>,
  solUsd: (ts: number) => number | null,
  s: RunSettings,
  now: number,
  excludeMints?: Set<string>,
): RunnerStats {
  const hits: RunnerHit[] = [];
  const entries: number[] = [];
  const secsAfter: number[] = [];
  let judged = 0, unknown = 0;
  for (const p of positions) {
    if (excludeMints?.has(p.mint) || p.buys === 0) continue;
    const f = facts.get(p.mint);
    if (f?.createdAt != null && p.firstBuy != null && p.firstBuy >= f.createdAt) secsAfter.push(p.firstBuy - f.createdAt);
    const c = classifyPosition(p, f, solUsd, s, now);
    if (c.status === "unknown") { unknown++; continue; }
    judged++;
    if (c.entryMcapUsd != null) entries.push(c.entryMcapUsd);
    if (c.hit) hits.push(c.hit);
  }
  hits.sort((a, b) => b.weight - a.weight || b.peakMultiple - a.peakMultiple);
  const base = {
    judged,
    unknown,
    runners: hits.length,
    weighted: Math.round(hits.reduce((a, h) => a + h.weight, 0) * 100) / 100,
    hitRate: judged ? hits.length / judged : null,
    medianEntryMcapUsd: median(hits.map((h) => h.entryMcapUsd)),
    medianCapture: median(hits.map((h) => h.capture).filter((x): x is number => x != null)),
    convictionCount: hits.filter((h) => (h.heldToMultiple ?? 0) >= s.convictionMultiple).length,
    biggestPeakUsd: hits.length ? Math.max(...hits.map((h) => h.peakMcapUsd)) : null,
    medianEntryAllUsd: median(entries),
    medianSecsAfterLaunch: median(secsAfter),
    hits: hits.slice(0, 30),
  };
  return { ...base, score: runnerScore(base, s) };
}

// Weight of a pasted token in this batch: its all-time peak decides how much catching it early counts.
export function batchTokenWeight(peakUsd: number | null, s: Pick<RunSettings, "runnerMinPeakUsd">): number {
  if (peakUsd == null) return 1;
  if (peakUsd < s.runnerMinPeakUsd) return 0.5;
  return runnerWeight(peakUsd);
}
