-- One-way driving time to the party address, for planning the whole day around a party.
ALTER TABLE bookings ADD COLUMN travel_minutes INTEGER;
-- Existing bookings: a first estimate from the distance (mostly motorway, plus ten minutes in town).
UPDATE bookings SET travel_minutes = round(travel_km * 0.65 + 10) WHERE travel_km IS NOT NULL;
