"use client";
import { useMemo, useState } from "react";
import { Addr, Empty, Hint, Panel, Tag } from "../../components/ui";
import { tokenLabel, type RunData, type WalletRow } from "./types";

// Sequential blue ramp (one hue; on the dark surface brighter = earlier). Steps from the validated ramp.
const RAMP = ["#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef"];
const rampFor = (rank: number, n: number) => RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor((1 - Math.min(1, rank / n)) * RAMP.length)))];
const inkFor = (bg: string) => (RAMP.indexOf(bg) >= 5 ? "#0b0c0e" : "#eceef1");

// Wallet x token grid. Each cell is the wallet's buyer rank on that token.
export function MatrixTab({ data, onOpen }: { data: RunData; onOpen: (w: WalletRow) => void }) {
  const [minHits, setMinHits] = useState(2);
  const tokens = data.tokens.filter((t) => t.status === "ok");
  const earlyN = Number(data.run.settings.earlyBuyers ?? 100);
  const avg = (w: WalletRow) => (w.buys.length ? w.buys.reduce((a, b) => a + b.rank, 0) / w.buys.length : 1e9);
  const rows = useMemo(
    () =>
      data.wallets
        .filter((w) => w.hits >= minHits)
        .sort((a, b) => b.hits - a.hits || avg(a) - avg(b))
        .slice(0, 400),
    [data.wallets, minHits],
  );
  const maxHits = Math.max(2, ...data.wallets.map((w) => w.hits));
  return (
    <Panel
      title="Who bought early in what"
      sub="Each cell is the wallet's buyer rank on that token (#1 = first buyer). Brighter is earlier; ● is a buy in the creation slot."
      right={
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[11px] text-faint" aria-label="Rank scale">
            later
            <span className="flex">
              {RAMP.map((c) => (
                <span key={c} className="w-3 h-2.5 first:rounded-l last:rounded-r" style={{ background: c }} />
              ))}
            </span>
            earlier
          </div>
          <select value={minHits} onChange={(e) => setMinHits(Number(e.target.value))} className="h-7 bg-bg border border-line-2 rounded-full px-2 text-[12px] text-dim">
            {Array.from({ length: maxHits }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                early in {n}+ tokens
              </option>
            ))}
          </select>
        </div>
      }
    >
      {rows.length === 0 ? (
        <Empty title={`No wallet was early in ${minHits}+ tokens`}>Lower the filter, or paste more tokens from the same period.</Empty>
      ) : (
        <div className="overflow-auto scroll-thin max-h-[72vh]">
          <table className="w-full text-[12px]">
            <thead>
              <tr>
                <th className="px-4 h-11 text-left font-normal text-[11.5px] text-faint border-b border-line w-56 sticky left-0 z-[3] bg-panel">Wallet</th>
                {tokens.map((t) => (
                  <th key={t.mint} className="px-1 h-11 font-normal border-b border-line text-center min-w-[84px]">
                    <Hint tip={`${t.name ?? t.mint}. ${t.buyers ?? "?"} early buyers read.`}>
                      <a
                        href={`https://dexscreener.com/solana/${t.mint}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex flex-col items-center leading-tight hover:text-accent-ink"
                      >
                        <span className="text-[#7fdcb8] text-[12px]">{tokenLabel(t)}</span>
                        <span className="text-faint text-[10.5px]">{t.buyers ?? "?"} buyers</span>
                      </a>
                    </Hint>
                  </th>
                ))}
                <th className="px-3 h-11 text-center font-normal text-[11.5px] text-faint border-b border-line w-20">Early in</th>
                <th className="px-3 h-11 text-left font-normal text-[11.5px] text-faint border-b border-line">Tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const by = new Map(w.buys.map((b) => [b.mint, b]));
                return (
                  <tr key={w.wallet} className="hover:bg-panel-2/70 cursor-pointer [&>td]:border-b [&>td]:border-line/50" onClick={() => onOpen(w)}>
                    <td className="px-4 py-1.5 whitespace-nowrap sticky left-0 z-[1] bg-panel">
                      <Addr a={w.wallet} n={5} bot={w.bot} />
                    </td>
                    {tokens.map((t) => {
                      const b = by.get(t.mint);
                      if (!b)
                        return (
                          <td key={t.mint} className="px-1 py-1 text-center text-line-2">
                            ·
                          </td>
                        );
                      const bg = b.rank === 0 ? "#d95926" : rampFor(b.rank, earlyN);
                      return (
                        <td key={t.mint} className="px-1 py-1">
                          <Hint tip={`${tokenLabel(t)}: buyer #${b.rank}, ${b.secsAfterCreate ?? "?"}s after launch, ${b.sol.toFixed(2)} SOL${b.sameSlot ? ", in the creation slot" : ""}`} className="w-full">
                            <span
                              className="block w-full rounded-[4px] py-1 text-center num font-medium"
                              style={{ background: bg, color: b.rank === 0 ? "#fff" : inkFor(bg) }}
                            >
                              {b.rank === 0 ? "dev" : `#${b.rank}`}
                              {b.sameSlot && b.rank !== 0 ? " ●" : ""}
                            </span>
                          </Hint>
                        </td>
                      );
                    })}
                    <td className="px-3 py-1.5 text-center num">
                      {w.hits}
                      <span className="text-faint">/{tokens.length}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {w.tags
                          .filter((t) => t !== "bot-like")
                          .slice(0, 4)
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
      )}
    </Panel>
  );
}
