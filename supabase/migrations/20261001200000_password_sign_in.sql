-- Password sign-in (replaces magic links). After an admin resets someone's password, they are asked to choose
-- their own on next sign-in.
ALTER TABLE members ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
