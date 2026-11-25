-- A picture at the top of a mailing (e.g. for the end-of-year mail). Stored here so the link in
-- the mail keeps working, whatever happens to the files on the server.
CREATE TABLE mailing_images (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE mailings ADD COLUMN header_image TEXT NOT NULL DEFAULT '';
