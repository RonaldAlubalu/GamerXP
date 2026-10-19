// Runs the whole site on your own computer with only Node.js: a built-in
// PostgreSQL database, test customers and a demo admin login.
//
//   npm install
//   npm run demo
//
// Website: http://localhost:8080   Admin: http://localhost:8080/admin
// The data is kept in .demo/ between runs; delete that folder to start over.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { addDemoData, DEMO_ADMIN } from './demo-data.js';

const PORT = Number(process.env.PORT ?? 8080);
const DB_PORT = Number(process.env.DEMO_DB_PORT ?? 54329);
const ADMIN_PASSWORD = 'demo-wachtwoord-123';
const dataDir = path.resolve('.demo', 'db');

console.log('Starting the built-in database…');
mkdirSync(path.dirname(dataDir), { recursive: true });
const database = new EmbeddedPostgres({
  databaseDir: dataDir,
  port: DB_PORT,
  user: 'gamerxp',
  password: 'demo',
  persistent: true,
  // PostgreSQL refuses to run as root, which some sandboxes and containers use.
  createPostgresUser: process.getuid?.() === 0,
  onLog: () => {},
  onError: (err) => {
    const text = String(err);
    if (/error|fatal/i.test(text) && !/already exists/i.test(text)) console.error(text);
  },
});
const firstRun = !existsSync(path.join(dataDir, 'PG_VERSION'));
if (firstRun) await database.initialise();
await database.start();

// Create the database on the first run.
const admin = new pg.Client({ host: 'localhost', port: DB_PORT, user: 'gamerxp', password: 'demo', database: 'postgres' });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'gamerxp'");
if (!exists.rowCount) await admin.query('CREATE DATABASE gamerxp');
await admin.end();

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(PORT),
  DATABASE_URL: `postgres://gamerxp:demo@localhost:${DB_PORT}/gamerxp`,
  PUBLIC_URL: process.env.PUBLIC_URL ?? `http://localhost:${PORT}`,
  OWNER_EMAIL: process.env.OWNER_EMAIL ?? DEMO_ADMIN,
  GOOGLE_REVIEW_URL: process.env.GOOGLE_REVIEW_URL ?? 'https://g.page/r/voorbeeld/review',
});
const db = createPool(config.DATABASE_URL);
await migrate(db, () => {});

const bookings = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM bookings');
if (bookings.rows[0]!.n === 0) {
  await addDemoData(config, db, { adminPassword: ADMIN_PASSWORD, log: () => {} });
  console.log('Test customers added.');
}

// Emails are not sent in the demo; they are shown here instead.
const app = await buildApp({
  config,
  db,
  logger: false,
  mailer: {
    async send(mail) {
      console.log(`\n✉  Email to ${mail.to}: ${mail.subject}`);
    },
  },
});

async function stop() {
  console.log('\nStopping…');
  await app.close().catch(() => {});
  await db.end().catch(() => {});
  await database.stop().catch(() => {});
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: PORT });
console.log(`
  Gamer Xperience is running

  Website:  http://localhost:${PORT}
  Admin:    http://localhost:${PORT}/admin
  Login:    ${DEMO_ADMIN} / ${ADMIN_PASSWORD}
  Online payments: ${app.mollie ? 'Mollie (MOLLIE_API_KEY)' : 'off (set MOLLIE_API_KEY=test_... to try Mollie)'}

  Stop with Ctrl+C. Delete the .demo folder to start over with fresh test customers.
`);
