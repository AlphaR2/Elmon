import { gunzipSync, gzipSync } from "node:zlib";
import { getDb } from "../db";
import type { Rpc } from "../helius";
import { buildPositions } from "../core/pnl";
import type { EventKind, OwnerEvent } from "../solana/tx";
import { isService, lookupWallet, pullHistory, readLaunch, type Launch, type WalletLookup } from "./fetch";

// The chain cache: parsed facts that are paid for once and reused by every later run, for every user.
// Only finalized data is stored, so nothing here can go stale except where a refresh age is noted.

const DAY = 86_400;
const nowS = () => Math.floor(Date.now() / 1000);
const pack = (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v)));
const unpack = <T>(b: unknown): T => JSON.parse(gunzipSync(Buffer.from(b as Uint8Array)).toString("utf8")) as T;

// ---------- launches ----------

type LaunchSettings = { earlyBuyers: number; maxLaunchTxs: number; maxSignaturePages: number };

// Reused when it was read with at least as many buyers and transactions, or it ran out of launch before the cap
// (there is nothing more to find).
export async function cachedLaunch(rpc: Rpc, mint: string, s: LaunchSettings): Promise<Launch & { cached: boolean }> {
  const db = await getDb();
  const row = await db.one<{ buyers_cap: number; max_txs: number; data: Uint8Array }>(
    "SELECT buyers_cap, max_txs, data FROM launches WHERE mint = $1",
    [mint],
  );
  if (row) {
    const l = unpack<Launch>(row.data);
    const buyers = l.buys.filter((b) => b.rank > 0).length;
    const exhausted = buyers < row.buyers_cap && l.txsRead < row.max_txs;
    if (exhausted || (row.buyers_cap >= s.earlyBuyers && row.max_txs >= s.maxLaunchTxs)) {
      return { ...l, buys: l.buys.filter((b) => b.rank <= s.earlyBuyers), cached: true };
    }
  }
  const l = await readLaunch(rpc, mint, s);
  if (l.status === "ok") {
    await db.run(
      `INSERT INTO launches (mint, buyers_cap, max_txs, data, fetched_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (mint) DO UPDATE SET buyers_cap = excluded.buyers_cap, max_txs = excluded.max_txs, data = excluded.data, fetched_at = excluded.fetched_at`,
      [mint, s.earlyBuyers, s.maxLaunchTxs, pack(l), nowS()],
    );
  }
  return { ...l, cached: false };
}

// ---------- wallet identity ----------

// First transaction and first funder are permanent. Activity is refreshed after a week for 1 credit.
export async function cachedWallet(rpc: Rpc, wallet: string, deep: boolean): Promise<WalletLookup & { cached: boolean }> {
  const db = await getDb();
  const row = await db.one<{
    first_tx_time: number | null; first_tx_exact: number | null; first_tx_sig: string | null; funder: string | null;
    deep: number; txs_per_day: number | null; checked_at: number;
  }>("SELECT * FROM wallet_facts WHERE wallet = $1", [wallet]);
  const t = nowS();
  // Reusable: the funder search went as deep as asked, and the first transaction is exact (permanent) or the
  // lookup is recent (busy wallets whose first transaction could not be reached are retried weekly, not per run).
  const reusable = row && (!deep || row.deep === 1 || row.funder != null) && (row.first_tx_exact === 1 || t - row.checked_at < 7 * DAY);
  if (row && reusable) {
    let txsPerDay = row.txs_per_day;
    if (t - row.checked_at > 7 * DAY && row.first_tx_exact === 1) {
      txsPerDay = await activity(rpc, wallet);
      await db.run("UPDATE wallet_facts SET txs_per_day = $2, checked_at = $3 WHERE wallet = $1", [wallet, txsPerDay, t]);
    }
    return {
      firstTxTime: row.first_tx_time, firstTxExact: row.first_tx_exact === 1, firstTxSig: row.first_tx_sig, funder: row.funder, txsPerDay, cached: true,
    };
  }
  const w = await lookupWallet(rpc, wallet, deep);
  await db.run(
    `INSERT INTO wallet_facts (wallet, first_tx_time, first_tx_exact, first_tx_sig, funder, deep, txs_per_day, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (wallet) DO UPDATE SET first_tx_time = excluded.first_tx_time, first_tx_exact = excluded.first_tx_exact,
       first_tx_sig = excluded.first_tx_sig, funder = COALESCE(excluded.funder, wallet_facts.funder), deep = GREATEST(excluded.deep, wallet_facts.deep),
       txs_per_day = excluded.txs_per_day, checked_at = excluded.checked_at`,
    [wallet, w.firstTxTime, w.firstTxExact ? 1 : 0, w.firstTxSig, w.funder, deep ? 1 : 0, w.txsPerDay, t],
  );
  return { ...w, cached: false };
}

async function activity(rpc: Rpc, wallet: string): Promise<number | null> {
  const sigs = await rpc.getSignatures(wallet, { limit: 1000 });
  if (sigs.length < 2) return null;
  const span = Math.max((sigs[0].blockTime ?? 0) - (sigs[sigs.length - 1].blockTime ?? 0), 3600) / DAY;
  return sigs.length / span;
}

// Exchanges and apps. Rechecked after 30 days.
export async function cachedIsService(rpc: Rpc, address: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.one<{ service: number; checked_at: number }>("SELECT service, checked_at FROM entities WHERE address = $1", [address]);
  if (row && nowS() - row.checked_at < 30 * DAY) return row.service === 1;
  const svc = await isService(rpc, address);
  await db.run(
    `INSERT INTO entities (address, service, checked_at) VALUES ($1, $2, $3)
     ON CONFLICT (address) DO UPDATE SET service = excluded.service, checked_at = excluded.checked_at`,
    [address, svc ? 1 : 0, nowS()],
  );
  return svc;
}

// ---------- wallet history ----------

// Compact event: [slot, blockTime, mint, kind, tokens, decimals, lamports]. PnL needs nothing else.
type Packed = [number, number | null, string, number, string, number, string];
const KINDS: EventKind[] = ["buy", "sell", "transfer_in", "transfer_out"];
const MAX_EVENTS = 6000; // about 1-2 MB of JSON before gzip; keeps one wallet's row small

export const encodeEvents = (evs: OwnerEvent[]): Packed[] =>
  evs.map((e) => [e.slot, e.blockTime, e.mint, KINDS.indexOf(e.kind), e.tokens.toString(), e.decimals, e.lamports.toString()]);
export const decodeEvents = (wallet: string, p: Packed[]): OwnerEvent[] =>
  p.map(([slot, blockTime, mint, k, tokens, decimals, lamports]) => ({
    signature: "", slot, blockTime, owner: wallet, mint, kind: KINDS[k], tokens: BigInt(tokens), decimals, lamports: BigInt(lamports), tokenAccount: "",
  }));

// Worth reading deeper: something in the first 100 transactions already made money.
export function worthDeeper(events: OwnerEvent[]): boolean {
  const closed = buildPositions(events).filter((p) => p.status === "closed");
  return closed.some((p) => (p.multiple ?? 0) >= 2) || closed.reduce((a, p) => a + p.pnlSol, 0) > 0;
}

export interface CachedHistory {
  events: OwnerEvent[];
  txsRead: number;
  oldest: number | null;
  newTxs: number; // transactions actually fetched this time
}

export async function loadHistoryEvents(wallet: string): Promise<OwnerEvent[] | null> {
  const db = await getDb();
  const row = await db.one<{ events: Uint8Array }>("SELECT events FROM wallet_history WHERE wallet = $1", [wallet]);
  return row ? decodeEvents(wallet, unpack<Packed[]>(row.events)) : null;
}

// Incremental: a wallet read before only has its newer transactions fetched. Adaptive: a wallet that shows
// nothing worth following in its first 100 transactions is not read deeper.
export async function cachedHistory(rpc: Rpc, wallet: string, s: { maxTxs: number; adaptive: boolean }): Promise<CachedHistory> {
  const db = await getDb();
  const row = await db.one<{
    newest_sig: string | null; newest_time: number | null; oldest_time: number | null; txs_read: number; depth: number;
    complete: number; events: Uint8Array;
  }>("SELECT * FROM wallet_history WHERE wallet = $1", [wallet]);
  const keepGoing = s.adaptive ? worthDeeper : undefined;

  let events: OwnerEvent[];
  let txsRead: number, oldest: number | null, depth: number, complete: boolean;
  let newestSig: string | null, newestTime: number | null;
  let fetched = 0;

  const cached = row ? decodeEvents(wallet, unpack<Packed[]>(row.events)) : null;
  const deepEnough = row && (row.complete === 1 || row.depth >= s.maxTxs || (s.adaptive && !worthDeeper(cached!)));
  if (row && cached && deepEnough) {
    const h = await pullHistory(rpc, wallet, s.maxTxs, { stopAt: { sig: row.newest_sig, time: row.newest_time } });
    fetched = h.txsRead;
    if (h.hitCursor || h.txsRead === 0) {
      events = [...h.events, ...cached];
      txsRead = row.txs_read + h.txsRead;
      oldest = row.oldest_time ?? h.oldest;
      newestSig = h.newestSig ?? row.newest_sig;
      newestTime = h.newestTime ?? row.newest_time;
      depth = row.depth;
      complete = row.complete === 1;
    } else {
      // More new transactions than the depth: the window moved past the cached part entirely.
      ({ events, txsRead, oldest, newestSig, newestTime } = h);
      depth = s.maxTxs;
      complete = h.complete;
    }
    // Adaptive wallets that started paying off earn a full read.
    if (s.adaptive && !complete && depth < s.maxTxs && worthDeeper(events)) {
      const full = await pullHistory(rpc, wallet, s.maxTxs);
      fetched += full.txsRead;
      ({ events, txsRead, oldest, newestSig, newestTime } = full);
      depth = s.maxTxs;
      complete = full.complete;
    }
  } else {
    const h = await pullHistory(rpc, wallet, s.maxTxs, { keepGoing });
    fetched = h.txsRead;
    ({ events, txsRead, oldest, newestSig, newestTime } = h);
    depth = h.stoppedEarly ? h.txsRead : s.maxTxs;
    complete = h.complete;
  }
  if (events.length > MAX_EVENTS) {
    events = events.slice(0, MAX_EVENTS); // newest first: drop the oldest
    complete = false;
    oldest = events.reduce<number | null>((m, e) => (e.blockTime != null && (m == null || e.blockTime < m) ? e.blockTime : m), null);
  }
  await db.run(
    `INSERT INTO wallet_history (wallet, newest_sig, newest_time, oldest_time, txs_read, depth, complete, events, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (wallet) DO UPDATE SET newest_sig = excluded.newest_sig, newest_time = excluded.newest_time, oldest_time = excluded.oldest_time,
       txs_read = excluded.txs_read, depth = excluded.depth, complete = excluded.complete, events = excluded.events, updated_at = excluded.updated_at`,
    [wallet, newestSig, newestTime, oldest, txsRead, depth, complete ? 1 : 0, pack(encodeEvents(events)), nowS()],
  );
  return { events, txsRead, oldest, newTxs: fetched };
}
