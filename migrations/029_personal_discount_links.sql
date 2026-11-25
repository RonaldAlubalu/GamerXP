-- A discount that only works through a personal link: every person on the mailing list gets
-- their own link, good for one booking (their own, or of someone they pass it on to).
ALTER TABLE discount_codes ADD COLUMN personal BOOLEAN NOT NULL DEFAULT false;
UPDATE discount_codes SET personal = true WHERE upper(code) = 'NIEUWJAAR10';

CREATE TABLE discount_links (
  token TEXT PRIMARY KEY,
  code_id INTEGER NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES mail_contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code_id, contact_id)
);

-- The personal link a booking was made with; a link counts as used while that booking stands.
ALTER TABLE bookings ADD COLUMN discount_link TEXT NOT NULL DEFAULT '';
CREATE INDEX bookings_discount_link ON bookings (discount_link) WHERE discount_link <> '';

-- Which discount the personal links of a mailing are for.
ALTER TABLE mailings ADD COLUMN discount_code_id INTEGER REFERENCES discount_codes(id) ON DELETE SET NULL;
