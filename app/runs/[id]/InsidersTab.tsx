"use client";
import { useMemo } from "react";
import { Addr, Button, Empty, Hint, Panel, Tag } from "../../components/ui";
import { tokenLabel, type RunData, type WalletRow } from "./types";

const KIND_STYLE: Record<string, string> = {
  "dev-linked": "text-bad border-bad/40 bg-bad/10",
  bundle: "text-violet border-violet/40 bg-violet/10",
  "shared-funder": "text-dim border-line-2 bg-panel-2",
};
const KIND_ORDER: Record<string, number> = { "dev-linked": 0, bundle: 1, "shared-funder": 2 };
const KIND_HELP: Record<string, string> = {
  "dev-linked": "Funded from the same source as a deployer, or by the deployer itself.",
  bundle: "3+ wallets from one funder that bought the same launch early.",
  "shared-funder": "Got first SOL from the same source. Could be one operator, or just friends.",
};

export function InsidersTab({ data, onOpen, onScan, live }: { data: RunData; onOpen: (w: WalletRow) => void; onScan: (mint: string) => void; live: boolean }) {
  const byWallet = useMemo(() => new Map(data.wallets.map((w) => [w.wallet, w])), [data.wallets]);
  const tokenName = useMemo(() => new Map(data.tokens.map((t) => [t.mint, tokenLabel(t)])), [data.tokens]);
  const clusters = [...data.clusters].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.members.length - a.members.length);
  const okTokens = data.tokens.filter((t) => t.status === "ok");
  const scanned = new Set(data.run.scanMints);
  const isTokens = data.run.mode === "tokens";

  return (
    <div className="space-y-4">
      {isTokens && okTokens.length > 0 && (
        <Panel
          title="Scan a launch for insiders"
          sub="Traces who funded every early buyer of one token, to catch bundles and deployer-linked wallets. Costs credits only for buyers not traced before."
        >
          <div className="p-4 flex flex-wrap gap-2">
            {okTokens.map((t) => {
              const done = scanned.has(t.mint);
              return (
                <Hint key={t.mint} tip={done ? "Scanned" : live ? "Available when the run finishes" : `Trace the ${t.buyers ?? "early"} buyers of ${tokenLabel(t)}`}>
                  <Button size="sm" disabled={done || live} onClick={() => onScan(t.mint)}>
                    {done ? "✓ " : ""}
                    {tokenLabel(t)}
                  </Button>
                </Hint>
              );
            })}
          </div>
        </Panel>
      )}

      {isTokens && (
        <Panel title="Deployers">
          <div className="divide-y divide-line">
            {data.tokens
              .filter((t) => t.deployer)
              .map((t) => {
                const d = byWallet.get(t.deployer!);
                const cluster = d?.clusterId != null ? data.clusters.find((c) => c.id === d.clusterId) : null;
                return (
                  <div key={t.mint} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                    <span className="w-24 truncate font-medium">{tokenName.get(t.mint)}</span>
                    <Addr a={t.deployer} n={5} />
                    <span className="text-faint text-[12px] inline-flex items-center gap-1">
                      funded by <Addr a={d?.funder} />
                      {d?.funderService ? " (exchange or app)" : ""}
                    </span>
                    <span className="ml-auto text-[12px]">
                      {cluster ? (
                        <span className="text-bad">{cluster.members.length - 1} linked wallets</span>
                      ) : (
                        <span className="text-faint">no linked wallets found{scanned.has(t.mint) ? "" : " (not scanned)"}</span>
                      )}
                    </span>
                  </div>
                );
              })}
          </div>
        </Panel>
      )}

      {clusters.length === 0 ? (
        <Panel>
          <Empty title="No wallet groups yet">
            {isTokens ? "Groups come from funder data. Scan a launch above to trace its buyers." : "None of these wallets share a funder."}
          </Empty>
        </Panel>
      ) : (
        clusters.map((c) => (
          <Panel
            key={c.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <Hint tip={KIND_HELP[c.kind]}>
                  <span className={`px-2 py-0.5 rounded border text-[11px] ${KIND_STYLE[c.kind]}`}>{c.kind}</span>
                </Hint>
                <span>Group {c.id}</span>
                <span className="text-faint font-normal text-[12px]">{c.reason}</span>
              </span>
            }
            right={
              <span className="text-[12px] text-faint inline-flex flex-wrap items-center gap-2">
                funders
                {c.funders.slice(0, 3).map((f) => (
                  <Addr key={f} a={f} />
                ))}
                {c.funders.length > 3 ? ` +${c.funders.length - 3}` : ""}
              </span>
            }
          >
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-[12.5px]">
                <tbody>
                  {c.members.map((m) => {
                    const w = byWallet.get(m);
                    return (
                      <tr key={m} className="hover:bg-panel-2/70 cursor-pointer [&>td]:border-b [&>td]:border-line/60" onClick={() => w && onOpen(w)}>
                        <td className="px-4 py-2 w-52">
                          <Addr a={m} n={5} bot={w?.bot} />
                        </td>
                        <td className="px-3 py-2 text-faint w-24">{w?.role}</td>
                        <td className="px-3 py-2">
                          {w?.buys.map((b) => (
                            <span key={b.mint} className="mr-3 whitespace-nowrap" title={`${b.secsAfterCreate ?? "?"}s after creation, ${b.sol.toFixed(2)} SOL`}>
                              {tokenName.get(b.mint)} <span className="text-faint">#{b.rank}</span>
                              {b.sameSlot && <span className="text-warn"> ●</span>}
                            </span>
                          ))}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1 justify-end">
                            {w?.tags.map((t) => (
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
          </Panel>
        ))
      )}
    </div>
  );
}
