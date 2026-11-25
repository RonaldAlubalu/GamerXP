-- Message templates the owner changed or wrote himself. A row with a key replaces the built-in
-- template of that key; a row without one is a template of his own.
CREATE TABLE message_templates (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'contact', 'birthday')),
  grp TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  hidden BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Small settings the owner changes in the admin, such as the sign-off under every mail.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A year after a party the child has a birthday again. The day the owner dealt with that
-- reminder (mailed, or chose to skip it).
ALTER TABLE bookings ADD COLUMN birthday_handled_on DATE;
