import { createHash } from "node:crypto";
import { getDb, insertMany, json, type Db } from "../db";
import { parseSettings, settingsHash, type RunMode, type RunSettings } from "../config";
import { AuthError, BudgetError, redact, type Rpc } from "../helius";
import { buildClusters, type WalletFacts } from "../core/clusters";
import { computeTags } from "../core/tags";
import { buildPositions, traderScore, traderStats, type TraderStats } from "../core/pnl";
import { batchTokenWeight, runnerStats, type RunnerStats } from "../core/runners";
import { ensureFacts, ensureSolPrice, peakMcapAfter, type MarketSource, type TokenFacts } from "../tokens";

const usdShort = (x: number) => (x >= 1e6 ? `$${x / 1e6}M` : `$${Math.round(x / 1e3)}K`);
import { mapLimit, tokenAccountEvents } from "./fetch";
import { cachedHistory, cachedIsService, cachedLaunch, cachedWallet, loadHistoryEvents } from "./cache";
import type { MarketInfo } from "../market";

export const TOKEN_STAGES = ["launch", "candidates", "funders", "clusters", "history", "runners", "finalize"] as const;
export const WALLET_STAGES = ["seed", "funders", "clusters", "history", "runners", "finalize"] as const;
export type Stage = (typeof TOKEN_STAGES)[number] | (typeof WALLET_STAGES)[number];

// Results live 7 days, or 24 h after the first export, whichever comes first.
export const RESULT_TTL_MS = 7 * 86_400_000;
export const AFTER_EXPORT_TTL_MS = 86_400_000;

export interface RunRow {
  id: number;
  created_at: number;
  created_by: string | null;
  mode: RunMode;
  label: string | null;
  inputs: string;
  settings: string;
  settings_hash: string;
  status: string;
  stage: string | null;
  stages_done: string;
  progress: string;
  error: string | null;
  finished_at: number | null;
  owner: string | null;
  heartbeat: number | null;
  scan_mints: string;
  exported_at: number | null;
  expires_at: number;
  created_by_email?: string | null;
  priority?: number;
}

export interface OnTokenResult {
  mint: string;
  rank: number;
  secsAfterCreate: number | null;
  status: "closed" | "open" | "excluded" | "unknown";
  spentSol: number;
  proceedsSol: number;
  pnlSol: number;
  multiple: number | null;
  soldPct: number;
  holdMinutes: number | null;
}

export class CancelError extends Error {}
class LostClaimError extends CancelError {}
class ShutdownError extends CancelError {}

// Errors that end the run instead of skipping one item.
const fatal = (e: unknown) => e instanceof CancelError || e instanceof AuthError;

// One id per process. A run is executed only by the process that claimed it; another process may take it over
// only after the owner's heartbeat has been silent for STALE_MS (the owner crashed or was closed).
export const PROCESS_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
export const STALE_MS = 60_000;

let shuttingDown = false;
// SIGTERM: finish the item in hand, then hand the run back to the queue. Its finished stages are kept.
export function requestShutdown() {
  shuttingDown = true;
}
export function _resetShutdownForTests() {
  shuttingDown = false;
}

const LIVE = ["queued", "running", "cancelling"];

export function dedupeKey(userId: string | null, mode: RunMode, inputs: string[], s: RunSettings): string {
  return createHash("sha256")
    .update(JSON.stringify([userId, mode, [...inputs].sort(), settingsHash(s)]))
    .digest("hex")
    .slice(0, 32);
}

// `claim` creates the run already owned by this process (the CLI), so a worker cannot pick it up.
// An identical request while the same run is still live returns that run instead of starting (and paying for)
// a second one.
export class RunLimitError extends Error {}

// Live runs per person come from the admin settings (members vs admins); see app/api/runs/route.ts.

export async function createRun(
  mode: RunMode,
  inputs: string[],
  settingsInput: unknown,
  o: { label?: string; claim?: boolean; userId?: string | null; userEmail?: string | null; maxLive?: number; priority?: number; ttlMs?: number } = {},
): Promise<{ id: number; existing: boolean }> {
  const db = await getDb();
  const settings = parseSettings(settingsInput);
  const uniq = [...new Set(inputs)];
  const now = Date.now();
  const user = o.userId ?? null;
  const key = dedupeKey(user, mode, uniq, settings);
  return db.tx(async (t) => {
    // Serialize run creation per user so the count and the insert agree. A transaction-scoped lock is released
    // at commit, which is safe behind Supabase's transaction pooler (a session lock would not be).
    await t.q("SELECT pg_advisory_xact_lock(hashtext($1))", [`run-create:${user ?? "cli"}`]);
    const same = await t.one<{ id: number }>("SELECT id FROM runs WHERE dedupe_key = $1 AND status = ANY($2::text[]) ORDER BY id DESC LIMIT 1", [key, LIVE]);
    if (same) return { id: same.id, existing: true };
    if (o.maxLive != null) {
      const n = await t.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE created_by IS NOT DISTINCT FROM $1 AND status = ANY($2::text[])", [user, LIVE]);
      if ((n?.n ?? 0) >= o.maxLive) {
        throw new RunLimitError(`You already have ${o.maxLive} runs going. Wait for one to finish, or stop one.`);
      }
    }
    const r = await t.one<{ id: number }>(
      `INSERT INTO runs (created_at, created_by, created_by_email, mode, label, inputs, settings, settings_hash, status, owner, heartbeat, dedupe_key, expires_at, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running', 'cancelling') DO NOTHING
       RETURNING id`,
      [
        now, user, o.userEmail ?? null, mode, o.label ?? null, JSON.stringify(uniq), JSON.stringify(settings), settingsHash(settings),
        o.claim ? "running" : "queued", o.claim ? PROCESS_ID : null, o.claim ? now : null, key, now + (o.ttlMs ?? RESULT_TTL_MS), o.priority ?? 0,
      ],
    );
    if (r) return { id: r.id, existing: false };
    const live = await t.one<{ id: number }>("SELECT id FROM runs WHERE dedupe_key = $1 AND status = ANY($2::text[]) ORDER BY id DESC LIMIT 1", [key, LIVE]);
    if (!live) throw new Error("Could not start the run. Try again.");
    return { id: live.id, existing: true };
  });
}

// Atomic: true only for the one process that gets the run.
export async function claimRun(id: number): Promise<boolean> {
  const db = await getDb();
  const now = Date.now();
  const n = await db.run(
    `UPDATE runs SET status = 'running', owner = $1, heartbeat = $2
     WHERE id = $3 AND (status = 'queued' OR (status = 'running' AND (owner = $1 OR owner IS NULL OR heartbeat IS NULL OR heartbeat < $4)))`,
    [PROCESS_ID, now, id, now - STALE_MS],
  );
  return n === 1;
}

async function releaseRun(id: number) {
  const db = await getDb();
  await db.run("UPDATE runs SET owner = NULL, heartbeat = NULL WHERE id = $1 AND owner = $2", [id, PROCESS_ID]);
}

export async function getRun(id: number): Promise<RunRow | undefined> {
  const db = await getDb();
  return db.one<RunRow>("SELECT * FROM runs WHERE id = $1", [id]);
}

export async function log(runId: number, level: "info" | "warn" | "error", msg: string) {
  const db = await getDb();
  await db.run("INSERT INTO run_log (run_id, ts, level, msg) VALUES ($1, $2, $3, $4)", [runId, Date.now(), level, redact(msg)]);
}

export interface Deps {
  fetchMarket?: (mints: string[]) => Promise<Map<string, MarketInfo>>;
  market?: MarketSource; // runner data (Jupiter, GeckoTerminal); without it runners stay unknown
  now?: () => number; // unix seconds
}

class Ctx {
  private lastProgress = 0;
  private lastCancelCheck = 0;
  budgetHit = false;
  constructor(public run: RunRow, public s: RunSettings, public rpc: Rpc, public deps: Deps, public db: Db) {}
  get id() { return this.run.id; }
  now() { return this.deps.now?.() ?? Math.floor(Date.now() / 1000); }
  log(level: "info" | "warn" | "error", msg: string) { return log(this.id, level, msg); }
  async progress(stage: string, done: number, total: number, note?: string, force = false) {
    this.rpc.setStage?.(stage);
    const now = Date.now();
    if (!force && now - this.lastProgress < 700 && done < total) return;
    this.lastProgress = now;
    await this.db.run("UPDATE runs SET stage = $1, progress = $2 WHERE id = $3", [
      stage, JSON.stringify({ stage, done, total, note: note ?? null, credits: this.rpc.creditsUsed() }), this.id,
    ]);
  }
  // Called per item. The database is asked at most every 1.5 s.
  async checkCancel(force = false) {
    if (shuttingDown) throw new ShutdownError("worker shutting down");
    const now = Date.now();
    if (!force && now - this.lastCancelCheck < 1500) return;
    this.lastCancelCheck = now;
    const r = await this.db.one<{ status: string; owner: string | null }>("SELECT status, owner FROM runs WHERE id = $1", [this.id]);
    if (r && r.owner !== PROCESS_ID) throw new LostClaimError("another process took over this run");
    if (!r || r.status === "cancelling" || r.status === "stopped") throw new CancelError("cancelled");
  }
  async onBudget(e: unknown): Promise<boolean> {
    if (!(e instanceof BudgetError)) return false;
    if (!this.budgetHit) await this.log("warn", `${e.message}. Remaining items use saved data only.`);
    this.budgetHit = true;
    return true;
  }
}

// ---------- stages ----------

async function stageLaunch(c: Ctx, mints: string[]) {
  const db = c.db;
  const done = new Set((await db.q<{ mint: string }>("SELECT mint FROM tokens WHERE run_id = $1 AND status = 'ok'", [c.id])).map((r) => r.mint));
  let i = 0, reused = 0;
  for (const mint of mints) {
    await c.checkCancel();
    await c.progress("launch", i, mints.length, `reading launch of ${mint.slice(0, 6)}…`, true);
    i++;
    if (done.has(mint)) continue;
    let launch;
    try {
      launch = await cachedLaunch(c.rpc, mint, c.s);
    } catch (e) {
      if (fatal(e)) throw e;
      const budget = await c.onBudget(e);
      const msg = budget ? "budget reached" : (e as Error).message;
      if (!budget) await c.log("error", `${mint}: ${msg}`);
      await db.run(
        `INSERT INTO tokens (run_id, mint, status, note) VALUES ($1, $2, $3, $4)
         ON CONFLICT (run_id, mint) DO UPDATE SET status = excluded.status, note = excluded.note`,
        [c.id, mint, budget ? "skipped" : "failed", msg],
      );
      continue;
    }
    if (launch.cached) reused++;
    await db.tx(async (t) => {
      await t.run("DELETE FROM early_buys WHERE run_id = $1 AND mint = $2", [c.id, mint]);
      await t.run(
        `INSERT INTO tokens (run_id, mint, status, note, deployer, created_at, create_sig, create_slot, launchpad, launch_txs, buyers)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (run_id, mint) DO UPDATE SET status = excluded.status, note = excluded.note, deployer = excluded.deployer,
           created_at = excluded.created_at, create_sig = excluded.create_sig, create_slot = excluded.create_slot,
           launchpad = excluded.launchpad, launch_txs = excluded.launch_txs, buyers = excluded.buyers`,
        [c.id, mint, launch.status, launch.note ?? null, launch.deployer, launch.createdAt, launch.createSig, launch.createSlot, launch.launchpad, launch.txsRead, launch.buys.length],
      );
      await insertMany(
        t,
        "INSERT INTO early_buys (run_id, mint, wallet, rank, sig, slot, block_time, secs_after_create, sol, tokens, token_account, same_slot)",
        "ON CONFLICT DO NOTHING",
        12,
        launch.buys.map((b) => [c.id, mint, b.wallet, b.rank, b.sig, b.slot, b.blockTime, b.secsAfterCreate, b.sol, b.tokens, b.tokenAccount, b.sameSlot ? 1 : 0]),
      );
    });
    if (launch.status === "ok") {
      await c.log("info", `${mint.slice(0, 8)}…: ${launch.buys.length} early buyers${launch.cached ? " (saved, no credits)" : ` from ${launch.txsRead} transactions`}, deployer ${launch.deployer?.slice(0, 8)}…`);
    } else await c.log("warn", `${mint}: ${launch.status}${launch.note ? ` (${launch.note})` : ""}`);
  }
  await c.progress("launch", mints.length, mints.length, undefined, true);
  if (reused) await c.log("info", `${reused} of ${mints.length} launches came from saved data`);
  if (c.deps.fetchMarket) {
    const info = await c.deps.fetchMarket(mints);
    for (const [mint, m] of info) {
      await db.run("UPDATE tokens SET name = $1, symbol = $2, market = $3 WHERE run_id = $4 AND mint = $5", [m.name, m.symbol, JSON.stringify(m), c.id, mint]);
    }
  }
}

async function stageCandidates(c: Ctx) {
  const db = c.db;
  const rows = await db.q<{ wallet: string; hits: number }>(
    "SELECT wallet, COUNT(DISTINCT mint)::int AS hits FROM early_buys WHERE run_id = $1 GROUP BY wallet",
    [c.id],
  );
  const deployers = new Set(
    (await db.q<{ deployer: string }>("SELECT deployer FROM tokens WHERE run_id = $1 AND deployer IS NOT NULL", [c.id])).map((r) => r.deployer),
  );
  const hits = new Map(rows.map((r) => [r.wallet, r.hits]));
  const values: unknown[][] = [];
  for (const d of deployers) values.push([c.id, d, "deployer", hits.get(d) ?? 0]);
  for (const r of rows) {
    if (deployers.has(r.wallet)) continue;
    values.push([c.id, r.wallet, r.hits >= c.s.minHits ? "candidate" : "buyer", r.hits]);
  }
  await db.tx(async (t) => {
    await t.run("DELETE FROM wallets WHERE run_id = $1", [c.id]);
    await insertMany(t, "INSERT INTO wallets (run_id, wallet, role, hits)", "ON CONFLICT DO NOTHING", 4, values);
  });
  const cands = rows.filter((r) => r.hits >= c.s.minHits && !deployers.has(r.wallet)).length;
  await c.log("info", `${rows.length} early buyers across the tokens; ${cands} were early in ${c.s.minHits}+ of them`);
  if (cands === 0) await c.log("warn", `No wallet was early in ${c.s.minHits}+ tokens. Paste more tokens, or tokens from the same period or theme.`);
}

async function stageSeed(c: Ctx, wallets: string[]) {
  await insertMany(c.db, "INSERT INTO wallets (run_id, wallet, role, hits)", "ON CONFLICT DO NOTHING", 4, wallets.map((w) => [c.id, w, "input", 0]));
}

async function stageFunders(c: Ctx) {
  const db = c.db;
  const scan = json<string[]>((await db.one<{ scan_mints: string }>("SELECT scan_mints FROM runs WHERE id = $1", [c.id]))?.scan_mints, []);
  type Row = { wallet: string; role: string; hits: number; min_rank: number | null; first_tx_exact: number | null; scanned: boolean };
  const rows = await db.q<Row>(
    `SELECT w.wallet, w.role, w.hits, w.first_tx_exact,
       (SELECT MIN(rank) FROM early_buys e WHERE e.run_id = w.run_id AND e.wallet = w.wallet) AS min_rank,
       EXISTS (SELECT 1 FROM early_buys e WHERE e.run_id = w.run_id AND e.wallet = w.wallet AND e.mint = ANY($2::text[])) AS scanned
     FROM wallets w WHERE w.run_id = $1`,
    [c.id, scan],
  );
  const prio = (r: Row) => (r.role === "deployer" ? 0 : r.role === "input" ? 1 : r.role === "candidate" ? 2 : 3);
  // Plain early buyers are traced only when asked: every buyer (setting) or the buyers of a launch the user
  // chose to scan for insiders.
  let list = rows
    .filter((r) => c.s.funderScope === "all" || r.role !== "buyer" || r.scanned)
    .sort((a, b) => prio(a) - prio(b) || b.hits - a.hits || (a.min_rank ?? 1e9) - (b.min_rank ?? 1e9));
  if (list.length > c.s.maxFunderLookups) {
    await c.log("warn", `Funder lookups capped at ${c.s.maxFunderLookups} of ${list.length} wallets`);
    list = list.slice(0, c.s.maxFunderLookups);
  }
  const todo = list.filter((r) => r.first_tx_exact == null);
  let done = list.length - todo.length;
  let reused = 0;
  await mapLimit(todo, 6, async (r) => {
    await c.checkCancel();
    try {
      const w = await cachedWallet(c.rpc, r.wallet, r.role !== "buyer");
      if (w.cached) reused++;
      await db.run(
        "UPDATE wallets SET first_tx_time = $1, first_tx_exact = $2, funder = $3, txs_per_day = $4 WHERE run_id = $5 AND wallet = $6",
        [w.firstTxTime, w.firstTxExact ? 1 : 0, w.funder, w.txsPerDay, c.id, r.wallet],
      );
    } catch (e) {
      if (fatal(e)) throw e;
      if (!(await c.onBudget(e))) await c.log("warn", `funder lookup failed for ${r.wallet}: ${(e as Error).message}`);
    }
    await c.progress("funders", ++done, list.length, "finding who funded each wallet");
  });
  // Funders that funded 2+ wallets here: exchange/app or one operator?
  const shared = await db.q<{ funder: string }>(
    "SELECT funder FROM wallets WHERE run_id = $1 AND funder IS NOT NULL GROUP BY funder HAVING COUNT(*) >= 2",
    [c.id],
  );
  let k = 0;
  await mapLimit(shared, 6, async (f) => {
    await c.checkCancel();
    try {
      const s = await cachedIsService(c.rpc, f.funder);
      await db.run("UPDATE wallets SET funder_service = $1 WHERE run_id = $2 AND funder = $3", [s ? 1 : 0, c.id, f.funder]);
    } catch (e) {
      if (fatal(e)) throw e;
      if (!(await c.onBudget(e))) await c.log("warn", `service check failed for ${f.funder}: ${(e as Error).message}`);
    }
    await c.progress("funders", list.length, list.length, `checking shared funders (${++k}/${shared.length})`);
  });
  const found = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM wallets WHERE run_id = $1 AND funder IS NOT NULL", [c.id]);
  await c.log("info", `Funders found for ${found?.n ?? 0} wallets${reused ? ` (${reused} from saved data)` : ""}; ${shared.length} funders are shared by 2+ wallets`);
}

async function stageClusters(c: Ctx) {
  const db = c.db;
  const rows = await db.q<{ wallet: string; role: string; funder: string | null; funder_service: number | null; first_tx_time: number | null }>(
    "SELECT wallet, role, funder, funder_service, first_tx_time FROM wallets WHERE run_id = $1",
    [c.id],
  );
  const mintsBy = new Map<string, string[]>();
  for (const e of await db.q<{ wallet: string; mint: string }>("SELECT wallet, mint FROM early_buys WHERE run_id = $1", [c.id])) {
    const l = mintsBy.get(e.wallet) ?? [];
    l.push(e.mint);
    mintsBy.set(e.wallet, l);
  }
  const facts: WalletFacts[] = rows.map((r) => ({
    wallet: r.wallet,
    funder: r.funder,
    funderService: r.funder_service === 1,
    firstTxTime: r.first_tx_time,
    mints: mintsBy.get(r.wallet) ?? [],
    isDeployer: r.role === "deployer",
  }));
  const { clusters, clusterOf } = buildClusters(facts, c.s);
  await db.tx(async (t) => {
    await t.run("DELETE FROM clusters WHERE run_id = $1", [c.id]);
    await t.run("UPDATE wallets SET cluster_id = NULL WHERE run_id = $1", [c.id]);
    await insertMany(
      t,
      "INSERT INTO clusters (run_id, cluster_id, kind, funders, members, deployers, mints, reason)",
      "",
      8,
      clusters.map((k) => [c.id, k.id, k.kind, JSON.stringify(k.funders), JSON.stringify(k.members), JSON.stringify(k.deployers), JSON.stringify(k.mints), k.reason]),
    );
    for (const [w, id] of clusterOf) await t.run("UPDATE wallets SET cluster_id = $1 WHERE run_id = $2 AND wallet = $3", [id, c.id, w]);
  });
  const byKind = clusters.reduce<Record<string, number>>((a, k) => ((a[k.kind] = (a[k.kind] ?? 0) + 1), a), {});
  await c.log("info", `${clusters.length} wallet groups: ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
}

async function stageHistory(c: Ctx, pastedMints: string[]) {
  const db = c.db;
  const now = c.now();
  type Row = { wallet: string; role: string; hits: number; kind: string | null; history_status: string | null; avg_rank: number | null };
  const rows = await db.q<Row>(
    `SELECT w.wallet, w.role, w.hits, w.history_status, k.kind,
       (SELECT AVG(rank) FROM early_buys e WHERE e.run_id = w.run_id AND e.wallet = w.wallet) AS avg_rank
     FROM wallets w LEFT JOIN clusters k ON k.run_id = w.run_id AND k.cluster_id = w.cluster_id
     WHERE w.run_id = $1 AND w.role IN ('candidate', 'input')`,
    [c.id],
  );
  const insider = (r: Row) => r.kind === "dev-linked" || r.kind === "bundle";
  const eligible = rows
    .filter((r) => !(c.s.historySkipInsiders && insider(r) && r.role !== "input"))
    .sort((a, b) => b.hits - a.hits || (a.avg_rank ?? 1e9) - (b.avg_rank ?? 1e9));
  const cap = c.run.mode === "wallets" ? Math.max(c.s.historyTopK, rows.length) : c.s.historyTopK;
  const chosen = eligible.slice(0, cap);
  const chosenSet = new Set(chosen.map((r) => r.wallet));
  const mark = (status: string, wallet: string) =>
    db.run(
      "UPDATE wallets SET history_status = $1 WHERE run_id = $2 AND wallet = $3 AND (history_status IS NULL OR history_status LIKE 'skipped:%')",
      [status, c.id, wallet],
    );
  for (const r of rows) {
    if (chosenSet.has(r.wallet)) continue;
    await mark(insider(r) && c.s.historySkipInsiders ? "skipped:insider" : "skipped:not in top K", r.wallet);
  }
  type Buy = { wallet: string; mint: string; rank: number; secs_after_create: number | null; block_time: number | null; token_account: string | null };
  const buysBy = new Map<string, Buy[]>();
  for (const b of await db.q<Buy>("SELECT wallet, mint, rank, secs_after_create, block_time, token_account FROM early_buys WHERE run_id = $1", [c.id])) {
    const l = buysBy.get(b.wallet) ?? [];
    l.push(b);
    buysBy.set(b.wallet, l);
  }
  const exclude = new Set(pastedMints);
  const todo = chosen.filter((r) => r.history_status !== "done");
  let done = chosen.length - todo.length;
  let fetchedTxs = 0;
  await c.progress("history", done, chosen.length, "reading trade history", true);
  await mapLimit(todo, 4, async (r) => {
    await c.checkCancel();
    try {
      const h = await cachedHistory(c.rpc, r.wallet, { maxTxs: c.s.historyMaxTxs, adaptive: c.s.adaptiveHistory });
      fetchedTxs += h.newTxs;
      const stats = traderStats(h.events, { excludeMints: exclude, now, openGraceHours: c.s.openGraceHours, txsRead: h.txsRead });
      const onTokens: OnTokenResult[] = [];
      for (const b of buysBy.get(r.wallet) ?? []) {
        let evs = h.events.filter((e) => e.mint === b.mint);
        const covered = h.oldest != null && b.block_time != null && h.oldest <= b.block_time;
        if (!covered && b.token_account) {
          try {
            evs = await tokenAccountEvents(c.rpc, r.wallet, b.mint, b.token_account);
          } catch (e) {
            if (fatal(e)) throw e;
            if (!(await c.onBudget(e))) await c.log("warn", `token-account read failed for ${r.wallet}/${b.mint}: ${(e as Error).message}`);
          }
        }
        const p = buildPositions(evs).find((x) => x.mint === b.mint);
        onTokens.push({
          mint: b.mint,
          rank: b.rank,
          secsAfterCreate: b.secs_after_create,
          status: p?.status ?? "unknown",
          spentSol: p?.spentSol ?? 0,
          proceedsSol: p?.proceedsSol ?? 0,
          pnlSol: p?.pnlSol ?? 0,
          multiple: p ? (p.spentSol > 0 ? p.proceedsSol / p.spentSol : null) : null,
          soldPct: p?.soldPct ?? 0,
          holdMinutes: p?.lastSell != null && p.firstBuy != null ? (p.lastSell - p.firstBuy) / 60 : null,
        });
      }
      const score = traderScore(stats, c.s.minClosedPositions);
      await db.run("UPDATE wallets SET stats = $1, on_tokens = $2, score = $3, history_status = 'done' WHERE run_id = $4 AND wallet = $5", [
        JSON.stringify(stats), JSON.stringify(onTokens), score, c.id, r.wallet,
      ]);
    } catch (e) {
      if (fatal(e)) throw e;
      if (await c.onBudget(e)) await mark("skipped:budget", r.wallet);
      else {
        await c.log("warn", `history failed for ${r.wallet}: ${(e as Error).message}`);
        await db.run("UPDATE wallets SET history_status = 'failed' WHERE run_id = $1 AND wallet = $2", [c.id, r.wallet]);
      }
    }
    await c.progress("history", ++done, chosen.length, "reading trade history");
  });
  const scored = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM wallets WHERE run_id = $1 AND score IS NOT NULL", [c.id]);
  await c.log("info", `Trade history read for ${chosen.length} wallets (${fetchedTxs.toLocaleString()} new transactions fetched); ${scored?.n ?? 0} had enough closed trades to score`);
}

// "How many runners did this wallet catch?" Uses free market data only. Pasted tokens are left out of the
// Runner Score (you picked them because they ran, so everyone early on them looks like a runner-catcher).
async function stageRunners(c: Ctx, pastedMints: string[]) {
  const db = c.db;
  if (!c.deps.market) {
    await c.log("warn", "No market data source: runners are not scored this run.");
    return;
  }
  const now = c.now();
  const wallets = await db.q<{ wallet: string }>("SELECT wallet FROM wallets WHERE run_id = $1 AND history_status = 'done'", [c.id]);
  const positions = new Map<string, ReturnType<typeof buildPositions>>();
  const mintCount = new Map<string, number>();
  const exclude = new Set(pastedMints);
  for (const w of wallets) {
    const evs = (await loadHistoryEvents(w.wallet)) ?? [];
    const ps = buildPositions(evs);
    positions.set(w.wallet, ps);
    for (const p of ps) if (!exclude.has(p.mint) && p.buys > 0) mintCount.set(p.mint, (mintCount.get(p.mint) ?? 0) + 1);
  }
  // Price history is slow (free API). Spend it where it decides most: tokens many of these wallets bought.
  const ordered = [...pastedMints, ...[...mintCount.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)];
  await c.progress("runners", 0, 1, `looking up ${ordered.length} tokens`, true);
  await c.log("info", `Price history from ${c.deps.market.tokenCandles ? `${c.deps.market.tokenCandlesName ?? "token source"} and GeckoTerminal` : "GeckoTerminal only (set BIRDEYE_API_KEY on the worker for faster runs)"}`);
  const solUsd = await ensureSolPrice(c.deps.market);
  // A token is worth a price lookup only if some checked wallet bought it at or under the entry cap (otherwise it
  // cannot be a runner catch for anyone here) or its entry cannot be computed. Pasted tokens always are.
  const positionsByMint = new Map<string, ReturnType<typeof buildPositions>>();
  for (const ps of positions.values()) for (const p of ps) if (p.buys > 0) positionsByMint.set(p.mint, [...(positionsByMint.get(p.mint) ?? []), p]);
  const pastedSet = new Set(pastedMints);
  let skippedEntry = 0;
  const needsHistory = (f: TokenFacts) => {
    if (pastedSet.has(f.mint)) return true;
    const need = (positionsByMint.get(f.mint) ?? []).some((p) => {
      const sol = p.firstBuy != null ? solUsd(p.firstBuy) : null;
      if (!f.supply || !sol || p.boughtTokens <= 0) return true; // cannot tell: look it up
      return (p.spentSol / p.boughtTokens) * sol * f.supply <= c.s.runnerEntryMaxUsd;
    });
    if (!need) skippedEntry++;
    return need;
  };
  const facts = await ensureFacts(c.deps.market, ordered, {
    needsHistory,
    minPeakUsd: c.s.runnerMinPeakUsd,
    maxPeakFetch: c.s.peakLookups,
    onProgress: (d, t, note) => c.progress("runners", d, t, note),
    shouldStop: () => c.checkCancel(),
    onSourceProblem: (msg) => void c.log("warn", `${msg}. Using GeckoTerminal only for the rest of this run.`),
  });
  if (skippedEntry) await c.log("info", `${skippedEntry} tokens skipped for price history: every wallet here bought them above the ${usdShort(c.s.runnerEntryMaxUsd)} entry cap`);

  // Pasted tokens: how big each one got decides how much catching it early counts.
  const weight = new Map<string, number>();
  for (const m of pastedMints) {
    const f = facts.get(m);
    const peak = f ? (peakMcapAfter(f, 0) ?? f.mcapUsd ?? null) : null;
    const w = batchTokenWeight(peak, c.s);
    weight.set(m, w);
    await db.run("UPDATE tokens SET peak_usd = $1, weight = $2 WHERE run_id = $3 AND mint = $4", [peak, w, c.id, m]);
  }
  const hitsBy = new Map<string, number>();
  for (const b of await db.q<{ wallet: string; mint: string }>("SELECT wallet, mint FROM early_buys WHERE run_id = $1", [c.id])) {
    hitsBy.set(b.wallet, (hitsBy.get(b.wallet) ?? 0) + (weight.get(b.mint) ?? 1));
  }
  for (const [wallet, h] of hitsBy) {
    await db.run("UPDATE wallets SET weighted_hits = $1 WHERE run_id = $2 AND wallet = $3", [Math.round(h * 100) / 100, c.id, wallet]);
  }

  let caught = 0;
  for (const w of wallets) {
    const r = runnerStats(positions.get(w.wallet) ?? [], facts, solUsd, c.s, now, exclude);
    if (r.runners > 0) caught++;
    await db.run("UPDATE wallets SET runner = $1, runner_score = $2 WHERE run_id = $3 AND wallet = $4", [JSON.stringify(r), r.score, c.id, w.wallet]);
  }
  const fetched = [...facts.values()].filter((f) => f.peakStatus === "fetched").length;
  await c.log("info", `Runners: ${caught} of ${wallets.length} wallets caught at least one; ${fetched} tokens had price history (free APIs, no credits)`);
}

async function stageFinalize(c: Ctx) {
  const db = c.db;
  const now = c.now();
  const rows = await db.q<{
    wallet: string; role: string; first_tx_time: number | null; first_tx_exact: number | null; funder_service: number | null;
    txs_per_day: number | null; stats: string | null; runner: string | null; score: number | null; history_status: string | null; kind: string | null;
  }>(
    `SELECT w.wallet, w.role, w.first_tx_time, w.first_tx_exact, w.funder_service, w.txs_per_day, w.stats, w.runner, w.score, w.history_status, k.kind
     FROM wallets w LEFT JOIN clusters k ON k.run_id = w.run_id AND k.cluster_id = w.cluster_id WHERE w.run_id = $1`,
    [c.id],
  );
  const buys = new Map<string, { same: boolean; minSecs: number | null; firstBuy: number | null }>();
  for (const b of await db.q<{ wallet: string; same_slot: number; secs_after_create: number | null; block_time: number | null }>(
    "SELECT wallet, same_slot, secs_after_create, block_time FROM early_buys WHERE run_id = $1",
    [c.id],
  )) {
    const cur = buys.get(b.wallet) ?? { same: false, minSecs: null, firstBuy: null };
    cur.same ||= b.same_slot === 1;
    if (b.secs_after_create != null) cur.minSecs = cur.minSecs == null ? b.secs_after_create : Math.min(cur.minSecs, b.secs_after_create);
    if (b.block_time != null) cur.firstBuy = cur.firstBuy == null ? b.block_time : Math.min(cur.firstBuy, b.block_time);
    buys.set(b.wallet, cur);
  }
  await db.tx(async (t) => {
    for (const r of rows) {
      const b = buys.get(r.wallet);
      const stats = json<TraderStats | null>(r.stats, null);
      const runner = json<RunnerStats | null>(r.runner, null);
      const tags = computeTags(
        {
          isDeployer: r.role === "deployer",
          clusterKind: (r.kind as "dev-linked" | "bundle" | "shared-funder" | null) ?? null,
          sameSlot: b?.same ?? false,
          minSecsAfterCreate: b?.minSecs ?? null,
          firstBuyTime: b?.firstBuy ?? null,
          firstTxTime: r.first_tx_time,
          firstTxExact: r.first_tx_exact === 1,
          funderService: r.funder_service === 1,
          txsPerDay: r.txs_per_day,
          botLike: stats?.botLike ?? null,
          scored: r.history_status === "done" ? r.score != null : null,
          runners: runner?.runners ?? null,
          medianCapture: runner?.medianCapture ?? null,
          convictionCount: runner?.convictionCount ?? null,
          medianHoldMin: stats?.medianHoldMin ?? null,
          daysSinceLastTrade: stats?.lastTradeTime != null ? (now - stats.lastTradeTime) / 86400 : null,
        },
        c.s,
      );
      await t.run("UPDATE wallets SET tags = $1 WHERE run_id = $2 AND wallet = $3", [JSON.stringify(tags), c.id, r.wallet]);
    }
  });
}

// ---------- on-demand insider scan ----------

// Traces the funders of every early buyer of one launch, then regroups and retags. Only launch buyers not
// traced before cost credits. The run must not be live: the worker owns a live run's stage list.
export async function requestInsiderScan(runId: number, mint: string): Promise<"queued" | "busy" | "unknown-mint"> {
  const db = await getDb();
  return db.tx(async (t) => {
    const r = await t.one<RunRow>("SELECT * FROM runs WHERE id = $1 FOR UPDATE", [runId]);
    if (!r) return "unknown-mint";
    if (LIVE.includes(r.status)) return "busy";
    const tok = await t.one("SELECT 1 FROM tokens WHERE run_id = $1 AND mint = $2 AND status = 'ok'", [runId, mint]);
    if (!tok) return "unknown-mint";
    const scan = new Set(json<string[]>(r.scan_mints, []));
    scan.add(mint);
    const redo = new Set(["funders", "clusters", "finalize"]);
    const stages = json<string[]>(r.stages_done, []).filter((s) => !redo.has(s));
    await t.run(
      "UPDATE runs SET scan_mints = $1, stages_done = $2, status = 'queued', error = NULL, finished_at = NULL WHERE id = $3",
      [JSON.stringify([...scan]), JSON.stringify(stages), runId],
    );
    await t.run("INSERT INTO run_log (run_id, ts, level, msg) VALUES ($1, $2, 'info', $3)", [runId, Date.now(), `Insider scan requested for ${mint.slice(0, 8)}…`]);
    return "queued";
  });
}

// ---------- recheck runners (free) ----------

// Recomputes runners, weights and tags from saved trade histories and free price data. No Helius credits.
// Used after a price-data fix, or to refresh peaks on an older run.
export async function requestRunnerRecheck(runId: number): Promise<"queued" | "busy" | "missing"> {
  const db = await getDb();
  return db.tx(async (t) => {
    const r = await t.one<RunRow>("SELECT * FROM runs WHERE id = $1 FOR UPDATE", [runId]);
    if (!r) return "missing";
    if (LIVE.includes(r.status)) return "busy";
    const redo = new Set(["runners", "finalize"]);
    const stages = json<string[]>(r.stages_done, []).filter((s) => !redo.has(s));
    await t.run("UPDATE runs SET stages_done = $1, status = 'queued', error = NULL, finished_at = NULL WHERE id = $2", [JSON.stringify(stages), runId]);
    await t.run("INSERT INTO run_log (run_id, ts, level, msg) VALUES ($1, $2, 'info', 'Runner recheck requested (free: saved histories and free price data)')", [runId, Date.now()]);
    return "queued";
  });
}

// ---------- driver ----------

export async function executeRun(runId: number, rpc: Rpc, deps: Deps = {}): Promise<void> {
  const db = await getDb();
  const run = await getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const s = parseSettings(json(run.settings, {}));
  const inputs = json<string[]>(run.inputs, []);
  const c = new Ctx(run, s, rpc, deps, db);
  const stages: readonly Stage[] = run.mode === "wallets" ? WALLET_STAGES : TOKEN_STAGES;
  const doneStages = new Set(json<string[]>(run.stages_done, []));
  if (!(await claimRun(runId))) return; // another process owns it
  await db.run("UPDATE runs SET error = NULL WHERE id = $1", [runId]);
  const beat = setInterval(() => {
    void db.run("UPDATE runs SET heartbeat = $1 WHERE id = $2 AND owner = $3", [Date.now(), runId, PROCESS_ID]).catch(() => {});
  }, 10_000);
  if (doneStages.size === 0) await c.log("info", `Run started: ${inputs.length} ${run.mode}, settings ${run.settings_hash}`);
  else await c.log("info", `Resuming after ${[...doneStages].join(", ")}`);
  try {
    for (const stage of stages) {
      if (doneStages.has(stage)) continue;
      await c.checkCancel(true);
      await c.progress(stage, 0, 1, undefined, true);
      switch (stage) {
        case "launch": await stageLaunch(c, inputs); break;
        case "candidates": await stageCandidates(c); break;
        case "seed": await stageSeed(c, inputs); break;
        case "funders": await stageFunders(c); break;
        case "clusters": await stageClusters(c); break;
        case "history": await stageHistory(c, run.mode === "tokens" ? inputs : []); break;
        case "runners": await stageRunners(c, run.mode === "tokens" ? inputs : []); break;
        case "finalize": await stageFinalize(c); break;
      }
      doneStages.add(stage);
      await db.run("UPDATE runs SET stages_done = $1 WHERE id = $2", [JSON.stringify([...doneStages]), runId]);
    }
    const note = c.budgetHit ? "Finished with the budget reached: some items were skipped." : null;
    await db.run("UPDATE runs SET status = 'done', stage = NULL, finished_at = $1, error = $2, progress = $3 WHERE id = $4", [
      Date.now(), note, JSON.stringify({ stage: "done", done: 1, total: 1, credits: rpc.creditsUsed() }), runId,
    ]);
    await c.log("info", `Done. ${rpc.creditsUsed().toLocaleString()} credits used by this run.`);
  } catch (e) {
    if (e instanceof LostClaimError) return; // someone else is running it now; leave their state alone
    if (e instanceof ShutdownError) {
      await db.run("UPDATE runs SET status = 'queued', owner = NULL, heartbeat = NULL WHERE id = $1 AND owner = $2", [runId, PROCESS_ID]);
      await c.log("warn", "Worker restarting: the run continues from here shortly.");
      return;
    }
    if (e instanceof CancelError) {
      await db.run("UPDATE runs SET status = 'stopped', finished_at = $1, error = 'Stopped by you' WHERE id = $2", [Date.now(), runId]);
      await c.log("warn", "Stopped. Press Resume to continue from where it stopped.");
      return;
    }
    const msg = redact((e as Error).message ?? String(e));
    await db.run("UPDATE runs SET status = 'failed', finished_at = $1, error = $2 WHERE id = $3", [Date.now(), msg, runId]);
    await c.log("error", msg);
  } finally {
    clearInterval(beat);
    await releaseRun(runId);
  }
}
