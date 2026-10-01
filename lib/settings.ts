// Browser-safe: shared by the server and the new-run form.
export type RunMode = "tokens" | "wallets";

export interface RunSettings {
  // Launch window
  earlyBuyers: number; // first N distinct buyer wallets per token
  maxLaunchTxs: number; // stop reading a token's launch after this many transactions
  maxSignaturePages: number; // fallback path only: skip tokens whose launch is further back than this
  sniperSeconds: number; // bought within this many seconds of creation
  // Candidates
  minHits: number; // a wallet must be early in at least this many pasted tokens
  // Funders and clusters
  funderScope: "all" | "candidates"; // "candidates": insiders are scanned per launch on demand
  maxFunderLookups: number;
  clusterMinService: number; // wallets funded by an exchange/app count as one group only in bursts this big
  serviceBurstMinutes: number;
  freshHours: number; // wallet younger than this at its first buy
  // History
  historyTopK: number; // how many candidates get their history read
  historyMaxTxs: number; // transactions per wallet, at most
  adaptiveHistory: boolean; // read 100 first, go deeper only if the wallet looks worth it
  historySkipInsiders: boolean; // skip devs and dev-linked wallets
  minClosedPositions: number; // fewer closed trades than this and a wallet gets no profit score
  openGraceHours: number; // positions opened this recently are left out (too new to judge)
  // Runners
  runnerEntryMaxUsd: number; // bought at or below this market cap
  runnerMinMultiple: number; // token later reached this multiple of the entry
  runnerMinPeakUsd: number; // and at least this market cap
  convictionMultiple: number; // held a runner past this multiple of entry
  peakLookups: number; // price-history lookups per run (free but rate-limited, about 2 s each)
  // Copyability and recency
  tooFastSeconds: number; // median hold under this is too fast to copy
  dormantDays: number; // no trade for this long
  // Money
  runBudget: number; // max credits this run may spend
}

export const DEFAULT_SETTINGS: RunSettings = {
  earlyBuyers: 100,
  maxLaunchTxs: 500,
  maxSignaturePages: 150,
  sniperSeconds: 10,
  minHits: 2,
  funderScope: "candidates",
  maxFunderLookups: 800,
  clusterMinService: 3,
  serviceBurstMinutes: 30,
  freshHours: 24,
  historyTopK: 30,
  historyMaxTxs: 1000,
  adaptiveHistory: true,
  historySkipInsiders: true,
  minClosedPositions: 5,
  openGraceHours: 24,
  runnerEntryMaxUsd: 300_000,
  runnerMinMultiple: 5,
  runnerMinPeakUsd: 1_000_000,
  convictionMultiple: 10,
  peakLookups: 300,
  tooFastSeconds: 60,
  dormantDays: 14,
  runBudget: 40_000,
};

export type PresetName = "cheap" | "balanced" | "deep";
export const PRESETS: Record<PresetName, { label: string; blurb: string; settings: Partial<RunSettings> }> = {
  cheap: {
    label: "Cheap",
    blurb: "First 50 buyers, 15 wallets checked, 300 transactions each",
    settings: { earlyBuyers: 50, maxLaunchTxs: 300, historyTopK: 15, historyMaxTxs: 300, peakLookups: 100, runBudget: 15_000 },
  },
  balanced: {
    label: "Balanced",
    blurb: "First 100 buyers, 30 wallets checked, up to 1,000 transactions each",
    settings: { earlyBuyers: 100, maxLaunchTxs: 500, historyTopK: 30, historyMaxTxs: 1000, peakLookups: 300, runBudget: 40_000 },
  },
  deep: {
    label: "Deep",
    blurb: "First 200 buyers, 60 wallets checked, up to 2,000 transactions each",
    settings: { earlyBuyers: 200, maxLaunchTxs: 1000, historyTopK: 60, historyMaxTxs: 2000, peakLookups: 800, runBudget: 120_000 },
  },
};

const LIMITS: Record<keyof RunSettings, [number, number] | null> = {
  earlyBuyers: [10, 1000],
  maxLaunchTxs: [50, 5000],
  maxSignaturePages: [1, 2000],
  sniperSeconds: [0, 600],
  minHits: [1, 50],
  funderScope: null,
  maxFunderLookups: [0, 10_000],
  clusterMinService: [2, 50],
  serviceBurstMinutes: [1, 1440],
  freshHours: [1, 720],
  historyTopK: [0, 500],
  historyMaxTxs: [100, 10_000],
  adaptiveHistory: null,
  historySkipInsiders: null,
  minClosedPositions: [1, 100],
  openGraceHours: [0, 720],
  runnerEntryMaxUsd: [1_000, 100_000_000],
  runnerMinMultiple: [1.5, 1000],
  runnerMinPeakUsd: [10_000, 10_000_000_000],
  convictionMultiple: [1.5, 10_000],
  peakLookups: [0, 5000],
  tooFastSeconds: [0, 86_400],
  dormantDays: [1, 365],
  runBudget: [100, 5_000_000],
};

const BOOLEANS = new Set<keyof RunSettings>(["historySkipInsiders", "adaptiveHistory"]);

export function parseSettings(input: unknown): RunSettings {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof RunSettings)[]) {
    const v = src[key];
    if (v === undefined || v === null || v === "") continue;
    const lim = LIMITS[key];
    if (key === "funderScope") {
      if (v === "all" || v === "candidates") out[key] = v;
      else throw new Error(`funderScope must be "all" or "candidates"`);
    } else if (BOOLEANS.has(key)) {
      out[key] = v === true || v === "true";
    } else if (lim) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < lim[0] || n > lim[1]) throw new Error(`${key} must be between ${lim[0]} and ${lim[1]}`);
      out[key] = key === "runnerMinMultiple" || key === "convictionMultiple" ? n : Math.round(n);
    }
  }
  return out as unknown as RunSettings;
}

// Credit estimate shown before a run starts. Assumes the Helius oldest-first method is available and that no
// wallet or token has been seen before; stored facts make real runs cheaper. The run budget is a hard cap.
export function estimateCredits(mode: RunMode, count: number, s: RunSettings): { low: number; high: number } {
  const historyFull = Math.ceil(s.historyMaxTxs / 100) * 10;
  const historyLow = s.adaptiveHistory ? 10 : historyFull;
  if (mode === "wallets") {
    return { low: count * (3 + historyLow), high: Math.min(s.runBudget, count * (22 + historyFull)) };
  }
  const launch = count * Math.ceil(s.maxLaunchTxs / 100) * 10;
  const buyers = Math.min(count * s.earlyBuyers, s.maxFunderLookups);
  const funderWallets = s.funderScope === "all" ? buyers : Math.min(buyers, s.historyTopK * 2);
  return {
    low: Math.round(launch * 0.3 + funderWallets * 2 + s.historyTopK * historyLow),
    high: Math.min(s.runBudget, Math.round(launch + funderWallets * 22 + s.historyTopK * (historyFull + s.minHits * 10))),
  };
}

type Group = "Launch" | "Candidates" | "Funders" | "History" | "Runners" | "Copying" | "Budget";
export const SETTING_HELP: { key: keyof RunSettings; label: string; help: string; group: Group; modes: RunMode[] }[] = [
  { key: "earlyBuyers", label: "Early buyers per token", help: "The first N distinct wallets that bought each token.", group: "Launch", modes: ["tokens"] },
  { key: "maxLaunchTxs", label: "Max launch transactions", help: "Stop reading a token's launch after this many successful transactions.", group: "Launch", modes: ["tokens"] },
  { key: "sniperSeconds", label: "Sniper window (s)", help: "Buys this soon after creation get the sniper tag.", group: "Launch", modes: ["tokens"] },
  { key: "minHits", label: "Min tokens in common", help: "A wallet must be early in at least this many of your tokens to be a candidate.", group: "Candidates", modes: ["tokens"] },
  { key: "funderScope", label: "Trace funders for", help: "Candidates only (insider scans are a button per launch) or every early buyer (costly).", group: "Funders", modes: ["tokens"] },
  { key: "historyTopK", label: "Wallets to check", help: "How many top candidates get their trade history read.", group: "History", modes: ["tokens"] },
  { key: "historyMaxTxs", label: "History depth (txs)", help: "Most recent transactions read per wallet, at most.", group: "History", modes: ["tokens", "wallets"] },
  { key: "adaptiveHistory", label: "Stop early on weak wallets", help: "Read 100 transactions first; go deeper only if the wallet caught something or is profitable.", group: "History", modes: ["tokens", "wallets"] },
  { key: "historySkipInsiders", label: "Skip insiders", help: "Do not spend credits checking devs, dev-linked wallets and bundles.", group: "History", modes: ["tokens"] },
  { key: "minClosedPositions", label: "Min closed trades for profit score", help: "Fewer closed trades than this and the wallet gets no profit score.", group: "History", modes: ["tokens", "wallets"] },
  { key: "runnerEntryMaxUsd", label: "Runner: entry at most ($)", help: "The wallet must have bought at or below this market cap.", group: "Runners", modes: ["tokens", "wallets"] },
  { key: "runnerMinMultiple", label: "Runner: at least x from entry", help: "The token must later reach this multiple of the wallet's entry.", group: "Runners", modes: ["tokens", "wallets"] },
  { key: "runnerMinPeakUsd", label: "Runner: peak at least ($)", help: "…and at least this market cap.", group: "Runners", modes: ["tokens", "wallets"] },
  { key: "convictionMultiple", label: "Conviction: held past x", help: "Held a runner past this multiple of its entry.", group: "Runners", modes: ["tokens", "wallets"] },
  { key: "peakLookups", label: "Price lookups per run", help: "Tokens whose price history is fetched to confirm a runner (free, about 2 s each). The rest use a lower-bound estimate.", group: "Runners", modes: ["tokens", "wallets"] },
  { key: "tooFastSeconds", label: "Too fast to copy (s)", help: "Median hold under this is flagged too-fast.", group: "Copying", modes: ["tokens", "wallets"] },
  { key: "dormantDays", label: "Dormant after (days)", help: "No trade for this long is flagged dormant.", group: "Copying", modes: ["tokens", "wallets"] },
  { key: "runBudget", label: "Run budget (credits)", help: "The run stops spending here and keeps what it has.", group: "Budget", modes: ["tokens", "wallets"] },
];

// Runner weight: bigger peaks count more. $1M = 1, $10M = 2, $100M = 3, $1B+ = 4.
export const runnerWeight = (peakUsd: number) => Math.min(4, Math.max(1, 1 + Math.log10(peakUsd / 1_000_000)));
