-- The party can be somewhere else than where the customer lives: a hall, a club, the grandparents.
-- The address a booking already has is where the party is; this is the customer's own address for
-- the invoice, filled in only when it differs. The location can also have a name.
ALTER TABLE bookings ADD COLUMN location_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN billing_street TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN billing_postal_code TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN billing_city TEXT NOT NULL DEFAULT '';
