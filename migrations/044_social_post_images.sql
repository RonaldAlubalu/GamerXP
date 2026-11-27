-- A post can carry several photos (a carousel on Instagram, an album on Facebook).
CREATE TABLE social_post_images (
  id BIGSERIAL PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  position INT NOT NULL,
  image BYTEA NOT NULL,
  -- The unguessable name under which Facebook and Instagram fetch the photo.
  image_key TEXT NOT NULL UNIQUE
);
CREATE INDEX social_post_images_post ON social_post_images (post_id, position);

INSERT INTO social_post_images (post_id, position, image, image_key)
SELECT id, 1, image, image_key FROM social_posts WHERE image IS NOT NULL AND image_key IS NOT NULL;

ALTER TABLE social_posts DROP COLUMN image, DROP COLUMN image_key;
