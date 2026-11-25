-- The customer card: a note about a customer, kept by e-mail address, so it stays with the person
-- across all their bookings.
CREATE TABLE customer_notes (
  email TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
