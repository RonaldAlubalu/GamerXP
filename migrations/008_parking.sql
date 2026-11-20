-- What the customer said about parking at the party address ('' = not asked or not answered).
ALTER TABLE bookings ADD COLUMN parking TEXT NOT NULL DEFAULT '' CHECK (parking IN ('', 'free', 'paid', 'unknown'));
