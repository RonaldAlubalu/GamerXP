-- When the "tomorrow is the day" reminder was sent, so it is not asked for twice.
ALTER TABLE bookings ADD COLUMN reminder_sent_at TIMESTAMPTZ;
