"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ago, short } from "@/lib/format";
import { INSIDER_TAGS } from "@/lib/core/tags";
import { Button, Hint, KindBadge, Menu, MenuItem, Panel, Stat, StatusPill } from "../../components/ui";
import { isTrader, type RunData, type WalletRow } from "./types";
import { TradersTab } from "./TradersTab";
import { InsidersTab } from "./InsidersTab";
import { MatrixTab } from "./MatrixTab";
import { TokensTab } from "./TokensTab";
import { LogTab } from "./LogTab";
import { WalletDrawer } from "./WalletDrawer";
import { useMe } from "../../components/Shell";
import { RunPageSkeleton } from "../../components/skeletons";

const STAGES: Record<string, { label: string; tip: string }> = {
  launch: { label: "Launches", tip: "Reading each token's first trades" },
  candidates: { label: "Overlap", tip: "Keeping wallets early in several tokens" },
  seed: { label: "Wallets", tip: "Loading your wallets" },
  funders: { label: "Funders", tip: "Who funded each wallet" },
  clusters: { label: "Groups", tip: "Grouping wallets run by one operator" },
  history: { label: "Trades", tip: "Reading trade histories" },
  runners: { label: "Runners", tip: "Checking which tokens ran (free price data)" },
  finalize: { label: "Tags", tip: "Tagging" },
};

// Fill fields a newer page expects but an older server may not send (hot reload, or a deploy where the page
// updates before the API). The page must never crash on a missing field.
function normalize(d: RunData): RunData {
  return {
    ...d,
    tokens: d.tokens ?? [],
    clusters: d.clusters ?? [],
    log: d.log ?? [],
    run: { ...d.run, scanMints: d.run.scanMints ?? [], stagesDone: d.run.stagesDone ?? [] },
    wallets: (d.wallets ?? []).map((w) => ({
      ...w,
      tags: w.tags ?? [],
      buys: w.buys ?? [],
      onTokens: w.onTokens ?? [],
      runnerHits: w.runnerHits ?? [],
      best: w.best ?? null,
      bot: w.bot ?? (w.tags ?? []).includes("bot-like"),
      weightedHits: w.weightedHits ?? 0,
    })),
  };
}

function expiresIn(ms: number) {
  const h = Math.max(0, (ms - Date.now()) / 3_600_000);
  return h < 1 ? "under an hour" : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
}

export function RunView({ id }: { id: number }) {
  const me = useMe();
  const router = useRouter();
  const [data, setData] = useState<RunData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const params = useSearchParams();
  // ?tab= keeps the open tab in the link, so a view can be shared or reloaded.
  const [tab, setTabState] = useState<string>(params.get("tab") ?? "traders");
  const setTab = useCallback((t: string) => {
    setTabState(t);
    const u = new URL(window.location.href);
    if (t === "traders") u.searchParams.delete("tab");
    else u.searchParams.set("tab", t);
    window.history.replaceState(null, "", u);
  }, []);
  // ?w=<wallet> opens that wallet: links to a wallet can be shared with the team.
  const [openWallet, setOpenWalletState] = useState<string | null>(params.get("w"));
  const setOpenWallet = useCallback(
    (w: string | null) => {
      setOpenWalletState(w);
      const u = new URL(window.location.href);
      if (w) u.searchParams.set("w", w);
      else u.searchParams.delete("w");
      window.history.replaceState(null, "", u);
    },
    [],
  );
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/runs/${id}`).catch(() => null);
    if (!res) return;
    if (!res.ok) {
      setErr(res.status === 404 ? "This run does not exist or has been cleared." : "Could not load the run.");
      return;
    }
    setData(normalize(await res.json()));
  }, [id]);

  const live = !!data && ["queued", "running", "cancelling"].includes(data.run.status);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [live, load]);

  const toggleWatch = useCallback(
    async (w: WalletRow) => {
      if (w.watched) await fetch(`/api/watchlist?wallet=${w.wallet}`, { method: "DELETE" });
      else
        await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet: w.wallet, sourceRun: id }),
        });
      setData((d) => (d ? { ...d, wallets: d.wallets.map((x) => (x.wallet === w.wallet ? { ...x, watched: !x.watched } : x)) } : d));
    },
    [id],
  );

  const scan = useCallback(
    async (mint: string) => {
      const r = await fetch(`/api/runs/${id}/scan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mint }) });
      const b = await r.json().catch(() => ({}));
      setNotice(r.ok ? "Insider scan queued. Groups and tags update when it finishes." : b.error ?? "Could not start the scan.");
      void load();
    },
    [id, load],
  );

  const kpi = useMemo(() => {
    if (!data) return null;
    const traders = data.wallets.filter(isTrader);
    const clean = traders.filter((w) => !w.tags.some((t) => INSIDER_TAGS.has(t)));
    const catchers = clean.filter((w) => (w.runner?.runners ?? 0) > 0);
    const both = clean.filter((w) => (w.runnerScore ?? 0) >= 50 && (w.score ?? 0) >= 50);
    const insiders = data.wallets.filter((w) => w.tags.some((t) => INSIDER_TAGS.has(t))).length;
    const okTokens = data.tokens.filter((t) => t.status === "ok").length;
    const best = [...clean].sort((a, b) => (b.runnerScore ?? -1) - (a.runnerScore ?? -1))[0];
    return { traders: traders.length, scored: traders.filter((w) => w.score != null || w.runnerScore != null).length, catchers: catchers.length, both: both.length, insiders, okTokens, best };
  }, [data]);

  if (err)
    return (
      <div className="max-w-lg mx-auto mt-20 text-center">
        <div className="font-medium">{err}</div>
        <Link href="/" className="text-accent-ink mt-3 inline-block">
          Start a new analysis →
        </Link>
      </div>
    );
  if (!data || !kpi) return <RunPageSkeleton />;
  const { run } = data;
  const p = run.progress;
  const stages = run.mode === "tokens" ? ["launch", "candidates", "funders", "clusters", "history", "runners", "finalize"] : ["seed", "funders", "clusters", "history", "runners", "finalize"];
  const stageIdx = stages.indexOf(p.stage ?? "");
  const stagePct = p.total ? Math.min(1, (p.done ?? 0) / p.total) : 0;
  const overall = Math.round(((run.stagesDone.filter((s) => stages.includes(s)).length + (stageIdx >= 0 ? stagePct : 0)) / stages.length) * 100);
  const open = openWallet ? data.wallets.find((w) => w.wallet === openWallet) ?? null : null;

  const tabs = [
    { k: "traders", t: "Traders", n: kpi.traders },
    { k: "insiders", t: "Insiders", n: data.clusters.length },
    ...(run.mode === "tokens"
      ? [
          { k: "matrix", t: "Co-buys", n: data.wallets.filter((w) => w.hits >= 2).length },
          { k: "tokens", t: "Tokens", n: data.tokens.length },
        ]
      : []),
    { k: "log", t: "Log", n: data.log.length },
  ];

  const act = async (path: string) => {
    await fetch(`/api/runs/${id}${path}`, { method: "POST" });
    void load();
  };
  const exportUrl = (kind: string, format = "csv") => `/api/runs/${id}/export?kind=${kind}&format=${format}`;
  const onExport = () => setTimeout(load, 800);
  const starred = data.wallets.filter((w) => w.watched && isTrader(w)).length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <Link href="/runs" className="text-faint hover:text-ink text-[12px]">
              Runs /
            </Link>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <h1 className="text-[19px] sm:text-[22px] font-semibold tracking-tight truncate">{run.label || `Run #${run.id}`}</h1>
            <StatusPill status={run.status} />
          </div>
          <div className="text-dim text-[12px] mt-1">
            {run.inputs.length} {run.mode} · started {ago(run.createdAt)}
            {me?.role === "admin" && run.createdByEmail && run.createdByEmail !== me.email ? ` by ${run.createdByEmail}` : ""} · {run.credits.toLocaleString()} credits
            {!live && <> · clears in {expiresIn(run.expiresAt)}</>}
          </div>
        </div>
        <div className="w-full sm:w-auto sm:ml-auto flex flex-wrap gap-2">
          {live && run.status !== "cancelling" && (
            <Button kind="danger" onClick={() => act("/cancel")}>
              Stop
            </Button>
          )}
          {(run.status === "stopped" || run.status === "failed") && <Button onClick={() => act("/resume")}>Resume</Button>}
          {!live && (
            <Hint tip="Recalculate runners, peaks and tags from saved trade histories and free price data. Costs no credits.">
              <Button
                kind="ghost"
                onClick={async () => {
                  const r = await fetch(`/api/runs/${id}/recheck`, { method: "POST" });
                  const b = await r.json().catch(() => ({}));
                  setNotice(r.ok ? "Rechecking runners with fresh price data (free). This takes a minute or two." : b.error ?? "Could not start the recheck.");
                  void load();
                }}
              >
                Recheck runners
              </Button>
            </Hint>
          )}
          <div onClick={onExport}>
            <Menu label="Export" kind={live ? "default" : "primary"}>
              <MenuItem href={exportUrl("starred")} sub={`${starred} starred wallet${starred === 1 ? "" : "s"}, CSV`}>
                Starred wallets
              </MenuItem>
              <MenuItem href={exportUrl("traders")} sub="Every trader with scores, CSV">
                All traders
              </MenuItem>
              <MenuItem href={exportUrl("traders", "json")} sub="Same, as JSON">
                All traders (JSON)
              </MenuItem>
              <MenuItem href={exportUrl("insiders")} sub="Deployer-linked wallets and bundles, CSV">
                Insiders
              </MenuItem>
              <MenuItem href={exportUrl("buyers")} sub="Every early buy, by token and rank, CSV">
                Early buyers
              </MenuItem>
            </Menu>
          </div>
          {!live && (
            <Button
              kind="ghost"
              onClick={async () => {
                if (!confirm("Clear this run and its results now? Saved chain data is kept, so a rerun stays cheap.")) return;
                await fetch(`/api/runs/${id}`, { method: "DELETE" });
                router.push("/");
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {run.exportedAt && !live && (
        <div className="rounded-lg border border-accent/30 bg-accent/[0.05] px-4 py-2.5 text-[12.5px] text-dim flex flex-wrap items-center gap-3">
          <span>
            Exported. These results clear in <span className="text-ink">{expiresIn(run.expiresAt)}</span>.
          </span>
          <button
            className="text-accent-ink hover:underline ml-auto"
            onClick={async () => {
              await fetch(`/api/runs/${id}`, { method: "DELETE" });
              router.push("/");
            }}
          >
            Clear now
          </button>
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-line-2 bg-panel px-4 py-2.5 text-[12.5px] text-dim flex items-center gap-3">
          {notice}
          <button className="ml-auto text-faint hover:text-ink" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {/* Live progress */}
      {live && (
        <Panel>
          <div className="p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium">{run.status === "queued" ? "Waiting for the worker" : STAGES[p.stage ?? ""]?.tip ?? "Working"}</span>
              {p.note && <span className="text-dim text-[12.5px]">{p.note}</span>}
              <span className="ml-auto text-dim text-[12px] num">
                {overall}% · {(p.credits ?? run.credits).toLocaleString()} credits
              </span>
            </div>
            <div className="h-1.5 bg-line rounded-full mt-3 overflow-hidden">
              <div className="h-full bg-accent rounded-full transition-all duration-700" style={{ width: `${Math.max(2, overall)}%` }} />
            </div>
            <ol className="grid mt-4 gap-2" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
              {stages.map((s) => {
                const done = run.stagesDone.includes(s);
                const cur = p.stage === s && !done;
                return (
                  <li key={s} className="min-w-0">
                    <div className={`h-1 rounded-full ${done ? "bg-good" : cur ? "bg-accent animate-pulse-soft" : "bg-line"}`} />
                    <div className={`mt-1.5 text-[11.5px] truncate ${done ? "text-dim" : cur ? "text-ink" : "text-faint"}`}>
                      {done ? "✓ " : ""}
                      {STAGES[s].label}
                    </div>
                  </li>
                );
              })}
            </ol>
            {data.log.length > 0 && <div className="mt-3 text-[12px] text-faint truncate">{data.log[data.log.length - 1].msg}</div>}
          </div>
        </Panel>
      )}
      {run.error && !live && (
        <div className={`rounded-lg border px-4 py-2.5 ${run.status === "failed" ? "border-bad/40 text-bad bg-bad/[0.05]" : "border-warn/40 text-warn bg-warn/[0.05]"}`}>{run.error}</div>
      )}

      {/* KPI widgets */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="Runner-catchers"
          tone="accent"
          value={kpi.catchers}
          sub={`of ${kpi.scored} wallets checked`}
          tip="Wallets (not insiders) that bought at least one other token early that later ran. Your pasted tokens are not counted."
        />
        <Stat
          label="Runners and profit"
          value={kpi.both}
          sub="runner score and profit score both 50+"
          tip="The top-right corner of the chart below: catches runners and makes money on them."
        />
        <Stat
          label="Top runner score"
          value={kpi.best?.runnerScore != null ? Math.round(kpi.best.runnerScore) : "—"}
          sub={
            kpi.best ? (
              <button className="inline-flex items-center gap-1.5 mono hover:text-accent-ink" onClick={() => setOpenWallet(kpi.best!.wallet)}>
                <KindBadge kind="account" />
                {short(kpi.best.wallet, 5)}
              </button>
            ) : (
              "none yet"
            )
          }
        />
        <Stat
          label="Insiders set aside"
          value={kpi.insiders}
          sub={`${data.clusters.length} groups${run.mode === "tokens" ? ` · ${kpi.okTokens}/${data.tokens.length} tokens read` : ""}`}
          tip="Deployers, wallets linked to a deployer by funding, and bundles. Hidden from Traders by default."
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-line overflow-x-auto scroll-thin" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.k}
            role="tab"
            aria-selected={tab === t.k}
            onClick={() => setTab(t.k)}
            className={`px-3.5 h-10 -mb-px border-b-2 whitespace-nowrap transition ${tab === t.k ? "border-accent text-ink" : "border-transparent text-dim hover:text-ink"}`}
          >
            {t.t} <span className="text-faint text-[11px] ml-1 num">{t.n}</span>
          </button>
        ))}
      </div>

      {tab === "traders" && <TradersTab data={data} onOpen={(w) => setOpenWallet(w.wallet)} onWatch={toggleWatch} />}
      {tab === "insiders" && <InsidersTab data={data} onOpen={(w) => setOpenWallet(w.wallet)} onScan={scan} live={live} />}
      {tab === "matrix" && <MatrixTab data={data} onOpen={(w) => setOpenWallet(w.wallet)} />}
      {tab === "tokens" && <TokensTab data={data} onScan={scan} live={live} />}
      {tab === "log" && <LogTab data={data} />}

      {open && <WalletDrawer runId={id} data={data} w={open} onClose={() => setOpenWallet(null)} onWatch={toggleWatch} />}
    </div>
  );
}
