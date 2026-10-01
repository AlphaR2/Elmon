"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ago, short } from "@/lib/format";
import { Empty, Panel, StatusPill } from "./ui";

interface RunItem {
  id: number;
  createdAt: number;
  mode: string;
  label: string | null;
  inputs: string[];
  status: string;
  progress: { stage?: string; done?: number; total?: number };
  credits: number;
  found: number;
  scored: number;
  runners: number;
  error: string | null;
  expiresAt: number;
}

const STAGE: Record<string, string> = {
  launch: "reading launches",
  candidates: "finding overlap",
  seed: "loading wallets",
  funders: "tracing funders",
  clusters: "grouping",
  history: "checking trades",
  runners: "checking runners",
  finalize: "tagging",
};

function expiresIn(ms: number) {
  const h = Math.max(0, (ms - Date.now()) / 3_600_000);
  return h < 1 ? "clears within the hour" : h < 48 ? `clears in ${Math.round(h)}h` : `clears in ${Math.round(h / 24)}d`;
}

export function RunsList({ limit, title = "Recent runs" }: { limit?: number; title?: string }) {
  const [runs, setRuns] = useState<RunItem[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/runs")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => !stop && (setRuns(d), setErr(false)))
        .catch(() => !stop && setErr(true));
    void load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  const list = runs ? (limit ? runs.slice(0, limit) : runs) : null;
  return (
    <Panel
      title={title}
      sub="Results clear 24 h after you export, or after 7 days"
      right={limit && runs && runs.length > limit ? <Link className="text-dim hover:text-ink text-[12px]" href="/runs">All runs →</Link> : null}
    >
      {!list ? (
        <Empty>{err ? "Could not load runs." : "Loading…"}</Empty>
      ) : list.length === 0 ? (
        <Empty title="No runs yet">Paste a few tokens that ran and press Find wallets.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((r) => (
            <li key={r.id}>
              <Link href={`/runs/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-panel-2/70 transition">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">
                      {r.label || (
                        <span className="mono text-dim font-normal">
                          {r.inputs.slice(0, 2).map((a) => short(a)).join("  ")}
                          {r.inputs.length > 2 ? `  +${r.inputs.length - 2}` : ""}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="text-[11.5px] text-faint mt-0.5 truncate">
                    {r.inputs.length} {r.mode} · {ago(r.createdAt)}
                    {r.status === "done" && (
                      <>
                        {" "}
                        · <span className="text-dim">{r.runners} runner-catchers</span> · {r.scored} scored
                      </>
                    )}
                    {r.status === "running" && r.progress.stage && ` · ${STAGE[r.progress.stage] ?? r.progress.stage}`}
                    {r.status === "done" && ` · ${expiresIn(r.expiresAt)}`}
                  </div>
                </div>
                <StatusPill status={r.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
