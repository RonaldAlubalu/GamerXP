-- A request for a day that is only possible after the owner has arranged things first.
ALTER TABLE bookings ADD COLUMN on_request BOOLEAN NOT NULL DEFAULT false;
