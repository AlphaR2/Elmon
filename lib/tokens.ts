// Token market facts from free APIs, stored forever in token_facts. No Helius credits.
//   Jupiter lite API: supply, current mcap, launchpad, graduation, holders. Many mints per call.
//   GeckoTerminal: top pool per token (30 per call), then that pool's daily candles for the peak.
// Checked live on 2026-09-30. pump.fun's own API is blocked (403/404) and is not used.
import { getDb, json, type Db } from "./db";

export type Candle = [day: number, high: number, close: number, volumeUsd: number];

export interface TokenInfo {
  mint: string;
  symbol: string | null;
  name: string | null;
  supply: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  launchpad: string | null;
  graduatedAt: number | null;
  createdAt: number | null;
  holders: number | null;
}

export interface TokenFacts extends TokenInfo {
  infoAt: number | null;
  pool: string | null;
  candles: Candle[] | null;
  peakAt: number | null;
  peakStatus: string | null;
}

// Everything the runner engine needs from the outside world. Tests pass a fake.
export interface MarketSource {
  info(mints: string[]): Promise<Map<string, TokenInfo>>;
  topPools(mints: string[]): Promise<Map<string, { pool: string; supply: number | null }>>;
  // Prices of `token` (not of whichever side is "base" in that pool).
  dailyCandles(pool: string, token: string): Promise<Candle[]>;
  solUsdDaily(): Promise<[day: number, usd: number][]>;
  // Optional second source keyed by token (no pool needed), e.g. Birdeye. When present it runs alongside
  // dailyCandles, and anything it fails on falls back to dailyCandles.
  tokenCandles?: (mint: string, sinceSec: number | null) => Promise<Candle[]>;
  tokenCandlesName?: string;
}

// Thrown by a token-candle source. `disable` = stop using this source for the rest of the run (bad key,
// quota used up); otherwise only this token falls back.
export class CandleSourceError extends Error {
  constructor(msg: string, public disable = false) {
    super(msg);
  }
}

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

// ---------- live source ----------

class Throttle {
  private next = 0;
  constructor(private gapMs: number, private maxGapMs = gapMs) {}
  async wait() {
    const t = Date.now();
    const at = Math.max(t, this.next);
    this.next = at + this.gapMs;
    if (at > t) await new Promise((r) => setTimeout(r, at - t));
  }
  // The API said "too many": space calls further apart from now on (up to maxGapMs), and pause until it allows.
  slowDown(retryAfterMs: number | null) {
    this.gapMs = Math.min(this.maxGapMs, Math.round(this.gapMs * 1.5));
    this.next = Math.max(this.next, Date.now() + (retryAfterMs ?? this.gapMs * 2));
  }
}

async function getJson(url: string, throttle: Throttle, tries = 4): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    await throttle.wait();
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) {
        // Follow the API's own signal instead of a fixed penalty; the throttle then paces later calls slower.
        lastErr = new Error(`HTTP 429 from ${new URL(url).host}`);
        const ra = Number(res.headers.get("retry-after"));
        throttle.slowDown(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : null);
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const toSec = (iso: unknown) => (typeof iso === "string" && iso ? Math.floor(Date.parse(iso) / 1000) : null);
const num = (x: unknown) => (x == null || x === "" || Number.isNaN(Number(x)) ? null : Number(x));

export class FreeMarket implements MarketSource {
  private jup = new Throttle(1100);
  // Free tier: nominally 30 calls a minute, often less in practice; slows itself down to what is allowed.
  private gecko = new Throttle(2200, 10_000);
  private birdeye = new Throttle(1100); // free (Standard) plan: 1 request a second
  tokenCandles?: (mint: string, sinceSec: number | null) => Promise<Candle[]>;
  tokenCandlesName?: string;

  // BIRDEYE_API_KEY (optional, worker only) adds Birdeye as a second price-history source.
  constructor(o: { birdeyeKey?: string | null } = {}) {
    const key = (o.birdeyeKey === undefined ? process.env.BIRDEYE_API_KEY : o.birdeyeKey)?.trim();
    if (key) {
      this.tokenCandles = (mint, since) => this.birdeyeCandles(key, mint, since);
      this.tokenCandlesName = "Birdeye";
    }
  }

  // Birdeye daily candles by token address (aggregated across pools, so no wrong-side-of-pool risk).
  // Cost: 12 compute units for up to 100 days, 25 for up to 300 (free plan: 30,000 a month).
  private async birdeyeCandles(key: string, mint: string, sinceSec: number | null): Promise<Candle[]> {
    const to = now();
    const from = Math.max(sinceSec ?? to - 300 * DAY, to - 299 * DAY);
    const url = `https://public-api.birdeye.so/defi/ohlcv?address=${mint}&type=1D&currency=usd&time_from=${from}&time_to=${to}`;
    for (let i = 0; i < 3; i++) {
      await this.birdeye.wait();
      let res: Response;
      try {
        res = await fetch(url, { headers: { "X-API-KEY": key, "x-chain": "solana", accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      } catch (e) {
        if (i === 2) throw new CandleSourceError(`Birdeye: ${(e as Error).message}`);
        continue;
      }
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        throw new CandleSourceError(`Birdeye refused the request (HTTP ${res.status}): check BIRDEYE_API_KEY or the plan's monthly units`, true);
      }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 1500 * (i + 1)));
        continue;
      }
      if (!res.ok) throw new CandleSourceError(`Birdeye HTTP ${res.status}`);
      const j = (await res.json()) as { success?: boolean; data?: { items?: { unixTime: number; h: number; c: number; vUsd?: number }[] } };
      if (j.success === false) throw new CandleSourceError("Birdeye returned no data");
      return (j.data?.items ?? [])
        .filter((x) => Number.isFinite(x.h) && Number.isFinite(x.c))
        .map((x) => [x.unixTime, x.h, x.c, x.vUsd ?? 0] as Candle)
        .sort((a, b) => a[0] - b[0]);
    }
    throw new CandleSourceError("Birdeye: rate limited");
  }

  async info(mints: string[]) {
    const out = new Map<string, TokenInfo>();
    for (let i = 0; i < mints.length; i += 50) {
      const chunk = mints.slice(i, i + 50);
      const list = (await getJson(`https://lite-api.jup.ag/tokens/v2/search?query=${chunk.join(",")}`, this.jup)) as Record<string, unknown>[] | null;
      for (const t of list ?? []) {
        const mint = t.id as string;
        if (!chunk.includes(mint)) continue;
        out.set(mint, {
          mint,
          symbol: (t.symbol as string) ?? null,
          name: (t.name as string) ?? null,
          supply: num(t.totalSupply),
          priceUsd: num(t.usdPrice),
          mcapUsd: num(t.mcap) ?? num(t.fdv),
          launchpad: (t.launchpad as string) ?? null,
          graduatedAt: toSec(t.graduatedAt),
          createdAt: toSec(t.createdAt) ?? toSec((t.firstPool as { createdAt?: string } | undefined)?.createdAt),
          holders: num(t.holderCount),
        });
      }
    }
    return out;
  }

  async topPools(mints: string[]) {
    const out = new Map<string, { pool: string; supply: number | null }>();
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      const j = (await getJson(
        `https://api.geckoterminal.com/api/v2/networks/solana/tokens/multi/${chunk.join(",")}?include=top_pools`,
        this.gecko,
      )) as { data?: { attributes: { address: string; normalized_total_supply?: string; total_supply?: string }; relationships?: { top_pools?: { data?: { id: string }[] } } }[] } | null;
      for (const t of j?.data ?? []) {
        const pool = t.relationships?.top_pools?.data?.[0]?.id?.replace(/^solana_/, "");
        if (pool) out.set(t.attributes.address, { pool, supply: num(t.attributes.normalized_total_supply) });
      }
    }
    return out;
  }

  // `token=<mint>` matters: in a pool like ZEC/MASK the token we care about is the quote side, and `token=base`
  // returned ZEC's price, which times MASK's supply made a $1.6 trillion "peak" (seen live 2026-10-01).
  async dailyCandles(pool: string, token: string): Promise<Candle[]> {
    const j = (await getJson(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/day?limit=1000&currency=usd&token=${token}`,
      this.gecko,
    )) as { data?: { attributes?: { ohlcv_list?: number[][] } } } | null;
    return (j?.data?.attributes?.ohlcv_list ?? []).map((c) => [c[0], c[2], c[4], c[5]] as Candle).sort((a, b) => a[0] - b[0]);
  }

  async solUsdDaily(): Promise<[number, number][]> {
    // Raydium SOL/USDC, the deepest SOL pool. Free history goes back about 6 months.
    const c = await this.dailyCandles("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", "So11111111111111111111111111111111111111112");
    return c.map((x) => [x[0], x[2]]);
  }
}

// ---------- stored facts ----------

function rowToFacts(r: Record<string, unknown>): TokenFacts {
  return {
    mint: r.mint as string,
    symbol: r.symbol as string | null,
    name: r.name as string | null,
    supply: r.supply as number | null,
    priceUsd: r.price_usd as number | null,
    mcapUsd: r.mcap_usd as number | null,
    launchpad: r.launchpad as string | null,
    graduatedAt: r.graduated_at as number | null,
    createdAt: r.created_at as number | null,
    holders: r.holders as number | null,
    infoAt: r.info_at as number | null,
    pool: r.pool as string | null,
    candles: json<Candle[] | null>(r.candles as string | null, null),
    peakAt: r.peak_at as number | null,
    peakStatus: r.peak_status as string | null,
  };
}

export async function loadFacts(mints: string[], db?: Db): Promise<Map<string, TokenFacts>> {
  const out = new Map<string, TokenFacts>();
  const d = db ?? (await getDb());
  for (let i = 0; i < mints.length; i += 500) {
    const chunk = mints.slice(i, i + 500);
    const rows = await d.q<Record<string, unknown>>("SELECT * FROM token_facts WHERE mint = ANY($1::text[])", [chunk]);
    for (const r of rows) out.set(r.mint as string, rowToFacts(r));
  }
  return out;
}

// Bonding-curve launchpads: a token that never graduated never left the curve, so it never got near $1M.
const CURVE_LAUNCHPADS = /pump|bonk|launchlab|raydium|believe|moonshot|boop|bags|heaven|stonk|jup|meteora|dbc/i;

// Why a token does or does not need a price-history call. Cheap filters first, so the slow API is used rarely.
export function peakPlan(f: TokenFacts, minPeakUsd: number): "fetch" | `skip:${string}` {
  if (f.infoAt != null && f.supply == null && f.mcapUsd == null) return "skip:no-market";
  if (f.launchpad && CURVE_LAUNCHPADS.test(f.launchpad) && f.graduatedAt == null) return "skip:never-graduated";
  if ((f.mcapUsd ?? 0) < 30_000 && (f.holders ?? 0) < 100) return "skip:tiny";
  void minPeakUsd;
  return "fetch";
}

export interface EnsureOpts {
  minPeakUsd: number;
  infoTtl?: number; // seconds
  peakTtl?: number;
  maxPeakFetch?: number; // price-history calls allowed this time (the free API is slow); the rest stay estimated
  onProgress?: (done: number, total: number, note: string) => Promise<void> | void;
  shouldStop?: () => Promise<void> | void; // throws to stop
  onSourceProblem?: (msg: string) => void; // a price source was switched off for this run (bad key, quota)
  // Per-run filter: false = this run cannot use the token's history (e.g. every wallet bought above the entry
  // cap), so do not spend a slow lookup on it. Nothing is stored: another run may need it.
  needsHistory?: (f: TokenFacts) => boolean;
}

// How long fetched price history is reused. A token that peaked over a week ago and now trades well below that
// peak will not set a new high tomorrow, so it keeps 14 days; anything else 3 days.
export function historyTtl(f: TokenFacts, defaultTtl: number): number {
  const c = f.candles;
  if (!c || c.length === 0) return defaultTtl;
  let peakDay = c[0][0];
  let peak = 0;
  for (const [day, high] of c) if (high > peak) (peak = high), (peakDay = day);
  const lastClose = c[c.length - 1][2];
  return now() - peakDay > 7 * DAY && lastClose < 0.5 * peak ? Math.max(defaultTtl, 14 * DAY) : defaultTtl;
}

// Fills token_facts for these mints: info for all, candles only where the filters say it could matter.
// `mints` should be in priority order: when maxPeakFetch runs out, the first ones got their history.
export async function ensureFacts(src: MarketSource, mints: string[], o: EnsureOpts): Promise<Map<string, TokenFacts>> {
  const db = await getDb();
  const infoTtl = o.infoTtl ?? DAY;
  const peakTtl = o.peakTtl ?? 3 * DAY;
  const t = now();
  const uniq = [...new Set(mints)];
  let facts = await loadFacts(uniq, db);

  const needInfo = uniq.filter((m) => {
    const f = facts.get(m);
    return !f || f.infoAt == null || t - f.infoAt > infoTtl;
  });
  if (needInfo.length) {
    await o.onProgress?.(0, needInfo.length, `token info for ${needInfo.length} tokens (Jupiter, free)`);
    const info = await src.info(needInfo);
    for (const m of needInfo) {
      const i = info.get(m);
      await db.run(
        `INSERT INTO token_facts (mint, symbol, name, supply, price_usd, mcap_usd, launchpad, graduated_at, created_at, holders, info_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (mint) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, supply = COALESCE(excluded.supply, token_facts.supply),
           price_usd = excluded.price_usd, mcap_usd = excluded.mcap_usd, launchpad = excluded.launchpad, graduated_at = excluded.graduated_at,
           created_at = COALESCE(excluded.created_at, token_facts.created_at), holders = excluded.holders, info_at = excluded.info_at`,
        i
          ? [m, i.symbol, i.name, i.supply, i.priceUsd, i.mcapUsd, i.launchpad, i.graduatedAt, i.createdAt, i.holders, t]
          : [m, null, null, null, null, null, null, null, null, null, t], // looked up, not listed
      );
    }
    facts = await loadFacts(uniq, db);
  }

  let needPeak: string[] = [];
  for (const m of uniq) {
    const f = facts.get(m)!;
    // Fresh history is reused, unless it contradicts today's price: then it was stored wrong (e.g. the other side
    // of the pool, before the 2026-10-01 fix) and is fetched again.
    if (f.peakAt != null && t - f.peakAt <= historyTtl(f, peakTtl) && !candlesDisagree(f.candles ?? [], f.priceUsd)) continue;
    const plan = peakPlan(f, o.minPeakUsd);
    if (plan === "fetch") {
      if (o.needsHistory && !o.needsHistory(f)) continue;
      needPeak.push(m);
    }
    else if (f.peakStatus !== plan) await db.run("UPDATE token_facts SET peak_status = $1 WHERE mint = $2", [plan, m]);
  }
  if (o.maxPeakFetch != null && needPeak.length > o.maxPeakFetch) needPeak = needPeak.slice(0, o.maxPeakFetch);
  if (needPeak.length) {
    // Two lanes pull from one queue: the token-keyed source (Birdeye, about 1 a second) and GeckoTerminal
    // (pool-keyed, slower). A token Birdeye cannot answer goes to the GeckoTerminal lane. Without a Birdeye
    // key only the GeckoTerminal lane runs, as before.
    const save = "UPDATE token_facts SET pool = $1, candles = $2, peak_at = $3, peak_status = $4, supply = COALESCE(supply, $5) WHERE mint = $6";
    const store = async (m: string, pool: string | null, c: Candle[], supply: number | null) => {
      const bad = candlesDisagree(c, facts.get(m)?.priceUsd ?? null);
      await db.run(save, [pool, bad ? null : JSON.stringify(c), t, bad ? "mismatch" : c.length ? "fetched" : "missing", supply, m]);
    };
    const queue = [...needPeak];
    const fallback: string[] = [];
    const pools = new Map<string, { pool: string; supply: number | null } | null>();
    const label = src.tokenCandles ? `${src.tokenCandlesName ?? "token source"} + GeckoTerminal` : "GeckoTerminal, free, rate-limited";
    let done = 0;
    let tokenLaneOpen = !!src.tokenCandles;
    const tick = async () => {
      await o.shouldStop?.();
      await o.onProgress?.(done, needPeak.length, `price history ${done}/${needPeak.length} (${label})`);
    };

    const tokenLane = async () => {
      try {
        for (let m = queue.shift(); m; m = queue.shift()) {
          await tick();
          try {
            await store(m, null, await src.tokenCandles!(m, facts.get(m)?.createdAt ?? null), null);
            done++;
          } catch (e) {
            if (!(e instanceof CandleSourceError)) throw e; // cancellation and other real errors
            fallback.push(m);
            if (e.disable) {
              o.onSourceProblem?.(e.message);
              break;
            }
          }
        }
      } finally {
        tokenLaneOpen = false;
      }
    };

    const geckoLane = async () => {
      for (;;) {
        const m = fallback.shift() ?? queue.shift();
        if (!m) {
          if (!tokenLaneOpen) break;
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        await tick();
        if (!pools.has(m)) {
          // Pools for this token and the next ones in line, 30 per call.
          const batch = [m, ...queue.filter((x) => !pools.has(x)).slice(0, 29)];
          const got = await src.topPools(batch);
          for (const x of batch) pools.set(x, got.get(x) ?? null);
        }
        const p = pools.get(m);
        if (!p) await db.run(save, [null, null, t, "missing", null, m]);
        else {
          try {
            await store(m, p.pool, await src.dailyCandles(p.pool, m), p.supply);
          } catch {
            // Leave peak_at null so the next run retries.
          }
        }
        done++;
      }
    };

    await Promise.all([src.tokenCandles ? tokenLane() : Promise.resolve(), geckoLane()]);
    facts = await loadFacts(uniq, db);
  }
  return facts;
}

// Price history must end near today's price. If the latest close is more than 20x away from the live price, the
// series is for something else (wrong side of the pool, a migrated pool) and is dropped rather than trusted.
export function candlesDisagree(c: Candle[], livePriceUsd: number | null): boolean {
  if (!c.length || livePriceUsd == null || !(livePriceUsd > 0)) return false;
  const lastClose = c[c.length - 1][2];
  if (!(lastClose > 0)) return true;
  const ratio = lastClose / livePriceUsd;
  return ratio > 20 || ratio < 1 / 20;
}

// ---------- SOL/USD ----------

export async function ensureSolPrice(src: MarketSource): Promise<(ts: number) => number | null> {
  const db = await getDb();
  const newest = (await db.one<{ d: number | null }>("SELECT MAX(day) AS d FROM sol_price"))?.d ?? null;
  if (newest == null || now() - newest > 1.5 * DAY) {
    try {
      const rows = await src.solUsdDaily();
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        await db.run(
          `INSERT INTO sol_price (day, usd) VALUES ${chunk.map((_, k) => `($${2 * k + 1}, $${2 * k + 2})`).join(",")}
           ON CONFLICT (day) DO UPDATE SET usd = excluded.usd`,
          chunk.flat(),
        );
      }
    } catch {
      // keep what we have
    }
  }
  const rows = await db.q<{ day: number; usd: number }>("SELECT day, usd FROM sol_price ORDER BY day");
  if (rows.length === 0) return () => null;
  return (ts: number) => {
    // nearest earlier day, or the oldest we have
    let lo = 0, hi = rows.length - 1;
    if (ts <= rows[0].day) return rows[0].usd;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rows[mid].day <= ts) lo = mid;
      else hi = mid - 1;
    }
    return rows[lo].usd;
  };
}

export const MAX_PLAUSIBLE_PEAK_USD = 100e9;

// Highest market cap reached from `from` onward, from daily candles. A daily high on a day with almost no volume
// is often a single freak trade, so on thin days the close is used instead.
export function peakMcapAfter(f: TokenFacts, from: number, until?: number): number | null {
  if (!f.candles || f.candles.length === 0 || !f.supply) return null;
  const startDay = Math.floor(from / DAY) * DAY;
  let best = 0;
  for (const [day, high, close, vol] of f.candles) {
    if (day < startDay) continue;
    if (until != null && day > until) break;
    const p = vol >= 5_000 ? high : close;
    if (p > best) best = p;
  }
  if (!(best > 0)) return null;
  const peak = best * f.supply;
  // No Solana token has peaked anywhere near this. A number this big is bad data, so it counts as unknown.
  return peak > MAX_PLAUSIBLE_PEAK_USD ? null : peak;
}
