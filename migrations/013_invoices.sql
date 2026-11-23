-- Invoices made in the bookkeeping (e-Boekhouden.nl) for a booking: one for the deposit, one for the rest.
CREATE TABLE invoices (
  id            SERIAL PRIMARY KEY,
  booking_id    UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('deposit', 'final')),
  external_id   TEXT NOT NULL,
  number        TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  pdf_url       TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, kind)
);
