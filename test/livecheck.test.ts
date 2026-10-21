import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { HeliusClient } from "@/lib/helius";
import { FreeMarket } from "@/lib/tokens";
import { FakeRpc } from "./helpers";
import { fakeMarket, NOW, world } from "./world";
import { LiveCheckError, main, parseArgs, runLiveCheck } from "../scripts/live-check";

const KEY = "SECRETKEY-do-not-leak-0123456789";
const URL_WITH_KEY = `http://fake-helius.test/?api-key=${KEY}`;

// A fetch that answers like Helius, over the fake chain. Counts what the node itself was asked for, so the
// credit totals can be checked against a count that does not come from the code under test.
function fakeFetch(node: FakeRpc) {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const msg = JSON.parse(init!.body!) as { id: number; method: string; params: unknown[] };
    const [a, cfg = {}] = msg.params as [string, Record<string, unknown>];
    let result: unknown;
    switch (msg.method) {
      case "getSignaturesForAddress":
        result = await node.getSignatures(a, { before: cfg.before as string | undefined, limit: (cfg.limit as number) ?? 1000 });
        break;
      case "getTransaction":
        result = await node.getTransaction(a);
        break;
      case "getTransactionsForAddress":
        result =
          cfg.transactionDetails === "signatures"
            ? await node.sigsForAddressAsc(a, (cfg.limit as number) ?? 1000)
            : await node.txsForAddress(a, {
                sortOrder: (cfg.sortOrder as "asc" | "desc") ?? "desc",
                limit: Math.min((cfg.limit as number) ?? 100, 100),
                paginationToken: (cfg.paginationToken as string) ?? null,
              });
        break;
      default:
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200 });
  });
}

const rpcFor = (g: ConstructorParameters<typeof HeliusClient>[0]) => new HeliusClient(g, { url: URL_WITH_KEY, rps: 10_000 });
const deps = () => ({ market: fakeMarket(), now: () => NOW });

beforeEach(async () => {
  await resetDbForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("live-check without a key", () => {
  it("exits non-zero with a clear message and makes no network call", async () => {
    vi.stubEnv("HELIUS_API_KEY", "");
    vi.stubEnv("HELIUS_RPC_URL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await main(["M1", "M2", "M3"]);
    expect(code).not.toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(err.mock.calls.flat().join(" ")).toMatch(/HELIUS_API_KEY is not set/);
  });

  it("rejects the wrong number of mints and unknown options before anything runs", () => {
    expect(() => parseArgs(["11111111111111111111111111111111"])).toThrow(LiveCheckError);
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--show", "0"])).toThrow(/--show/);
  });
});

describe("live-check report", () => {
  it("writes per-stage credits that agree with the ledger and with what the node counted, and hides the key", async () => {
    const node = new FakeRpc(world(), { gtfa: true });
    const fetchSpy = fakeFetch(node);
    vi.stubGlobal("fetch", fetchSpy);
    const res = await runLiveCheck({
      mints: ["M1", "M2", "M3"],
      rpcFor,
      settings: { earlyBuyers: 20, minClosedPositions: 5, funderScope: "all" },
      deps: deps(),
      secrets: [URL_WITH_KEY, KEY],
      usingDatabaseUrl: false,
    });
    expect(res.status).toBe("done");
    expect(res.budgetHit).toBe(false);
    // ledger total = per-stage sum = the client's counter = what the fake node charged
    expect(res.ledgerTotal).toBeGreaterThan(0);
    expect(res.stageSum).toBe(res.ledgerTotal);
    expect(res.counterTotal).toBe(res.ledgerTotal);
    expect(node.credits).toBe(res.ledgerTotal);
    expect(res.markdown).toContain("All three agree");
    // stages, derived-average wording, early buyers with entry time, market cap and Solscan links
    expect(res.markdown).toMatch(/\| launch \|/);
    expect(res.markdown).toMatch(/\| history \|/);
    expect(res.markdown).toMatch(/derived averages/);
    expect(res.markdown).toMatch(/not from real usage/); // no DATABASE_URL
    expect(res.markdown).toMatch(/cannot be measured here/);
    expect(res.markdown).toContain("https://solscan.io/token/M1");
    expect(res.markdown).toMatch(/\| 1 \| \[`S1`\]\(https:\/\/solscan.io\/account\/S1\) \| \d{4}-\d{2}-\d{2}T/);
    expect(res.markdown).toMatch(/\$1[0-9]{1,3}[,0-9]*|\$\d+/); // an entry market cap in USD is printed
    // the key is in no request log line and not in the report
    expect(res.markdown).not.toContain(KEY);
    expect(res.markdown).not.toContain("api-key");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("stops at its budget and says so", async () => {
    const node = new FakeRpc(world(), { gtfa: true });
    vi.stubGlobal("fetch", fakeFetch(node));
    const budget = 40; // the whole run costs 91 on this chain
    const res = await runLiveCheck({
      mints: ["M1", "M2", "M3"],
      rpcFor,
      settings: { earlyBuyers: 20, minClosedPositions: 5, funderScope: "all" },
      budget,
      deps: deps(),
      secrets: [KEY],
    });
    expect(res.budgetHit).toBe(true);
    expect(res.counterTotal).toBeLessThanOrEqual(budget);
    expect(node.credits).toBeLessThanOrEqual(budget);
    expect(res.stageSum).toBe(res.ledgerTotal);
    expect(res.markdown).toMatch(/stopped at its budget\*\* of 40 credits/);
    expect(res.markdown).not.toContain(KEY);
  });

  it("uses the free market source type without needing a key for it", () => {
    expect(new FreeMarket()).toBeTruthy();
  });
});
