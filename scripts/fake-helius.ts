// A local JSON-RPC server that behaves like Helius over a made-up chain (test/world.ts).
// For trying the app end to end without a key or credits:
//   npx tsx scripts/fake-helius.ts            (listens on :8899, writes the demo addresses to stdout)
//   HELIUS_RPC_URL=http://127.0.0.1:8899 npm run dev   (no DATABASE_URL: in-memory database)
import http from "node:http";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { FakeRpc } from "../test/helpers";
import { world } from "../test/world";

const addr = (name: string) => bs58.encode(createHash("sha256").update(`elmon-demo:${name}`).digest());
const rpc = new FakeRpc(world(addr, Math.floor(Date.now() / 1000)), { gtfa: process.env.FAKE_NO_GTFA !== "1" });

async function handle(method: string, params: unknown[]): Promise<unknown> {
  const [a, cfg = {}] = params as [string, Record<string, unknown>];
  switch (method) {
    case "getSignaturesForAddress":
      return rpc.getSignatures(a, { before: cfg.before as string | undefined, limit: (cfg.limit as number) ?? 1000 });
    case "getTransaction":
      return rpc.getTransaction(a);
    case "getTransactionsForAddress":
      if (process.env.FAKE_NO_GTFA === "1") throw Object.assign(new Error("Method not available on this plan"), { code: -32601 });
      if (cfg.transactionDetails === "signatures") return rpc.sigsForAddressAsc(a, (cfg.limit as number) ?? 1000);
      return rpc.txsForAddress(a, {
        sortOrder: (cfg.sortOrder as "asc" | "desc") ?? "desc",
        limit: Math.min((cfg.limit as number) ?? 100, 100),
        paginationToken: (cfg.paginationToken as string) ?? null,
      });
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let id: unknown = null;
    try {
      const msg = JSON.parse(body) as { id: unknown; method: string; params: unknown[] };
      id = msg.id;
      const result = await handle(msg.method, msg.params ?? []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (e) {
      const err = e as Error & { code?: number };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: err.code ?? -32000, message: err.message } }));
    }
  });
});

const port = Number(process.env.PORT ?? 8899);
server.listen(port, "127.0.0.1", () => {
  console.log(`fake helius on http://127.0.0.1:${port}`);
  console.log(JSON.stringify({ tokens: ["M1", "M2", "M3"].map(addr), trader: addr("S1"), loser: addr("S2"), insider: addr("X") }));
});
