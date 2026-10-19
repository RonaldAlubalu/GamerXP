-- Communication log, agreements, price breakdown, payments and review tracking.

-- Every message with a customer: emails sent from the admin page, the original
-- website request, and WhatsApp messages or calls logged by hand.
CREATE TABLE communications (
  id                  SERIAL PRIMARY KEY,
  booking_id          UUID REFERENCES bookings (id) ON DELETE CASCADE,
  contact_message_id  INTEGER REFERENCES contact_messages (id) ON DELETE CASCADE,
  direction           TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  channel             TEXT NOT NULL CHECK (channel IN ('website', 'email', 'whatsapp', 'phone', 'in_person', 'other')),
  subject             TEXT NOT NULL DEFAULT '',
  body                TEXT NOT NULL,
  -- For emails sent from the admin page: 'sent' or 'failed'.
  delivery            TEXT CHECK (delivery IN ('sent', 'failed')),
  actor               TEXT NOT NULL DEFAULT 'system',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((booking_id IS NULL) <> (contact_message_id IS NULL))
);

CREATE INDEX communications_booking_idx ON communications (booking_id, created_at);
CREATE INDEX communications_contact_idx ON communications (contact_message_id, created_at);

-- Whose turn it is. Updated automatically when a message is logged, and can be changed by hand.
ALTER TABLE bookings ADD COLUMN waiting_on TEXT NOT NULL DEFAULT 'me' CHECK (waiting_on IN ('me', 'customer', 'nobody'));
ALTER TABLE contact_messages ADD COLUMN waiting_on TEXT NOT NULL DEFAULT 'me' CHECK (waiting_on IN ('me', 'customer', 'nobody'));
UPDATE contact_messages SET waiting_on = 'nobody' WHERE handled;
UPDATE bookings SET waiting_on = 'nobody' WHERE status IN ('completed', 'cancelled');

-- The website request is the first message of every existing booking and contact message.
INSERT INTO communications (booking_id, direction, channel, subject, body, actor, created_at)
SELECT id, 'in', 'website', 'Aanvraag via de website', CASE WHEN notes = '' THEN '(geen details)' ELSE notes END, parent_name, created_at
FROM bookings;
INSERT INTO communications (contact_message_id, direction, channel, subject, body, actor, created_at)
SELECT id, 'in', 'website', 'Contactformulier', message, name, created_at FROM contact_messages;

-- Things agreed with the customer, e.g. "Starttijd 14:00" or "Fortnite + Minecraft".
CREATE TABLE agreements (
  id          SERIAL PRIMARY KEY,
  booking_id  UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'system',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agreements_booking_idx ON agreements (booking_id);

-- Price breakdown. price_cents stays the total; these columns explain it.
ALTER TABLE bookings ADD COLUMN travel_km NUMERIC(6, 1);           -- one-way driving distance
ALTER TABLE bookings ADD COLUMN evening_surcharge BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN price_extras JSONB NOT NULL DEFAULT '[]';  -- [{ "label": "...", "amountCents": 1500 }]
UPDATE bookings SET evening_surcharge = (time_slot = 'avond');

CREATE TABLE payments (
  id            SERIAL PRIMARY KEY,
  booking_id    UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('deposit', 'payment', 'refund', 'security_deposit', 'security_deposit_returned')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  method        TEXT NOT NULL CHECK (method IN ('bank', 'cash', 'tikkie', 'other')),
  paid_on       DATE NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL DEFAULT 'system',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payments_booking_idx ON payments (booking_id);

-- Amounts entered before the payments list existed become one payment each.
INSERT INTO payments (booking_id, kind, amount_cents, method, paid_on, note)
SELECT id, 'payment', paid_cents, 'other', updated_at::date, 'Overgenomen uit eerdere registratie'
FROM bookings WHERE paid_cents > 0;

-- Google reviews.
ALTER TABLE bookings ADD COLUMN review_status TEXT NOT NULL DEFAULT 'none'
  CHECK (review_status IN ('none', 'requested', 'received', 'declined'));
ALTER TABLE bookings ADD COLUMN review_requested_at TIMESTAMPTZ;

ALTER TABLE booking_events DROP CONSTRAINT booking_events_type_check;
ALTER TABLE booking_events ADD CONSTRAINT booking_events_type_check
  CHECK (type IN ('created', 'status', 'note', 'task', 'email', 'update', 'payment', 'agreement', 'message', 'review'));

-- The package price at the time of booking, so the breakdown can be recalculated
-- later without picking up package price changes.
ALTER TABLE bookings ADD COLUMN package_price_cents INTEGER;
UPDATE bookings b SET package_price_cents = p.price_cents FROM packages p WHERE p.id = b.package_id;
ALTER TABLE bookings ALTER COLUMN package_price_cents SET NOT NULL;
