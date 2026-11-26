-- A login on a remembered device stays valid for 30 days, counted from its last use.
ALTER TABLE admin_sessions ADD COLUMN remembered BOOLEAN NOT NULL DEFAULT false;
