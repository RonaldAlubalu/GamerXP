-- Recommending: every customer has a link of their own. Someone who books through it gets a
-- discount, and the customer who shared it earns one for their own next party, once the
-- recommended party has taken place.
ALTER TABLE mail_contacts ADD COLUMN referral_token TEXT UNIQUE;

-- Who recommended this booking, and the booking on which that recommendation was cashed in.
ALTER TABLE bookings ADD COLUMN referred_by BIGINT REFERENCES mail_contacts(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN referral_redeemed_on UUID REFERENCES bookings(id) ON DELETE SET NULL;
CREATE INDEX bookings_referred_by ON bookings (referred_by) WHERE referred_by IS NOT NULL;
