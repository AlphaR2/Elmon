import type { RawTx } from "@/lib/solana/tx";
import type { Candle, MarketSource } from "@/lib/tokens";
import { buyTx, createTx, fundTx, sellTx } from "./helpers";

export const NOW = 1_800_000_000;
export const DAY = 86400;
export const T0 = NOW - 30 * DAY; // tokens launched a month before NOW

// A small chain with one clear trader (S1), one repeat buyer who loses (S2), a dev-linked insider (X),
// a bundle (B1-B3), an exchange funder (CEX) and noise buyers. `n` maps names to addresses.
export function world(n: (name: string) => string = (s) => s, now = NOW): RawTx[] {
  const t0 = now - 30 * DAY;
  const txs: RawTx[] = [];
  const at = (t: number) => ({ slot: t, time: t });
  const fund = (from: string, to: string, sol: number, t: number) => txs.push(fundTx({ from: n(from), to: n(to), sol, ...at(t) }));

  fund("CEX", "S1", 50, t0 - 20 * DAY);
  fund("CEX", "Y", 5, t0 - 60 * DAY);
  fund("F2", "S2", 50, t0 - 15 * DAY);
  fund("Fdev", "D3", 10, t0 - 5 * DAY);
  fund("Fdev", "X", 10, t0 - 4 * DAY);
  for (const b of ["B1", "B2", "B3"]) fund("FB", b, 3, t0 - DAY + b.charCodeAt(1));
  for (const d of ["D1", "D2"]) fund(`F${d}`, d, 3, t0 - 3 * DAY);
  for (let i = 1; i <= 6; i++) fund(`FN${i}`, `N${i}`, 3, t0 - 7 * DAY);
  // The exchange is busy: 1,000 payouts in the last hour
  for (let i = 0; i < 1000; i++) fund("CEX", `cust${i}`, 0.1, now - 3600 + i);

  const launch = (mint: string, dev: string, t: number, early: string[], block0: string[] = []) => {
    txs.push(createTx({ deployer: n(dev), mint: n(mint), ...at(t), devBuySol: 1 }));
    block0.forEach((w) => txs.push(buyTx({ wallet: n(w), mint: n(mint), sol: 0.5, tokens: 500, ...at(t) })));
    early.forEach((w, i) => txs.push(buyTx({ wallet: n(w), mint: n(mint), sol: 1, tokens: 100, ...at(t + 20 + i * 5) })));
  };
  launch("M1", "D1", t0, ["S1", "S2", "X", "N1", "N2"]);
  launch("M2", "D2", t0 + DAY, ["S2", "S1", "N3", "Y"], ["B1", "B2", "B3"]);
  launch("M3", "D3", t0 + 2 * DAY, ["S1", "X", "S2", "N4", "Y"]);

  txs.push(sellTx({ wallet: n("S1"), mint: n("M1"), sol: 5, tokens: 100, held: 100, ...at(t0 + 3600), close: true }));
  for (let i = 0; i < 8; i++) {
    const t = t0 + 5 * DAY + i * DAY;
    txs.push(buyTx({ wallet: n("S1"), mint: n(`O${i}`), sol: 1, tokens: 100, ...at(t) }));
    txs.push(sellTx({ wallet: n("S1"), mint: n(`O${i}`), sol: 3, tokens: 100, held: 100, ...at(t + 1800), close: true }));
  }
  for (let i = 0; i < 8; i++) {
    const t = t0 + 5 * DAY + i * DAY + 100;
    txs.push(buyTx({ wallet: n("S2"), mint: n(`P${i}`), sol: 1, tokens: 100, ...at(t) }));
    txs.push(sellTx({ wallet: n("S2"), mint: n(`P${i}`), sol: 0.4, tokens: 100, held: 100, ...at(t + 1800), close: true }));
  }
  return txs;
}

// Free market data for the world above. Token supply 10,000 and SOL at $150, so a 1 SOL buy of 100 tokens is an
// entry at $15k market cap. O0-O3 later peak at $3M (runners), O4-O7 at $30k, P* at $20k, the pasted M* at $2M.
export function fakeMarket(now = NOW, nameOf: (addr: string) => string = (a) => a): MarketSource {
  const t0 = now - 30 * DAY;
  const supply = 10_000;
  const day = (t: number) => Math.floor(t / DAY) * DAY;
  const high = (addr: string): number => {
    const mint = nameOf(addr);
    if (/^O[0-3]$/.test(mint)) return 300;
    if (/^O[4-7]$/.test(mint)) return 3;
    if (/^M\d$/.test(mint)) return 200;
    return 2;
  };
  return {
    async info(mints) {
      return new Map(
        mints.map((m) => [m, { mint: m, symbol: nameOf(m), name: nameOf(m), supply, priceUsd: high(m) / 2, mcapUsd: 50_000, launchpad: null, graduatedAt: null, createdAt: t0, holders: 500 }]),
      );
    },
    async topPools(mints) {
      return new Map(mints.map((m) => [m, { pool: `pool-${m}`, supply }]));
    },
    async dailyCandles(pool, _token) {
      const mint = pool.slice(5);
      const h = high(mint);
      return [[day(t0 + 14 * DAY), h, h / 2, 10_000] as Candle];
    },
    async solUsdDaily() {
      const out: [number, number][] = [];
      for (let d = day(t0 - 90 * DAY); d <= now; d += DAY) out.push([d, 150]);
      return out;
    },
  };
}
