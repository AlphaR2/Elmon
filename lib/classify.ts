import { getDb } from "./db";

// What a pasted address is: a token mint, a wallet, or something else (a token account, a program, a pool).
// Free sources only, no Helius credits:
//   1. token_facts (mints Elmon has already seen)
//   2. the public Solana RPC: getMultipleAccounts says who owns each account (definitive)
//   3. Jupiter: symbols for the chips (and "listed" also means "token" if the RPC was unreachable)
// Best effort: anything not resolved comes back "unknown" and nothing is blocked.

export type AddressKind = "token" | "wallet" | "token-account" | "program" | "other" | "empty" | "unknown";
export interface Classified {
  kind: AddressKind;
  symbol: string | null;
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

export interface RpcAccount {
  owner: string;
  executable?: boolean;
  data?: unknown;
}

export function kindFromAccount(v: RpcAccount | null | undefined): AddressKind {
  if (v == null) return "empty"; // no account: an unfunded wallet, or nothing at all. Never a token.
  if (v.executable) return "program";
  if (v.owner === SYSTEM_PROGRAM) return "wallet";
  if (TOKEN_PROGRAMS.has(v.owner)) {
    const type = (v.data as { parsed?: { type?: string } } | undefined)?.parsed?.type;
    if (type === "mint") return "token";
    if (type === "account") return "token-account";
    return "other";
  }
  return "other";
}

type Fetch = typeof fetch;

export async function classifyAddresses(addrs: string[], o: { fetch?: Fetch; rpcUrl?: string; useDb?: boolean } = {}): Promise<Record<string, Classified>> {
  const f = o.fetch ?? fetch;
  const out: Record<string, Classified> = {};
  const uniq = [...new Set(addrs)];
  for (const a of uniq) out[a] = { kind: "unknown", symbol: null };

  if (o.useDb !== false) {
    try {
      const db = await getDb();
      for (const r of await db.q<{ mint: string; symbol: string | null }>(
        "SELECT mint, symbol FROM token_facts WHERE mint = ANY($1::text[]) AND (symbol IS NOT NULL OR supply IS NOT NULL)",
        [uniq],
      )) {
        out[r.mint] = { kind: "token", symbol: r.symbol };
      }
    } catch {
      // database unavailable: the network sources still answer
    }
  }

  const rpcUrl = o.rpcUrl ?? process.env.ELMON_PUBLIC_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const ask = uniq.filter((a) => out[a].kind === "unknown");
  for (let i = 0; i < ask.length; i += 100) {
    const chunk = ask.slice(i, i + 100);
    try {
      const res = await f(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [chunk, { encoding: "jsonParsed", commitment: "confirmed" }] }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { result?: { value?: (RpcAccount | null)[] } };
      const vals = body.result?.value;
      if (!Array.isArray(vals) || vals.length !== chunk.length) continue;
      chunk.forEach((a, k) => (out[a] = { kind: kindFromAccount(vals[k]), symbol: null }));
    } catch {
      // rate limited or offline: leave unknown
    }
  }

  const needSymbol = uniq.filter((a) => (out[a].kind === "token" && !out[a].symbol) || out[a].kind === "unknown");
  for (let i = 0; i < needSymbol.length; i += 50) {
    const chunk = needSymbol.slice(i, i + 50);
    try {
      const res = await f(`https://lite-api.jup.ag/tokens/v2/search?query=${chunk.join(",")}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const list = (await res.json()) as { id?: string; symbol?: string }[];
      for (const t of Array.isArray(list) ? list : []) {
        if (!t.id || !(t.id in out) || !chunk.includes(t.id)) continue;
        out[t.id] = { kind: "token", symbol: t.symbol ?? out[t.id].symbol };
      }
    } catch {
      // names are a nicety
    }
  }
  return out;
}
