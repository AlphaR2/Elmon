// Headless run: npm run cli -- tokens <mint> <mint> ...   or   npm run cli -- wallets <addr> ...
// Options: --set key=value (any RunSettings field), --label "name"
// Reads .env.local. With DATABASE_URL the results land in Supabase (visible in the app); without it they are
// printed and forgotten.
import { loadEnv } from "./env";

loadEnv();
const { createRun, executeRun, getRun } = await import("../lib/pipeline/run");
const { HeliusClient } = await import("../lib/helius");
const { CreditGuard } = await import("../lib/credits");
const { fetchMarket } = await import("../lib/market");
const { FreeMarket } = await import("../lib/tokens");
const { parseAddresses } = await import("../lib/format");
const { parseSettings } = await import("../lib/config");
const { exportRows } = await import("../lib/queries");
const { getDb } = await import("../lib/db");
const { migrate } = await import("../lib/migrate");

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (mode !== "tokens" && mode !== "wallets") {
    console.error("usage: npm run cli -- tokens|wallets <address...> [--set key=value] [--label name]");
    process.exit(1);
  }
  const settings: Record<string, string> = {};
  let label: string | undefined;
  const addrs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--set") {
      const [k, v] = args[++i].split("=");
      settings[k] = v;
    } else if (args[i] === "--label") label = args[++i];
    else addrs.push(args[i]);
  }
  const { valid, invalid } = parseAddresses(addrs.join(" "));
  if (invalid.length) throw new Error(`Not Solana addresses: ${invalid.join(", ")}`);
  const s = parseSettings(settings);
  const db = await getDb();
  if (process.env.DATABASE_URL) await migrate(db);
  const { id } = await createRun(mode, valid, s, { label, claim: true }); // owned by this process from the start
  console.log(`run #${id}: ${valid.length} ${mode}`);
  const guard = await new CreditGuard(id, s.runBudget).init();
  const rpc = new HeliusClient(guard);
  let lastLog = 0;
  let lastLine = "";
  const timer = setInterval(async () => {
    const r = (await getRun(id))!;
    for (const l of await db.q<{ id: number; level: string; msg: string }>("SELECT id, level, msg FROM run_log WHERE run_id = $1 AND id > $2 ORDER BY id", [id, lastLog])) {
      console.log(`[${l.level}] ${l.msg}`);
      lastLog = l.id;
    }
    const p = JSON.parse(r.progress || "{}");
    const line = `  ${p.stage ?? r.status} ${p.done ?? 0}/${p.total ?? "?"} ${p.note ?? ""} (${p.credits ?? 0} credits)`;
    if (line !== lastLine && p.total) console.log(line);
    lastLine = line;
  }, 3000);
  try {
    await executeRun(id, rpc, { fetchMarket, market: new FreeMarket() });
  } finally {
    clearInterval(timer);
    await guard.release();
  }
  const r = (await getRun(id))!;
  console.log(`\n${r.status}${r.error ? `: ${r.error}` : ""}. ${rpc.creditsUsed()} credits.`);
  const top = (await exportRows(id, "traders")).slice(0, 25);
  console.table(top.map((t) => ({ wallet: t.wallet, runner: t.runner_score, runners: t.runners, profit: t.profit_score, net_sol: t.net_sol, hits: t.hits, tags: t.tags })));
  await db.close();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
