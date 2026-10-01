"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ago, parseAddresses, pct, sol } from "@/lib/format";
import { Addr, Button, Empty, Menu, MenuItem, Panel, ScoreBar, Signed, Tag } from "../components/ui";

interface Entry {
  wallet: string;
  label: string | null;
  note: string | null;
  addedAt: number;
  addedBy: string | null;
  sourceRun: number | null;
  snapshot: {
    runnerScore?: number | null;
    runners?: number | null;
    medianCapture?: number | null;
    score?: number | null;
    netSol?: number | null;
    winRate?: number | null;
    closed?: number | null;
    tags?: string[];
  } | null;
}

export default function WatchlistPage() {
  const [list, setList] = useState<Entry[] | null>(null);
  const [add, setAdd] = useState("");
  const [q, setQ] = useState("");
  const load = () =>
    fetch("/api/watchlist")
      .then((r) => (r.ok ? r.json() : []))
      .then(setList);
  useEffect(() => {
    void load();
  }, []);

  const patch = async (wallet: string, fields: { label?: string; note?: string }) => {
    await fetch("/api/watchlist", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet, ...fields }) });
  };
  const remove = async (wallet: string) => {
    setList((l) => l?.filter((e) => e.wallet !== wallet) ?? null);
    await fetch(`/api/watchlist?wallet=${wallet}`, { method: "DELETE" });
  };
  const toAdd = parseAddresses(add).valid;
  const addMany = async () => {
    for (const w of toAdd) await fetch("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: w }) });
    setAdd("");
    void load();
  };
  const shown = (list ?? []).filter((e) => !q || e.wallet.toLowerCase().includes(q.toLowerCase()) || (e.label ?? "").toLowerCase().includes(q.toLowerCase()) || (e.note ?? "").toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Watchlist</h1>
          <p className="text-dim mt-1 max-w-2xl">Wallets the team starred. Shared by everyone and kept after runs clear. Scores are a snapshot from the run they were starred in.</p>
        </div>
        <div className="ml-auto">
          <Menu label="Export" kind="primary">
            <MenuItem href="/api/watchlist/export?format=csv" sub="For a spreadsheet or wallet tracker">
              CSV
            </MenuItem>
            <MenuItem href="/api/watchlist/export?format=json" sub="For scripts and the watcher">
              JSON
            </MenuItem>
          </Menu>
        </div>
      </div>
      <Panel
        title={`${list?.length ?? 0} wallets`}
        right={
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-10 sm:h-8 w-full sm:w-40 bg-bg border border-line-2 rounded-md px-3 text-[12px] outline-none focus:border-accent/70" />
            <input
              value={add}
              onChange={(e) => setAdd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && toAdd.length && addMany()}
              placeholder="Add wallet addresses"
              className="h-10 sm:h-8 flex-1 sm:flex-none min-w-0 sm:w-64 bg-bg border border-line-2 rounded-md px-3 mono text-[12px] outline-none focus:border-accent/70"
            />
            <Button onClick={addMany} disabled={!toAdd.length}>
              Add{toAdd.length > 1 ? ` ${toAdd.length}` : ""}
            </Button>
          </>
        }
      >
        {!list ? (
          <Empty>Loading…</Empty>
        ) : list.length === 0 ? (
          <Empty title="Nothing starred yet">Open a run and press ☆ next to a wallet you want to follow.</Empty>
        ) : (
          <>
          <ul className="md:hidden divide-y divide-line">
            {shown.map((e) => {
              const s = e.snapshot;
              return (
                <li key={e.wallet} className="px-4 py-3.5 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <Addr a={e.wallet} n={5} bot={(s?.tags ?? []).includes("bot-like")} />
                    <button onClick={() => remove(e.wallet)} className="ml-auto grid place-items-center size-10 -my-2 text-faint" aria-label="Remove">
                      ✕
                    </button>
                  </div>
                  <input
                    defaultValue={e.label ?? ""}
                    onBlur={(ev) => ev.target.value !== (e.label ?? "") && patch(e.wallet, { label: ev.target.value })}
                    placeholder="Name it"
                    className="w-full h-10 bg-bg border border-line rounded-md px-3 outline-none focus:border-accent/70"
                  />
                  <div className="grid grid-cols-4 gap-2 text-[13px]">
                    <div>
                      <div className="text-faint text-[11.5px]">Runner</div>
                      <div className="num font-medium">{s?.runnerScore != null ? Math.round(s.runnerScore) : "—"}</div>
                    </div>
                    <div>
                      <div className="text-faint text-[11.5px]">Runners</div>
                      <div className="num">{s?.runners ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-faint text-[11.5px]">Profit</div>
                      <div className="num">{s?.score != null ? Math.round(s.score) : "—"}</div>
                    </div>
                    <div>
                      <div className="text-faint text-[11.5px]">Net SOL</div>
                      <div className="num">
                        <Signed v={s?.netSol}>{sol(s?.netSol, 1)}</Signed>
                      </div>
                    </div>
                  </div>
                  <input
                    defaultValue={e.note ?? ""}
                    onBlur={(ev) => ev.target.value !== (e.note ?? "") && patch(e.wallet, { note: ev.target.value })}
                    placeholder="Add a note"
                    className="w-full h-10 bg-bg border border-line rounded-md px-3 outline-none focus:border-accent/70"
                  />
                  <div className="text-faint text-[12px]">
                    Added {ago(e.addedAt)}
                    {e.addedBy ? ` by ${e.addedBy}` : ""}
                    {e.sourceRun != null && (
                      <>
                        {" · "}
                        <Link href={`/runs/${e.sourceRun}`} className="text-accent-ink">
                          run #{e.sourceRun}
                        </Link>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="hidden md:block overflow-auto scroll-thin">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr>
                  {["Wallet", "Name", "Runner score", "Runners", "Capture", "Profit score", "Net SOL", "Win", "Tags", "Note", "Added", ""].map((h) => (
                    <th key={h} className="px-3 h-9 text-left font-normal text-[11.5px] text-faint border-b border-line whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const s = e.snapshot;
                  return (
                    <tr key={e.wallet} className="[&>td]:border-b [&>td]:border-line/70 hover:bg-panel-2/50">
                      <td className="px-3 py-2">
                        <Addr a={e.wallet} n={5} bot={(s?.tags ?? []).includes("bot-like")} />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          defaultValue={e.label ?? ""}
                          onBlur={(ev) => ev.target.value !== (e.label ?? "") && patch(e.wallet, { label: ev.target.value })}
                          placeholder="name it"
                          className="bg-transparent border-b border-transparent hover:border-line-2 focus:border-accent outline-none w-28"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <ScoreBar v={s?.runnerScore} width={40} />
                      </td>
                      <td className="px-3 py-2">{s?.runners ?? "—"}</td>
                      <td className="px-3 py-2 text-dim">{pct(s?.medianCapture)}</td>
                      <td className="px-3 py-2">
                        <ScoreBar v={s?.score} width={32} />
                      </td>
                      <td className="px-3 py-2 num">
                        <Signed v={s?.netSol}>{sol(s?.netSol, 1)}</Signed>
                      </td>
                      <td className="px-3 py-2 text-dim">
                        {pct(s?.winRate)}
                        {s?.closed != null && <span className="text-faint"> /{s.closed}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1 max-w-56">
                          {(s?.tags ?? []).map((t) => (
                            <Tag key={t} t={t} />
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          defaultValue={e.note ?? ""}
                          onBlur={(ev) => ev.target.value !== (e.note ?? "") && patch(e.wallet, { note: ev.target.value })}
                          placeholder="add a note"
                          className="bg-transparent border-b border-transparent hover:border-line-2 focus:border-accent outline-none w-44"
                        />
                      </td>
                      <td className="px-3 py-2 text-faint whitespace-nowrap">
                        {ago(e.addedAt)}
                        {e.addedBy && <span className="block text-[11px] truncate max-w-32" title={e.addedBy}>{e.addedBy}</span>}
                        {e.sourceRun != null && (
                          <Link href={`/runs/${e.sourceRun}`} className="block text-[11px] hover:text-accent-ink">
                            run #{e.sourceRun}
                          </Link>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => remove(e.wallet)} className="text-faint hover:text-bad" title="Remove" aria-label="Remove">
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Panel>
    </div>
  );
}
