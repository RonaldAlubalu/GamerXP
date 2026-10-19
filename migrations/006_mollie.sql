-- Online payments through Mollie.

CREATE TABLE mollie_payments (
  id            TEXT PRIMARY KEY,                 -- Mollie payment id, e.g. tr_WDqYK6vllg
  booking_id    UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('deposit', 'payment')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  status        TEXT NOT NULL,                    -- open, pending, authorized, paid, canceled, expired, failed
  checkout_url  TEXT,
  -- The registered payment once it is paid; set at most once.
  payment_id    INTEGER REFERENCES payments (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mollie_payments_booking_idx ON mollie_payments (booking_id);

ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('bank', 'cash', 'tikkie', 'mollie', 'other'));
