-- "Remember this device for 30 days": a device that passed the second step may skip it until
-- the entry expires. Only the hash of the device's token is stored.
CREATE TABLE trusted_devices (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trusted_devices_user ON trusted_devices (user_id);
ALTER TABLE login_links ADD COLUMN remember BOOLEAN NOT NULL DEFAULT FALSE;
