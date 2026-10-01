-- Elmon Analytics schema. Additive only: never edit this file once applied; add a new migration instead.
--
-- Two kinds of data live here:
--   * Chain cache (permanent, shared by everyone): facts that never change once finalized, or change slowly.
--     Every row here is Helius credits not spent twice. Only the worker writes it.
--   * Run results (temporary): a run and everything it found. Deleted after export (24 h grace) or 7 days.
--     Run-scoped tables cascade from runs, so deleting a run removes all of it.
--
-- Row level security is on for every table with no policies: the anon and authenticated roles (the browser's
-- Supabase key) can read nothing. The app and worker connect as the database owner through DATABASE_URL.
-- Timestamps are unix ms (runs, logs, config) or unix seconds (chain facts), as noted per column.

-- ---------- config and credits ----------

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,            -- JSON
  updated_at BIGINT NOT NULL      -- ms
);
-- Ops can change these without a deploy.
INSERT INTO app_config (key, value, updated_at) VALUES
  ('allowed_emails', '[]', 0),    -- JSON array of lowercase emails, merged with ELMON_ALLOWED_EMAILS
  ('monthly_credits', 'null', 0)  -- null = use HELIUS_MONTHLY_CREDITS, else a number
ON CONFLICT (key) DO NOTHING;

-- Authoritative monthly spend. Workers reserve credits in blocks with one atomic conditional UPDATE, so two
-- workers can never both pass the last check.
CREATE TABLE IF NOT EXISTS credit_month (
  month TEXT PRIMARY KEY,         -- YYYY-MM (UTC)
  used BIGINT NOT NULL DEFAULT 0
);
-- Accounting detail, written in batches: which run and stage spent what.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,             -- ms
  month TEXT NOT NULL,
  run_id BIGINT,
  stage TEXT,
  method TEXT NOT NULL,
  calls INTEGER NOT NULL,
  credits INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credit_ledger_run ON credit_ledger (run_id);
CREATE INDEX IF NOT EXISTS credit_ledger_month ON credit_ledger (month);

-- ---------- chain cache (permanent) ----------

-- A token's parsed launch: deployer and first buyers. Finalized history, so it never changes. Reused when a
-- later run asks for no more buyers than were read, or the launch was read to its end.
CREATE TABLE IF NOT EXISTS launches (
  mint TEXT PRIMARY KEY,
  buyers_cap INTEGER NOT NULL,    -- earlyBuyers setting it was read with
  max_txs INTEGER NOT NULL,       -- maxLaunchTxs setting it was read with
  data BYTEA NOT NULL,            -- gzip JSON Launch
  fetched_at BIGINT NOT NULL      -- s
);

-- A wallet's first transaction and first funder never change. Activity (txs_per_day) is refreshed weekly.
CREATE TABLE IF NOT EXISTS wallet_facts (
  wallet TEXT PRIMARY KEY,
  first_tx_time BIGINT,
  first_tx_exact INTEGER,
  first_tx_sig TEXT,
  funder TEXT,
  deep INTEGER NOT NULL DEFAULT 0, -- 1 = funder search went past the first transaction
  txs_per_day DOUBLE PRECISION,
  checked_at BIGINT NOT NULL      -- s
);

-- Exchanges and apps (latest 1,000 transactions within a day). Rechecked after 30 days.
CREATE TABLE IF NOT EXISTS entities (
  address TEXT PRIMARY KEY,
  service INTEGER NOT NULL,
  checked_at BIGINT NOT NULL      -- s
);

-- A wallet's parsed trades. Later runs read only transactions newer than newest_sig.
CREATE TABLE IF NOT EXISTS wallet_history (
  wallet TEXT PRIMARY KEY,
  newest_sig TEXT,
  newest_time BIGINT,
  oldest_time BIGINT,
  txs_read INTEGER NOT NULL,
  depth INTEGER NOT NULL,         -- transactions the last full read asked for
  complete INTEGER NOT NULL,      -- 1 = reached the wallet's first transaction
  events BYTEA NOT NULL,          -- gzip JSON compact events
  updated_at BIGINT NOT NULL      -- s
);
CREATE INDEX IF NOT EXISTS wallet_history_updated ON wallet_history (updated_at);

-- Token market facts from free APIs (Jupiter, GeckoTerminal). No Helius credits.
CREATE TABLE IF NOT EXISTS token_facts (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  supply DOUBLE PRECISION,
  price_usd DOUBLE PRECISION,
  mcap_usd DOUBLE PRECISION,
  launchpad TEXT,
  graduated_at BIGINT,
  created_at BIGINT,
  holders INTEGER,
  info_at BIGINT,                 -- s; null = not fetched
  pool TEXT,
  candles TEXT,                   -- JSON [dayTs, high, close, volumeUsd][]
  peak_at BIGINT,                 -- s; when candles were fetched
  peak_status TEXT                -- fetched | skip:<why> | missing
);

CREATE TABLE IF NOT EXISTS sol_price (
  day BIGINT PRIMARY KEY,         -- unix seconds at 00:00 UTC
  usd DOUBLE PRECISION NOT NULL
);

-- Team watchlist. Small and kept: it is what a later watcher will follow.
CREATE TABLE IF NOT EXISTS watchlist (
  wallet TEXT PRIMARY KEY,
  label TEXT,
  note TEXT,
  added_at BIGINT NOT NULL,       -- ms
  added_by TEXT,
  source_run BIGINT,              -- may point at a run that has since expired
  snapshot TEXT                   -- JSON stats when added
);

-- ---------- runs (temporary) ----------

CREATE TABLE IF NOT EXISTS runs (
  id BIGSERIAL PRIMARY KEY,
  created_at BIGINT NOT NULL,     -- ms
  created_by TEXT,                -- auth user id; null = CLI
  mode TEXT NOT NULL,             -- tokens | wallets
  label TEXT,
  inputs TEXT NOT NULL,           -- JSON array
  settings TEXT NOT NULL,         -- JSON RunSettings
  settings_hash TEXT NOT NULL,
  -- Lifecycle: queued -> running -> done | failed | stopped. running -> cancelling -> stopped.
  -- A worker shutting down puts its run back to queued; stages already done are skipped on the next claim.
  status TEXT NOT NULL,
  stage TEXT,
  stages_done TEXT NOT NULL DEFAULT '[]',
  progress TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  finished_at BIGINT,
  owner TEXT,                     -- worker process executing it
  heartbeat BIGINT,               -- ms; stale = owner died
  scan_mints TEXT NOT NULL DEFAULT '[]', -- launches the user asked to scan for insiders
  dedupe_key TEXT NOT NULL,
  exported_at BIGINT,
  expires_at BIGINT NOT NULL      -- ms
);
-- One live run per identical request: a double-clicked start returns the run already going.
CREATE UNIQUE INDEX IF NOT EXISTS runs_live_dedupe ON runs (dedupe_key) WHERE status IN ('queued', 'running', 'cancelling');
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS runs_expires ON runs (expires_at);
CREATE INDEX IF NOT EXISTS runs_created_by ON runs (created_by, id);

CREATE TABLE IF NOT EXISTS run_log (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  level TEXT NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_log_run ON run_log (run_id, id);

CREATE TABLE IF NOT EXISTS tokens (
  run_id BIGINT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  mint TEXT NOT NULL,
  status TEXT NOT NULL,           -- ok | skipped | failed
  note TEXT,
  name TEXT,
  symbol TEXT,
  deployer TEXT,
  created_at BIGINT,
  create_sig TEXT,
  create_slot BIGINT,
  launchpad TEXT,
  launch_txs INTEGER,
  buyers INTEGER,
  market TEXT,                    -- JSON from DexScreener
  peak_usd DOUBLE PRECISION,
  weight DOUBLE PRECISION,        -- runner weight of this pasted token
  PRIMARY KEY (run_id, mint)
);

CREATE TABLE IF NOT EXISTS early_buys (
  run_id BIGINT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  rank INTEGER NOT NULL,          -- 0 = deployer's own buy
  sig TEXT NOT NULL,
  slot BIGINT NOT NULL,
  block_time BIGINT,
  secs_after_create BIGINT,
  sol DOUBLE PRECISION NOT NULL,
  tokens DOUBLE PRECISION NOT NULL,
  token_account TEXT,
  same_slot INTEGER NOT NULL,
  PRIMARY KEY (run_id, mint, wallet)
);
CREATE INDEX IF NOT EXISTS early_buys_wallet ON early_buys (run_id, wallet);

CREATE TABLE IF NOT EXISTS wallets (
  run_id BIGINT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  role TEXT NOT NULL,             -- candidate | buyer | deployer | input
  hits INTEGER NOT NULL DEFAULT 0,
  weighted_hits DOUBLE PRECISION NOT NULL DEFAULT 0,
  first_tx_time BIGINT,
  first_tx_exact INTEGER,
  funder TEXT,
  funder_service INTEGER,
  txs_per_day DOUBLE PRECISION,
  cluster_id INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  stats TEXT,                     -- JSON TraderStats
  on_tokens TEXT,                 -- JSON per pasted mint
  score DOUBLE PRECISION,         -- profit score
  runner_score DOUBLE PRECISION,
  runner TEXT,                    -- JSON RunnerStats
  history_status TEXT,            -- null | done | skipped:<why> | failed
  PRIMARY KEY (run_id, wallet)
);

CREATE TABLE IF NOT EXISTS clusters (
  run_id BIGINT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  cluster_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  funders TEXT NOT NULL,
  members TEXT NOT NULL,
  deployers TEXT NOT NULL,
  mints TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (run_id, cluster_id)
);

-- ---------- lock the browser key out ----------

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_month ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE launches ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sol_price ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE early_buys ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE clusters ENABLE ROW LEVEL SECURITY;
