import { BudgetError, CreditGuard } from "./credits";
import type { RawTx } from "./solana/tx";

export { BudgetError };

export interface SigInfo {
  signature: string;
  slot: number;
  blockTime?: number | null;
  err?: unknown;
}

export interface TxPage {
  data: RawTx[];
  paginationToken: string | null;
}

export interface SigPage {
  data: SigInfo[];
  paginationToken: string | null;
}

// Everything the pipeline needs from a node. Tests pass a fake.
export interface Rpc {
  getSignatures(address: string, opts?: { before?: string; limit?: number }): Promise<SigInfo[]>;
  getTransaction(signature: string): Promise<RawTx | null>;
  // Helius-only. Throws UnsupportedError when the plan or node lacks it.
  txsForAddress(address: string, opts: { sortOrder: "asc" | "desc"; limit: number; paginationToken?: string | null }): Promise<TxPage>;
  sigsForAddressAsc(address: string, limit: number): Promise<SigPage>;
  hasTxsForAddress(): boolean;
  creditsUsed(): number;
  setStage?(stage: string): void;
}
export class UnsupportedError extends Error {}
// The node refused the key. Nothing else in the run can work, so the run stops with this message.
export class AuthError extends Error {
  constructor(status: number) {
    super(
      `Helius rejected the API key (HTTP ${status}). Check HELIUS_API_KEY in .env.local: it can be the key itself or the full RPC URL. Restart the app after changing it.`,
    );
    this.name = "AuthError";
  }
}
export class RpcError extends Error {
  constructor(msg: string, public code?: number) {
    super(msg);
  }
}

// Helius prices (verified by tracced on 24 Sep 2026): 1 credit per standard call, 10 for getTransactionsForAddress.
export const CREDITS: Record<string, number> = { getTransactionsForAddress: 10 };
const creditCost = (method: string) => CREDITS[method] ?? 1;

// Mainnet carries version 1 transactions (2026). Asking for less makes Helius refuse the whole page (-32015).
export const MAX_TX_VERSION = 1;

// Accepts HELIUS_RPC_URL, or HELIUS_API_KEY as either the bare key or the full RPC URL Helius shows in its dashboard.
export function heliusUrl(): string | null {
  const url = process.env.HELIUS_RPC_URL?.trim();
  if (url) return url;
  const key = process.env.HELIUS_API_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return key;
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

let txsForAddressSupported: boolean | null = null; // learned once per process

// Redacts the API key from anything that might reach a log or the UI.
export const redact = (msg: string) => msg.replace(/api-key=[^&\s"']+/gi, "api-key=***");

export class HeliusClient implements Rpc {
  private url: string;
  private inflight = 0;
  private waiters: (() => void)[] = [];
  private nextSlot = 0;
  private rps: number;
  private concurrency: number;
  calls = 0;

  constructor(
    public guard: CreditGuard,
    opts: { url?: string; rps?: number; concurrency?: number } = {},
  ) {
    const url = opts.url ?? heliusUrl();
    if (!url) throw new Error("HELIUS_API_KEY is not set on the worker.");
    this.url = url;
    // Free plan: 10 requests/s. Stay under it.
    this.rps = opts.rps ?? 8;
    this.concurrency = opts.concurrency ?? 6;
  }

  creditsUsed() {
    return this.guard.used;
  }
  setStage(stage: string) {
    this.guard.stage = stage;
  }
  hasTxsForAddress() {
    return txsForAddressSupported !== false;
  }

  private async acquire() {
    if (this.inflight >= this.concurrency) await new Promise<void>((r) => this.waiters.push(r));
    this.inflight++;
    // Spread starts evenly to stay under the plan's requests-per-second cap.
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + 1000 / this.rps;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
  private release() {
    this.inflight--;
    this.waiters.shift()?.();
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const delays = [500, 1500, 4000, 8000, 15000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      await this.acquire();
      let wait = delays[Math.min(attempt, delays.length - 1)];
      try {
        const refund = await this.guard.take(method, creditCost(method)); // a failed attempt is still billed, except an auth rejection
        this.calls++;
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(45_000),
        });
        // 403 on the Helius-only method can mean "not on your plan"; that is handled as unsupported, not as a bad key.
        if (res.status === 401 || (res.status === 403 && method !== "getTransactionsForAddress")) {
          refund();
          throw new AuthError(res.status);
        }
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get("retry-after"));
          if (Number.isFinite(ra) && ra > 0) wait = Math.min(ra * 1000, 30_000);
          lastErr = new RpcError(`HTTP ${res.status} on ${method}`, res.status);
        } else {
          if (!res.ok) throw new RpcError(`HTTP ${res.status} on ${method}`, res.status);
          const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
          if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code);
          return body.result as T;
        }
      } catch (e) {
        if (e instanceof BudgetError || e instanceof RpcError || e instanceof AuthError) throw e;
        lastErr = new Error(redact((e as Error).message ?? String(e))); // network error or timeout: retry
      } finally {
        this.release();
      }
      await new Promise((r) => setTimeout(r, wait));
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async getSignatures(address: string, opts: { before?: string; limit?: number } = {}): Promise<SigInfo[]> {
    const limit = opts.limit ?? 1000;
    const cfg: Record<string, unknown> = { limit, commitment: "finalized" };
    if (opts.before) cfg.before = opts.before;
    const res = await this.call<SigInfo[]>("getSignaturesForAddress", [address, cfg]);
    return res ?? [];
  }

  async getTransaction(signature: string): Promise<RawTx | null> {
    return this.call<RawTx | null>(
      "getTransaction",
      [signature, { encoding: "json", maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: "finalized" }],
    );
  }

  private async gtfa<T>(address: string, cfg: Record<string, unknown>): Promise<{ data: T[]; paginationToken: string | null }> {
    if (txsForAddressSupported === false) throw new UnsupportedError("getTransactionsForAddress is not available");
    try {
      const res = await this.call<{ data?: T[]; paginationToken?: string | null } | T[]>("getTransactionsForAddress", [address, cfg]);
      txsForAddressSupported = true;
      if (Array.isArray(res)) return { data: res, paginationToken: null };
      return { data: res?.data ?? [], paginationToken: res?.paginationToken ?? null };
    } catch (e) {
      // Only a missing method or a plan restriction means "use the fallback". Parameter errors (such as -32015,
      // "transaction version not supported by the requesting client") are bugs to surface, not a reason to spend
      // 10x more credits on plain RPC.
      const looksUnsupported =
        e instanceof RpcError &&
        e.code !== -32015 &&
        !/requesting client|parameter/i.test(e.message) &&
        (e.code === -32601 || e.code === 403 || /method not found|not available|not allowed|upgrade|your plan|paid plan/i.test(e.message));
      if (looksUnsupported && txsForAddressSupported !== true) {
        txsForAddressSupported = false;
        throw new UnsupportedError(e.message);
      }
      throw e;
    }
  }

  async txsForAddress(address: string, opts: { sortOrder: "asc" | "desc"; limit: number; paginationToken?: string | null }): Promise<TxPage> {
    const cfg: Record<string, unknown> = {
      sortOrder: opts.sortOrder,
      limit: opts.limit,
      transactionDetails: "full",
      encoding: "json",
      maxSupportedTransactionVersion: MAX_TX_VERSION,
      // Busy launches are mostly failed sniper attempts (82 of the first 100 on one live token). Skip them server-side.
      filters: { status: "succeeded" },
    };
    if (opts.paginationToken) cfg.paginationToken = opts.paginationToken;
    return this.gtfa<RawTx>(address, cfg);
  }

  async sigsForAddressAsc(address: string, limit: number): Promise<SigPage> {
    return this.gtfa<SigInfo>(address, { sortOrder: "asc", limit, transactionDetails: "signatures" });
  }
}

// Test hook
export function _resetHeliusSupport() {
  txsForAddressSupported = null;
}
