"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { TraderStats } from "@/lib/core/pnl";
import type { RunnerStats } from "@/lib/core/runners";
import type { OnTokenResult } from "@/lib/pipeline/run";
import { ago, duration, mult, pct, short, sol, usd } from "@/lib/format";
import { Addr, Button, Hint, ShareBar, Signed, Tag } from "../../components/ui";
import { PnlCurve, RunnerHitsChart } from "../../components/charts";
import { tokenLabel, type RunData, type WalletRow } from "./types";

interface Detail {
  stats: TraderStats | null;
  onTokens: OnTokenResult[];
  runner: RunnerStats | null;
}

// One sentence a teammate can act on, built from the numbers below it.
function verdict(w: WalletRow, s: TraderStats | null, r: RunnerStats | null, conviction: number): string {
  if (w.tags.includes("dev")) return "Deployer of one of your tokens.";
  if (w.tags.includes("dev-linked")) return "Funded from the same source as a deployer: likely an insider.";
  if (w.tags.includes("bundle")) return "Part of a bundle: several wallets from one funder buying the same launch.";
  if (!s && !r) return w.historyStatus?.startsWith("skipped") ? "Trade history not read in this run." : "Not checked yet.";
  const parts: string[] = [];
  if (r && r.runners > 0) {
    parts.push(`Caught ${r.runners} runner${r.runners === 1 ? "" : "s"} outside your batch`);
    if (r.medianCapture != null) parts.push(r.medianCapture < 0.25 ? `sells early (keeps ${pct(r.medianCapture)} of the move)` : `keeps ${pct(r.medianCapture)} of the move`);
    if (r.convictionCount > 0) parts.push(`held ${r.convictionCount} past ${conviction}x`);
  } else if (r) parts.push(`No runners in ${r.judged} tokens judged`);
  if (s) parts.push(s.netSol >= 0 ? `up ${sol(s.netSol, 1)} SOL on other tokens` : `down ${sol(-s.netSol, 1)} SOL on other tokens`);
  return parts.join(", ") + ".";
}

export function WalletDrawer({ runId, data, w, onClose, onWatch }: { runId: number; data: RunData; w: WalletRow; onClose: () => void; onWatch: (w: WalletRow) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setDetail(null);
    setFailed(false);
    fetch(`/api/runs/${runId}/wallets/${w.wallet}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setDetail)
      .catch(() => setFailed(true));
  }, [runId, w.wallet]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const s = detail?.stats ?? null;
  const r = detail?.runner ?? null;
  const tokenName = new Map(data.tokens.map((t) => [t.mint, tokenLabel(t)]));
  const cluster = w.clusterId != null ? data.clusters.find((c) => c.id === w.clusterId) : null;

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[1px]" />
      <aside
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Wallet details"
        className="absolute right-0 top-0 h-full w-full max-w-[680px] bg-panel border-l border-line overflow-y-auto scroll-thin shadow-[-20px_0_60px_rgb(0_0_0/0.5)]"
      >
        <div className="sticky top-0 z-10 bg-panel/95 backdrop-blur border-b border-line px-4 sm:px-5 py-3 flex items-center gap-2 sm:gap-3">
          <Addr a={w.wallet} n={8} bot={w.bot} />
          <span className="hidden sm:inline text-faint text-[11.5px] px-1.5 py-px rounded border border-line">{w.role}</span>
          <div className="ml-auto flex gap-2">
            <Button onClick={() => onWatch(w)}>{w.watched ? <span className="text-series-2">★ Starred</span> : "☆ Star"}</Button>
            <Button kind="ghost" onClick={onClose}>
              ✕
            </Button>
          </div>
        </div>

        <div className="p-4 sm:p-5 space-y-6 pb-safe">
          <div>
            <p className="text-[14px] leading-snug">{detail ? verdict(w, s, r, Number(data.run.settings.convictionMultiple ?? 10)) : failed ? "Could not load this wallet." : "Loading…"}</p>
            {w.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2.5">
                {w.tags.map((t) => (
                  <Tag key={t} t={t} />
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Tile label="Runner score" v={w.runnerScore != null ? Math.round(w.runnerScore) : "—"} strong />
            <Tile label="Runners caught" v={r ? `${r.runners}` : "—"} sub={r ? `of ${r.judged} judged` : undefined} />
            <Tile label="Median capture" v={r?.medianCapture != null ? pct(r.medianCapture) : "—"} sub="of each run" />
            <Tile label="Median entry" v={usd(r?.medianEntryMcapUsd)} sub="market cap" />
            <Tile label="Profit score" v={w.score != null ? Math.round(w.score) : "—"} strong />
            <Tile label="Net SOL" v={<Signed v={s?.netSol}>{sol(s?.netSol, 1)}</Signed>} sub="other tokens" />
            <Tile label="Win rate" v={s ? pct(s.winRate) : "—"} sub={s ? `${s.wins}/${s.closed} closed` : undefined} />
            <Tile label="Median hold" v={duration(s?.medianHoldMin)} sub={s?.tradesPerDay != null ? `${s.tradesPerDay.toFixed(1)} trades/day` : undefined} />
          </div>

          {r && (
            <Section title="Runners caught" sub="Tokens outside your batch it bought early that later ran. Your pasted tokens are not included.">
              <RunnerHitsChart
                hits={r.hits.map((h) => ({ mint: h.mint, symbol: h.symbol, entry: h.entryMcapUsd, peak: h.peakMcapUsd, exitMultiple: h.exitMultiple, capture: h.capture, estimated: h.estimated }))}
              />
              {r.hits.length > 0 && (
                <div className="overflow-x-auto mt-3"><table className="w-full min-w-[440px] text-[12.5px]">
                  <thead>
                    <tr className="text-faint text-[11.5px]">
                      <td className="py-1">Token</td>
                      <td>Entry</td>
                      <td>Peak</td>
                      <td>Available</td>
                      <td>Made</td>
                      <td>Captured</td>
                    </tr>
                  </thead>
                  <tbody>
                    {r.hits.slice(0, 12).map((h) => (
                      <tr key={h.mint} className="border-t border-line/70">
                        <td className="py-1.5">
                          <Addr a={h.mint} kind="token" label={h.symbol ? `$${h.symbol}` : undefined} />
                        </td>
                        <td className="num">{usd(h.entryMcapUsd)}</td>
                        <td className="num">
                          {usd(h.peakMcapUsd)}
                          {h.estimated && (
                            <Hint tip="No price history: this is a lower bound (current cap or its own exit).">
                              <span className="text-faint">+</span>
                            </Hint>
                          )}
                        </td>
                        <td className="num text-dim">{mult(h.peakMultiple)}</td>
                        <td className="num">{h.exitMultiple != null ? mult(h.exitMultiple) : <span className="text-faint">holding</span>}</td>
                        <td>
                          <ShareBar v={h.capture} width={40} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </Section>
          )}

          {s && (
            <Section title="Profit over time" sub={`Cumulative SOL from closed trades on other tokens${s.maxDrawdownSol > 0 ? `. Worst drawdown ${sol(s.maxDrawdownSol, 1)} SOL` : ""}.`}>
              <PnlCurve curve={s.pnlCurve ?? []} />
              <div className="text-faint text-[11.5px] mt-2">
                From the last {s.txsRead.toLocaleString()} transactions
                {s.windowStart && s.windowEnd ? `, ${new Date(s.windowStart * 1000).toLocaleDateString()} to ${new Date(s.windowEnd * 1000).toLocaleDateString()}` : ""}.
                {s.excluded > 0 && ` ${s.excluded} positions left out (arrived by transfer, or bought before the window).`}
              </div>
            </Section>
          )}

          {w.buys.length > 0 && (
            <Section title="On your tokens" sub="Shown for context. Not used in either score.">
              <div className="overflow-x-auto"><table className="w-full min-w-[440px] text-[12.5px]">
                <thead>
                  <tr className="text-faint text-[11.5px]">
                    <td className="py-1">Token</td>
                    <td>Rank</td>
                    <td>After launch</td>
                    <td>In</td>
                    <td>Out</td>
                    <td>Result</td>
                  </tr>
                </thead>
                <tbody>
                  {w.buys.map((b) => {
                    const o = detail?.onTokens.find((x) => x.mint === b.mint);
                    return (
                      <tr key={b.mint} className="border-t border-line/70">
                        <td className="py-1.5">
                          <Addr a={b.mint} kind="token" label={tokenName.get(b.mint)} />
                        </td>
                        <td>{b.rank === 0 ? "dev" : `#${b.rank}`}</td>
                        <td className="text-dim">{b.secsAfterCreate != null ? `${b.secsAfterCreate}s` : "—"}</td>
                        <td className="num">{sol(o?.spentSol ?? b.sol)}</td>
                        <td className="num">{o && o.status !== "unknown" ? sol(o.proceedsSol) : "—"}</td>
                        <td>
                          {o && o.status !== "unknown" ? (
                            <span>
                              <Signed v={o.pnlSol}>{mult(o.multiple)}</Signed>{" "}
                              <span className="text-faint">{o.status === "closed" ? "sold" : o.status === "open" ? `${Math.round(o.soldPct * 100)}% sold` : o.status}</span>
                            </span>
                          ) : (
                            <span className="text-faint">not read</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            </Section>
          )}

          {s && s.top.length > 0 && (
            <Section title="Biggest positions on other tokens">
              <div className="overflow-x-auto"><table className="w-full min-w-[440px] text-[12.5px]">
                <thead>
                  <tr className="text-faint text-[11.5px]">
                    <td className="py-1">Token</td>
                    <td>Bought</td>
                    <td>In</td>
                    <td>Out</td>
                    <td>PnL</td>
                    <td>Exit</td>
                    <td>Hold</td>
                  </tr>
                </thead>
                <tbody>
                  {s.top.slice(0, 15).map((p) => (
                    <tr key={p.mint} className="border-t border-line/70">
                      <td className="py-1.5">
                        <Addr a={p.mint} kind="token" />
                      </td>
                      <td className="text-dim">{p.firstBuy ? ago(p.firstBuy * 1000) : "—"}</td>
                      <td className="num">{sol(p.spentSol)}</td>
                      <td className="num">{sol(p.proceedsSol)}</td>
                      <td className="num">
                        <Signed v={p.pnlSol}>{sol(p.pnlSol)}</Signed>
                      </td>
                      <td>{p.status === "open" ? <span className="text-faint">open</span> : mult(p.multiple)}</td>
                      <td className="text-dim">{duration(p.holdMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </Section>
          )}

          <Section title="Identity">
            <Row
              k="First transaction"
              v={w.firstTxTime ? `${new Date(w.firstTxTime * 1000).toLocaleDateString()}${w.firstTxExact ? "" : " or earlier"} (${ago(w.firstTxTime * 1000)})` : "—"}
            />
            <Row
              k="First SOL from"
              v={
                <span className="inline-flex items-center gap-2">
                  <Addr a={w.funder} n={6} />
                  {w.funderService ? <span className="text-faint text-[11.5px]">exchange or app</span> : null}
                </span>
              }
            />
            <Row k="Activity" v={w.txsPerDay != null ? `${w.txsPerDay.toFixed(1)} transactions a day recently` : "—"} />
            {cluster && <Row k="Group" v={<span>#{cluster.id} {cluster.kind}, {cluster.members.length} wallets. {cluster.reason}</span>} />}
          </Section>

          <div className="flex gap-4 text-[12px] pb-4">
            <a className="text-dim hover:text-accent-ink" href={`https://solscan.io/account/${w.wallet}`} target="_blank" rel="noreferrer">
              Solscan ↗
            </a>
            <a className="text-dim hover:text-accent-ink" href={`https://gmgn.ai/sol/address/${w.wallet}`} target="_blank" rel="noreferrer">
              GMGN ↗
            </a>
            <button className="text-dim hover:text-accent-ink" onClick={() => navigator.clipboard.writeText(w.wallet)}>
              Copy address
            </button>
            <span className="ml-auto text-faint mono">{short(w.wallet, 6)}</span>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Tile({ label, v, sub, strong }: { label: string; v: ReactNode; sub?: string; strong?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${strong ? "border-accent/30 bg-accent/[0.06]" : "border-line bg-panel-2/60"}`}>
      <div className="text-faint text-[11px]">{label}</div>
      <div className="mt-0.5 text-[16px] font-semibold num">{v}</div>
      {sub && <div className="text-faint text-[11px]">{sub}</div>}
    </div>
  );
}
function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2.5">
        <div className="text-[12px] uppercase tracking-wider text-dim">{title}</div>
        {sub && <div className="text-faint text-[11.5px] mt-0.5">{sub}</div>}
      </div>
      {children}
    </section>
  );
}
function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-[12.5px]">
      <span className="text-faint w-36 shrink-0">{k}</span>
      <span className="min-w-0">{v}</span>
    </div>
  );
}
