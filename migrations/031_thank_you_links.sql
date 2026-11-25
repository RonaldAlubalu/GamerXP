-- A customer can get more than one personal discount link: one from a mailing, and another as a
-- thank-you when they book again (to share with a brother, sister or friend).
ALTER TABLE discount_links DROP CONSTRAINT discount_links_code_id_contact_id_key;
ALTER TABLE discount_links ADD COLUMN note TEXT NOT NULL DEFAULT '';
-- The booking a thank-you link was given for: at most one per booking.
ALTER TABLE discount_links ADD COLUMN booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX discount_links_booking ON discount_links (booking_id) WHERE booking_id IS NOT NULL;
