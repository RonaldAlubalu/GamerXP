-- Booking pipeline: more stages, a per-booking checklist, a timeline of
-- everything that happened, payment amounts and a private status link for parents.

ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
UPDATE bookings SET status = 'new' WHERE status = 'pending';
ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'new';
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'new', 'contacted', 'confirmed', 'deposit_paid', 'scheduled', 'party_held', 'completed', 'cancelled'
));

-- Price is copied from the package at booking time, so later price changes don't affect it.
ALTER TABLE bookings ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0);
ALTER TABLE bookings ADD COLUMN deposit_cents INTEGER NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0);
ALTER TABLE bookings ADD COLUMN paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0);
UPDATE bookings b SET price_cents = p.price_cents FROM packages p WHERE p.id = b.package_id;

-- Secret token for the parent's "follow your party" page.
ALTER TABLE bookings ADD COLUMN status_token TEXT;
UPDATE bookings SET status_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
ALTER TABLE bookings ALTER COLUMN status_token SET NOT NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_token_key UNIQUE (status_token);

CREATE TABLE booking_tasks (
  id          SERIAL PRIMARY KEY,
  booking_id  UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  label       TEXT NOT NULL,
  done        BOOLEAN NOT NULL DEFAULT FALSE,
  done_at     TIMESTAMPTZ,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX booking_tasks_booking_id_idx ON booking_tasks (booking_id);

CREATE TABLE booking_events (
  id           SERIAL PRIMARY KEY,
  booking_id   UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('created', 'status', 'note', 'task', 'email', 'update')),
  from_status  TEXT,
  to_status    TEXT,
  message      TEXT NOT NULL DEFAULT '',
  actor        TEXT NOT NULL DEFAULT 'system',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX booking_events_booking_id_idx ON booking_events (booking_id, created_at);
