# Wallet list contract

The shared definitions for the evidence-first wallet list. Both sides build against this: the pure core
(`lib/core/*`, the report script) and the wiring, UI and exports (`lib/pipeline/run.ts`, `lib/queries.ts`, `app/`).
Where code and this document disagree, this document wins until the boss changes it.

Boss's veto of these defaults: the board marks p2.1 to p2.4 as accepted by the boss ("choose yourself", "yes", 2026-10-21). Change a number
here only with the boss's say, and change the code in the same step.

## 1. Evidence per wallet (`WalletEvidence`, inside `wallets.stats`)

- **Ranking key** = `netSol` (proceeds minus spent over judged positions, unsold valued at zero). `realizedSol` is shown beside it, never used to rank.
- **excludedProfitSol** = the sum of `proceedsSol` of every *excluded* position (transfer-in, sold-before-buy, transferred-out). It is proceeds, not profit: the cost of those positions is unknown. `excludedByReason` gives `{ count, proceedsSol }` per reason; `excludedCount` is the total count.
- **topTradeShare** = (the best closed position's `pnlSol`) / `netSol`, when `netSol > 0`; otherwise `null`. A wallet with `topTradeShare > 0.5` is dropped from the ranked list (reason `top-trade`).
- **truncated** = the saved history is not complete (the read stopped before the wallet's first transaction). `null` when unknown (old stats, or a source that cannot tell).
- **operatorId** = the operator this wallet belongs to (section 2), or `null` when not computed.
- **Eligibility** to be ranked: `closed >= minClosedPositions`, not `botLike`, and `topTradeShare` is `null` or `<= 0.5`. Dropped wallets are counted per reason: `too-few-closed`, `bot`, `top-trade`.

Accounting stays average cost with "unsold valued at zero". That biases against sells that happened outside the read window.

## 2. Operators

An **operator** is a set of wallets treated as one actor. Two wallets are the same operator if either holds:

1. they are in the same funding cluster (`buildClusters` cluster id), or
2. their trade signatures match: they share at least 3 tokens each, the overlap is at least 70% of the smaller token set, and the median gap between their buys of the shared tokens is under 10 seconds.

Merging is transitive. `botLike` wallets are excluded from the operator count. The unit of every count in the verdict is the **operator**, never the wallet.

## 3. Window and split

- **Common window** = one `[from, to]` cut (unix seconds) applied to every wallet on both sides. A wallet whose saved history does not reach `from` (its oldest event is later than `from` and the history is not complete) is dropped from **both** sides and counted.
- **Split time T** = the launch time of the latest pasted mint. Wallets are ranked on events **before** T and scored on events **after** T (the held-out half). Every event lands in exactly one half.

## 4. Verdict

- **Success per operator** = held-out `netSol` above 0 with at least 3 closed positions in the held-out half. An operator's held-out figures are its wallets' combined.
- **Wilson 95% interval**, z = 1.96, on successes out of operators.
- **Control** = early buyers of non-runner tokens from the same period, run through the same cut and split. A control never contains a candidate wallet.
- The verdict is one of, in this order of checking:
  1. `fewer than 10 independent operators` when candidates have fewer than 10 operators;
  2. `control missing or too small` when the control has fewer than 20 operators;
  3. `no better than control` when the candidates' Wilson lower bound is not above the control's success rate;
  4. `passes` otherwise.
- Only `passes` allows the words "good wallets". Anything else is the negative finding.

## 5. Where results live

- `operatorId` is inside each wallet's `wallets.stats` JSON (no new column).
- A run's final `runs.progress` write carries `walletList`: `{ operatorCount, walletsRanked, droppedByReason, status }`, where `status` is `fewer_than_10_operators` or `unproven`. The web run has no control, so it can never say "passes".
- The full verdict (with the control) lives only in the CLI markdown report. Run rows expire; the report file does not.
- No schema change. `lib/migrate.ts` and `supabase/migrations/` stay unchanged.

## 6. Pinned signatures

See `lib/core/walletList.types.ts`, `lib/core/window.ts` (`cutToWindow`, `splitAt`), `lib/core/operators.ts` (`buildOperators`), `lib/core/rank.ts` (`rankRealized`) and `lib/core/verdict.ts` (`wilson`, `walletListVerdict`). These are implemented (no stubs remain). `scripts/realized-report.ts` is the admin CLI that applies sections 3 and 4 to saved histories with no network call; it has no funding graph, so there only the trade signature merges operators.

## 7. Wording

The list shows what a **wallet realized**. It is not follower-executable returns and not advice. The words "followable" and "insider" are not used as labels anywhere in `lib/` or `app/`.
