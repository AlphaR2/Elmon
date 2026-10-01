// The pipeline worker: npm run worker. On Railway (or any always-on host) set DATABASE_URL (Supabase session
// pooler, :5432), DB_POOL_MAX=5, HELIUS_API_KEY and HELIUS_MONTHLY_CREDITS. Locally it reads .env.local.
import { loadEnv } from "./env";

loadEnv();
if (!process.env.DB_POOL_MAX) process.env.DB_POOL_MAX = "5";

const { startWorker } = await import("../lib/worker");
startWorker().catch((e) => {
  console.error(JSON.stringify({ level: "fatal", msg: String((e as Error).message ?? e) }));
  process.exit(1);
});
