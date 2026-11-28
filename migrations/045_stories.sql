-- Stories (blog posts) the owner writes in the admin. The older stories are files in site/pages/verhalen.
CREATE TABLE stories (
  id BIGSERIAL PRIMARY KEY,
  -- The last part of the address (/verhalen/<slug>). Set at the first publication and kept after that.
  slug TEXT UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  -- A few sentences: on the overview page and in Google.
  intro TEXT NOT NULL DEFAULT '',
  -- The text, in the simple marks the admin explains (## heading, - list, **bold**).
  body TEXT NOT NULL DEFAULT '',
  published BOOLEAN NOT NULL DEFAULT false,
  published_on DATE NOT NULL DEFAULT CURRENT_DATE,
  cover_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE story_images (
  id BIGSERIAL PRIMARY KEY,
  story_id BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  data BYTEA NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX story_images_story ON story_images (story_id);
