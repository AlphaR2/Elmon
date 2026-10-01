import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db";

// Applies supabase/migrations/*.sql in name order, each once, each in its own transaction. The same files work
// with `supabase db push`; this runner exists so the worker and tests need no CLI. A transaction-scoped
// advisory lock keeps two workers starting at once from applying the same file twice (safe behind a pooler,
// unlike a session lock, because it is released with the transaction).
export async function migrate(db: Db, dir = path.join(process.cwd(), "supabase", "migrations")): Promise<string[]> {
  await db.script("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    const did = await db.tx(async (t) => {
      await t.q("SELECT pg_advisory_xact_lock(724913)");
      if (await t.one("SELECT 1 FROM schema_migrations WHERE name = $1", [f])) return false;
      await t.script(fs.readFileSync(path.join(dir, f), "utf8"));
      await t.run("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [f, Date.now()]);
      return true;
    });
    if (did) applied.push(f);
  }
  return applied;
}
