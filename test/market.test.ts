import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { candlesDisagree, ensureFacts, peakMcapAfter, type Candle, type MarketSource } from "@/lib/tokens";

describe("price history sanity", () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("asks for the token's own price, not the pool's base side", async () => {
    const asked: string[] = [];
    const src: MarketSource = {
      info: async (m) => new Map(m.map((x) => [x, { mint: x, symbol: "MASK", name: "Nullmask", supply: 994_319_165, priceUsd: 0.0219, mcapUsd: 21_000_000, launchpad: "Raydium LaunchLab", graduatedAt: 1, createdAt: 1, holders: 5000 }])),
      topPools: async (m) => new Map(m.map((x) => [x, { pool: "ZEC-MASK", supply: null }])),
      dailyCandles: async (_pool, token) => {
        asked.push(token);
        // Real MASK candles (2026-09-23..10-01, abridged): peak high 0.0311
        return [[1758585600, 0.00537, 0.00325, 2e6], [1758758400, 0.0311, 0.0256, 2.8e6], [1759276800, 0.022, 0.0219, 3e4]] as Candle[];
      },
      solUsdDaily: async () => [],
    };
    const f = (await ensureFacts(src, ["MASKmint"], { minPeakUsd: 1e6 })).get("MASKmint")!;
    expect(asked).toEqual(["MASKmint"]);
    const peak = peakMcapAfter(f, 0)!;
    expect(peak).toBeGreaterThan(25e6);
    expect(peak).toBeLessThan(40e6); // ~$31M, not $1.6 trillion
  });

  it("drops a series that ends far from the live price (it belongs to something else)", async () => {
    // ZEC's price (~$1,440) returned for MASK (~$0.022)
    expect(candlesDisagree([[0, 1650, 1440, 1e6]], 0.0219)).toBe(true);
    expect(candlesDisagree([[0, 0.03, 0.0219, 1e6]], 0.0219)).toBe(false);
    expect(candlesDisagree([[0, 0.03, 0.02, 1e6]], null)).toBe(false); // no live price: nothing to compare
    const src: MarketSource = {
      info: async (m) => new Map(m.map((x) => [x, { mint: x, symbol: "X", name: "X", supply: 1e9, priceUsd: 0.0219, mcapUsd: 21e6, launchpad: null, graduatedAt: null, createdAt: 1, holders: 5000 }])),
      topPools: async (m) => new Map(m.map((x) => [x, { pool: "p", supply: null }])),
      dailyCandles: async () => [[1759276800, 1650, 1440, 1e6]] as Candle[],
      solUsdDaily: async () => [],
    };
    const f = (await ensureFacts(src, ["X"], { minPeakUsd: 1e6 })).get("X")!;
    expect(f.peakStatus).toBe("mismatch");
    expect(f.candles).toBeNull();
    expect(peakMcapAfter(f, 0)).toBeNull();
  });
});

describe("fewer slow lookups", () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("skips tokens the run cannot use, and keeps finished tokens cached longer", async () => {
    const now = Math.floor(Date.now() / 1000);
    let asked: string[] = [];
    const src: MarketSource = {
      info: async (m) => new Map(m.map((x) => [x, { mint: x, symbol: x, name: x, supply: 1e9, priceUsd: 0.001, mcapUsd: 1e6, launchpad: null, graduatedAt: null, createdAt: now - 60 * 86400, holders: 5000 }])),
      topPools: async (m) => new Map(m.map((x) => [x, { pool: `p-${x}`, supply: null }])),
      dailyCandles: async (_p, token) => {
        asked.push(token);
        // Peaked 30 days ago at 0.01, now 0.001: finished
        return [[now - 30 * 86400, 0.01, 0.009, 1e6], [now - 86400, 0.0011, 0.001, 1e5]] as Candle[];
      },
      solUsdDaily: async () => [],
    };
    await ensureFacts(src, ["KEEP", "SKIP"], { minPeakUsd: 1e6, needsHistory: (f) => f.mint !== "SKIP" });
    expect(asked).toEqual(["KEEP"]);

    // 5 days later: past the default 3-day reuse, but a finished token keeps its history for 14 days
    asked = [];
    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    await db.run("UPDATE token_facts SET peak_at = peak_at - 5 * 86400 WHERE mint = 'KEEP'");
    await ensureFacts(src, ["KEEP"], { minPeakUsd: 1e6 });
    expect(asked).toEqual([]);
    const f = (await import("@/lib/tokens")).historyTtl;
    expect(f({ candles: [[now - 86400, 0.01, 0.01, 1e5]] } as never, 3 * 86400)).toBe(3 * 86400); // near its high: 3 days
  });
});

describe("bad price history already in the cache", () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("is refetched when it contradicts today's price, and absurd peaks never count", async () => {
    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    const now = Math.floor(Date.now() / 1000);
    // QI as stored before the fix: QNT's price (~$300) in place of QI's (~$0.0000052)
    await db.run(
      "INSERT INTO token_facts (mint, symbol, supply, price_usd, mcap_usd, holders, info_at, pool, candles, peak_at, peak_status) VALUES ('QI', 'QI', 1e9, 0.0000052, 5200, 5000, $1, 'QNT-QI', $2, $1, 'fetched')",
      [now, JSON.stringify([[now - 86400, 312.8, 300, 1e6]])],
    );
    let refetched = 0;
    const src: MarketSource = {
      info: async () => new Map(),
      topPools: async (m) => new Map(m.map((x) => [x, { pool: "QNT-QI", supply: null }])),
      dailyCandles: async () => {
        refetched++;
        return [[now - 86400, 0.0000485, 0.0000052, 5e4]] as Candle[];
      },
      solUsdDaily: async () => [],
    };
    const f = (await ensureFacts(src, ["QI"], { minPeakUsd: 1e6 })).get("QI")!;
    expect(refetched).toBe(1);
    expect(peakMcapAfter(f, 0)).toBeCloseTo(48_500, -2); // $48.5K, not $313B

    // Even if bad data slipped through, a peak over $100B is treated as unknown.
    expect(peakMcapAfter({ ...f, candles: [[0, 312.8, 300, 1e6]] }, 0)).toBeNull();
  });
});
