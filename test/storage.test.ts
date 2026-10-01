import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import { createRun, executeRun, getRun } from "@/lib/pipeline/run";
import { markExported } from "@/lib/queries";
import { sweep } from "@/lib/worker";
import { cachedHistory } from "@/lib/pipeline/cache";
import { guard } from "@/lib/auth";
import { safeNext } from "@/lib/format";
import { buyTx, FakeRpc, sellTx } from "./helpers";
import { NOW, world } from "./world";

describe("temporary results, permanent cache", () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("an expired run is deleted with everything it found; the chain cache stays", async () => {
    const rpc = new FakeRpc(world(), { gtfa: true });
    const { id } = await createRun("tokens", ["M1", "M2", "M3"], { earlyBuyers: 20 });
    await executeRun(id, rpc, { now: () => NOW });
    const db = await getDb();
    const count = async (t: string) => (await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
    expect(await count("wallets")).toBeGreaterThan(0);
    const cache = { launches: await count("launches"), wallet_facts: await count("wallet_facts"), wallet_history: await count("wallet_history") };
    expect(cache.launches).toBe(3);

    expect((await sweep()).runs).toBe(0); // not expired yet
    await markExported(id);
    const r = (await getRun(id))!;
    expect(r.exported_at).not.toBeNull();
    expect(r.expires_at - Date.now()).toBeLessThanOrEqual(86_400_000);
    await db.run("UPDATE runs SET expires_at = $1 WHERE id = $2", [Date.now() - 1, id]);
    expect((await sweep()).runs).toBe(1);
    for (const t of ["runs", "wallets", "tokens", "early_buys", "clusters", "run_log"]) expect(await count(t)).toBe(0);
    expect({ launches: await count("launches"), wallet_facts: await count("wallet_facts"), wallet_history: await count("wallet_history") }).toEqual(cache);
  });

  it("a live run is never swept", async () => {
    const { id } = await createRun("tokens", ["M1", "M2"], {});
    const db = await getDb();
    await db.run("UPDATE runs SET status = 'running', expires_at = 0 WHERE id = $1", [id]);
    expect((await sweep()).runs).toBe(0);
  });

  it("history reads only newer transactions the second time, from the saved cursor", async () => {
    const txs = world();
    const rpc = new FakeRpc(txs, { gtfa: true });
    const first = await cachedHistory(rpc, "S1", { maxTxs: 1000, adaptive: false });
    const c1 = rpc.credits;
    // Two new trades land
    rpc.add(buyTx({ wallet: "S1", mint: "NEW", sol: 1, tokens: 100, slot: NOW + 10, time: NOW + 10 }));
    rpc.add(sellTx({ wallet: "S1", mint: "NEW", sol: 2, tokens: 100, held: 100, slot: NOW + 20, time: NOW + 20, close: true }));
    const second = await cachedHistory(rpc, "S1", { maxTxs: 1000, adaptive: false });
    expect(rpc.credits - c1).toBe(10); // one page
    expect(second.newTxs).toBe(2);
    expect(second.events.length).toBe(first.events.length + 2);
    expect(second.events.filter((e) => e.mint === "NEW").map((e) => e.kind).sort()).toEqual(["buy", "sell"]);
    // Nothing new: still one page to ask, nothing added
    const third = await cachedHistory(rpc, "S1", { maxTxs: 1000, adaptive: false });
    expect(third.newTxs).toBe(0);
    expect(third.events.length).toBe(second.events.length);
  });

  it("adaptive history stops after one page for a wallet with nothing worth following", async () => {
    const txs = world();
    // S2 loses on every trade. Give it 250 more losing transactions so a full read would be 4 pages.
    for (let i = 0; i < 125; i++) {
      const t = NOW - 10 * 86400 + i * 60;
      txs.push(buyTx({ wallet: "S2", mint: `L${i}`, sol: 1, tokens: 100, slot: t, time: t }));
      txs.push(sellTx({ wallet: "S2", mint: `L${i}`, sol: 0.5, tokens: 100, held: 100, slot: t + 30, time: t + 30, close: true }));
    }
    const rpc = new FakeRpc(txs, { gtfa: true });
    await cachedHistory(rpc, "S2", { maxTxs: 1000, adaptive: true });
    expect(rpc.credits).toBe(10);
    const full = new FakeRpc(txs, { gtfa: true });
    await resetDbForTests();
    await cachedHistory(full, "S2", { maxTxs: 1000, adaptive: false });
    expect(full.credits).toBeGreaterThanOrEqual(30);
  });
});

describe("access", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("fails closed when sign-in is not configured", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.ELMON_DEV_NO_AUTH;
    const g = await guard();
    expect(g.res?.status).toBe(503);
    const { GET } = await import("@/app/api/runs/route");
    expect((await GET()).status).toBe(503);
  });

  it("the dev bypass never works in production", async () => {
    process.env.ELMON_DEV_NO_AUTH = "1";
    expect((await guard()).user).toMatchObject({ id: "dev", role: "admin" });
    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect((await guard()).res?.status).toBe(503);
  });

  it("sign-in redirects stay on this site", () => {
    expect(safeNext("/runs/3")).toBe("/runs/3");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "", null, "runs"]) expect(safeNext(bad)).toBe("/");
  });
});
