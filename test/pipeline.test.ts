import { beforeEach, describe, expect, it } from "vitest";
import { getDb, json, resetDbForTests } from "@/lib/db";
import { createRun, executeRun, getRun, requestInsiderScan, type OnTokenResult } from "@/lib/pipeline/run";
import type { TraderStats } from "@/lib/core/pnl";
import type { RunnerStats } from "@/lib/core/runners";
import { FakeRpc } from "./helpers";
import { fakeMarket, NOW, world } from "./world";

async function rows(runId = 1) {
  const db = await getDb();
  const wallets = await db.q<Record<string, unknown>>("SELECT * FROM wallets WHERE run_id = $1", [runId]);
  return Object.fromEntries(wallets.map((w) => [w.wallet as string, w]));
}
async function clustersByKind(runId: number) {
  const db = await getDb();
  const clusters = await db.q<{ kind: string; members: string }>("SELECT kind, members FROM clusters WHERE run_id = $1", [runId]);
  return Object.fromEntries(clusters.map((c) => [c.kind, json<string[]>(c.members, []).sort()]));
}

describe.each([
  ["Helius getTransactionsForAddress", true],
  ["plain RPC fallback", false],
])("pipeline over a fake chain (%s)", (_name, gtfa) => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("finds the profitable repeat buyer and separates the insiders", async () => {
    const rpc = new FakeRpc(world(), { gtfa });
    const { id } = await createRun("tokens", ["M1", "M2", "M3"], { earlyBuyers: 20, minClosedPositions: 5, funderScope: "all" });
    await executeRun(id, rpc, { now: () => NOW });
    const run = (await getRun(id))!;
    expect(run.status).toBe("done");

    const db = await getDb();
    const tokens = await db.q("SELECT mint, status, deployer, launchpad FROM tokens WHERE run_id = $1 ORDER BY mint", [id]);
    expect(tokens).toEqual([
      { mint: "M1", status: "ok", deployer: "D1", launchpad: "pump.fun" },
      { mint: "M2", status: "ok", deployer: "D2", launchpad: "pump.fun" },
      { mint: "M3", status: "ok", deployer: "D3", launchpad: "pump.fun" },
    ]);

    const w = await rows(id);
    expect(w.S1.role).toBe("candidate");
    expect(w.S1.hits).toBe(3);
    expect(w.S2.role).toBe("candidate");
    expect(w.X.role).toBe("candidate");
    expect(w.Y.role).toBe("candidate");
    expect(w.B1.role).toBe("buyer");
    expect(w.D3.role).toBe("deployer");

    // Funders and exchange detection
    expect(w.S1.funder).toBe("CEX");
    expect(w.S1.funder_service).toBe(1);
    expect(w.X.funder).toBe("Fdev");

    // Clusters
    const byKind = await clustersByKind(id);
    expect(byKind["dev-linked"]).toEqual(["D3", "X"]);
    expect(byKind.bundle).toEqual(["B1", "B2", "B3"]);
    // S1 and Y share an exchange funder but were created 40 days apart: not a group
    expect(w.S1.cluster_id).toBeNull();

    // History and scoring
    expect(w.X.history_status).toBe("skipped:insider");
    const s1 = json<TraderStats | null>(w.S1.stats, null)!;
    const s2 = json<TraderStats | null>(w.S2.stats, null)!;
    expect(s1.closed).toBe(8);
    expect(s1.winRate).toBe(1);
    expect(s1.netSol).toBeGreaterThan(15);
    expect(s2.winRate).toBe(0);
    expect(w.S1.score as number).toBeGreaterThan(w.S2.score as number);
    // pasted tokens stay out of the score but show in on_tokens
    expect(s1.top.some((p) => p.mint.startsWith("M"))).toBe(false);
    const on = json<OnTokenResult[]>(w.S1.on_tokens, []);
    const m1 = on.find((o) => o.mint === "M1")!;
    expect(m1.status).toBe("closed");
    expect(m1.multiple!).toBeGreaterThan(4.5);
    expect(on.find((o) => o.mint === "M2")!.status).toBe("open");

    // Tags
    expect(json<string[]>(w.S1.tags, [])).toContain("service-funded");
    expect(json<string[]>(w.B1.tags, [])).toEqual(expect.arrayContaining(["bundle", "block-0"]));
    expect(json<string[]>(w.X.tags, [])).toContain("dev-linked");
    expect(json<string[]>(w.D1.tags, [])).toContain("dev");
    expect(json<string[]>(w.Y.tags, [])).toContain("thin-history");

    expect(rpc.credits).toBeGreaterThan(0);
  });

  it("by default traces only candidates; an insider scan of one launch finds its bundle", async () => {
    const rpc = new FakeRpc(world(), { gtfa });
    const { id } = await createRun("tokens", ["M1", "M2", "M3"], { earlyBuyers: 20 });
    await executeRun(id, rpc, { now: () => NOW });
    expect((await getRun(id))!.status).toBe("done");
    expect((await clustersByKind(id)).bundle).toBeUndefined();
    expect((await rows(id)).B1.funder).toBeNull();

    // A scan while the run is live is refused: the worker owns the stage list.
    const db = await getDb();
    await db.run("UPDATE runs SET status = 'running' WHERE id = $1", [id]);
    expect(await requestInsiderScan(id, "M2")).toBe("busy");
    await db.run("UPDATE runs SET status = 'done' WHERE id = $1", [id]);

    const before = rpc.credits;
    expect(await requestInsiderScan(id, "M2")).toBe("queued");
    expect((await getRun(id))!.status).toBe("queued");
    await executeRun(id, rpc, { now: () => NOW });
    expect((await getRun(id))!.status).toBe("done");
    expect((await clustersByKind(id)).bundle).toEqual(["B1", "B2", "B3"]);
    const w = await rows(id);
    expect(json<string[]>(w.B1.tags, [])).toContain("bundle");
    expect(w.S1.history_status).toBe("done"); // history was not redone
    // Only M2's untraced buyers cost anything; M1/M3-only buyers were not looked up.
    expect(w.N1.funder).toBeNull();
    expect(rpc.credits - before).toBeGreaterThan(0);
    expect(await requestInsiderScan(id, "NOT-IN-RUN")).toBe("unknown-mint");
  });

  it("rerunning a finished run spends nothing (finished stages are skipped)", async () => {
    const rpc = new FakeRpc(world(), { gtfa });
    const { id } = await createRun("tokens", ["M1", "M2", "M3"], { earlyBuyers: 20 });
    await executeRun(id, rpc, { now: () => NOW });
    const before = rpc.credits;
    const db = await getDb();
    await db.run("UPDATE runs SET status = 'running' WHERE id = $1", [id]);
    await executeRun(id, rpc, { now: () => NOW });
    expect(rpc.credits).toBe(before);
  });

  it("a new run over the same tokens reuses saved launches, funders and histories", async () => {
    const rpc = new FakeRpc(world(), { gtfa });
    const a = await createRun("tokens", ["M1", "M2", "M3"], { earlyBuyers: 20 });
    await executeRun(a.id, rpc, { now: () => NOW });
    const first = rpc.credits;
    const b = await createRun("tokens", ["M3", "M2", "M1"], { earlyBuyers: 20, historyTopK: 29 }); // different settings: a new run
    expect(b.id).not.toBe(a.id);
    const calls0 = { ...rpc.calls };
    await executeRun(b.id, rpc, { now: () => NOW });
    const second = rpc.credits - first;
    expect((await getRun(b.id))!.status).toBe("done");
    expect(second).toBeLessThan(first / 2); // tiny world: what is left is one "anything newer?" page per wallet
    // No launch was read again: the only new calls are "anything newer?" checks on wallet histories.
    const newCalls = Object.fromEntries(Object.entries(rpc.calls).map(([k, v]) => [k, v - (calls0[k] ?? 0)]));
    if (gtfa) expect(Object.keys(newCalls).filter((k) => newCalls[k] > 0)).toEqual(["getTransactionsForAddress"]);
    // Same answers
    const w = await rows(b.id);
    expect(json<TraderStats | null>(w.S1.stats, null)!.closed).toBe(8);
  });

  it("stops spending at the budget and still finishes with partial results", async () => {
    const rpc = new FakeRpc(world(), { gtfa, budget: gtfa ? 25 : 12 });
    const { id } = await createRun("tokens", ["M1", "M2", "M3"], { earlyBuyers: 20 });
    await executeRun(id, rpc, { now: () => NOW });
    const run = (await getRun(id))!;
    expect(run.status).toBe("done");
    expect(run.error).toMatch(/budget/i);
    const db = await getDb();
    const skipped = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM tokens WHERE run_id = $1 AND status = 'skipped'", [id]);
    expect(skipped!.n).toBeGreaterThan(0);
  });

  it("analyses pasted wallets directly", async () => {
    const rpc = new FakeRpc(world(), { gtfa });
    const { id } = await createRun("wallets", ["S1", "S2"], {});
    await executeRun(id, rpc, { now: () => NOW });
    expect((await getRun(id))!.status).toBe("done");
    const w = await rows(id);
    expect(w.S1.role).toBe("input");
    expect(w.S1.history_status).toBe("done");
    // no pasted mints to exclude, so M1 counts here
    const s1 = json<TraderStats | null>(w.S1.stats, null)!;
    expect(s1.top.some((p) => p.mint === "M1")).toBe(true);
    expect(w.S1.score as number).toBeGreaterThan(w.S2.score as number);
  });

  it("scores runners from market data, leaving the pasted tokens out", async () => {
    const rpc = new FakeRpc(world(), { gtfa });
    const { id } = await createRun("tokens", ["M1", "M2", "M3"], { earlyBuyers: 20 });
    await executeRun(id, rpc, { now: () => NOW, market: fakeMarket() });
    expect((await getRun(id))!.status).toBe("done");
    const w = await rows(id);
    const r1 = json<RunnerStats | null>(w.S1.runner, null)!;
    const r2 = json<RunnerStats | null>(w.S2.runner, null)!;
    // S1 bought O0-O3 at $15k and they ran to $2M+; it sold at 3x (paperhands). S2's P tokens never ran.
    expect(r1.runners).toBe(4);
    expect(r1.hits.every((h) => h.mint.startsWith("O"))).toBe(true); // M1-M3 (pasted) excluded
    expect(r1.medianCapture!).toBeLessThan(0.25);
    expect(r2.runners).toBe(0);
    expect(w.S1.runner_score as number).toBeGreaterThan(w.S2.runner_score as number);
    const tags = json<string[]>(w.S1.tags, []);
    expect(tags).toEqual(expect.arrayContaining(["runner-catcher", "paperhands"]));
    // Pasted tokens got their peak and weight
    const db = await getDb();
    const m1 = await db.one<{ peak_usd: number; weight: number }>("SELECT peak_usd, weight FROM tokens WHERE run_id = $1 AND mint = 'M1'", [id]);
    expect(m1!.peak_usd).toBeGreaterThan(1_000_000);
    expect(m1!.weight).toBeGreaterThanOrEqual(1);
    expect(w.S1.weighted_hits as number).toBeGreaterThanOrEqual(3);
  });
});
