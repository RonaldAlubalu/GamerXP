-- A second phone number and e-mail address per booking, e.g. the other parent.
ALTER TABLE bookings ADD COLUMN phone2 TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN email2 TEXT NOT NULL DEFAULT '';
