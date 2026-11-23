-- More than one login for the admin page. An owner can do everything; an assistant
-- can look at bookings and the calendar and change the availability.
ALTER TABLE admin_users ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'assistant'));
