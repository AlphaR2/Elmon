import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthError, HeliusClient, heliusUrl, redact } from "@/lib/helius";
import { CreditGuard, monthlyCreditsUsed } from "@/lib/credits";
import { resetDbForTests } from "@/lib/db";
import { createRun, executeRun, getRun } from "@/lib/pipeline/run";
import { FakeRpc } from "./helpers";
import { world } from "./world";

describe("heliusUrl", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("builds the URL from a bare key", () => {
    delete process.env.HELIUS_RPC_URL;
    process.env.HELIUS_API_KEY = "abc-123";
    expect(heliusUrl()).toBe("https://mainnet.helius-rpc.com/?api-key=abc-123");
  });
  it("accepts the full RPC URL pasted as the key, with quotes or spaces", () => {
    delete process.env.HELIUS_RPC_URL;
    process.env.HELIUS_API_KEY = ' "https://mainnet.helius-rpc.com/?api-key=abc-123" ';
    expect(heliusUrl()).toBe("https://mainnet.helius-rpc.com/?api-key=abc-123");
  });
  it("prefers HELIUS_RPC_URL", () => {
    process.env.HELIUS_RPC_URL = "http://127.0.0.1:1";
    process.env.HELIUS_API_KEY = "abc";
    expect(heliusUrl()).toBe("http://127.0.0.1:1");
  });
  it("never lets the key into a message", () => {
    expect(redact("fetch failed: https://mainnet.helius-rpc.com/?api-key=abc-123&x=1")).toBe("fetch failed: https://mainnet.helius-rpc.com/?api-key=***&x=1");
  });
});

describe("a rejected key", () => {
  let server: http.Server;
  let url: string;
  beforeEach(async () => {
    await resetDbForTests();
    server = http.createServer((_req, res) => {
      res.writeHead(401);
      res.end("Unauthorized");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("throws AuthError and refunds the credit", async () => {
    const guard = await new CreditGuard(null, 1000).init();
    const c = new HeliusClient(guard, { url });
    await expect(c.getSignatures("x")).rejects.toBeInstanceOf(AuthError);
    expect(c.creditsUsed()).toBe(0);
    await guard.release();
    expect(await monthlyCreditsUsed()).toBe(0);
  });

  it("fails the whole run with one clear message", async () => {
    const rpc = new FakeRpc(world(), { gtfa: true });
    rpc.txsForAddress = async () => {
      throw new AuthError(401);
    };
    const { id } = await createRun("tokens", ["M1", "M2"], {});
    await executeRun(id, rpc);
    const run = (await getRun(id))!;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/rejected the API key/);
    expect(run.stages_done).toBe("[]");
  });
});
