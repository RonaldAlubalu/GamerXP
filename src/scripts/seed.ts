// Inserts example packages so a fresh install has something to show.
// Safe to run more than once. Edit or replace them via the admin page.
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

const packages = [
  {
    slug: 'basis',
    name: 'LAN-Party Basis',
    description: '6 gameplekken met consoles, schermen en controllers. Wij bouwen op en ruimen op.',
    maxPlayers: 6, durationHours: 3, priceCents: 19900, sortOrder: 1,
  },
  {
    slug: 'plus',
    name: 'LAN-Party Plus',
    description: '10 gameplekken, inclusief toernooibegeleiding door een GamerXP game-host.',
    maxPlayers: 10, durationHours: 3, priceCents: 29900, sortOrder: 2,
  },
  {
    slug: 'xl',
    name: 'LAN-Party XL',
    description: '16 gameplekken, game-host, toernooi met prijsuitreiking en een medaille voor de jarige.',
    maxPlayers: 16, durationHours: 4, priceCents: 44900, sortOrder: 3,
  },
];

const db = createPool(loadConfig().DATABASE_URL);
try {
  await migrate(db);
  for (const p of packages) {
    await db.query(
      `INSERT INTO packages (slug, name, description, max_players, duration_hours, price_cents, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (slug) DO NOTHING`,
      [p.slug, p.name, p.description, p.maxPlayers, p.durationHours, p.priceCents, p.sortOrder],
    );
  }
  console.log('Example packages seeded.');
} finally {
  await db.end();
}
