import type { DropReason, RankInput, RankResult } from "./walletList.types";

export const MAX_TOP_TRADE_SHARE = 0.5;

// Orders by netSol (descending; ties keep input order). A wallet is dropped, with one reason, when it has too few
// closed positions, is bot-like, or owes more than half its profit to one trade. Checked in that order.
export function rankRealized(items: RankInput[], opts: { minClosed: number }): RankResult {
  const ranked: RankInput[] = [];
  const dropped: { wallet: string; reason: DropReason }[] = [];
  for (const it of items) {
    const s = it.stats;
    if (s.closed < opts.minClosed) dropped.push({ wallet: it.wallet, reason: "too-few-closed" });
    else if (s.botLike) dropped.push({ wallet: it.wallet, reason: "bot" });
    else if (s.topTradeShare != null && s.topTradeShare > MAX_TOP_TRADE_SHARE) dropped.push({ wallet: it.wallet, reason: "top-trade" });
    else ranked.push(it);
  }
  // Array.prototype.sort is stable, so equal netSol keeps input order.
  ranked.sort((a, b) => b.stats.netSol - a.stats.netSol);
  return { ranked, dropped };
}
