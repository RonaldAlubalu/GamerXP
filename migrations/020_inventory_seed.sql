-- The existing inventory: which stations, games and subscriptions there are. Account names and
-- serial numbers are left out on purpose; the owner adds those in the admin himself.
-- An item that is already there (same kind and name) is left alone.
INSERT INTO inventory_items (kind, name, quantity, status, price_cents, details, notes)
SELECT v.kind, v.name, v.quantity, v.status, v.price_cents, v.details, v.notes
FROM (VALUES
  ('station', 'Station 1', 1, 'in_use', NULL::integer, '{"homeConsole": "Nee", "gamePass": true, "gamePassNote": "Per 22-10"}'::jsonb, ''),
  ('station', 'Station 2', 1, 'in_use', NULL, '{"homeConsole": "Nee", "gamePass": true, "gamePassNote": "Per 22-10"}'::jsonb, ''),
  ('station', 'Station 3', 1, 'in_use', NULL, '{"homeConsole": "Nee", "gamePass": true, "gamePassNote": "Per 22-10"}'::jsonb, ''),
  ('station', 'Station 4', 1, 'in_use', NULL, '{"homeConsole": "Ja, GP01", "gamePass": false, "gamePassNote": ""}'::jsonb, ''),
  ('station', 'Station 5', 1, 'in_use', NULL, '{"homeConsole": "Ja, GP02", "gamePass": false, "gamePassNote": ""}'::jsonb, ''),
  ('station', 'Station 6', 1, 'in_use', NULL, '{"homeConsole": "Ja, GP03", "gamePass": false, "gamePassNote": ""}'::jsonb, ''),
  ('station', 'Station 7', 1, 'in_use', NULL, '{"homeConsole": "Ja, GP08", "gamePass": false, "gamePassNote": ""}'::jsonb, ''),
  ('station', 'Station 8', 1, 'in_use', NULL, '{"homeConsole": "Nee", "gamePass": true, "gamePassNote": "Per 22-10"}'::jsonb, ''),
  ('station', 'Station 9', 1, 'in_use', NULL, '{"homeConsole": "Nee", "gamePass": true, "gamePassNote": "Per 22-10"}'::jsonb, ''),
  ('station', 'Station 10', 1, 'in_use', NULL, '{"homeConsole": "Ja GP09", "gamePass": false, "gamePassNote": ""}'::jsonb, ''),
  ('game', 'Fortnite', 1, 'in_use', NULL, '{"source": "free"}'::jsonb, ''),
  ('game', 'Minecraft', 1, 'in_use', 1000, '{"source": "gamepass_or_bought"}'::jsonb, 'Zit in Game Pass Premium'),
  ('game', 'Asphalt', 1, 'in_use', NULL, '{"source": "free"}'::jsonb, ''),
  ('game', 'Marvel Rivals', 1, 'in_use', NULL, '{"source": "free"}'::jsonb, ''),
  ('game', 'Roblox', 1, 'in_use', NULL, '{"source": "free"}'::jsonb, ''),
  ('game', 'Fall Guys', 1, 'in_use', NULL, '{"source": "free"}'::jsonb, ''),
  ('game', 'Turtles (TMNT)', 1, 'in_use', 1000, '{"source": "gamepass_or_bought"}'::jsonb, 'Zit in Game Pass Premium'),
  ('game', 'All Star Brawl 2', 1, 'in_use', 2000, '{"source": "gamepass_or_bought"}'::jsonb, 'Zit in Game Pass Premium'),
  ('game', 'Among Us', 1, 'in_use', 500, '{"source": "gamepass_or_bought"}'::jsonb, 'Zit in Game Pass Premium'),
  ('game', 'FC26', 1, 'in_use', 2000, '{"source": "bought"}'::jsonb, ''),
  ('game', 'Sonic Racing Crossworlds', 1, 'in_use', NULL, '{"source": "bought"}'::jsonb, ''),
  ('game', 'Goat Simulator 3', 1, 'in_use', 1000, '{"source": "gamepass_or_bought"}'::jsonb, 'Zit in Game Pass Premium'),
  ('subscription', 'Xbox Game Pass Premium', 1, 'in_use', 5000, '{"provider": "Microsoft", "period": "month", "autoRenew": false}'::jsonb, 'Bedrag uit de lijst: € 50 per maand voor alle accounts samen. Vul de einddatum in.'),
  ('subscription', 'Website en Google Workspace', 1, 'in_use', 16320, '{"provider": "Squarespace / Google", "period": "year", "autoRenew": true}'::jsonb, 'Bedrag uit de lijst: € 163,20 per jaar. Vul de einddatum in.')
) AS v(kind, name, quantity, status, price_cents, details, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_items i WHERE i.kind = v.kind AND lower(i.name) = lower(v.name)
);
