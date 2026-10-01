import { BudgetError, UnsupportedError, type Rpc, type SigInfo } from "../helius";
import { funderFromTx, LAUNCHPADS, mintEvents, normalizeTx, ownerEvents, type OwnerEvent, type RawTx, type Tx } from "../solana/tx";

export interface EarlyBuy {
  wallet: string;
  rank: number; // 0 = deployer
  sig: string;
  slot: number;
  blockTime: number | null;
  secsAfterCreate: number | null;
  sol: number;
  tokens: number;
  tokenAccount: string;
  sameSlot: boolean;
}

export interface Launch {
  status: "ok" | "skipped" | "failed";
  note?: string;
  deployer: string | null;
  createdAt: number | null;
  createSig: string | null;
  createSlot: number | null;
  launchpad: string | null;
  txsRead: number;
  buys: EarlyBuy[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Oldest transactions touching the mint, oldest first, until `enough` says stop.
async function oldestTxs(
  rpc: Rpc,
  address: string,
  maxTxs: number,
  maxPages: number,
  enough: (txs: Tx[]) => boolean,
): Promise<{ txs: Tx[]; skipped?: string }> {
  const txs: Tx[] = [];
  if (rpc.hasTxsForAddress()) {
    try {
      let token: string | null = null;
      do {
        const page = await rpc.txsForAddress(address, { sortOrder: "asc", limit: 100, paginationToken: token });
        for (const raw of page.data) {
          const t = normalizeTx(raw);
          if (t) txs.push(t);
        }
        token = page.paginationToken;
        if (page.data.length < 100) break;
      } while (token && txs.length < maxTxs && !enough(txs));
      return { txs };
    } catch (e) {
      if (!(e instanceof UnsupportedError)) throw e;
    }
  }
  // Fallback: walk signatures newest -> oldest to the start, then read the oldest ones.
  const sigs: SigInfo[] = [];
  let before: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= maxPages) return { txs: [], skipped: `launch is more than ${maxPages * 1000} transactions back` };
    const batch = await rpc.getSignatures(address, { before, limit: 1000 });
    if (batch.length === 0) break;
    sigs.push(...batch);
    before = batch[batch.length - 1].signature;
  }
  const oldest = sigs.reverse().filter((s) => !s.err);
  for (let i = 0; i < oldest.length && txs.length < maxTxs; i += 20) {
    const chunk = oldest.slice(i, Math.min(i + 20, oldest.length));
    const raws = await mapLimit(chunk, 6, (s) => rpc.getTransaction(s.signature));
    for (const raw of raws) {
      const t = raw ? normalizeTx(raw) : null;
      if (t) txs.push(t);
    }
    if (enough(txs)) break;
  }
  return { txs };
}

export function parseLaunch(mint: string, txs: Tx[], earlyBuyers: number): Omit<Launch, "status" | "note"> {
  // Block order: slot, then position in the block when known (stable sort keeps node order otherwise).
  const ok = txs.filter((t) => !t.failed).sort((a, b) => a.slot - b.slot || (a.index ?? 0) - (b.index ?? 0));
  const create = ok[0];
  if (!create) return { deployer: null, createdAt: null, createSig: null, createSlot: null, launchpad: null, txsRead: txs.length, buys: [] };
  const deployer = create.feePayer;
  const lp = Object.keys(LAUNCHPADS).find((p) => create.programs.has(p) || create.keys.includes(p));
  const launchpad = lp ? LAUNCHPADS[lp] : null;
  const buys: EarlyBuy[] = [];
  const seen = new Set<string>();
  let rank = 1;
  for (const t of ok) {
    for (const e of mintEvents(t, mint)) {
      // The buyer must have signed. This drops pools and bonding curves, whose side of a sell looks like a buy.
      if (e.kind !== "buy" || seen.has(e.owner) || !t.signers.includes(e.owner)) continue;
      seen.add(e.owner);
      const isDev = e.owner === deployer;
      buys.push({
        wallet: e.owner,
        rank: isDev ? 0 : rank++,
        sig: e.signature,
        slot: e.slot,
        blockTime: e.blockTime,
        secsAfterCreate: e.blockTime != null && create.blockTime != null ? e.blockTime - create.blockTime : null,
        sol: Number(e.lamports) / 1e9,
        tokens: Number(e.tokens) / 10 ** e.decimals,
        tokenAccount: e.tokenAccount,
        sameSlot: e.slot === create.slot,
      });
    }
    if (rank > earlyBuyers) break;
  }
  return {
    deployer,
    createdAt: create.blockTime,
    createSig: create.signature,
    createSlot: create.slot,
    launchpad,
    txsRead: txs.length,
    buys: buys.filter((b) => b.rank <= earlyBuyers),
  };
}

export async function readLaunch(rpc: Rpc, mint: string, s: { earlyBuyers: number; maxLaunchTxs: number; maxSignaturePages: number }): Promise<Launch> {
  const enough = (txs: Tx[]) => {
    const buyers = new Set<string>();
    for (const t of txs) for (const e of mintEvents(t, mint)) if (e.kind === "buy" && t.signers.includes(e.owner)) buyers.add(e.owner);
    return buyers.size > s.earlyBuyers;
  };
  const { txs, skipped } = await oldestTxs(rpc, mint, s.maxLaunchTxs, s.maxSignaturePages, enough);
  if (skipped) return { status: "skipped", note: skipped, deployer: null, createdAt: null, createSig: null, createSlot: null, launchpad: null, txsRead: 0, buys: [] };
  if (txs.length === 0) return { status: "failed", note: "no transactions found for this address", deployer: null, createdAt: null, createSig: null, createSlot: null, launchpad: null, txsRead: 0, buys: [] };
  const parsed = parseLaunch(mint, txs, s.earlyBuyers);
  const note = parsed.buys.length === 0 ? "no buys found in the launch window (is this a token mint?)" : undefined;
  return { status: parsed.buys.length ? "ok" : "failed", note, ...parsed };
}

export interface WalletLookup {
  firstTxTime: number | null;
  firstTxExact: boolean;
  firstTxSig: string | null;
  funder: string | null;
  txsPerDay: number | null;
}

// Age, activity and first funder. About 2 credits for a quiet wallet, up to 22 for a busy one.
export async function lookupWallet(rpc: Rpc, wallet: string, deepScan: boolean): Promise<WalletLookup> {
  const sigs = await rpc.getSignatures(wallet, { limit: 1000 });
  let txsPerDay: number | null = null;
  if (sigs.length >= 2) {
    const newest = sigs[0].blockTime ?? 0, oldest = sigs[sigs.length - 1].blockTime ?? 0;
    const span = Math.max(newest - oldest, 3600) / 86400;
    // A short page covers the whole history; rate over the page is the rate.
    txsPerDay = sigs.length / span;
  }
  let first: SigInfo | null = null;
  let exact = false;
  if (sigs.length < 1000) {
    first = sigs[sigs.length - 1] ?? null;
    exact = true;
  } else if (rpc.hasTxsForAddress()) {
    try {
      const page = await rpc.sigsForAddressAsc(wallet, 1);
      first = page.data[0] ?? null;
      exact = !!first;
    } catch (e) {
      if (!(e instanceof UnsupportedError)) throw e;
    }
  }
  if (!first) return { firstTxTime: null, firstTxExact: false, firstTxSig: null, funder: null, txsPerDay };
  let funder: string | null = null;
  const raw = await rpc.getTransaction(first.signature);
  const t = raw ? normalizeTx(raw) : null;
  if (t) funder = funderFromTx(t, wallet);
  // App wallets often start with tokens, not SOL. Look for the first SOL in the first 100 transactions.
  if (!funder && deepScan && rpc.hasTxsForAddress()) {
    try {
      const page = await rpc.txsForAddress(wallet, { sortOrder: "asc", limit: 100 });
      for (const r of page.data) {
        const n = normalizeTx(r);
        if (!n || n.failed) continue;
        funder = funderFromTx(n, wallet);
        if (funder) break;
      }
    } catch (e) {
      if (!(e instanceof UnsupportedError)) throw e;
    }
  }
  return { firstTxTime: first.blockTime ?? null, firstTxExact: exact, firstTxSig: first.signature, funder, txsPerDay };
}

// An exchange or app: its latest 1,000 transactions fit in one day (tracced's rule, 1 credit).
export async function isService(rpc: Rpc, address: string): Promise<boolean> {
  const sigs = await rpc.getSignatures(address, { limit: 1000 });
  if (sigs.length < 1000) return false;
  const newest = sigs[0].blockTime, oldest = sigs[sigs.length - 1].blockTime;
  return newest != null && oldest != null && newest - oldest < 86400;
}

export interface HistoryRead {
  events: OwnerEvent[];
  txsRead: number;
  oldest: number | null;
  newestSig: string | null;
  newestTime: number | null;
  complete: boolean; // reached the wallet's first transaction
  hitCursor: boolean; // stopped at `stopAt`: everything older is already known
  stoppedEarly: boolean; // keepGoing said no after the first page
}

// A wallet's trades, newest first, up to maxTxs transactions.
//   stopAt: stop at this already-read transaction (incremental read).
//   keepGoing: asked after the first page of 100; false stops there (adaptive depth).
export async function pullHistory(
  rpc: Rpc,
  wallet: string,
  maxTxs: number,
  o: { stopAt?: { sig: string | null; time: number | null }; keepGoing?: (events: OwnerEvent[]) => boolean } = {},
): Promise<HistoryRead> {
  const r: HistoryRead = { events: [], txsRead: 0, oldest: null, newestSig: null, newestTime: null, complete: false, hitCursor: false, stoppedEarly: false };
  const stop = o.stopAt;
  const isCursor = (sig: string, time: number | null | undefined) =>
    !!stop && (sig === stop.sig || (time != null && stop.time != null && time < stop.time));
  const take = (raw: RawTx | null) => {
    const t = raw ? normalizeTx(raw) : null;
    if (!t) return;
    r.txsRead++;
    if (r.newestSig == null) {
      r.newestSig = t.signature;
      r.newestTime = t.blockTime;
    }
    if (t.blockTime != null) r.oldest = r.oldest == null ? t.blockTime : Math.min(r.oldest, t.blockTime);
    r.events.push(...ownerEvents(t, wallet));
  };
  if (rpc.hasTxsForAddress()) {
    try {
      let token: string | null = null;
      let first = true;
      outer: do {
        const page = await rpc.txsForAddress(wallet, { sortOrder: "desc", limit: 100, paginationToken: token });
        for (const raw of page.data) {
          if (isCursor(raw.transaction.signatures[0], raw.blockTime)) {
            r.hitCursor = true;
            break outer;
          }
          take(raw);
        }
        token = page.paginationToken;
        if (page.data.length < 100 || !token) {
          r.complete = true;
          break;
        }
        if (first && o.keepGoing && !o.keepGoing(r.events)) {
          r.stoppedEarly = true;
          break;
        }
        first = false;
      } while (r.txsRead < maxTxs);
      return r;
    } catch (e) {
      if (!(e instanceof UnsupportedError)) throw e;
      Object.assign(r, { events: [], txsRead: 0, oldest: null, newestSig: null, newestTime: null, complete: false, hitCursor: false, stoppedEarly: false });
    }
  }
  // Fallback costs 1 credit per transaction, so read fewer.
  const cap = Math.min(maxTxs, 300);
  const all = await rpc.getSignatures(wallet, { limit: 1000 });
  const sigs: SigInfo[] = [];
  for (const sg of all) {
    if (isCursor(sg.signature, sg.blockTime)) {
      r.hitCursor = true;
      break;
    }
    if (!sg.err) sigs.push(sg);
  }
  let list = sigs.slice(0, cap);
  if (o.keepGoing && list.length > 100) {
    (await mapLimit(list.slice(0, 100), 6, (sg) => rpc.getTransaction(sg.signature))).forEach(take);
    if (!o.keepGoing(r.events)) {
      r.stoppedEarly = true;
      return r;
    }
    list = list.slice(100);
  }
  (await mapLimit(list, 6, (sg) => rpc.getTransaction(sg.signature))).forEach(take);
  r.complete = !r.hitCursor && all.length < 1000 && sigs.length <= cap;
  return r;
}

// Every trade by one owner on one mint, read from the owner's token account for that mint (cheap and complete
// unless the tokens moved through another account).
export async function tokenAccountEvents(rpc: Rpc, owner: string, mint: string, tokenAccount: string): Promise<OwnerEvent[]> {
  const out: OwnerEvent[] = [];
  const take = (raw: RawTx | null) => {
    const t = raw ? normalizeTx(raw) : null;
    if (t) out.push(...ownerEvents(t, owner).filter((e) => e.mint === mint));
  };
  if (rpc.hasTxsForAddress()) {
    try {
      const page = await rpc.txsForAddress(tokenAccount, { sortOrder: "asc", limit: 100 });
      page.data.forEach(take);
      return out;
    } catch (e) {
      if (!(e instanceof UnsupportedError)) throw e;
    }
  }
  const sigs = (await rpc.getSignatures(tokenAccount, { limit: 1000 })).filter((s) => !s.err).slice(0, 40);
  const raws = await mapLimit(sigs, 6, (s) => rpc.getTransaction(s.signature));
  raws.forEach(take);
  return out;
}

export { BudgetError, mapLimit };
