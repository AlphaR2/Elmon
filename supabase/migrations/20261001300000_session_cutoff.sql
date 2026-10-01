-- After an admin resets a member's password, every session the member had before that moment stops working
-- (checked against the session's issued-at time on each request). Null = no cutoff.
ALTER TABLE members ADD COLUMN IF NOT EXISTS sessions_valid_after BIGINT; -- ms
