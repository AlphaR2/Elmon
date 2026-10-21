// Admin CLI, no network: judges the wallet list from saved histories only (wallet_history).
//   npx tsx scripts/realized-report.ts --candidates c.txt --control k.txt --from <unix> --to <unix> --split-at <unix>
//        [--exclude-mints A,B] [--min-closed 5] [--out report.md]
// Wallet files: one address per line. Cut both sides to the same window, rank on events before --split-at, score the
// same wallets on events after it, count operators (not wallets), print the verdict from docs/wallet-list-contract.md.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { traderStats, type TraderStats } from "../lib/core/pnl";
import { buildOperators } from "../lib/core/operators";
import { rankRealized } from "../lib/core/rank";
import { walletListVerdict } from "../lib/core/verdict";
import { cutToWindow, splitAt } from "../lib/core/window";
import type { OperatorInput, OperatorOutcome } from "../lib/core/walletList.types";
import type { OwnerEvent } from "../lib/solana/tx";

export const MIN_HELD_OUT_CLOSED = 3;

export interface SavedHistory {
  events: OwnerEvent[];
  complete: boolean;
}
export type HistoryLoader = (wallet: string) => Promise<SavedHistory | null>;

export interface ReportInput {
  candidates: string[];
  control: string[];
  from: number;
  to: number;
  splitAt: number;
  excludeMints?: string[];
  minClosed?: number;
  load: HistoryLoader;
}

interface SideResult {
  steps: { label: string; n: number }[];
  ranked: { wallet: string; stats: TraderStats; operatorId: string | null }[];
  outcomes: OperatorOutcome[];
  window: { from: number; to: number };
  droppedByReason: Record<string, number>;
}

const unique = (xs: string[]) => [...new Set(xs)];
const f = (n: number | null | undefined, d = 2) => (n == null ? "not measured" : n.toFixed(d));
const pct = (n: number | null) => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const iso = (t: number) => new Date(t * 1000).toISOString();

async function evaluateSide(wallets: string[], r: ReportInput, minClosed: number): Promise<SideResult> {
  const exclude = new Set(r.excludeMints ?? []);
  const steps: SideResult["steps"] = [{ label: "listed", n: wallets.length }];
  const window = { from: r.from, to: r.to };
  const covered: { wallet: string; events: OwnerEvent[]; complete: boolean }[] = [];
  let withHistory = 0;
  for (const wallet of wallets) {
    const h = await r.load(wallet);
    if (!h) continue;
    withHistory++;
    const times = h.events.map((e) => e.blockTime).filter((t): t is number => t != null);
    const oldest = times.length ? Math.min(...times) : null;
    // A wallet whose saved history does not reach `from` (and is not complete) says nothing about the window.
    if (!h.complete && (oldest == null || oldest > r.from)) continue;
    covered.push({ wallet, events: cutToWindow(h.events, window), complete: h.complete });
  }
  steps.push({ label: "with saved history", n: withHistory }, { label: "covering the window", n: covered.length });

  const opts = { now: r.to, openGraceHours: 0, excludeMints: exclude };
  const evidence = covered.map((c) => {
    const { before, after } = splitAt(c.events, r.splitAt);
    return {
      wallet: c.wallet,
      before,
      after,
      stats: traderStats(before, { ...opts, txsRead: before.length, historyComplete: c.complete }),
    };
  });
  const rankedRes = rankRealized(evidence.map((e) => ({ wallet: e.wallet, stats: e.stats })), { minClosed });
  const droppedByReason: Record<string, number> = { "too-few-closed": 0, bot: 0, "top-trade": 0 };
  for (const d of rankedRes.dropped) droppedByReason[d.reason]++;
  const after = (reason: string) => droppedByReason[reason];
  const afterMin = covered.length - after("too-few-closed");
  steps.push(
    { label: `at least ${minClosed} closed`, n: afterMin },
    { label: "not bot", n: afterMin - after("bot") },
    { label: "not top-trade", n: rankedRes.ranked.length },
  );

  const byWallet = new Map(evidence.map((e) => [e.wallet, e]));
  const opInputs: OperatorInput[] = rankedRes.ranked.map((x) => ({
    wallet: x.wallet,
    clusterId: null, // no funding graph in saved histories: only the trade signature applies here
    botLike: x.stats.botLike,
    buys: byWallet.get(x.wallet)!.before.filter((e) => e.kind === "buy" && e.blockTime != null && !exclude.has(e.mint)).map((e) => ({ mint: e.mint, time: e.blockTime as number })),
  }));
  const operators = buildOperators(opInputs);
  const opOf = new Map<string, string>();
  for (const o of operators) for (const w of o.wallets) opOf.set(w, o.operatorId);
  steps.push({ label: "operators", n: operators.length });

  const outcomes: OperatorOutcome[] = operators.map((o) => {
    let net = 0, closed = 0;
    for (const w of o.wallets) {
      const held = traderStats(byWallet.get(w)!.after, { ...opts, txsRead: byWallet.get(w)!.after.length });
      net += held.netSol;
      closed += held.closed;
    }
    return { operatorId: o.operatorId, heldOutNetSol: net, heldOutClosed: closed, success: net > 0 && closed >= MIN_HELD_OUT_CLOSED };
  });
  return {
    steps,
    ranked: rankedRes.ranked.map((x) => ({ wallet: x.wallet, stats: x.stats, operatorId: opOf.get(x.wallet) ?? null })),
    outcomes,
    window,
    droppedByReason,
  };
}

export async function buildReport(r: ReportInput) {
  if (!(r.from < r.splitAt && r.splitAt < r.to)) throw new Error("Need --from < --split-at < --to (unix seconds).");
  const minClosed = r.minClosed ?? 5;
  const candidates = unique(r.candidates);
  const cand = new Set(candidates);
  const controlAll = unique(r.control);
  const control = controlAll.filter((w) => !cand.has(w)); // a control never contains a candidate
  const removed = controlAll.length - control.length;
  const [c, k] = await Promise.all([evaluateSide(candidates, r, minClosed), evaluateSide(control, r, minClosed)]);
  const verdict = walletListVerdict(c.outcomes, k.outcomes);

  const L: string[] = [];
  L.push("# Realized wallet list report", "");
  L.push(`Verdict: **${verdict.verdict}**`, "");
  L.push("This shows what each wallet realized in its own saved history. It is not what a follower would have made, and not advice.", "");
  L.push(`- Window (same for both sides): ${iso(r.from)} to ${iso(r.to)}`);
  L.push(`- Ranked on events before ${iso(r.splitAt)}; scored on events after it (held-out half).`);
  L.push(`- Excluded mints: ${(r.excludeMints ?? []).join(", ") || "none"}`);
  L.push(`- Success per operator: held-out net SOL above 0 with at least ${MIN_HELD_OUT_CLOSED} closed positions. The count is operators, not wallets.`);
  L.push(`- Control wallets removed because they are also candidates: ${removed}`);
  L.push("- No network was used: saved histories only (0 credits).", "");
  L.push("## Wilson 95% intervals", "", "| side | operators | successes | rate | low | high |", "|---|---|---|---|---|---|");
  for (const [n, w] of [["candidates", verdict.candidate], ["control", verdict.control]] as const) {
    L.push(`| ${n} | ${w.n} | ${w.successes} | ${pct(w.rate)} | ${pct(w.lo)} | ${pct(w.hi)} |`);
  }
  L.push("", "## Wallets left at every filter step", "", "| step | candidates | control |", "|---|---|---|");
  c.steps.forEach((s, i) => L.push(`| ${s.label} | ${s.n} | ${k.steps[i]?.n ?? 0} |`));
  const dist = new Map(c.outcomes.map((o) => [o.operatorId, o]));
  L.push("", "## Top 20 candidates (by net SOL before the split)", "");
  L.push("| # | wallet | net SOL | closed | top-trade share | excluded SOL | txs read | median hold (min) | operator | held-out net SOL |", "|---|---|---|---|---|---|---|---|---|---|");
  c.ranked.slice(0, 20).forEach((x, i) => {
    const s = x.stats;
    const ho = x.operatorId ? dist.get(x.operatorId) : undefined;
    L.push(`| ${i + 1} | ${x.wallet} | ${f(s.netSol)} | ${s.closed} | ${s.topTradeShare == null ? "n/a" : s.topTradeShare.toFixed(2)} | ${f(s.excludedProfitSol)} | ${s.txsRead} | ${f(s.medianHoldMin, 1)} | ${x.operatorId ?? "none"} | ${ho ? f(ho.heldOutNetSol) : "n/a"} |`);
  });
  L.push("", `Distinct operators beside wallets: ${c.ranked.length} wallets, ${c.outcomes.length} operators.`, "");
  return { verdict, candidates: c, control: k, removedFromControl: removed, markdown: L.join("\n") };
}

// ---------- CLI ----------

export class ReportArgError extends Error {}

export function parseArgs(argv: string[]) {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new ReportArgError(`Unexpected argument "${a.slice(0, 40)}".`);
    const key = a.slice(2);
    if (!["candidates", "control", "from", "to", "split-at", "exclude-mints", "min-closed", "out"].includes(key)) throw new ReportArgError(`Unknown option --${key.slice(0, 40)}.`);
    const v = argv[++i];
    if (v == null || v.startsWith("--")) throw new ReportArgError(`--${key} needs a value.`);
    o[key] = v;
  }
  const num = (k: string) => {
    const n = Number(o[k]);
    if (!o[k] || !Number.isInteger(n) || n <= 0) throw new ReportArgError(`--${k} must be a positive whole number of unix seconds.`);
    return n;
  };
  if (!o.candidates || !o.control) throw new ReportArgError("--candidates and --control (wallet list files) are required.");
  const minClosed = o["min-closed"] == null ? 5 : Number(o["min-closed"]);
  if (!Number.isInteger(minClosed) || minClosed < 1) throw new ReportArgError("--min-closed must be a whole number of at least 1.");
  const mints = (o["exclude-mints"] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  for (const m of mints) if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m) && !/^[A-Za-z0-9]{1,12}$/.test(m)) throw new ReportArgError(`Not a mint address: "${m.slice(0, 20)}".`);
  return { candidates: o.candidates, control: o.control, from: num("from"), to: num("to"), splitAt: num("split-at"), excludeMints: mints, minClosed, out: o.out };
}

export const MAX_WALLETS_PER_FILE = 5000;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function readWalletFile(path: string): string[] {
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length > MAX_WALLETS_PER_FILE) throw new ReportArgError(`${path}: more than ${MAX_WALLETS_PER_FILE} wallets.`);
  const bad = lines.find((l) => !ADDRESS.test(l));
  if (bad) throw new ReportArgError(`${path}: "${bad.slice(0, 20)}" is not a wallet address.`);
  return lines;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const a = parseArgs(argv);
    const { getDb } = await import("../lib/db");
    const { loadHistoryEvents } = await import("../lib/pipeline/cache");
    const db = await getDb();
    const load: HistoryLoader = async (wallet) => {
      const events = await loadHistoryEvents(wallet);
      if (!events) return null;
      const row = await db.one<{ complete: number }>("SELECT complete FROM wallet_history WHERE wallet = $1", [wallet]);
      return { events, complete: row?.complete === 1 };
    };
    const res = await buildReport({ ...a, candidates: readWalletFile(a.candidates), control: readWalletFile(a.control), load });
    if (a.out) fs.writeFileSync(a.out, res.markdown);
    console.log(res.markdown);
    await db.close();
    return 0;
  } catch (e) {
    console.error((e as Error).message ?? String(e));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadEnv } = await import("./env");
  loadEnv();
  process.exit(await main(process.argv.slice(2)));
}
