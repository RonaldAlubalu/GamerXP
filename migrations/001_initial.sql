-- Party packages offered on the website (e.g. "Basis", "Plus", "XL").
CREATE TABLE packages (
  id              SERIAL PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  max_players     INTEGER NOT NULL CHECK (max_players > 0),
  duration_hours  NUMERIC(4, 1) NOT NULL CHECK (duration_hours > 0),
  price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dates on which no parties can be booked (holidays, maintenance, ...).
CREATE TABLE blocked_dates (
  date        DATE PRIMARY KEY,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bookings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference     TEXT NOT NULL UNIQUE,
  package_id    INTEGER NOT NULL REFERENCES packages (id),
  party_date    DATE NOT NULL,
  start_time    TIME NOT NULL,
  parent_name   TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL,
  street        TEXT NOT NULL,
  postal_code   TEXT NOT NULL,
  city          TEXT NOT NULL,
  child_name    TEXT NOT NULL,
  child_age     INTEGER NOT NULL CHECK (child_age BETWEEN 1 AND 18),
  guest_count   INTEGER NOT NULL CHECK (guest_count > 0),
  notes         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
  admin_notes   TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bookings_party_date_idx ON bookings (party_date);
CREATE INDEX bookings_status_idx ON bookings (status);

CREATE TABLE contact_messages (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL,
  handled     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_users (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only a SHA-256 hash of the session token is stored.
CREATE TABLE admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX admin_sessions_expires_at_idx ON admin_sessions (expires_at);
