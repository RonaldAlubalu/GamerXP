import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const db = createPool(loadConfig().DATABASE_URL);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Done, ${applied.length} migration(s) applied.` : 'Database is up to date.');
} finally {
  await db.end();
}
