import type { ClusterRow, RunDetail, TokenRow, WalletRow } from "@/lib/queries";
import type { WalletListSummary } from "@/lib/core/walletList.types";

export type { ClusterRow, TokenRow, WalletRow, WalletListSummary };
export type RunData = RunDetail;

export const isTrader = (w: WalletRow) => w.role === "candidate" || w.role === "input";
export const tokenLabel = (t: TokenRow) => (t.symbol ? `$${t.symbol}` : `${t.mint.slice(0, 4)}…`);

// Saved by the run itself (server side). Absent on runs made before the wallet list existed.
export const walletListOf = (d: RunData): WalletListSummary | null => d.run.progress.walletList ?? null;
