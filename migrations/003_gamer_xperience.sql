-- Match bookings to the Gamer Xperience booking form: a time slot instead of an
-- exact start time, optional extra game stations, and optional details about the
-- birthday child (the original form doesn't ask for them).

ALTER TABLE bookings ADD COLUMN time_slot TEXT;
UPDATE bookings SET time_slot = CASE
  WHEN start_time < '12:00' THEN 'ochtend'
  WHEN start_time < '17:00' THEN 'middag'
  ELSE 'avond'
END;
ALTER TABLE bookings ALTER COLUMN time_slot SET NOT NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_time_slot_check CHECK (time_slot IN ('ochtend', 'middag', 'avond'));

-- The exact start time is agreed later and set in the admin page.
ALTER TABLE bookings ALTER COLUMN start_time DROP NOT NULL;

ALTER TABLE bookings ADD COLUMN extra_stations INTEGER NOT NULL DEFAULT 0 CHECK (extra_stations BETWEEN 0 AND 2);

ALTER TABLE bookings ALTER COLUMN child_name SET DEFAULT '';
ALTER TABLE bookings ALTER COLUMN child_age DROP NOT NULL;
ALTER TABLE bookings ALTER COLUMN guest_count DROP NOT NULL;
ALTER TABLE bookings ALTER COLUMN phone SET DEFAULT '';

-- The real packages. The example packages from the first version are hidden.
UPDATE packages SET active = FALSE WHERE slug IN ('basis', 'plus', 'xl');

INSERT INTO packages (slug, name, description, max_players, duration_hours, price_cents, sort_order) VALUES
  ('standaard', 'Standaard Xperience',
   'Wij bouwen op, leggen alles uit en halen het weer op. 8 gamestations, 3 uur speeltijd. Jij houdt toezicht.',
   8, 3, 27500, 2),
  ('ultimate', 'Ultimate Xperience',
   'Onze Game Master doet alles: toernooi met poules en finale, mini-games, challenges, prijsuitreiking en neonverlichting. 8 gamestations, 4 uur speeltijd.',
   8, 4, 35000, 1)
ON CONFLICT (slug) DO NOTHING;
