-- Texts on the website the owner changed in the admin. The page files hold the original; a row
-- here replaces one piece of text (found by its original wording) on one file.
CREATE TABLE site_texts (
  file TEXT NOT NULL,
  key TEXT NOT NULL,
  original TEXT NOT NULL,
  replacement TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (file, key)
);

-- The photos in the strip on the website, in order. A photo is either a file that came with the
-- site (src) or one the owner added in the admin (data).
CREATE TABLE site_photos (
  id BIGSERIAL PRIMARY KEY,
  position INT NOT NULL,
  src TEXT NOT NULL DEFAULT '',
  alt TEXT NOT NULL DEFAULT '',
  width INT NOT NULL,
  height INT NOT NULL,
  hidden BOOLEAN NOT NULL DEFAULT false,
  mime TEXT NOT NULL DEFAULT '',
  data BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO site_photos (position, src, alt, width, height) VALUES
  (1, '/assets/img/game-kinderfeestje-utrecht.webp', 'Game kinderfeestje in Utrecht', 900, 1200),
  (2, '/assets/img/img20240629160402.webp', 'Kinderen gamen samen aan tafel', 1200, 900),
  (3, '/assets/img/game-kinderfeestje-in-apeldoorn.webp', 'Game kinderfeestje in Apeldoorn', 900, 1200),
  (4, '/assets/img/img-20260822-205318.webp', 'Gaming opstelling met neonverlichting', 1200, 900),
  (5, '/assets/img/game-kinderfeestje-in-eindhoven.webp', 'Game kinderfeestje in Eindhoven', 900, 1200),
  (6, '/assets/img/game-party-nieuwegein.webp', 'Game party in Nieuwegein', 1200, 900),
  (7, '/assets/img/game-kinderfeestje-den-bosch.webp', 'Game kinderfeestje in Den Bosch', 900, 1200),
  (8, '/assets/img/img20240629171631.webp', 'Twee kinderen spelen naast elkaar', 1200, 900),
  (9, '/assets/img/img-20260412-221600.webp', 'Gamestations met neonverlichting', 900, 1200),
  (10, '/assets/img/minecraft-feest.webp', 'Minecraft feest', 1200, 900),
  (11, '/assets/img/game-kinderfeestje-utrecht-2.webp', 'Game kinderfeestje in Utrecht', 900, 1200),
  (12, '/assets/img/games-bedrijfsfeest.webp', 'Gaming op een bedrijfsfeest', 1200, 900),
  (13, '/assets/img/img-20260329-140103.webp', 'Kinderen gamen samen op een verjaardag', 1200, 900),
  (14, '/assets/img/img-20260131-195610.webp', 'Fortnite op een gamestation met neonverlichting', 900, 1200),
  (15, '/assets/img/img20260411150808.webp', 'Gamestations klaar voor een feest in een zaal', 900, 1200),
  (16, '/assets/img/game-kinderfeestje-in-den-bosch.webp', 'Game kinderfeestje in Den Bosch', 900, 1200),
  (17, '/assets/img/img20240629140945.webp', 'Kinderen gamen op een rij schermen', 1200, 900),
  (18, '/assets/img/img-20260412-221955.webp', 'Groot gamefeest in een zaal', 900, 1200),
  (19, '/assets/img/game-kinderfeestje-helmond.webp', 'Game kinderfeestje in Helmond', 900, 1200),
  (20, '/assets/img/game-feestje-bedrijf-1.webp', 'Kussens met gaming thema als decoratie', 1200, 900),
  (21, '/assets/img/game-kinderfeestje-eindhoven.webp', 'Gaming opstelling in de woonkamer', 900, 1200);
