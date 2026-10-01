import { getDb, json } from "./db";
import type { OnTokenResult, RunRow } from "./pipeline/run";
import { getAppSettings } from "./appSettings";
import type { TraderStats } from "./core/pnl";
import type { RunnerStats } from "./core/runners";
import type { MarketInfo } from "./market";
import { monthlyCreditsUsed, monthlyLimit, runCreditsUsed } from "./credits";

// Reads for the API. Every run read is scoped to its creator: another user's run id reads as "not found"
// (never "forbidden"), so ids cannot be probed. `userId` null means the CLI/admin path and sees CLI runs only.

export interface RunSummary {
  id: number;
  createdAt: number;
  finishedAt: number | null;
  mode: "tokens" | "wallets";
  label: string | null;
  inputs: string[];
  status: string;
  stage: string | null;
  progress: { stage?: string; done?: number; total?: number; note?: string | null; credits?: number };
  error: string | null;
  credits: number;
  settingsHash: string;
  settings: Record<string, unknown>;
  stagesDone: string[];
  scanMints: string[];
  exportedAt: number | null;
  expiresAt: number;
  createdByEmail: string | null;
}

async function summarize(r: RunRow): Promise<RunSummary> {
  return {
    id: r.id,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    mode: r.mode,
    label: r.label,
    inputs: json(r.inputs, []),
    status: r.status,
    stage: r.stage,
    progress: json(r.progress, {}),
    error: r.error,
    credits: await runCreditsUsed(r.id),
    settingsHash: r.settings_hash,
    settings: json(r.settings, {}),
    stagesDone: json(r.stages_done, []),
    scanMints: json(r.scan_mints, []),
    exportedAt: r.exported_at,
    expiresAt: r.expires_at,
    createdByEmail: r.created_by_email ?? null,
  };
}

// Who is asking: a signed-in user (admins see every run) or null for the CLI (sees CLI runs only).
export type Viewer = { id: string | null; role?: string } | string | null;
const viewerOf = (v: Viewer): { id: string | null; admin: boolean } =>
  v && typeof v === "object" ? { id: v.id, admin: v.role === "admin" } : { id: (v as string | null) ?? null, admin: false };

export async function ownRun(id: number, viewer: Viewer): Promise<RunRow | undefined> {
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  const db = await getDb();
  const v = viewerOf(viewer);
  if (v.admin) return db.one<RunRow>("SELECT * FROM runs WHERE id = $1", [id]);
  return db.one<RunRow>("SELECT * FROM runs WHERE id = $1 AND created_by IS NOT DISTINCT FROM $2", [id, v.id]);
}

export async function listRuns(userId: string | null, limit = 50): Promise<(RunSummary & { found: number; scored: number; runners: number })[]> {
  const db = await getDb();
  const rows = await db.q<RunRow & { found: number; scored: number; runners: number }>(
    `SELECT r.*,
       (SELECT COUNT(*) FROM wallets w WHERE w.run_id = r.id AND w.role IN ('candidate', 'input')) AS found,
       (SELECT COUNT(*) FROM wallets w WHERE w.run_id = r.id AND (w.score IS NOT NULL OR w.runner_score IS NOT NULL)) AS scored,
       (SELECT COUNT(*) FROM wallets w WHERE w.run_id = r.id AND w.runner_score IS NOT NULL AND w.runner_score > 0) AS runners
     FROM runs r WHERE r.created_by IS NOT DISTINCT FROM $1 ORDER BY r.id DESC LIMIT $2`,
    [userId, limit],
  );
  return Promise.all(rows.map(async (r) => ({ ...(await summarize(r)), found: r.found, scored: r.scored, runners: r.runners })));
}

export interface WalletRow {
  wallet: string;
  role: string;
  hits: number;
  weightedHits: number;
  firstTxTime: number | null;
  firstTxExact: boolean;
  funder: string | null;
  funderService: boolean;
  txsPerDay: number | null;
  clusterId: number | null;
  clusterKind: string | null;
  tags: string[];
  score: number | null; // profit score
  runnerScore: number | null;
  runner: Omit<RunnerStats, "hits"> | null;
  // The tokens behind the numbers: the wallet's biggest runners (outside your batch) and its best trade.
  runnerHits: { mint: string; symbol: string | null; peakMultiple: number; exitMultiple: number | null; capture: number | null; entryMcapUsd: number; peakMcapUsd: number; estimated: boolean }[];
  best: { mint: string; symbol: string | null; pnlSol: number; multiple: number | null } | null;
  bot: boolean;
  historyStatus: string | null;
  stats: Omit<TraderStats, "top" | "pnlCurve"> | null;
  onTokens: OnTokenResult[];
  buys: { mint: string; rank: number; secsAfterCreate: number | null; sol: number; sameSlot: boolean }[];
  watched: boolean;
}

export interface TokenRow {
  mint: string;
  status: string;
  note: string | null;
  name: string | null;
  symbol: string | null;
  deployer: string | null;
  createdAt: number | null;
  launchpad: string | null;
  launchTxs: number | null;
  buyers: number | null;
  market: MarketInfo | null;
  peakUsd: number | null;
  weight: number | null;
}

export interface ClusterRow {
  id: number;
  kind: string;
  funders: string[];
  members: string[];
  deployers: string[];
  mints: string[];
  reason: string;
}

export interface RunDetail {
  run: RunSummary;
  tokens: TokenRow[];
  wallets: WalletRow[];
  clusters: ClusterRow[];
  log: { ts: number; level: string; msg: string }[];
}

export async function runDetail(id: number, viewer: Viewer): Promise<RunDetail | null> {
  const run = await ownRun(id, viewer);
  if (!run) return null;
  const db = await getDb();
  const tokens: TokenRow[] = (await db.q<Record<string, unknown>>("SELECT * FROM tokens WHERE run_id = $1 ORDER BY created_at NULLS LAST", [id])).map((t) => ({
    mint: t.mint as string,
    status: t.status as string,
    note: t.note as string | null,
    name: t.name as string | null,
    symbol: t.symbol as string | null,
    deployer: t.deployer as string | null,
    createdAt: t.created_at as number | null,
    launchpad: t.launchpad as string | null,
    launchTxs: t.launch_txs as number | null,
    buyers: t.buyers as number | null,
    market: json<MarketInfo | null>(t.market, null),
    peakUsd: t.peak_usd as number | null,
    weight: t.weight as number | null,
  }));
  const buysBy = new Map<string, WalletRow["buys"]>();
  for (const b of await db.q<{ wallet: string; mint: string; rank: number; secs_after_create: number | null; sol: number; same_slot: number }>(
    "SELECT wallet, mint, rank, secs_after_create, sol, same_slot FROM early_buys WHERE run_id = $1",
    [id],
  )) {
    const l = buysBy.get(b.wallet) ?? [];
    l.push({ mint: b.mint, rank: b.rank, secsAfterCreate: b.secs_after_create, sol: b.sol, sameSlot: b.same_slot === 1 });
    buysBy.set(b.wallet, l);
  }
  const watched = new Set((await db.q<{ wallet: string }>("SELECT wallet FROM watchlist")).map((w) => w.wallet));
  const clusters: ClusterRow[] = (await db.q<Record<string, unknown>>("SELECT * FROM clusters WHERE run_id = $1 ORDER BY cluster_id", [id])).map((c) => ({
    id: c.cluster_id as number,
    kind: c.kind as string,
    funders: json<string[]>(c.funders, []),
    members: json<string[]>(c.members, []),
    deployers: json<string[]>(c.deployers, []),
    mints: json<string[]>(c.mints, []),
    reason: c.reason as string,
  }));
  const kindOf = new Map(clusters.map((c) => [c.id, c.kind]));
  const raw = await db.q<Record<string, unknown>>("SELECT * FROM wallets WHERE run_id = $1", [id]);
  // Symbols for each wallet's best trade (runner hits carry their own).
  const bestMints = [...new Set(raw.map((w) => json<TraderStats | null>(w.stats, null)?.best?.mint).filter((m): m is string => !!m))];
  const symbolOf = new Map(
    bestMints.length
      ? (await db.q<{ mint: string; symbol: string | null }>("SELECT mint, symbol FROM token_facts WHERE mint = ANY($1::text[])", [bestMints])).map((r) => [r.mint, r.symbol])
      : [],
  );
  for (const t of tokens) if (t.symbol) symbolOf.set(t.mint, t.symbol);
  const wallets: WalletRow[] = raw.map((w) => {
    const stats = json<TraderStats | null>(w.stats, null);
    if (stats) {
      delete (stats as Partial<TraderStats>).top;
      delete (stats as Partial<TraderStats>).pnlCurve;
    }
    const runner = json<RunnerStats | null>(w.runner, null);
    const runnerHits = (runner?.hits ?? []).slice(0, 5).map((h) => ({
      mint: h.mint, symbol: h.symbol, peakMultiple: h.peakMultiple, exitMultiple: h.exitMultiple, capture: h.capture,
      entryMcapUsd: h.entryMcapUsd, peakMcapUsd: h.peakMcapUsd, estimated: h.estimated,
    }));
    if (runner) delete (runner as Partial<RunnerStats>).hits;
    const b = stats?.best ?? null;
    const tags = json<string[]>(w.tags, []);
    return {
      wallet: w.wallet as string,
      role: w.role as string,
      hits: w.hits as number,
      weightedHits: (w.weighted_hits as number) ?? 0,
      firstTxTime: w.first_tx_time as number | null,
      firstTxExact: w.first_tx_exact === 1,
      funder: w.funder as string | null,
      funderService: w.funder_service === 1,
      txsPerDay: w.txs_per_day as number | null,
      clusterId: w.cluster_id as number | null,
      clusterKind: w.cluster_id != null ? kindOf.get(w.cluster_id as number) ?? null : null,
      tags,
      score: w.score as number | null,
      runnerScore: w.runner_score as number | null,
      runner,
      runnerHits,
      best: b && b.pnlSol > 0 ? { mint: b.mint, symbol: symbolOf.get(b.mint) ?? null, pnlSol: b.pnlSol, multiple: b.multiple } : null,
      bot: tags.includes("bot-like"),
      historyStatus: w.history_status as string | null,
      stats,
      onTokens: json<OnTokenResult[]>(w.on_tokens, []),
      buys: (buysBy.get(w.wallet as string) ?? []).sort((a, b) => a.rank - b.rank),
      watched: watched.has(w.wallet as string),
    };
  });
  const logRows = await db.q<{ ts: number; level: string; msg: string }>(
    "SELECT ts, level, msg FROM run_log WHERE run_id = $1 ORDER BY id DESC LIMIT 300",
    [id],
  );
  return { run: await summarize(run), tokens, wallets, clusters, log: logRows.reverse() };
}

export async function walletDetail(runId: number, wallet: string, viewer: Viewer) {
  if (!(await ownRun(runId, viewer))) return null;
  const db = await getDb();
  const w = await db.one<{ stats: string | null; on_tokens: string | null; runner: string | null }>(
    "SELECT stats, on_tokens, runner FROM wallets WHERE run_id = $1 AND wallet = $2",
    [runId, wallet],
  );
  if (!w) return null;
  return {
    stats: json<TraderStats | null>(w.stats, null),
    onTokens: json<OnTokenResult[]>(w.on_tokens, []),
    runner: json<RunnerStats | null>(w.runner, null),
  };
}

// What the UI needs to warn before a run is wasted: is a worker alive, and is the month nearly spent.
export async function status() {
  const db = await getDb();
  const beat = await db.one<{ value: string; updated_at: number }>("SELECT value, updated_at FROM app_config WHERE key = 'worker_heartbeat'");
  const w = json<{ helius?: boolean }>(beat?.value, {});
  const limit = await monthlyLimit(db);
  const used = await monthlyCreditsUsed(db);
  return {
    workerOnline: !!beat && Date.now() - beat.updated_at < 90_000,
    heliusConfigured: !!w.helius,
    creditsLeft: Math.max(0, Math.floor(limit * 0.98) - used),
  };
}

// ---------- watchlist (team-wide, kept) ----------

export interface WatchEntry {
  wallet: string;
  label: string | null;
  note: string | null;
  addedAt: number;
  addedBy: string | null;
  sourceRun: number | null;
  snapshot: Record<string, unknown> | null;
}

export async function listWatch(): Promise<WatchEntry[]> {
  const db = await getDb();
  return (await db.q<Record<string, unknown>>("SELECT * FROM watchlist ORDER BY added_at DESC")).map((r) => ({
    wallet: r.wallet as string,
    label: r.label as string | null,
    note: r.note as string | null,
    addedAt: r.added_at as number,
    addedBy: r.added_by as string | null,
    sourceRun: r.source_run as number | null,
    snapshot: json(r.snapshot, null),
  }));
}

export async function addWatch(wallet: string, sourceRun: number | null, label: string | null, user: { id: string | null; email?: string | null; role?: string }) {
  const db = await getDb();
  let snapshot: Record<string, unknown> | null = null;
  if (sourceRun != null && (await ownRun(sourceRun, user))) {
    const w = await db.one<{ score: number | null; runner_score: number | null; runner: string | null; stats: string | null; tags: string; hits: number }>(
      "SELECT score, runner_score, runner, stats, tags, hits FROM wallets WHERE run_id = $1 AND wallet = $2",
      [sourceRun, wallet],
    );
    if (w) {
      const s = json<TraderStats | null>(w.stats, null);
      const r = json<RunnerStats | null>(w.runner, null);
      snapshot = {
        runnerScore: w.runner_score, runners: r?.runners ?? null, medianCapture: r?.medianCapture ?? null,
        score: w.score, hits: w.hits, tags: json(w.tags, []),
        netSol: s?.netSol ?? null, winRate: s?.winRate ?? null, closed: s?.closed ?? null,
        medianMultiple: s?.medianMultiple ?? null, medianHoldMin: s?.medianHoldMin ?? null, tradesPerDay: s?.tradesPerDay ?? null,
      };
    }
  }
  await db.run(
    `INSERT INTO watchlist (wallet, label, added_at, added_by, source_run, snapshot) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (wallet) DO UPDATE SET label = COALESCE(excluded.label, watchlist.label), source_run = COALESCE(excluded.source_run, watchlist.source_run),
       snapshot = COALESCE(excluded.snapshot, watchlist.snapshot)`,
    [wallet, label, Date.now(), user.email ?? user.id, snapshot ? sourceRun : null, snapshot ? JSON.stringify(snapshot) : null],
  );
}

export async function updateWatch(wallet: string, fields: { label?: string | null; note?: string | null }) {
  const db = await getDb();
  if (fields.label !== undefined) await db.run("UPDATE watchlist SET label = $1 WHERE wallet = $2", [fields.label, wallet]);
  if (fields.note !== undefined) await db.run("UPDATE watchlist SET note = $1 WHERE wallet = $2", [fields.note, wallet]);
}

export async function removeWatch(wallet: string) {
  const db = await getDb();
  await db.run("DELETE FROM watchlist WHERE wallet = $1", [wallet]);
}

// Run-scoped tables cascade from runs.
export async function deleteRun(id: number) {
  const db = await getDb();
  await db.run("DELETE FROM runs WHERE id = $1", [id]);
}

// First export starts the 24 h countdown; the run goes then (or at 7 days, whichever is first).
export async function markExported(id: number) {
  const db = await getDb();
  const now = Date.now();
  const s = await getAppSettings(db);
  await db.run("UPDATE runs SET exported_at = COALESCE(exported_at, $1), expires_at = LEAST(expires_at, $2) WHERE id = $3", [now, now + s.afterExportTtlHours * 3_600_000, id]);
}

// ---------- CSV ----------

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v == null) return "";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
    if (Array.isArray(v)) v = v.join(" ");
    let s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

export type ExportKind = "traders" | "starred" | "insiders" | "buyers";

export async function exportRows(id: number, kind: ExportKind, viewer: Viewer = null): Promise<Record<string, unknown>[]> {
  const d = await runDetail(id, viewer);
  if (!d) return [];
  const sym = new Map(d.tokens.map((t) => [t.mint, t.symbol ?? t.mint]));
  if (kind === "traders" || kind === "starred") {
    return d.wallets
      .filter((w) => w.role === "candidate" || w.role === "input")
      .filter((w) => kind === "traders" || w.watched)
      .sort((a, b) => (b.runnerScore ?? -1) - (a.runnerScore ?? -1) || (b.score ?? -1) - (a.score ?? -1))
      .map((w) => ({
        wallet: w.wallet,
        runner_score: w.runnerScore, runners: w.runner?.runners, weighted_runners: w.runner?.weighted, median_capture: w.runner?.medianCapture,
        conviction_runners: w.runner?.convictionCount, median_runner_entry_usd: w.runner?.medianEntryMcapUsd,
        profit_score: w.score, net_sol: w.stats?.netSol, win_rate: w.stats?.winRate, closed: w.stats?.closed,
        median_multiple: w.stats?.medianMultiple, median_hold_min: w.stats?.medianHoldMin, trades_per_day: w.stats?.tradesPerDay,
        runner_tokens: w.runnerHits.map((h) => `${h.symbol ?? h.mint} ${Math.round(h.peakMultiple)}x`).join(" | "),
        best_trade: w.best ? `${w.best.symbol ?? w.best.mint} +${w.best.pnlSol.toFixed(2)} SOL` : null,
        bot: w.bot,
        hits: w.hits, tokens: w.buys.map((b) => `${sym.get(b.mint)}#${b.rank}`).join(" "), tags: w.tags.join(" "),
        group: w.clusterId, funder: w.funder, starred: w.watched, history: w.historyStatus,
      }));
  }
  if (kind === "insiders") {
    const byWallet = new Map(d.wallets.map((w) => [w.wallet, w]));
    return d.clusters.flatMap((c) =>
      c.members.map((m) => ({
        group: c.id, kind: c.kind, wallet: m, role: byWallet.get(m)?.role, funder: byWallet.get(m)?.funder,
        tokens: byWallet.get(m)?.buys.map((b) => `${sym.get(b.mint)}#${b.rank}`).join(" "), tags: byWallet.get(m)?.tags.join(" "), reason: c.reason,
      })),
    );
  }
  return d.wallets.flatMap((w) =>
    w.buys.map((b) => ({ wallet: w.wallet, mint: b.mint, token: sym.get(b.mint), rank: b.rank, secs_after_create: b.secsAfterCreate, sol: b.sol, block0: b.sameSlot, role: w.role })),
  );
}
