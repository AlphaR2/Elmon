// Cost probe: run the real pipeline on 3 to 5 token mints and write a markdown report of what it cost in Helius
// credits, plus the early buyers it found (entry time and market cap) so they can be spot-checked on Solscan.
//   npm run live-check -- <mint> <mint> <mint> [--out report.md] [--budget 15000] [--show 10] [--set key=value]
// Needs HELIUS_API_KEY (or HELIUS_RPC_URL) in .env.local. Without it the script stops before anything else happens.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./env";
import { createRun, executeRun, getRun } from "../lib/pipeline/run";
import { HeliusClient, heliusUrl, redact, type Rpc } from "../lib/helius";
import { CreditGuard, MONTH_CAP_SHARE, monthlyLimit } from "../lib/credits";
import { fetchMarket } from "../lib/market";
import { FreeMarket, ensureSolPrice, loadFacts, type MarketSource } from "../lib/tokens";
import { parseAddresses } from "../lib/format";
import { parseSettings } from "../lib/config";
import { getDb } from "../lib/db";
import { migrate } from "../lib/migrate";
import type { MarketInfo } from "../lib/market";

export const MIN_MINTS = 3;
export const MAX_MINTS = 5;

export class LiveCheckError extends Error {}

// The key check comes first and does not touch the network, the database or HeliusClient.
export function requireHeliusUrl(): string {
  const url = heliusUrl();
  if (!url) {
    throw new LiveCheckError("HELIUS_API_KEY is not set. Put it (or HELIUS_RPC_URL) in .env.local, then run this again. Nothing was called.");
  }
  return url;
}

export interface LiveCheckInput {
  mints: string[];
  rpcFor: (guard: CreditGuard) => Rpc; // built after the run exists, so the ledger rows carry its id
  settings?: unknown; // RunSettings overrides
  deps?: { fetchMarket?: (mints: string[]) => Promise<Map<string, MarketInfo>>; market?: MarketSource; now?: () => number };
  budget?: number; // credit cap for this run; defaults to the runBudget setting (whose lowest allowed value is 100)
  show?: number; // early buyers listed per token
  secrets?: string[]; // strings that must never appear in the report
  usingDatabaseUrl?: boolean;
}

export interface LiveCheckResult {
  markdown: string;
  runId: number;
  status: string;
  ledgerTotal: number;
  stageSum: number;
  counterTotal: number;
  budgetHit: boolean;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const usd = (n: number | null) => (n == null ? "n/a" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${fmt(n)}`);
const iso = (t: number | null) => (t == null ? "n/a" : new Date(t * 1000).toISOString().replace(".000Z", "Z"));
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Runs the pipeline through the same path as scripts/cli.ts and builds the report. Spends credits only through
// the client `rpcFor` returns (the real one in main(), one over a fake node in tests).
export async function runLiveCheck(o: LiveCheckInput): Promise<LiveCheckResult> {
  const db = await getDb();
  const settings = parseSettings(o.settings ?? {});
  const { id } = await createRun("tokens", o.mints, settings, { label: "live-check", claim: true });
  const budget = o.budget ?? settings.runBudget;
  const guard = await new CreditGuard(id, budget).init();
  const rpc = o.rpcFor(guard);
  try {
    await executeRun(id, rpc, o.deps ?? {});
  } finally {
    await guard.release(); // writes the ledger and returns unspent reservation
  }
  const run = (await getRun(id))!;

  // ---- credits ----
  const ledger = await db.q<{ stage: string | null; method: string; calls: number; credits: number }>(
    "SELECT stage, method, SUM(calls) AS calls, SUM(credits) AS credits FROM credit_ledger WHERE run_id = $1 GROUP BY stage, method ORDER BY stage, method",
    [id],
  );
  const ledgerTotal = Number((await db.one<{ c: number }>("SELECT COALESCE(SUM(credits), 0) AS c FROM credit_ledger WHERE run_id = $1", [id]))?.c ?? 0);
  const byStage = new Map<string, { calls: number; credits: number }>();
  for (const r of ledger) {
    const k = r.stage ?? "(none)";
    const cur = byStage.get(k) ?? { calls: 0, credits: 0 };
    cur.calls += Number(r.calls);
    cur.credits += Number(r.credits);
    byStage.set(k, cur);
  }
  const stageSum = [...byStage.values()].reduce((a, s) => a + s.credits, 0);
  const counterTotal = rpc.creditsUsed();
  const budgetHit = /budget/i.test(run.error ?? "") || (await db.q("SELECT 1 FROM run_log WHERE run_id = $1 AND msg LIKE '%budget%'", [id])).length > 0;

  const tokensRead = Number((await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM tokens WHERE run_id = $1 AND status = 'ok'", [id]))?.n ?? 0);
  const walletsRead = Number((await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM wallets WHERE run_id = $1 AND history_status = 'done'", [id]))?.n ?? 0);
  const perToken = tokensRead ? ledgerTotal / tokensRead : null;
  const launchCredits = byStage.get("launch")?.credits ?? 0;
  const historyCredits = byStage.get("history")?.credits ?? 0;
  const monthly = await monthlyLimit(db);
  const usable = Math.floor(monthly * MONTH_CAP_SHARE);

  const L: string[] = [];
  L.push(`# Live check: ${o.mints.length} tokens`, "");
  L.push(`- Run #${id}, status **${run.status}**${run.error ? `, note: ${run.error}` : ""}`);
  L.push(`- Tokens: ${o.mints.map((m) => `\`${m}\``).join(", ")}`);
  L.push(`- Settings: earlyBuyers ${settings.earlyBuyers}, historyTopK ${settings.historyTopK}, historyMaxTxs ${settings.historyMaxTxs}, adaptiveHistory ${settings.adaptiveHistory}, run budget ${fmt(budget)} credits`);
  L.push("");
  L.push("## Credits per stage", "", "| Stage | Calls | Credits |", "|---|---:|---:|");
  for (const [stage, v] of byStage) L.push(`| ${stage} | ${fmt(v.calls)} | ${fmt(v.credits)} |`);
  L.push(`| **Total** | | **${fmt(stageSum)}** |`, "");
  L.push("By method:", "", "| Stage | Method | Calls | Credits |", "|---|---|---:|---:|");
  for (const r of ledger) L.push(`| ${r.stage ?? "(none)"} | ${r.method} | ${fmt(Number(r.calls))} | ${fmt(Number(r.credits))} |`);
  L.push("");

  L.push("## Checks", "");
  const match = ledgerTotal === stageSum && stageSum === counterTotal;
  L.push(`- Ledger total (${fmt(ledgerTotal)}) ${ledgerTotal === stageSum ? "equals" : "DOES NOT equal"} the sum of the per-stage rows (${fmt(stageSum)}); the client's own counter says ${fmt(counterTotal)}. **${match ? "All three agree." : "MISMATCH: do not trust this report's totals."}**`);
  if (budgetHit) {
    L.push(`- The run **stopped at its budget** of ${fmt(budget)} credits (used ${fmt(counterTotal)}). Some items were skipped, so the costs below are a floor, not the full cost.`);
  } else {
    L.push(`- The run finished inside its budget of ${fmt(budget)} credits (used ${fmt(counterTotal)}).`);
  }
  L.push("");

  L.push("## Cost per token and per wallet history", "");
  L.push(`These are **derived averages**, not per-call measurements: the ledger is written per stage and method, not per token or wallet.`, "");
  L.push(`- Credits per token (all stages / ${tokensRead} tokens read): **${perToken == null ? "n/a" : fmt(perToken)}**`);
  L.push(`- Launch stage per token (${fmt(launchCredits)} / ${tokensRead}): ${tokensRead ? fmt(launchCredits / tokensRead) : "n/a"}`);
  L.push(`- Credits per wallet history (history stage ${fmt(historyCredits)} / ${walletsRead} wallets read): **${walletsRead ? fmt(historyCredits / walletsRead) : "n/a"}**, sample size ${walletsRead}`);
  L.push(`- Min, median and max per wallet: **cannot be measured here**. History reads are adaptive (100 transactions first, deeper only for wallets that look profitable), so the average is skewed toward the cheap wallets, and the ledger has no per-wallet rows.`);
  L.push(`- A rerun of the same tokens costs less: wallet histories, launches and funders are cached and only refreshed. This is the cold cost.`, "");

  L.push("## Tokens per month", "");
  if (perToken == null || perToken <= 0) L.push("- Not computable: no token was read.");
  else {
    L.push(`- Plan: ${fmt(monthly)} credits a month, runs stop at ${Math.round(MONTH_CAP_SHARE * 100)}% (${fmt(usable)}). At ${fmt(perToken)} credits per token that is about **${fmt(Math.floor(usable / perToken))} tokens a month** at cold cost.`);
  }
  L.push(
    o.usingDatabaseUrl
      ? `- The monthly figure comes from the plan setting (app_config or HELIUS_MONTHLY_CREDITS), not from real usage so far this month.`
      : `- DATABASE_URL is not set, so the month counter is an in-memory one that started at 0: the plan size comes from HELIUS_MONTHLY_CREDITS (default 1,000,000), **not from real usage**. Check the Helius dashboard for what is left.`,
    "",
  );

  // ---- early buyers ----
  const facts = await loadFacts(o.mints, db);
  const solAt = o.deps?.market ? await ensureSolPrice(o.deps.market) : () => null;
  const show = o.show ?? 10;
  L.push("## Early buyers (spot-check on Solscan)", "");
  L.push(`Entry market cap = price paid per token x today's supply x SOL price on the day. Supply is today's, so a token that burned or minted since will be off. First ${show} buyers per token.`, "");
  type EB = { wallet: string; rank: number; sig: string; block_time: number | null; secs_after_create: number | null; sol: number; tokens: number; same_slot: number };
  for (const mint of o.mints) {
    const tok = await db.one<{ status: string; note: string | null; symbol: string | null; created_at: number | null; deployer: string | null; buyers: number | null }>(
      "SELECT status, note, symbol, created_at, deployer, buyers FROM tokens WHERE run_id = $1 AND mint = $2",
      [id, mint],
    );
    const f = facts.get(mint);
    L.push(`### ${tok?.symbol ?? f?.symbol ?? mint.slice(0, 8)} · [\`${mint}\`](https://solscan.io/token/${mint})`, "");
    if (!tok || tok.status !== "ok") {
      L.push(`Not read: ${tok?.status ?? "missing"}${tok?.note ? ` (${tok.note})` : ""}`, "");
      continue;
    }
    L.push(`Created ${iso(tok.created_at)}, deployer ${tok.deployer ? `[\`${tok.deployer}\`](https://solscan.io/account/${tok.deployer})` : "n/a"}, ${tok.buyers ?? 0} early buyers found, supply ${f?.supply ? fmt(f.supply) : "n/a"}`, "");
    const buys = await db.q<EB>(
      "SELECT wallet, rank, sig, block_time, secs_after_create, sol, tokens, same_slot FROM early_buys WHERE run_id = $1 AND mint = $2 ORDER BY rank LIMIT $3",
      [id, mint, show],
    );
    L.push("| # | Wallet | Entry time (UTC) | After create | SOL | Entry mcap | Tx |", "|---:|---|---|---:|---:|---:|---|");
    for (const b of buys) {
      const px = Number(b.tokens) > 0 ? Number(b.sol) / Number(b.tokens) : null;
      const sol = b.block_time != null ? solAt(b.block_time) : null;
      const mcap = px != null && f?.supply && sol ? px * f.supply * sol : null;
      L.push(
        `| ${b.rank} | [\`${b.wallet}\`](https://solscan.io/account/${b.wallet}) | ${iso(b.block_time)} | ${b.secs_after_create == null ? "n/a" : `${b.secs_after_create}s`}${b.same_slot ? " (same slot)" : ""} | ${Number(b.sol).toFixed(3)} | ${usd(mcap)} | [tx](https://solscan.io/tx/${b.sig}) |`,
      );
    }
    L.push("");
  }
  const times = (await db.q<{ s: number | null }>("SELECT secs_after_create AS s FROM early_buys WHERE run_id = $1", [id])).map((r) => r.s).filter((x): x is number => x != null);
  const med = median(times);
  if (med != null) L.push(`Median entry across all early buyers: ${Math.round(med)}s after creation.`, "");

  let markdown = L.join("\n");
  for (const s of o.secrets ?? []) if (s) markdown = markdown.split(s).join("***");
  markdown = redact(markdown);
  return { markdown, runId: id, status: run.status, ledgerTotal, stageSum, counterTotal, budgetHit };
}

// ---------- command line ----------

export interface ParsedArgs {
  mints: string[];
  out: string;
  show: number;
  settings: Record<string, string>;
}

export function parseArgs(argv: string[], now = new Date()): ParsedArgs {
  const settings: Record<string, string> = {};
  const addrs: string[] = [];
  let out = `live-check-${now.toISOString().replace(/[:.]/g, "-")}.md`;
  let show = 10;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new LiveCheckError(`${a} needs a value`);
      return v;
    };
    if (a === "--out") out = val();
    else if (a === "--budget") settings.runBudget = val();
    else if (a === "--show") {
      show = Number(val());
      if (!Number.isInteger(show) || show < 1 || show > 100) throw new LiveCheckError("--show must be a whole number from 1 to 100");
    } else if (a === "--set") {
      const kv = val();
      const eq = kv.indexOf("=");
      if (eq < 1) throw new LiveCheckError(`--set needs key=value, got "${kv}"`);
      settings[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith("--")) throw new LiveCheckError(`Unknown option ${a}`);
    else addrs.push(a);
  }
  const { valid, invalid } = parseAddresses(addrs.join(" "));
  if (invalid.length) throw new LiveCheckError(`Not Solana addresses: ${invalid.join(", ")}`);
  if (valid.length < MIN_MINTS || valid.length > MAX_MINTS) {
    throw new LiveCheckError(`Give ${MIN_MINTS} to ${MAX_MINTS} token mints, got ${valid.length}. Usage: npm run live-check -- <mint> <mint> <mint> [--out file.md] [--budget N] [--show N]`);
  }
  return { mints: valid, out, show, settings };
}

// Returns the exit code. Env loading is done by the caller, so tests control the environment.
export async function main(argv: string[]): Promise<number> {
  let url: string;
  try {
    url = requireHeliusUrl(); // first: no key, no further step
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const secrets = [url, new URL(url).searchParams.get("api-key") ?? "", process.env.HELIUS_API_KEY?.trim() ?? ""].filter((s) => s.length > 6);
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const db = await getDb();
  try {
    if (process.env.DATABASE_URL) await migrate(db);
    const res = await runLiveCheck({
      mints: args.mints,
      rpcFor: (guard) => new HeliusClient(guard),
      settings: args.settings,
      show: args.show,
      secrets,
      usingDatabaseUrl: !!process.env.DATABASE_URL,
      deps: { fetchMarket, market: new FreeMarket() },
    });
    fs.writeFileSync(args.out, res.markdown);
    console.log(`${res.status}. ${res.counterTotal.toLocaleString("en-US")} credits. Report: ${args.out}`);
    if (!(res.ledgerTotal === res.stageSum && res.stageSum === res.counterTotal)) console.error("WARNING: ledger and counter disagree; see the report.");
    return res.status === "done" ? 0 : 2;
  } catch (e) {
    console.error(redact((e as Error).message ?? String(e)));
    return 1;
  } finally {
    await db.close();
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  loadEnv();
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(redact((e as Error).message ?? String(e)));
      process.exit(1);
    },
  );
}
