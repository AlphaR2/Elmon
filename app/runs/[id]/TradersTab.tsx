"use client";
import { useMemo, useState } from "react";
import { INSIDER_TAGS } from "@/lib/core/tags";
import { duration, mult, pct, short, sol, usd } from "@/lib/format";
import { Addr, BotBadge, Chip, Empty, Hint, KindBadge, Panel, ScoreBar, ShareBar, Signed, Tag, Th, TokenChip } from "../../components/ui";
import { RunnerProfitScatter, type TraderPoint } from "../../components/charts";
import { isTrader, type RunData, type WalletRow } from "./types";

type Sort = { key: string; dir: 1 | -1 };

function onTokensSummary(w: WalletRow) {
  const known = w.onTokens.filter((o) => o.status !== "unknown" && o.status !== "excluded");
  if (known.length === 0) return null;
  const spent = known.reduce((a, o) => a + o.spentSol, 0);
  const got = known.reduce((a, o) => a + o.proceedsSol, 0);
  return { n: known.length, closed: known.filter((o) => o.status === "closed").length, pnl: got - spent, multiple: spent > 0 ? got / spent : null };
}

// Default order is the team's: runners caught first, profit second.
const val = (w: WalletRow, key: string): number => {
  const s = w.stats;
  const r = w.runner;
  switch (key) {
    case "runner": return (w.runnerScore ?? -1) * 1000 + (w.score ?? -1);
    case "runners": return (r?.weighted ?? -1) * 1000 + (r?.runners ?? 0);
    case "capture": return r?.medianCapture ?? -1;
    case "entry": return -(r?.medianEntryMcapUsd ?? 1e12);
    case "score": return w.score ?? -1;
    case "net": return s?.netSol ?? -1e9;
    case "win": return s?.winRate ?? -1;
    case "hold": return -(s?.medianHoldMin ?? 1e9);
    case "hits": return w.weightedHits * 100 + w.hits;
    case "yours": return onTokensSummary(w)?.pnl ?? -1e9;
    default: return 0;
  }
};

// Phone layout of one trader: the same numbers as the table row, stacked and labelled.
function TraderCard({
  w,
  tokensN,
  symbolOf,
  onOpen,
  onWatch,
  pending,
}: {
  w: WalletRow;
  tokensN: number;
  symbolOf: Map<string, string | null>;
  onOpen: (w: WalletRow) => void;
  onWatch: (w: WalletRow) => void;
  pending: boolean;
}) {
  const s = w.stats;
  const r = w.runner;
  const stat = (label: string, value: React.ReactNode) => (
    <div className="min-w-0">
      <div className="text-faint text-[11.5px]">{label}</div>
      <div className="mt-0.5 num">{value}</div>
    </div>
  );
  return (
    <li>
      <div role="button" tabIndex={0} onClick={() => onOpen(w)} onKeyDown={(e) => e.key === "Enter" && onOpen(w)} className="px-4 py-3.5 active:bg-panel-2/70">
        <div className="flex items-center gap-2">
          <Addr a={w.wallet} n={5} bot={w.bot} />
          <button
            aria-label={w.watched ? "Unstar" : "Star"}
            onClick={(e) => {
              e.stopPropagation();
              onWatch(w);
            }}
            className={`ml-auto grid place-items-center size-10 -my-2 text-[19px] ${w.watched ? "text-series-2" : "text-faint"}`}
          >
            {w.watched ? "★" : "☆"}
          </button>
        </div>
        <div className="flex items-end gap-3 mt-2">
          <div>
            <div className="text-faint text-[11.5px]">Runner score</div>
            <div className="text-[26px] font-semibold leading-8 num">{pending ? "…" : w.runnerScore != null ? Math.round(w.runnerScore) : "—"}</div>
          </div>
          <div className="flex-1 pb-2">
            {w.runnerScore != null && (
              <div className="h-1.5 rounded-full bg-line overflow-hidden">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, Math.min(100, w.runnerScore))}%` }} />
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 mt-2.5">
          {stat("Runners", r ? r.runners : "—")}
          {stat("Capture", pct(r?.medianCapture))}
          {stat("Profit", w.score != null ? Math.round(w.score) : "—")}
          {stat("Net SOL", <Signed v={s?.netSol}>{sol(s?.netSol, 1)}</Signed>)}
        </div>
        {w.runnerHits.length > 0 && (
          <div className="mt-3">
            <div className="text-faint text-[11.5px] mb-1">Runners caught</div>
            <div className="flex flex-wrap gap-1.5">
              {w.runnerHits.slice(0, 4).map((h) => (
                <TokenChip key={h.mint} mint={h.mint} symbol={h.symbol} value={`${Math.round(h.peakMultiple)}x`} />
              ))}
            </div>
          </div>
        )}
        {w.buys.length > 0 && (
          <div className="mt-2.5">
            <div className="text-faint text-[11.5px] mb-1">
              Early in {w.hits}/{tokensN} of yours
            </div>
            <div className="flex flex-wrap gap-1.5">
              {w.buys.slice(0, 5).map((b) => (
                <TokenChip key={b.mint} mint={b.mint} symbol={symbolOf.get(b.mint)} value={b.rank === 0 ? "dev" : `#${b.rank}`} />
              ))}
            </div>
          </div>
        )}
        {w.tags.filter((t) => t !== "bot-like").length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2.5">
            {w.tags
              .filter((t) => t !== "bot-like")
              .map((t) => (
                <Tag key={t} t={t} />
              ))}
          </div>
        )}
      </div>
    </li>
  );
}

export function TradersTab({ data, onOpen, onWatch }: { data: RunData; onOpen: (w: WalletRow) => void; onWatch: (w: WalletRow) => void }) {
  const isTokens = data.run.mode === "tokens";
  const [hideInsiders, setHideInsiders] = useState(true);
  // Bots are shown (many good traders use them) and marked with a B; hiding them is opt-in.
  const [hideBots, setHideBots] = useState(false);
  const [onlyRunners, setOnlyRunners] = useState(false);
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [minHits, setMinHits] = useState(0);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "runner", dir: -1 });

  const all = useMemo(() => data.wallets.filter(isTrader), [data.wallets]);
  const maxHits = Math.max(0, ...all.map((w) => w.hits));
  const rows = useMemo(() => {
    let r = all;
    if (hideInsiders) r = r.filter((w) => !w.tags.some((t) => INSIDER_TAGS.has(t)));
    if (hideBots) r = r.filter((w) => !w.tags.includes("bot-like"));
    if (onlyRunners) r = r.filter((w) => (w.runner?.runners ?? 0) > 0);
    if (onlyStarred) r = r.filter((w) => w.watched);
    if (minHits) r = r.filter((w) => w.hits >= minHits);
    if (q) r = r.filter((w) => w.wallet.toLowerCase().includes(q.trim().toLowerCase()));
    return [...r].sort((a, b) => (val(a, sort.key) - val(b, sort.key)) * sort.dir);
  }, [all, hideInsiders, hideBots, onlyRunners, onlyStarred, minHits, q, sort]);
  const hidden = all.length - rows.length;
  const tokensN = data.tokens.filter((t) => t.status === "ok").length;
  const symbolOf = useMemo(() => new Map(data.tokens.map((t) => [t.mint, t.symbol])), [data.tokens]);

  const points: TraderPoint[] = rows
    .filter((w) => w.runnerScore != null && w.score != null)
    .map((w) => ({ wallet: w.wallet, x: w.score!, y: w.runnerScore!, runners: w.runner?.runners ?? 0, netSol: w.stats?.netSol ?? null, starred: w.watched }));
  const unplotted = rows.length - points.length;
  const top = rows
    .filter((w) => w.runnerScore != null)
    .sort((a, b) => val(b, "runner") - val(a, "runner"))
    .slice(0, 5);
  const byWallet = new Map(all.map((w) => [w.wallet, w]));

  const stillWorking = ["queued", "running"].includes(data.run.status) && !data.run.stagesDone.includes("runners");

  return (
    <div className="space-y-4">
      {all.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Panel
            title="Runners against profit"
            sub="Up: catches tokens early before they run. Right: makes money doing it. Your pasted tokens are left out of both."
          >
            <div className="p-4">
              {points.length ? (
                <RunnerProfitScatter points={points} onPick={(w) => byWallet.get(w) && onOpen(byWallet.get(w)!)} />
              ) : (
                <Empty title={stillWorking ? "Scores are on the way" : "Nothing to plot yet"}>
                  {stillWorking ? "Each wallet appears here once its trades and runners are checked." : "No wallet has both scores. Try a deeper preset, or paste more tokens."}
                </Empty>
              )}
              {points.length > 0 && unplotted > 0 && <div className="text-faint text-[11.5px] mt-2">{unplotted} wallets not plotted: missing a runner or profit score.</div>}
            </div>
          </Panel>
          <Panel title="Top picks" sub="Highest runner score, then profit">
            {top.length === 0 ? (
              <Empty>{stillWorking ? "Checking wallets…" : "No scored wallets."}</Empty>
            ) : (
              <ol className="divide-y divide-line">
                {top.map((w, i) => (
                  <li key={w.wallet}>
                    <button onClick={() => onOpen(w)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-panel-2/70">
                      <span className="text-faint w-3 text-[12px]">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 mono text-[12.5px]">
                          <KindBadge kind="account" />
                          {w.bot && <BotBadge />}
                          {short(w.wallet, 5)}
                        </div>
                        <div className="text-faint text-[11.5px] mt-0.5">
                          {w.runner?.runners ?? 0} runners · capture {w.runner?.medianCapture != null ? pct(w.runner.medianCapture) : "—"} · {sol(w.stats?.netSol, 1)} SOL
                        </div>
                        {w.runnerHits.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {w.runnerHits.slice(0, 3).map((h) => (
                              <TokenChip key={h.mint} mint={h.mint} symbol={h.symbol} value={`${Math.round(h.peakMultiple)}x`} />
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="text-[15px] font-semibold num">{Math.round(w.runnerScore!)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      )}

      <Panel
        title={
          <span>
            Traders <span className="text-faint font-normal text-[12px] ml-1.5">{rows.length} shown</span>
          </span>
        }
        right={
          <>
            <Chip on={hideInsiders} onClick={() => setHideInsiders(!hideInsiders)} title="Deployers, deployer-linked wallets and bundles">
              hide insiders
            </Chip>
            <Chip on={hideBots} onClick={() => setHideBots(!hideBots)}>hide bots</Chip>
            <Chip on={onlyRunners} onClick={() => setOnlyRunners(!onlyRunners)}>caught a runner</Chip>
            <Chip on={onlyStarred} onClick={() => setOnlyStarred(!onlyStarred)}>★ starred</Chip>
            {isTokens && maxHits > 1 && (
              <select
                value={minHits}
                onChange={(e) => setMinHits(Number(e.target.value))}
                className="h-7 bg-bg border border-line-2 rounded-full px-2 text-[12px] text-dim"
                aria-label="Minimum overlap"
              >
                <option value={0}>any overlap</option>
                {Array.from({ length: maxHits - 1 }, (_, i) => i + 2).map((n) => (
                  <option key={n} value={n}>
                    early in {n}+ of {tokensN}
                  </option>
                ))}
              </select>
            )}
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search wallet"
              className="h-7 w-36 bg-bg border border-line-2 rounded-full px-3 text-[12px] outline-none focus:border-accent/70"
            />
          </>
        }
      >
        {rows.length === 0 ? (
          <Empty title={all.length === 0 ? (isTokens ? "No overlapping wallets yet" : "No wallets yet") : "Everything is filtered out"}>
            {all.length === 0
              ? isTokens
                ? stillWorking
                  ? "Still reading launches."
                  : "No wallet was early in enough of these tokens. Paste more tokens, ideally from the same period or theme."
                : "Waiting for the worker."
              : `All ${all.length} wallets are hidden by the filters above.`}
          </Empty>
        ) : (
          <>
          {/* Phones: one card per wallet instead of a 14-column table */}
          <ul className="md:hidden divide-y divide-line">
            {rows.map((w) => (
              <TraderCard key={w.wallet} w={w} tokensN={tokensN} symbolOf={symbolOf} onOpen={onOpen} onWatch={onWatch} pending={w.historyStatus == null && stillWorking} />
            ))}
          </ul>
          <div className="hidden md:block overflow-auto scroll-thin max-h-[72vh]">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr>
                  <Th className="w-8"> </Th>
                  <Th>Wallet</Th>
                  <Th sortKey="runner" sort={sort} setSort={setSort} tip="0 to 100. Mostly how many runners it caught (bigger runners count more), plus hit rate, holding through the run, and how early it gets in.">
                    Runner score
                  </Th>
                  <Th sortKey="runners" sort={sort} setSort={setSort} tip="Other tokens it bought at or under $300k that later went 5x and past $1M. Selling early still counts.">
                    Runners
                  </Th>
                  <Th tip="The runners behind the count: its biggest ones outside your batch, with how far each ran from its entry. Click one for its chart.">Runner tokens</Th>
                  <Th sortKey="capture" sort={sort} setSort={setSort} tip="Median share of each run it actually took (its exit multiple against the token's peak multiple). Low = sells early.">
                    Capture
                  </Th>
                  <Th sortKey="entry" sort={sort} setSort={setSort} tip="Median market cap when it bought its runners.">
                    Entry
                  </Th>
                  <Th sortKey="score" sort={sort} setSort={setSort} tip="0 to 100: 50% net profit, 30% win rate, 20% median exit, shrunk toward 50 with few trades.">
                    Profit score
                  </Th>
                  <Th sortKey="net" sort={sort} setSort={setSort} tip="SOL out minus SOL in on other tokens. Unsold bags count as zero.">
                    Net SOL
                  </Th>
                  <Th tip="Its single most profitable position on other tokens.">Best trade</Th>
                  <Th sortKey="win" sort={sort} setSort={setSort} tip="Closed positions that made money">
                    Win
                  </Th>
                  <Th sortKey="hold" sort={sort} setSort={setSort} tip="Median time from first buy to last sell">
                    Hold
                  </Th>
                  {isTokens && (
                    <Th sortKey="hits" sort={sort} setSort={setSort} tip="Which of your tokens it was early in, and its buyer rank on each (#1 = first buyer)">
                      Early in
                    </Th>
                  )}
                  {isTokens && (
                    <Th sortKey="yours" sort={sort} setSort={setSort} tip="What it made on your pasted tokens. Shown, not scored.">
                      On yours
                    </Th>
                  )}
                  <Th>Tags</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const s = w.stats;
                  const r = w.runner;
                  const y = onTokensSummary(w);
                  const pending = w.historyStatus == null && stillWorking;
                  return (
                    <tr key={w.wallet} onClick={() => onOpen(w)} className="group hover:bg-panel-2/70 cursor-pointer [&>td]:border-b [&>td]:border-line/70 [&>td]:whitespace-nowrap">
                      <td className="px-3 py-2">
                        <button
                          title={w.watched ? "Unstar" : "Star (adds to the team watchlist)"}
                          aria-label={w.watched ? "Unstar" : "Star"}
                          onClick={(e) => {
                            e.stopPropagation();
                            onWatch(w);
                          }}
                          className={`text-[15px] ${w.watched ? "text-series-2" : "text-faint hover:text-series-2"}`}
                        >
                          {w.watched ? "★" : "☆"}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <Addr a={w.wallet} n={5} bot={w.bot} />
                      </td>
                      <td className="px-3 py-2">
                        {pending ? (
                          <span className="text-faint">checking…</span>
                        ) : (
                          <ScoreBar v={w.runnerScore} hint={w.historyStatus?.startsWith("skipped") ? "skipped" : w.historyStatus === "done" ? "too few" : "—"} />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r ? (
                          <Hint tip={`${r.runners} of ${r.judged} tokens judged${r.unknown ? `, ${r.unknown} unknown` : ""}. Weighted ${r.weighted}.${r.biggestPeakUsd ? ` Biggest peak ${usd(r.biggestPeakUsd)}.` : ""}`}>
                            <span className={r.runners ? "font-medium" : "text-faint"}>
                              {r.runners}
                              {r.convictionCount > 0 && <span className="text-[#5fd1a6] ml-1">◆{r.convictionCount}</span>}
                            </span>
                          </Hint>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {w.runnerHits.length ? (
                          <div className="flex items-center gap-1">
                            {w.runnerHits.slice(0, 3).map((h) => (
                              <TokenChip
                                key={h.mint}
                                mint={h.mint}
                                symbol={h.symbol}
                                value={`${Math.round(h.peakMultiple)}x`}
                                tip={`Bought at ${usd(h.entryMcapUsd)}, peaked at ${usd(h.peakMcapUsd)}${h.estimated ? " (lower bound)" : ""}. ${h.exitMultiple != null ? `It made ${mult(h.exitMultiple)}` : "Still holding"}${h.capture != null ? `, ${pct(h.capture)} of the run` : ""}.`}
                              />
                            ))}
                            {(r?.runners ?? 0) > 3 && <span className="text-faint text-[11px]">+{(r?.runners ?? 0) - 3}</span>}
                          </div>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <ShareBar v={r?.medianCapture} />
                      </td>
                      <td className="px-3 py-2 text-dim">{usd(r?.medianEntryMcapUsd)}</td>
                      <td className="px-3 py-2">
                        <ScoreBar v={w.score} width={40} hint={s ? "too few" : "—"} />
                      </td>
                      <td className="px-3 py-2 num">
                        <Signed v={s?.netSol}>{sol(s?.netSol, 1)}</Signed>
                      </td>
                      <td className="px-3 py-2">
                        {w.best ? (
                          <TokenChip
                            mint={w.best.mint}
                            symbol={w.best.symbol}
                            value={<span className="text-good">+{sol(w.best.pnlSol, 1)}</span>}
                            tip={`Made ${sol(w.best.pnlSol, 2)} SOL on this token${w.best.multiple != null ? ` (${mult(w.best.multiple)})` : ""}.`}
                          />
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-dim">
                        {pct(s?.winRate)}
                        {s?.closed ? <span className="text-faint"> /{s.closed}</span> : null}
                      </td>
                      <td className="px-3 py-2 text-dim">{duration(s?.medianHoldMin)}</td>
                      {isTokens && (
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            {w.buys.slice(0, 4).map((b) => (
                              <TokenChip
                                key={b.mint}
                                mint={b.mint}
                                symbol={symbolOf.get(b.mint)}
                                value={b.rank === 0 ? "dev" : `#${b.rank}`}
                                tip={`Buyer #${b.rank} on this token, ${b.secsAfterCreate ?? "?"}s after launch, ${sol(b.sol)} SOL${b.sameSlot ? ", in the creation slot" : ""}.`}
                              />
                            ))}
                            {w.buys.length > 4 && <span className="text-faint text-[11px]">+{w.buys.length - 4}</span>}
                            <span className="text-faint text-[11px] ml-0.5">{w.hits}/{tokensN}</span>
                          </div>
                        </td>
                      )}
                      {isTokens && (
                        <td className="px-3 py-2 num">
                          {y ? (
                            <Hint tip={`${y.closed} of ${y.n} sold out`}>
                              <span>
                                <Signed v={y.pnl}>{sol(y.pnl, 1)}</Signed> <span className="text-faint">{mult(y.multiple)}</span>
                              </span>
                            </Hint>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1 min-w-48 max-w-64 whitespace-normal">
                          {w.tags
                            .filter((t) => t !== "bot-like")
                            .map((t) => (
                              <Tag key={t} t={t} />
                            ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
        {hidden > 0 && rows.length > 0 && <div className="px-4 py-2 text-faint text-[11.5px] border-t border-line">{hidden} hidden by filters</div>}
      </Panel>
    </div>
  );
}
