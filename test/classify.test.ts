import { beforeEach, describe, expect, it } from "vitest";
import { classifyAddresses, kindFromAccount } from "@/lib/classify";
import { getDb, resetDbForTests } from "@/lib/db";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM = "11111111111111111111111111111111";

describe("what an address is", () => {
  it("reads the account owner", () => {
    expect(kindFromAccount({ owner: SYSTEM })).toBe("wallet");
    expect(kindFromAccount(null)).toBe("empty");
    expect(kindFromAccount({ owner: TOKEN, data: { parsed: { type: "mint" } } })).toBe("token");
    expect(kindFromAccount({ owner: TOKEN22, data: { parsed: { type: "mint" } } })).toBe("token");
    expect(kindFromAccount({ owner: TOKEN, data: { parsed: { type: "account" } } })).toBe("token-account");
    expect(kindFromAccount({ owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true })).toBe("program");
    expect(kindFromAccount({ owner: "SomePoolProgram1111111111111111111111111111" })).toBe("other");
  });

  beforeEach(async () => {
    await resetDbForTests();
  });

  it("combines saved facts, the public RPC and Jupiter, and never needs Helius", async () => {
    const db = await getDb();
    await db.run("INSERT INTO token_facts (mint, symbol, supply, info_at) VALUES ('KNOWN', 'OLD', 1e9, 0)");
    const calls: string[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(u.includes("jup.ag") ? "jupiter" : u);
      if (u.includes("jup.ag")) return new Response(JSON.stringify([{ id: "MINT", symbol: "CAT" }, { id: "UNLISTED_IN_RPC", symbol: "DOG" }]));
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe("getMultipleAccounts");
      expect(body.params[0]).not.toContain("KNOWN"); // already known: not asked again
      const by: Record<string, unknown> = {
        MINT: { owner: TOKEN, data: { parsed: { type: "mint" } } },
        WALLET: { owner: SYSTEM },
        ATA: { owner: TOKEN, data: { parsed: { type: "account" } } },
        NEW: null,
      };
      return new Response(JSON.stringify({ result: { value: body.params[0].map((a: string) => by[a] ?? null) } }));
    }) as typeof fetch;
    const r = await classifyAddresses(["KNOWN", "MINT", "WALLET", "ATA", "NEW"], { fetch: fake, rpcUrl: "http://rpc.test" });
    expect(r).toEqual({
      KNOWN: { kind: "token", symbol: "OLD" },
      MINT: { kind: "token", symbol: "CAT" },
      WALLET: { kind: "wallet", symbol: null },
      ATA: { kind: "token-account", symbol: null },
      NEW: { kind: "empty", symbol: null },
    });
    expect(calls.some((c) => c.includes("helius"))).toBe(false);
  });

  it("degrades to unknown, or to Jupiter's answer, when the RPC is unreachable", async () => {
    const fake = (async (url: string | URL) => {
      if (String(url).includes("jup.ag")) return new Response(JSON.stringify([{ id: "LISTED", symbol: "CAT" }]));
      throw new Error("rate limited");
    }) as typeof fetch;
    const r = await classifyAddresses(["LISTED", "OTHER"], { fetch: fake, rpcUrl: "http://rpc.test" });
    expect(r.LISTED).toEqual({ kind: "token", symbol: "CAT" });
    expect(r.OTHER).toEqual({ kind: "unknown", symbol: null });
  });
});
