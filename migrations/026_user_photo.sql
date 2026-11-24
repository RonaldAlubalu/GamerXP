-- A small photo per admin user, shown next to what they did. Kept as a tiny image in the row itself.
ALTER TABLE admin_users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
