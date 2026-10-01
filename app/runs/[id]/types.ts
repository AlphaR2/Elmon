import type { ClusterRow, RunDetail, TokenRow, WalletRow } from "@/lib/queries";

export type { ClusterRow, TokenRow, WalletRow };
export type RunData = RunDetail;

export const isTrader = (w: WalletRow) => w.role === "candidate" || w.role === "input";
export const tokenLabel = (t: TokenRow) => (t.symbol ? `$${t.symbol}` : `${t.mint.slice(0, 4)}…`);
