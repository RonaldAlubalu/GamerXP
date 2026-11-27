-- Counting visitors without cookies. A visitor is a code made from the address and browser of
-- the visit plus a key that changes every day and is then thrown away: the same person gets
-- another code the next day, and nobody can work back from the code to a person.
CREATE TABLE site_visits (
  id BIGSERIAL PRIMARY KEY,
  day DATE NOT NULL,
  visitor TEXT NOT NULL,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX site_visits_day ON site_visits (day);

-- Whether a booking came in through the form on the website (and not typed in or imported).
ALTER TABLE bookings ADD COLUMN via_website BOOLEAN NOT NULL DEFAULT false;
