// Dev only: market data for the fake chain in scripts/fake-helius.ts, so runners and charts can be tried
// without real tokens. Enabled with ELMON_DEMO_MARKET=1 and never in production.
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { fakeMarket } from "../test/world";

const addr = (name: string) => bs58.encode(createHash("sha256").update(`elmon-demo:${name}`).digest());

export function demoMarket() {
  const names = ["M1", "M2", "M3", ...Array.from({ length: 8 }, (_, i) => `O${i}`), ...Array.from({ length: 8 }, (_, i) => `P${i}`)];
  const back = new Map(names.map((n) => [addr(n), n]));
  return fakeMarket(Math.floor(Date.now() / 1000), (a) => back.get(a) ?? a);
}
