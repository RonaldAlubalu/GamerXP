-- Second step at login for accounts without an authenticator app: a link and a code sent by
-- email. Only hashes are stored. "pending" ties the mail to the browser that typed the password.
CREATE TABLE login_links (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  pending_hash TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
