// Normalizes a getTransaction / getTransactionsForAddress result ("json" or "jsonParsed" encoding)
// into the few facts the pipeline needs: who signed, who paid, and how each owner's SOL and tokens moved.

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
// Stablecoins are quote assets, not positions. A token<->USDC swap is skipped rather than guessed.
export const QUOTE_MINTS = new Set([
  WSOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// Launchpad programs seen in real create transactions. Label only; parsing does not depend on it.
export const LAUNCHPADS: Record<string, string> = {
  [PUMP_FUN_PROGRAM]: "pump.fun",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "Raydium LaunchLab", // verified on a live launch, 2026-09-30
};

// Below this much SOL moved (after fees and rent are netted out) a token change is a transfer, not a trade.
export const MIN_TRADE_LAMPORTS = 1_000_000n; // 0.001 SOL

export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface RawTx {
  slot: number;
  transactionIndex?: number; // position inside the block (Helius getTransactionsForAddress)
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee?: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
    logMessages?: string[] | null;
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: (string | { pubkey: string; signer?: boolean; writable?: boolean })[];
      header?: { numRequiredSignatures: number };
      instructions?: unknown[];
    };
  };
}

export interface TokenBalanceChange {
  mint: string;
  owner: string;
  account: string; // token account address
  decimals: number;
  delta: bigint; // raw units
}

export interface Tx {
  signature: string;
  slot: number;
  index: number | null; // position inside the block, when the node gives it
  blockTime: number | null; // unix seconds
  failed: boolean;
  keys: string[];
  signers: string[];
  feePayer: string;
  lamportDelta: Map<string, bigint>; // per account key
  tokenChanges: TokenBalanceChange[];
  programs: Set<string>;
}

export function normalizeTx(raw: RawTx): Tx | null {
  if (!raw || !raw.transaction || !raw.meta) return null;
  const msg = raw.transaction.message;
  const statics = msg.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  // jsonParsed already lists loaded addresses inside accountKeys; json lists them separately.
  const parsedKeys = msg.accountKeys.length > 0 && typeof msg.accountKeys[0] !== "string";
  const loaded = parsedKeys ? [] : [
    ...(raw.meta.loadedAddresses?.writable ?? []),
    ...(raw.meta.loadedAddresses?.readonly ?? []),
  ];
  const keys = [...statics, ...loaded];

  let signers: string[];
  if (parsedKeys) {
    signers = (msg.accountKeys as { pubkey: string; signer?: boolean }[]).filter((k) => k.signer).map((k) => k.pubkey);
  } else {
    const n = msg.header?.numRequiredSignatures ?? 1;
    signers = statics.slice(0, n);
  }

  const lamportDelta = new Map<string, bigint>();
  const pre = raw.meta.preBalances ?? [];
  const post = raw.meta.postBalances ?? [];
  for (let i = 0; i < keys.length && i < pre.length && i < post.length; i++) {
    const d = BigInt(post[i]) - BigInt(pre[i]);
    lamportDelta.set(keys[i], (lamportDelta.get(keys[i]) ?? 0n) + d);
  }

  // Token changes keyed by token account. An account missing on one side had a zero balance there.
  const byAccount = new Map<number, { pre?: RawTokenBalance; post?: RawTokenBalance }>();
  for (const b of raw.meta.preTokenBalances ?? []) byAccount.set(b.accountIndex, { ...byAccount.get(b.accountIndex), pre: b });
  for (const b of raw.meta.postTokenBalances ?? []) byAccount.set(b.accountIndex, { ...byAccount.get(b.accountIndex), post: b });
  const tokenChanges: TokenBalanceChange[] = [];
  for (const [idx, { pre: p, post: q }] of byAccount) {
    const ref = q ?? p!;
    const owner = q?.owner ?? p?.owner;
    if (!owner) continue;
    const delta = BigInt(q?.uiTokenAmount.amount ?? "0") - BigInt(p?.uiTokenAmount.amount ?? "0");
    tokenChanges.push({
      mint: ref.mint,
      owner,
      account: keys[idx] ?? "",
      decimals: ref.uiTokenAmount.decimals,
      delta,
    });
  }

  const programs = new Set<string>();
  for (const line of raw.meta.logMessages ?? []) {
    const m = /^Program (\w{32,44}) invoke/.exec(line);
    if (m) programs.add(m[1]);
  }

  return {
    signature: raw.transaction.signatures[0],
    slot: raw.slot,
    index: raw.transactionIndex ?? null,
    blockTime: raw.blockTime ?? null,
    failed: raw.meta.err != null,
    keys,
    signers,
    feePayer: statics[0],
    lamportDelta,
    tokenChanges,
    programs,
  };
}

// The owner's economic SOL change: its own lamports plus the lamports of every token account it owns.
// Rent paid into a new token account, rent refunded on close, and WSOL wrap/unwrap all net to zero this way,
// so only the SOL that actually left or entered the owner's control remains (fees and tips included).
export function ownerSolDelta(tx: Tx, owner: string): bigint {
  let d = tx.lamportDelta.get(owner) ?? 0n;
  const seen = new Set<string>();
  for (const c of tx.tokenChanges) {
    if (c.owner !== owner || seen.has(c.account)) continue;
    seen.add(c.account);
    d += tx.lamportDelta.get(c.account) ?? 0n;
  }
  return d;
}

export function ownerTokenDeltas(tx: Tx, owner: string): Map<string, { delta: bigint; decimals: number; account: string }> {
  const out = new Map<string, { delta: bigint; decimals: number; account: string }>();
  for (const c of tx.tokenChanges) {
    if (c.owner !== owner || QUOTE_MINTS.has(c.mint)) continue;
    const cur = out.get(c.mint);
    if (cur) cur.delta += c.delta;
    else out.set(c.mint, { delta: c.delta, decimals: c.decimals, account: c.account });
  }
  for (const [m, v] of out) if (v.delta === 0n) out.delete(m);
  return out;
}

export type EventKind = "buy" | "sell" | "transfer_in" | "transfer_out";

export interface OwnerEvent {
  signature: string;
  slot: number;
  blockTime: number | null;
  owner: string;
  mint: string;
  kind: EventKind;
  tokens: bigint; // raw, always positive
  decimals: number;
  lamports: bigint; // SOL spent (buy) or received (sell), always positive; 0 for transfers
  tokenAccount: string;
}

// Classifies what one owner did in one tx. A trade needs exactly one non-quote mint to change and SOL to move
// the opposite way. Multi-token routes are skipped rather than guessed.
export function ownerEvents(tx: Tx, owner: string): OwnerEvent[] {
  if (tx.failed) return [];
  const deltas = ownerTokenDeltas(tx, owner);
  if (deltas.size === 0) return [];
  const sol = ownerSolDelta(tx, owner);
  const base = { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, owner };
  if (deltas.size > 1) {
    // Several tokens moved: only plain transfers (no real SOL movement) can be read safely.
    if ((sol < 0n ? -sol : sol) >= MIN_TRADE_LAMPORTS) return [];
    const out: OwnerEvent[] = [];
    for (const [mint, v] of deltas) {
      out.push({ ...base, mint, kind: v.delta > 0n ? "transfer_in" : "transfer_out", tokens: v.delta > 0n ? v.delta : -v.delta, decimals: v.decimals, lamports: 0n, tokenAccount: v.account });
    }
    return out;
  }
  const [[mint, v]] = [...deltas];
  const absSol = sol < 0n ? -sol : sol;
  const tokens = v.delta > 0n ? v.delta : -v.delta;
  let kind: EventKind;
  if (v.delta > 0n) kind = sol <= -MIN_TRADE_LAMPORTS ? "buy" : "transfer_in";
  else kind = sol >= MIN_TRADE_LAMPORTS ? "sell" : "transfer_out";
  // Token in with SOL also in (or out with SOL out) is not a trade we can price.
  if (v.delta > 0n && sol >= MIN_TRADE_LAMPORTS) return [];
  if (v.delta < 0n && sol <= -MIN_TRADE_LAMPORTS) return [];
  const lamports = kind === "buy" || kind === "sell" ? absSol : 0n;
  return [{ ...base, mint, kind, tokens, decimals: v.decimals, lamports, tokenAccount: v.account }];
}

// Everyone whose balance of `mint` changed in this tx, with what they did.
export function mintEvents(tx: Tx, mint: string): OwnerEvent[] {
  if (tx.failed) return [];
  const owners = new Set(tx.tokenChanges.filter((c) => c.mint === mint && c.delta !== 0n).map((c) => c.owner));
  const out: OwnerEvent[] = [];
  for (const o of owners) for (const e of ownerEvents(tx, o)) if (e.mint === mint) out.push(e);
  return out;
}

// Who gave `wallet` SOL in this tx: the signer with the largest lamport outflow, if the wallet's balance rose.
// Ported from tracced (MIT) funder_from_tx.
export function funderFromTx(tx: Tx, wallet: string): string | null {
  const got = tx.lamportDelta.get(wallet) ?? 0n;
  if (got <= 0n) return null;
  let best: string | null = null;
  let bestOut = 0n;
  for (const s of tx.signers) {
    if (s === wallet) continue;
    const out = -(tx.lamportDelta.get(s) ?? 0n);
    if (out > bestOut) {
      best = s;
      bestOut = out;
    }
  }
  return best;
}

export const lamportsToSol = (l: bigint) => Number(l) / 1e9;
