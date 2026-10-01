import { getDb } from "./db";
import { migrate } from "./migrate";
import { CreditGuard } from "./credits";
import { HeliusClient, heliusUrl } from "./helius";
import { executeRun, log, PROCESS_ID, requestShutdown, STALE_MS } from "./pipeline/run";
import { fetchMarket } from "./market";
import { FreeMarket } from "./tokens";
import { parseSettings } from "./config";
import { json } from "./db";
import { getAppSettings } from "./appSettings";

// The only process that spends Helius credits. One run at a time per worker; several workers are safe (claims
// are atomic, credits are reserved atomically). Stages are resumable, so a restart continues where it stopped.

const TICK_MS = 1500;
const SWEEP_MS = 60 * 60_000;
const BEAT_MS = 15_000;

// The next queued run, or a running one whose owner went silent. FOR UPDATE SKIP LOCKED plus the conditional
// UPDATE make the claim atomic across workers without advisory locks (which break behind a transaction pooler).
export async function claimNext(): Promise<number | null> {
  const db = await getDb();
  const now = Date.now();
  // Cancel requests on runs nobody is executing any more. A live owner handles its own.
  await db.run(
    "UPDATE runs SET status = 'stopped', error = 'Stopped by you', finished_at = $1 WHERE status = 'cancelling' AND (heartbeat IS NULL OR heartbeat < $2)",
    [now, now - STALE_MS],
  );
  // Paused (admin switch): runs already started continue (including takeover of a dead worker's run), queued
  // ones wait. Admin runs carry a higher priority and go first.
  const paused = (await getAppSettings(db)).pauseNewRuns;
  const r = await db.one<{ id: number }>(
    `UPDATE runs SET status = 'running', owner = $1, heartbeat = $2
     WHERE id = (
       SELECT id FROM runs
       WHERE (status = 'queued' AND NOT $4::boolean) OR (status = 'running' AND (heartbeat IS NULL OR heartbeat < $3))
       ORDER BY (status = 'running') DESC, priority DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [PROCESS_ID, now, now - STALE_MS, paused],
  );
  return r?.id ?? null;
}

async function marketSource() {
  if (process.env.ELMON_DEMO_MARKET === "1" && process.env.NODE_ENV !== "production") {
    const { demoMarket } = await import("../scripts/demo-market");
    return demoMarket();
  }
  return new FreeMarket();
}

export async function runOne(id: number): Promise<void> {
  const db = await getDb();
  const row = await db.one<{ settings: string }>("SELECT settings FROM runs WHERE id = $1", [id]);
  if (!row) return;
  if (!heliusUrl()) {
    await db.run("UPDATE runs SET status = 'failed', error = $1, owner = NULL WHERE id = $2", ["HELIUS_API_KEY is not set on the worker.", id]);
    return;
  }
  const s = parseSettings(json(row.settings, {}));
  const guard = await new CreditGuard(id, s.runBudget).init();
  try {
    await executeRun(id, new HeliusClient(guard), { fetchMarket, market: await marketSource() });
  } finally {
    await guard.release().catch((e) => console.error(JSON.stringify({ level: "error", msg: "credit release failed", err: String(e) })));
  }
}

// Expired results go; the chain cache stays. Old unused wallet histories go too, to keep under the free plan's
// 500 MB (they are the only large rows).
export async function sweep(): Promise<{ runs: number; histories: number }> {
  const db = await getDb();
  const now = Date.now();
  const runs = await db.run("DELETE FROM runs WHERE expires_at < $1 AND status NOT IN ('running', 'cancelling')", [now]);
  const keepDays = (await getAppSettings(db)).historyKeepDays;
  const histories = await db.run("DELETE FROM wallet_history WHERE updated_at < $1", [Math.floor(now / 1000) - keepDays * 86400]);
  return { runs, histories };
}

const out = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, worker: PROCESS_ID, ...extra }));

export async function startWorker(o: { signals?: boolean } = {}): Promise<void> {
  const db = await getDb();
  const applied = await migrate(db);
  if (applied.length) out("info", "migrations applied", { applied });
  const g = globalThis as unknown as { __elmonWorker?: boolean };
  if (g.__elmonWorker) return; // one per process (Next dev reloads modules)
  g.__elmonWorker = true;
  out("info", "worker started", { helius: heliusUrl() ? "configured" : "MISSING" });

  let busy = false;
  let stopping = false;
  let current: Promise<void> | null = null;
  let lastSweep = 0;

  const beat = async () => {
    await db.run(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('worker_heartbeat', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify({ worker: PROCESS_ID, helius: !!heliusUrl(), birdeye: !!process.env.BIRDEYE_API_KEY?.trim() }), Date.now()],
    );
  };
  await beat();
  const beatTimer = setInterval(() => void beat().catch(() => {}), BEAT_MS);

  const tick = async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      if (Date.now() - lastSweep > SWEEP_MS) {
        lastSweep = Date.now();
        const r = await sweep();
        if (r.runs || r.histories) out("info", "sweep", r);
      }
      const id = await claimNext();
      if (id != null) {
        out("info", "run claimed", { run: id });
        current = runOne(id);
        await current;
        out("info", "run finished", { run: id });
      }
    } catch (e) {
      out("error", "tick failed", { err: String((e as Error).message ?? e) });
    } finally {
      current = null;
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();

  // Rolling deploys: stop claiming, let the run in hand put itself back in the queue, then exit.
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    out("info", "shutting down", { signal: sig });
    clearInterval(timer);
    requestShutdown();
    await current?.catch(() => {});
    clearInterval(beatTimer);
    await db.close();
    process.exit(0);
  };
  if (o.signals !== false) {
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }
}

export { log };
