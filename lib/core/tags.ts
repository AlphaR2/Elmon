// Tags are rules, not opinions. Each has a definition shown in the UI.

export const TAG_DEFS: Record<string, string> = {
  "runner-catcher": "Caught 3+ runners outside your batch (bought early, token later ran)",
  conviction: "Held at least one runner past the conviction multiple (default 10x from entry)",
  paperhands: "Catches runners but sells early: median capture under 25% of what the runner offered",
  "too-fast": "Median hold is shorter than you could copy (default 60 s)",
  dormant: "No trade for longer than the dormant window (default 14 days)",
  dev: "Created one of the pasted tokens",
  "dev-linked": "Shares a funding source with the deployer of a pasted token",
  bundle: "In a group of 3+ wallets from one funder that bought the same token early",
  "shared-funder": "Got its first SOL from the same source as another wallet here",
  "block-0": "Bought in the same slot the token was created",
  sniper: "Bought within the sniper window after creation (see settings)",
  fresh: "Wallet was younger than the fresh window at its first early buy",
  "service-funded": "First SOL came from an exchange or app (1,000+ transactions a day)",
  "bot-like": "30+ trades with a median hold under 2 min, or 5+ buy-then-sell pairs within 5 s",
  busy: "More than 500 transactions a day",
  "thin-history": "Too few closed trades to score",
};

// Tags that mark a wallet as an insider rather than a trader to copy.
export const INSIDER_TAGS = new Set(["dev", "dev-linked", "bundle"]);
// Tags that make a wallet a poor copy target even if profitable.
export const NOISE_TAGS = new Set(["bot-like", "block-0"]);

export interface TagInput {
  isDeployer: boolean;
  clusterKind: "dev-linked" | "bundle" | "shared-funder" | null;
  sameSlot: boolean;
  minSecsAfterCreate: number | null;
  firstBuyTime: number | null;
  firstTxTime: number | null;
  firstTxExact: boolean;
  funderService: boolean;
  txsPerDay: number | null;
  botLike: boolean | null;
  scored: boolean | null; // null = no history pulled
  runners?: number | null;
  medianCapture?: number | null;
  convictionCount?: number | null;
  medianHoldMin?: number | null;
  daysSinceLastTrade?: number | null;
}

export function computeTags(
  t: TagInput,
  s: { sniperSeconds: number; freshHours: number; tooFastSeconds?: number; dormantDays?: number },
): string[] {
  const tags: string[] = [];
  if ((t.runners ?? 0) >= 3) tags.push("runner-catcher");
  if ((t.convictionCount ?? 0) >= 1) tags.push("conviction");
  if ((t.runners ?? 0) >= 2 && t.medianCapture != null && t.medianCapture < 0.25) tags.push("paperhands");
  if (t.isDeployer) tags.push("dev");
  if (t.clusterKind === "dev-linked" && !t.isDeployer) tags.push("dev-linked");
  if (t.clusterKind === "bundle") tags.push("bundle");
  if (t.clusterKind === "shared-funder") tags.push("shared-funder");
  if (t.sameSlot && !t.isDeployer) tags.push("block-0");
  if (!t.sameSlot && t.minSecsAfterCreate != null && t.minSecsAfterCreate <= s.sniperSeconds && !t.isDeployer) tags.push("sniper");
  if (t.firstTxExact && t.firstTxTime != null && t.firstBuyTime != null) {
    const age = t.firstBuyTime - t.firstTxTime;
    if (age >= 0 && age <= s.freshHours * 3600) tags.push("fresh");
  }
  if (t.funderService) tags.push("service-funded");
  if (t.botLike) tags.push("bot-like");
  if (t.txsPerDay != null && t.txsPerDay > 500) tags.push("busy");
  if (t.scored === false) tags.push("thin-history");
  if (t.medianHoldMin != null && s.tooFastSeconds != null && t.medianHoldMin * 60 < s.tooFastSeconds) tags.push("too-fast");
  if (t.daysSinceLastTrade != null && s.dormantDays != null && t.daysSinceLastTrade > s.dormantDays) tags.push("dormant");
  return tags;
}
