"use client";
import { ago, usd } from "@/lib/format";
import { Addr, Button, Hint, Panel } from "../../components/ui";
import { Bars } from "../../components/charts";
import { tokenLabel, type RunData } from "./types";

export function TokensTab({ data, onScan, live }: { data: RunData; onScan: (mint: string) => void; live: boolean }) {
  const scanned = new Set(data.run.scanMints);
  const withPeak = data.tokens.filter((t) => t.status === "ok");
  return (
    <div className="space-y-4">
      {withPeak.some((t) => t.peakUsd != null) && (
        <Panel title="How big each token got" sub="All-time peak market cap. Bigger runners count more when a wallet caught them early.">
          <div className="p-4">
            <Bars
              rows={withPeak
                .slice()
                .sort((a, b) => (b.peakUsd ?? 0) - (a.peakUsd ?? 0))
                .map((t) => ({ key: t.mint, label: tokenLabel(t), value: t.peakUsd, note: t.weight != null ? `weight ${t.weight.toFixed(1)}` : undefined }))}
              format={usd}
            />
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.tokens.map((t) => {
          const ok = t.status === "ok";
          return (
            <div key={t.mint} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">
                    {t.name ?? <span className="text-faint">Unknown token</span>} {t.symbol && <span className="text-dim font-normal">${t.symbol}</span>}
                  </div>
                  <Addr a={t.mint} kind="token" />
                </div>
                <span
                  className={`ml-auto text-[11px] px-1.5 py-px rounded border ${ok ? "text-good border-good/30" : t.status === "skipped" ? "text-warn border-warn/30" : "text-bad border-bad/30"}`}
                >
                  {t.status}
                </span>
              </div>
              {t.note && <div className="text-faint text-[11.5px] mt-1">{t.note}</div>}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-3 text-[12px]">
                <dt className="text-faint">Launched</dt>
                <dd>{t.createdAt ? ago(t.createdAt * 1000) : "—"}</dd>
                <dt className="text-faint">Launchpad</dt>
                <dd>{t.launchpad ?? "other"}</dd>
                <dt className="text-faint">Peak</dt>
                <dd className="num">{usd(t.peakUsd)}</dd>
                <dt className="text-faint">Now</dt>
                <dd className="num">{usd(t.market?.marketCap)}</dd>
                <dt className="text-faint">Early buyers</dt>
                <dd className="num">
                  {t.buyers ?? "—"}
                  {t.launchTxs != null && <span className="text-faint"> from {t.launchTxs} txs</span>}
                </dd>
                <dt className="text-faint">Deployer</dt>
                <dd>
                  <Addr a={t.deployer} />
                </dd>
              </dl>
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line">
                {ok && (
                  <Hint tip={scanned.has(t.mint) ? "Buyers already traced" : live ? "Available when the run finishes" : "Trace who funded every early buyer, to find bundles and deployer-linked wallets"} left>
                    <Button size="sm" disabled={scanned.has(t.mint) || live} onClick={() => onScan(t.mint)}>
                      {scanned.has(t.mint) ? "✓ Insiders scanned" : "Scan insiders"}
                    </Button>
                  </Hint>
                )}
                {t.market?.url && (
                  <a href={t.market.url} target="_blank" rel="noreferrer" className="ml-auto text-dim hover:text-accent-ink text-[12px]">
                    Chart ↗
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
