-- An agreed end time per booking, for a party that is shorter or longer than its package says.
ALTER TABLE bookings ADD COLUMN end_time TIME;
