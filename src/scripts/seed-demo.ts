// Adds test customers in every phase of the pipeline (see demo-data.ts).
//
//   npm run seed-demo                 add test customers
//   npm run seed-demo -- --if-empty   only when there are no bookings yet
//   npm run seed-demo -- --clear      remove all test customers again
//
// With DEMO_ADMIN_PASSWORD set, it also creates the admin login demo@gamerxp.nl.
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { addDemoData, clearDemoData, DEMO_ADMIN } from './demo-data.js';

const args = new Set(process.argv.slice(2));
const config = loadConfig();
const db = createPool(config.DATABASE_URL);
try {
  await migrate(db, () => {});
  if (args.has('--clear')) {
    await clearDemoData(db);
  } else {
    const existing = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM bookings');
    if (args.has('--if-empty') && existing.rows[0]!.n > 0) {
      console.log('There are already bookings; not adding test customers.');
    } else {
      await addDemoData(config, db, { adminPassword: process.env.DEMO_ADMIN_PASSWORD });
      if (process.env.DEMO_ADMIN_PASSWORD) console.log(`Admin login: ${DEMO_ADMIN}`);
      console.log('Done. Remove them again with: npm run seed-demo -- --clear');
    }
  }
} finally {
  await db.end();
}
