-- A photo on a page that the owner replaced in the admin: the big one at the top ("hero") or
-- one in the page itself (found by the address of the original photo).
CREATE TABLE site_images (
  id BIGSERIAL PRIMARY KEY,
  file TEXT NOT NULL,
  slot TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file, slot)
);
