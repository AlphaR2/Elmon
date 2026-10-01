import postgres from "postgres";

// One async interface over two Postgres engines:
//   * postgres.js against Supabase (DATABASE_URL). Used by the Vercel app and the worker.
//   * PGlite, an in-process Postgres, in memory. Used by tests and by local dev without Supabase.
// SQL is plain Postgres with $1, $2 placeholders, so both engines run the same statements.

export type Row = Record<string, unknown>;

export interface Db {
  q<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  // Returns affected rows.
  run(sql: string, params?: unknown[]): Promise<number>;
  // Several statements, no parameters (migrations).
  script(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const clean = (params: unknown[] = []) => params.map((p) => (p === undefined ? null : p));

// BIGINT and NUMERIC come back as strings by default. Every value we store fits a double.
const toNum = (x: unknown) => (x == null ? null : Number(x));

type Sql = postgres.Sql | postgres.TransactionSql;

class PgDb implements Db {
  constructor(private sql: Sql, private root: postgres.Sql | null) {}
  async q<T>(text: string, params?: unknown[]) {
    return (await this.sql.unsafe(text, clean(params) as postgres.ParameterOrJSON<never>[])) as unknown as T[];
  }
  async one<T>(text: string, params?: unknown[]) {
    return (await this.q<T>(text, params))[0];
  }
  async run(text: string, params?: unknown[]) {
    const r = await this.sql.unsafe(text, clean(params) as postgres.ParameterOrJSON<never>[]);
    return r.count ?? 0;
  }
  async script(text: string) {
    await this.sql.unsafe(text);
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.root) return fn(this); // already inside a transaction
    return (await this.root.begin((t) => fn(new PgDb(t, null)))) as T;
  }
  async close() {
    await this.root?.end({ timeout: 5 });
  }
}

interface PgliteLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

class LiteDb implements Db {
  constructor(private pg: PgliteLike, private inTx = false) {}
  async q<T>(text: string, params?: unknown[]) {
    return (await this.pg.query<T>(text, clean(params))).rows;
  }
  async one<T>(text: string, params?: unknown[]) {
    return (await this.q<T>(text, params))[0];
  }
  async run(text: string, params?: unknown[]) {
    return (await this.pg.query(text, clean(params))).affectedRows ?? 0;
  }
  async script(text: string) {
    await this.pg.exec(text);
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return this.pg.transaction((t) => fn(new LiteDb(t, true)));
  }
  async close() {
    await this.pg.close?.();
  }
}

// Pool sizing, per process: (Vercel instances x 1) + (workers x WORKER_POOL) must stay under the pooler's
// client limit (Supabase free: 200 on the transaction pooler, 15 direct/session). The app uses the transaction
// pooler (:6543) with max 1, the worker the session pooler (:5432) with max 5.
function pgFromUrl(url: string): Db {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 1),
    prepare: false, // required by Supabase's transaction pooler; harmless elsewhere
    ssl: local ? false : "require",
    idle_timeout: 20,
    connect_timeout: 15,
    types: {
      int8: { to: 20, from: [20], serialize: (x: number) => String(x), parse: toNum },
      numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: toNum },
    },
    onnotice: () => {},
  });
  return new PgDb(sql, sql);
}

async function pgliteInMemory(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite({ parsers: { 20: toNum, 1700: toNum } });
  return new LiteDb(pg as unknown as PgliteLike);
}

type G = { __elmonDb?: Promise<Db>; __elmonDbReady?: Promise<void> };
const g = globalThis as unknown as G;

export function dbKind(): "postgres" | "memory" {
  return process.env.DATABASE_URL ? "postgres" : "memory";
}

// Production without DATABASE_URL fails closed: nothing silently writes to a throwaway in-memory database.
export function getDb(): Promise<Db> {
  if (g.__elmonDb) return g.__elmonDb;
  const url = process.env.DATABASE_URL;
  if (!url && process.env.NODE_ENV === "production" && process.env.ELMON_ALLOW_MEMORY_DB !== "1") {
    throw new Error("DATABASE_URL is not set. Add the Supabase connection string to the environment.");
  }
  g.__elmonDb = (async () => {
    const db = url ? pgFromUrl(url) : await pgliteInMemory();
    // An in-memory database starts empty, so it migrates itself. Supabase is migrated by the worker on start.
    if (!url) {
      const { migrate } = await import("./migrate");
      await migrate(db);
    }
    return db;
  })();
  return g.__elmonDb;
}

// Tests: empty every table in the shared in-memory database (fast; a new PGlite per test is ~0.5 s).
export async function resetDbForTests(): Promise<Db> {
  delete process.env.DATABASE_URL;
  const db = await getDb();
  const tables = await db.q<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'app_config')",
  );
  if (tables.length) await db.script(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await db.run("DELETE FROM app_config WHERE key NOT IN ('monthly_credits', 'settings')");
  await db.run("UPDATE app_config SET value = 'null' WHERE key = 'monthly_credits'");
  const { DEFAULT_APP_SETTINGS } = await import("./appSettings");
  await db.run("UPDATE app_config SET value = $1 WHERE key = 'settings'", [JSON.stringify(DEFAULT_APP_SETTINGS)]);
  return db;
}

export const json = <T>(s: unknown, fallback: T): T => {
  if (s == null || s === "") return fallback;
  if (typeof s !== "string") return s as T;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// Placeholder list for multi-row inserts: rows(2, 3, 1) -> "($1,$2,$3),($4,$5,$6)"
export function rows(n: number, width: number, start = 1): string {
  const out: string[] = [];
  for (let r = 0; r < n; r++) {
    const cols: string[] = [];
    for (let c = 0; c < width; c++) cols.push(`$${start + r * width + c}`);
    out.push(`(${cols.join(",")})`);
  }
  return out.join(",");
}

// Multi-row insert in chunks (Postgres caps a statement at 65,535 parameters).
export async function insertMany(db: Db, head: string, tail: string, width: number, values: unknown[][]): Promise<void> {
  const per = Math.max(1, Math.floor(60_000 / width));
  for (let i = 0; i < values.length; i += per) {
    const chunk = values.slice(i, i + per);
    await db.run(`${head} VALUES ${rows(chunk.length, width)} ${tail}`, chunk.flat());
  }
}
