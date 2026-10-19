-- Availability is managed in the admin page instead of environment variables:
-- time slots with their hours, a weekly schedule, capacity and exceptions per date.

CREATE TABLE time_slots (
  key         TEXT PRIMARY KEY CHECK (key IN ('ochtend', 'middag', 'avond')),
  label       TEXT NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  sort_order  INTEGER NOT NULL
);

INSERT INTO time_slots (key, label, start_time, end_time, sort_order) VALUES
  ('ochtend', 'Ochtend', '09:00', '13:00', 1),
  ('middag',  'Middag',  '13:00', '17:00', 2),
  ('avond',   'Avond',   '17:00', '21:00', 3);

-- Which slots are open on which weekday (ISO: 1 = Monday ... 7 = Sunday).
CREATE TABLE weekly_availability (
  weekday  INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  slot     TEXT NOT NULL REFERENCES time_slots (key),
  open     BOOLEAN NOT NULL,
  PRIMARY KEY (weekday, slot)
);

-- Starting schedule: Wednesday afternoon, Friday afternoon and evening, all day in
-- the weekend. Change it in the admin page.
INSERT INTO weekly_availability (weekday, slot, open)
SELECT d, s, (d IN (6, 7)) OR (d = 3 AND s = 'middag') OR (d = 5 AND s IN ('middag', 'avond'))
FROM generate_series(1, 7) AS d, unnest(ARRAY['ochtend', 'middag', 'avond']) AS s;

-- Exceptions for a single date and slot: open an extra slot or close one.
-- Whole days are closed with blocked_dates.
CREATE TABLE slot_overrides (
  date        DATE NOT NULL,
  slot        TEXT NOT NULL REFERENCES time_slots (key),
  open        BOOLEAN NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (date, slot)
);

-- Simple key/value settings editable in the admin page.
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);

CREATE INDEX bookings_party_date_slot_idx ON bookings (party_date, time_slot) WHERE status <> 'cancelled';
