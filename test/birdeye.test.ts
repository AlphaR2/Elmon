import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { CandleSourceError, ensureFacts, FreeMarket, peakMcapAfter, type Candle, type MarketSource } from "@/lib/tokens";

const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const info = (mints: string[]) =>
  new Map(mints.map((m) => [m, { mint: m, symbol: m, name: m, supply: 1e9, priceUsd: 0.01, mcapUsd: 1e7, launchpad: null, graduatedAt: null, createdAt: now - 30 * DAY, holders: 5000 }]));
const candles = (high: number): Candle[] => [[now - 2 * DAY, high, 0.01, 1e5]];

function source(o: { birdeye?: (m: string) => Promise<Candle[]> }) {
  const gecko: string[] = [];
  const bird: string[] = [];
  const src: MarketSource = {
    info: async (m) => info(m),
    topPools: async (m) => new Map(m.map((x) => [x, { pool: `pool-${x}`, supply: null }])),
    dailyCandles: async (_pool, token) => {
      gecko.push(token);
      return candles(0.02);
    },
    solUsdDaily: async () => [],
  };
  if (o.birdeye) {
    src.tokenCandles = async (m) => {
      bird.push(m);
      return o.birdeye!(m);
    };
    src.tokenCandlesName = "Birdeye";
  }
  return { src, gecko, bird };
}

describe("Birdeye alongside GeckoTerminal", () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("without a key, only GeckoTerminal is used (unchanged behaviour)", async () => {
    const { src, gecko } = source({});
    await ensureFacts(src, ["A", "B", "C"], { minPeakUsd: 1e6 });
    expect(gecko.sort()).toEqual(["A", "B", "C"]);
  });

  it("with a key, both share the list and every token is looked up exactly once", async () => {
    const { src, gecko, bird } = source({ birdeye: async () => candles(0.03) });
    const mints = Array.from({ length: 12 }, (_, i) => `T${i}`);
    const facts = await ensureFacts(src, mints, { minPeakUsd: 1e6 });
    expect(bird.length).toBeGreaterThan(0);
    expect([...bird, ...gecko].sort()).toEqual([...mints].sort());
    for (const m of mints) expect(facts.get(m)!.peakStatus).toBe("fetched");
  });

  it("a token Birdeye cannot answer falls back to GeckoTerminal", async () => {
    const { src, gecko } = source({
      birdeye: async (m) => {
        if (m === "B") throw new CandleSourceError("no data");
        return candles(0.03);
      },
    });
    const facts = await ensureFacts(src, ["A", "B"], { minPeakUsd: 1e6 });
    expect(gecko).toContain("B");
    expect(peakMcapAfter(facts.get("B")!, 0)).toBeCloseTo(0.02 * 1e9, -3);
  });

  it("a refused key switches Birdeye off for the run and says so", async () => {
    let calls = 0;
    const { src, gecko } = source({
      birdeye: async () => {
        calls++;
        throw new CandleSourceError("Birdeye refused the request (HTTP 401)", true);
      },
    });
    const problems: string[] = [];
    const mints = ["A", "B", "C", "D"];
    await ensureFacts(src, mints, { minPeakUsd: 1e6, onSourceProblem: (m) => problems.push(m) });
    expect(calls).toBe(1);
    expect(problems).toHaveLength(1);
    expect(gecko.sort()).toEqual(mints);
  });
});

describe("Birdeye request and response", () => {
  let server: http.Server;
  let seen: { url: string; key: string | undefined; chain: string | undefined }[] = [];
  const realFetch = globalThis.fetch;
  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "", key: req.headers["x-api-key"] as string, chain: req.headers["x-chain"] as string });
      if (req.headers["x-api-key"] !== "good") {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { items: [{ unixTime: 200, o: 1, h: 3, l: 1, c: 2, v: 10, vUsd: 9000 }, { unixTime: 100, o: 1, h: 2, l: 1, c: 1.5, v: 10, vUsd: 8000 }] } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => realFetch(String(url).replace("https://public-api.birdeye.so", base), init));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("asks for daily USD candles by token with the key and chain headers, and maps them oldest first", async () => {
    const m = new FreeMarket({ birdeyeKey: "good" });
    const c = await m.tokenCandles!("MINT", now - 10 * DAY);
    expect(c).toEqual([
      [100, 2, 1.5, 8000],
      [200, 3, 2, 9000],
    ]);
    expect(seen[0].key).toBe("good");
    expect(seen[0].chain).toBe("solana");
    expect(seen[0].url).toMatch(/^\/defi\/ohlcv\?address=MINT&type=1D&currency=usd&time_from=\d+&time_to=\d+$/);
  });

  it("a refused key is reported as 'switch this source off'", async () => {
    const m = new FreeMarket({ birdeyeKey: "bad" });
    await expect(m.tokenCandles!("MINT", null)).rejects.toMatchObject({ disable: true });
  });

  it("no key, no Birdeye", () => {
    expect(new FreeMarket({ birdeyeKey: null }).tokenCandles).toBeUndefined();
  });
});
