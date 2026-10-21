import type { ExcludedReason, TraderStats } from "./pnl";

// Pinned by docs/wallet-list-contract.md. Types only.

export type { ExcludedReason };

export interface ExcludedBucket {
  count: number;
  proceedsSol: number;
}

// Evidence stored inside wallets.stats beside the existing TraderStats fields.
export interface WalletEvidence {
  excludedProfitSol: number; // sum of proceedsSol of excluded positions
  excludedCount: number;
  excludedByReason: Record<ExcludedReason, ExcludedBucket>;
  topTradeShare: number | null; // best closed pnlSol / netSol when netSol > 0
  truncated: boolean | null; // saved history not complete; null = unknown
  operatorId: string | null;
}

export type DropReason = "too-few-closed" | "bot" | "top-trade";

export interface RankInput {
  wallet: string;
  stats: TraderStats;
}

export interface RankResult {
  ranked: RankInput[]; // netSol descending, ties keep input order
  dropped: { wallet: string; reason: DropReason }[];
}

export interface OperatorInput {
  wallet: string;
  clusterId: number | null; // buildClusters id
  botLike: boolean;
  buys: { mint: string; time: number }[]; // buy events, unix seconds
}

export interface OperatorResult {
  operatorId: string;
  wallets: string[];
}

// Per operator, scored on the held-out half.
export interface OperatorOutcome {
  operatorId: string;
  heldOutNetSol: number;
  heldOutClosed: number;
  success: boolean;
}

export interface WilsonInterval {
  n: number;
  successes: number;
  rate: number | null;
  lo: number | null;
  hi: number | null;
}

export type VerdictLine = "passes" | "fewer than 10 independent operators" | "no better than control" | "control missing or too small";

export interface VerdictResult {
  verdict: VerdictLine;
  candidate: WilsonInterval;
  control: WilsonInterval;
}

// What the web run saves under key `walletList` in the final runs.progress write.
export interface WalletListSummary {
  operatorCount: number;
  walletsRanked: number;
  droppedByReason: Record<DropReason, number>;
  status: "fewer_than_10_operators" | "unproven";
}
