import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import { claimRun, createRun, executeRun, getRun, STALE_MS } from "@/lib/pipeline/run";
import { claimNext } from "@/lib/worker";
import { FakeRpc } from "./helpers";
import { NOW, world } from "./world";

describe("run claims", () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("a run owned by a live process is not executed by another", async () => {
    const { id } = await createRun("tokens", ["M1", "M2"], {});
    const db = await getDb();
    await db.run("UPDATE runs SET status = 'running', owner = 'other-proc', heartbeat = $1 WHERE id = $2", [Date.now(), id]);
    expect(await claimRun(id)).toBe(false);
    const rpc = new FakeRpc(world(), { gtfa: true });
    await executeRun(id, rpc, { now: () => NOW });
    expect(rpc.credits).toBe(0);
    const r = (await getRun(id))!;
    expect(r.status).toBe("running");
    expect(r.owner).toBe("other-proc");
  });

  it("a run whose owner went silent is taken over", async () => {
    const { id } = await createRun("tokens", ["M1", "M2"], {});
    const db = await getDb();
    await db.run("UPDATE runs SET status = 'running', owner = 'dead-proc', heartbeat = $1 WHERE id = $2", [Date.now() - STALE_MS - 1000, id]);
    await executeRun(id, new FakeRpc(world(), { gtfa: true }), { now: () => NOW });
    const r = (await getRun(id))!;
    expect(r.status).toBe("done");
    expect(r.owner).toBeNull(); // released when finished
  });

  it("a claimed-at-creation run (CLI) is runnable by its creator only", async () => {
    const { id } = await createRun("tokens", ["M1"], {}, { claim: true });
    expect(await claimRun(id)).toBe(true); // same process
    const db = await getDb();
    await db.run("UPDATE runs SET owner = 'someone-else' WHERE id = $1", [id]);
    expect(await claimRun(id)).toBe(false);
  });

  it("two workers asking at once get different runs, never the same one", async () => {
    const a = await createRun("tokens", ["M1", "M2"], {});
    const b = await createRun("tokens", ["M2", "M3"], {});
    const [x, y, z] = await Promise.all([claimNext(), claimNext(), claimNext()]);
    const got = [x, y, z].filter((v) => v != null).sort();
    expect(got).toEqual([a.id, b.id].sort());
  });

  it("one person can have at most the allowed number of live runs; a duplicate still returns the live one", async () => {
    const a = await createRun("tokens", ["M1", "M2"], { earlyBuyers: 50 }, { userId: "u1", maxLive: 2 });
    await createRun("tokens", ["M1", "M2"], { earlyBuyers: 51 }, { userId: "u1", maxLive: 2 });
    await expect(createRun("tokens", ["M1", "M2"], { earlyBuyers: 52 }, { userId: "u1", maxLive: 2 })).rejects.toThrow(/already have 2 runs/);
    // The same request as a live run is not a new run, so it is not refused
    expect(await createRun("tokens", ["M2", "M1"], { earlyBuyers: 50 }, { userId: "u1", maxLive: 2 })).toEqual({ id: a.id, existing: true });
    // Someone else is not affected
    expect((await createRun("tokens", ["M1", "M2"], { earlyBuyers: 52 }, { userId: "u2", maxLive: 2 })).existing).toBe(false);
    // Racing starts cannot sneak past the limit
    const db = await getDb();
    await db.run("UPDATE runs SET status = 'done' WHERE created_by = 'u1'");
    const results = await Promise.allSettled([50, 60, 70, 80].map((n) => createRun("tokens", ["M3", "M4"], { earlyBuyers: n }, { userId: "u1", maxLive: 2 })));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2);
  });

  it("a double-clicked start returns the live run instead of a second one", async () => {
    const a = await createRun("tokens", ["M1", "M2"], { earlyBuyers: 50 }, { userId: "u1" });
    const b = await createRun("tokens", ["M2", "M1"], { earlyBuyers: 50 }, { userId: "u1" });
    expect(b).toEqual({ id: a.id, existing: true });
    // Another user, or different settings, is a different run
    expect((await createRun("tokens", ["M1", "M2"], { earlyBuyers: 50 }, { userId: "u2" })).existing).toBe(false);
    expect((await createRun("tokens", ["M1", "M2"], { earlyBuyers: 60 }, { userId: "u1" })).existing).toBe(false);
    // Once finished, the same request starts fresh
    const db = await getDb();
    await db.run("UPDATE runs SET status = 'done' WHERE id = $1", [a.id]);
    expect((await createRun("tokens", ["M1", "M2"], { earlyBuyers: 50 }, { userId: "u1" })).existing).toBe(false);
  });
});
