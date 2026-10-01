// Token names and current market data from DexScreener's free public API. Best effort: no credits, no key,
// and a failure only leaves the name blank.

export interface MarketInfo {
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  dex: string | null;
  url: string | null;
}

interface Pair {
  dexId?: string;
  url?: string;
  baseToken?: { address: string; name?: string; symbol?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
}

export async function fetchMarket(mints: string[]): Promise<Map<string, MarketInfo>> {
  const out = new Map<string, MarketInfo>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const pairs = (await res.json()) as Pair[];
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const mint = p.baseToken?.address;
        if (!mint || !chunk.includes(mint)) continue;
        const prev = out.get(mint);
        const liq = p.liquidity?.usd ?? 0;
        if (prev && (prev.liquidityUsd ?? 0) >= liq) continue;
        out.set(mint, {
          name: p.baseToken?.name ?? null,
          symbol: p.baseToken?.symbol ?? null,
          priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
          marketCap: p.marketCap ?? p.fdv ?? null,
          liquidityUsd: liq || null,
          dex: p.dexId ?? null,
          url: p.url ?? null,
        });
      }
    } catch {
      // offline or rate limited: names stay blank
    }
  }
  return out;
}
