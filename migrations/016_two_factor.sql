-- Second step at login: a code from an authenticator app (TOTP), with one-time backup codes.
ALTER TABLE admin_users ADD COLUMN totp_secret TEXT;
ALTER TABLE admin_users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
-- The time step of the last accepted code, so a code can't be used twice.
ALTER TABLE admin_users ADD COLUMN totp_last_step BIGINT NOT NULL DEFAULT 0;
-- SHA-256 hashes of the unused backup codes.
ALTER TABLE admin_users ADD COLUMN recovery_codes TEXT[] NOT NULL DEFAULT '{}';
