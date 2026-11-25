-- Discount codes: a percentage off the package price, for parties within a period.
CREATE TABLE discount_codes (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL,
  percent INTEGER NOT NULL CHECK (percent BETWEEN 1 AND 100),
  valid_from DATE,
  valid_until DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX discount_codes_code ON discount_codes (upper(code));

-- The code a booking was made with, so it is clear where a discount came from.
ALTER TABLE bookings ADD COLUMN discount_code TEXT NOT NULL DEFAULT '';

-- The thank-you for the customers of 2026: 10% off the package for a party in 2027.
INSERT INTO discount_codes (code, percent, valid_from, valid_until, note)
VALUES ('NIEUWJAAR10', 10, '2027-01-01', '2027-12-31', 'Nieuwjaarsactie: bedankje voor klanten van 2026');
