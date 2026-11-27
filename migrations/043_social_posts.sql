-- Posts the owner writes in the admin and sends to the Facebook page and the Instagram account.
CREATE TABLE social_posts (
  id BIGSERIAL PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '',
  -- The photo, and the unguessable name under which Facebook and Instagram fetch it.
  image BYTEA,
  image_key TEXT UNIQUE,
  to_facebook BOOLEAN NOT NULL DEFAULT false,
  to_instagram BOOLEAN NOT NULL DEFAULT false,
  -- Empty: placed right away.
  scheduled_at TIMESTAMPTZ,
  -- scheduled, posting, done or failed.
  status TEXT NOT NULL DEFAULT 'scheduled',
  facebook_id TEXT NOT NULL DEFAULT '',
  facebook_url TEXT NOT NULL DEFAULT '',
  facebook_error TEXT NOT NULL DEFAULT '',
  instagram_id TEXT NOT NULL DEFAULT '',
  instagram_url TEXT NOT NULL DEFAULT '',
  instagram_error TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ
);
CREATE INDEX social_posts_due ON social_posts (scheduled_at) WHERE status = 'scheduled';
