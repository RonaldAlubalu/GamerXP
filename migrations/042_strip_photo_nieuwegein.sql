-- One more photo for the photo strip; the faces in it are blurred.
INSERT INTO site_photos (position, src, alt, width, height)
SELECT coalesce(max(position), 0) + 1, '/assets/img/game-kinderfeestje-in-nieuwegein.webp', 'Game kinderfeestje in Nieuwegein', 1200, 900
  FROM site_photos;
