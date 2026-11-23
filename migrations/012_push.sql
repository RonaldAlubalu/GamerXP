-- Devices (browsers, phones) that asked for notifications from the admin page.
CREATE TABLE push_subscriptions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  keys        JSONB NOT NULL,
  device      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
