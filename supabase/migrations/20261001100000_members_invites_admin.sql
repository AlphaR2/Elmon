-- Members, invite codes and admin tools. Replaces the email allowlist (retired on 2026-10-01).
--
-- Access model:
--   * Admins are named only in the ELMON_ADMIN_EMAILS environment variable. The database cannot make anyone an
--     admin, so a bug or a leaked session cannot escalate privileges.
--   * Members join with an invite code. A code use is consumed only after the person proves they own the email
--     (they clicked the magic link), so a leaked code cannot be burned with fake emails.

CREATE TABLE IF NOT EXISTS members (
  email TEXT PRIMARY KEY,           -- lowercase
  user_id TEXT,                     -- Supabase auth user id, set on join
  joined_at BIGINT NOT NULL,        -- ms
  last_seen BIGINT,                 -- ms, updated at most every few minutes
  invite_code_id BIGINT
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id BIGSERIAL PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,   -- sha256 of the normalized code; the code itself is shown once and never stored
  hint TEXT NOT NULL,               -- last 4 characters, to recognise a code in the list
  label TEXT,
  bound_email TEXT,                 -- if set, only this email can redeem it
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT,                -- ms; null = never
  revoked_at BIGINT,                -- ms
  created_by TEXT NOT NULL,         -- admin email
  created_at BIGINT NOT NULL
);

-- Between "entered a valid code" and "clicked the email link". Consumed on the callback.
CREATE TABLE IF NOT EXISTS pending_invites (
  email TEXT PRIMARY KEY,
  code_id BIGINT NOT NULL REFERENCES invite_codes (id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL        -- ms
);

-- Sign-in attempt counter (per IP and per email), kept in the database so the limit holds across app instances.
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT NOT NULL,
  ts BIGINT NOT NULL                -- ms
);
CREATE INDEX IF NOT EXISTS login_attempts_key_ts ON login_attempts (key, ts);

-- Who did what: codes created/revoked/redeemed, members removed, runs stopped by an admin, settings changed.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,               -- ms
  actor TEXT NOT NULL,              -- email, or "system"
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT                       -- JSON
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts DESC);

-- Runs: who started it (shown to admins) and queue priority (admin runs go first).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS created_by_email TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS runs_queue ON runs (status, priority DESC, id);

-- Settings ops can change from the admin page without a deploy.
INSERT INTO app_config (key, value, updated_at) VALUES (
  'settings',
  '{"maxLiveMember":2,"maxLiveAdmin":5,"maxBudgetMember":60000,"maxBudgetAdmin":200000,"resultTtlDays":7,"afterExportTtlHours":24,"historyKeepDays":120,"defaultPreset":"balanced","pauseNewRuns":false,"codeDefaultUses":5,"codeDefaultDays":7}',
  0
) ON CONFLICT (key) DO NOTHING;

-- The allowlist is retired.
DELETE FROM app_config WHERE key = 'allowed_emails';

ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
