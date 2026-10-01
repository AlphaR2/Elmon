import { BudgetError, UnsupportedError, type Rpc, type SigInfo, type SigPage, type TxPage } from "@/lib/helius";
import { PUMP_FUN_PROGRAM, type RawTx } from "@/lib/solana/tx";

export const SOL = 1_000_000_000;
export const RENT = 2_039_280;
export const FEE = 5_000;

export interface TokenBal {
  account: string;
  owner: string;
  mint: string;
  pre: bigint | number | null; // null = account did not exist
  post: bigint | number | null;
  decimals?: number;
}

export interface TxSpec {
  sig: string;
  slot: number;
  time: number;
  signers: string[];
  lamports?: Record<string, [number, number]>; // pre, post
  tokens?: TokenBal[];
  extraKeys?: string[];
  failed?: boolean;
  pump?: boolean;
}

export function makeTx(s: TxSpec): RawTx {
  const keys: string[] = [];
  const add = (k: string) => { if (!keys.includes(k)) keys.push(k); };
  s.signers.forEach(add);
  Object.keys(s.lamports ?? {}).forEach(add);
  (s.tokens ?? []).forEach((t) => add(t.account));
  (s.extraKeys ?? []).forEach(add);
  if (s.pump) add(PUMP_FUN_PROGRAM);
  const pre = keys.map((k) => s.lamports?.[k]?.[0] ?? 5 * SOL);
  const post = keys.map((k) => s.lamports?.[k]?.[1] ?? 5 * SOL);
  const bal = (t: TokenBal, v: bigint | number | null) =>
    v == null ? null : { accountIndex: keys.indexOf(t.account), mint: t.mint, owner: t.owner, uiTokenAmount: { amount: String(v), decimals: t.decimals ?? 6 } };
  return {
    slot: s.slot,
    blockTime: s.time,
    meta: {
      err: s.failed ? { InstructionError: [0, "Custom"] } : null,
      fee: FEE,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: (s.tokens ?? []).map((t) => bal(t, t.pre)).filter((x) => x != null),
      postTokenBalances: (s.tokens ?? []).map((t) => bal(t, t.post)).filter((x) => x != null),
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: s.pump ? [`Program ${PUMP_FUN_PROGRAM} invoke [1]`] : [],
    },
    transaction: {
      signatures: [s.sig],
      message: { accountKeys: keys, header: { numRequiredSignatures: s.signers.length } },
    },
  };
}

// A pump-style buy: wallet pays `sol` (+ fee), a new ATA is created with rent, the curve sends tokens.
let n = 0;
export function buyTx(o: { wallet: string; mint: string; sol: number; tokens: number; slot: number; time: number; sig?: string; ataExists?: boolean; held?: number; curve?: string }): RawTx {
  const curve = o.curve ?? `curve-${o.mint}`;
  const ata = `ata-${o.wallet}-${o.mint}`;
  const held = o.held ?? 0;
  const walletPre = 100 * SOL;
  const rent = o.ataExists ? 0 : RENT;
  return makeTx({
    sig: o.sig ?? `buy-${o.wallet}-${o.mint}-${++n}`,
    slot: o.slot,
    time: o.time,
    signers: [o.wallet],
    lamports: {
      [o.wallet]: [walletPre, walletPre - Math.round(o.sol * SOL) - rent - FEE],
      [ata]: [o.ataExists ? RENT : 0, RENT],
      [curve]: [50 * SOL, 50 * SOL + Math.round(o.sol * SOL)],
    },
    tokens: [
      { account: ata, owner: o.wallet, mint: o.mint, pre: o.ataExists ? held * 1e6 : null, post: (held + o.tokens) * 1e6 },
      { account: `curve-ata-${o.mint}`, owner: curve, mint: o.mint, pre: 1e15, post: 1e15 - o.tokens * 1e6 },
    ],
    extraKeys: [o.mint],
    pump: true,
  });
}

export function sellTx(o: { wallet: string; mint: string; sol: number; tokens: number; held: number; slot: number; time: number; close?: boolean; sig?: string; curve?: string }): RawTx {
  const curve = o.curve ?? `curve-${o.mint}`;
  const ata = `ata-${o.wallet}-${o.mint}`;
  const walletPre = 100 * SOL;
  const refund = o.close ? RENT : 0;
  return makeTx({
    sig: o.sig ?? `sell-${o.wallet}-${o.mint}-${++n}`,
    slot: o.slot,
    time: o.time,
    signers: [o.wallet],
    lamports: {
      [o.wallet]: [walletPre, walletPre + Math.round(o.sol * SOL) + refund - FEE],
      [ata]: [RENT, o.close ? 0 : RENT],
      [curve]: [50 * SOL, 50 * SOL - Math.round(o.sol * SOL)],
    },
    tokens: [
      { account: ata, owner: o.wallet, mint: o.mint, pre: o.held * 1e6, post: o.close ? null : (o.held - o.tokens) * 1e6 },
      { account: `curve-ata-${o.mint}`, owner: curve, mint: o.mint, pre: 1e15, post: 1e15 + o.tokens * 1e6 },
    ],
    extraKeys: [o.mint],
    pump: true,
  });
}

export function fundTx(o: { from: string; to: string; sol: number; slot: number; time: number; sig?: string }): RawTx {
  return makeTx({
    sig: o.sig ?? `fund-${o.from}-${o.to}-${++n}`,
    slot: o.slot,
    time: o.time,
    signers: [o.from],
    lamports: { [o.from]: [1000 * SOL, 1000 * SOL - Math.round(o.sol * SOL) - FEE], [o.to]: [0, Math.round(o.sol * SOL)] },
  });
}

export function createTx(o: { deployer: string; mint: string; slot: number; time: number; devBuySol?: number; sig?: string }): RawTx {
  if (o.devBuySol) return buyTx({ wallet: o.deployer, mint: o.mint, sol: o.devBuySol, tokens: 1000, slot: o.slot, time: o.time, sig: o.sig ?? `create-${o.mint}` });
  return makeTx({ sig: o.sig ?? `create-${o.mint}`, slot: o.slot, time: o.time, signers: [o.deployer, o.mint], extraKeys: [o.mint], pump: true });
}

// A fake node. Every address in a tx (keys and token-balance owners) indexes it.
export class FakeRpc implements Rpc {
  private byAddr = new Map<string, RawTx[]>();
  private bySig = new Map<string, RawTx>();
  credits = 0;
  calls: Record<string, number> = {};
  constructor(txs: RawTx[], private opts: { gtfa?: boolean; budget?: number } = {}) {
    for (const t of txs) this.add(t);
  }
  add(t: RawTx) {
    this.bySig.set(t.transaction.signatures[0], t);
    const addrs = new Set<string>(t.transaction.message.accountKeys as string[]);
    for (const b of [...(t.meta?.preTokenBalances ?? []), ...(t.meta?.postTokenBalances ?? [])]) if (b.owner) addrs.add(b.owner);
    for (const a of addrs) {
      const l = this.byAddr.get(a) ?? [];
      l.push(t);
      l.sort((x, y) => x.slot - y.slot);
      this.byAddr.set(a, l);
    }
  }
  private charge(method: string, c: number) {
    if (this.opts.budget != null && this.credits + c > this.opts.budget) throw new BudgetError("budget");
    this.credits += c;
    this.calls[method] = (this.calls[method] ?? 0) + 1;
  }
  private asc(a: string) { return this.byAddr.get(a) ?? []; }
  private sigInfo(t: RawTx): SigInfo {
    return { signature: t.transaction.signatures[0], slot: t.slot, blockTime: t.blockTime, err: t.meta?.err ?? null };
  }
  async getSignatures(address: string, o: { before?: string; limit?: number } = {}): Promise<SigInfo[]> {
    this.charge("getSignaturesForAddress", 1);
    const desc = [...this.asc(address)].reverse();
    let start = 0;
    if (o.before) start = desc.findIndex((t) => t.transaction.signatures[0] === o.before) + 1;
    return desc.slice(start, start + (o.limit ?? 1000)).map((t) => this.sigInfo(t));
  }
  async getTransaction(sig: string) {
    this.charge("getTransaction", 1);
    return this.bySig.get(sig) ?? null;
  }
  async txsForAddress(address: string, o: { sortOrder: "asc" | "desc"; limit: number; paginationToken?: string | null }): Promise<TxPage> {
    if (!this.opts.gtfa) throw new UnsupportedError("no");
    this.charge("getTransactionsForAddress", 10);
    const list = o.sortOrder === "asc" ? this.asc(address) : [...this.asc(address)].reverse();
    const start = o.paginationToken ? Number(o.paginationToken) : 0;
    const data = list.slice(start, start + o.limit);
    return { data, paginationToken: start + o.limit < list.length ? String(start + o.limit) : null };
  }
  async sigsForAddressAsc(address: string, limit: number): Promise<SigPage> {
    if (!this.opts.gtfa) throw new UnsupportedError("no");
    this.charge("getTransactionsForAddress", 10);
    return { data: this.asc(address).slice(0, limit).map((t) => this.sigInfo(t)), paginationToken: null };
  }
  hasTxsForAddress() { return !!this.opts.gtfa; }
  creditsUsed() { return this.credits; }
}
