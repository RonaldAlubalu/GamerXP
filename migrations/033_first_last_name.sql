-- First and last name apart, so a mail can start with "Hoi Lina," and not with the whole name.
-- parent_name stays the full name, for lists and searching.
ALTER TABLE bookings ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
UPDATE bookings SET first_name = split_part(btrim(parent_name), ' ', 1),
                    last_name = btrim(substr(btrim(parent_name), length(split_part(btrim(parent_name), ' ', 1)) + 1));

ALTER TABLE mail_contacts ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
UPDATE mail_contacts SET first_name = split_part(btrim(name), ' ', 1);
