// Runs the whole site on your own computer with only Node.js: a built-in
// PostgreSQL database, test customers and a demo admin login.
//
//   npm install
//   npm run demo
//
// Website: http://localhost:8080   Admin: http://localhost:8080/admin
// The demo database lives in your home folder (~/.gamerxp-demo), outside the
// project, so cloud-synced folders like OneDrive don't interfere with it.
// Start over with fresh test customers: npm run demo -- --reset
// Own admin password: set DEMO_ADMIN_PASSWORD (applies when test customers are added).
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
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
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? 'demo-wachtwoord-123';
// As root (some sandboxes), PostgreSQL runs as a separate user that can't open
// root's home folder, so the data goes to the shared temp folder instead.
const runningAsRoot = process.getuid?.() === 0;
const defaultDir = runningAsRoot ? path.join(os.tmpdir(), 'gamerxp-demo', 'db') : path.join(os.homedir(), '.gamerxp-demo', 'db');
const dataDir = path.resolve(process.env.DEMO_DATA_DIR ?? defaultDir);

if (process.argv.includes('--reset')) {
  rmSync(path.dirname(dataDir), { recursive: true, force: true });
  console.log('Old demo data removed.');
}

console.log('Starting the built-in database…');
const log: string[] = [];
mkdirSync(path.dirname(dataDir), { recursive: true });
const database = new EmbeddedPostgres({
  databaseDir: dataDir,
  port: DB_PORT,
  user: 'gamerxp',
  password: 'demo',
  persistent: true,
  // PostgreSQL refuses to run as root, which some sandboxes and containers use.
  createPostgresUser: runningAsRoot,
  // Kept so we can explain why the database didn't start.
  onLog: (message) => {
    log.push(String(message));
  },
  onError: (err) => {
    const text = String(err);
    if (/error|fatal/i.test(text) && !/already exists/i.test(text)) console.error(text);
  },
});
const firstRun = !existsSync(path.join(dataDir, 'PG_VERSION'));
try {
  if (firstRun) await database.initialise();
  await database.start();
} catch (err) {
  console.error('\nThe built-in database could not start.\n');
  if (err) console.error(String(err));
  const output = log.join('').trim();
  if (output) console.error(`Database output:\n${output.split(/\r?\n/).slice(-15).join('\n')}\n`);
  console.error(
    [
      'Common causes:',
      '- Windows: PowerShell or Command Prompt was opened with "Run as administrator".',
      '  The database refuses to run as administrator; open a normal window instead.',
      '- Windows: the Microsoft Visual C++ Redistributable (x64) is missing:',
      '  https://aka.ms/vs/17/release/vc_redist.x64.exe',
      `- Port ${DB_PORT} is already in use: set DEMO_DB_PORT to another port.`,
      '- A previous attempt left broken data behind: npm run demo -- --reset',
    ].join('\n'),
  );
  process.exit(1);
}

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

  Stop with Ctrl+C. Fresh test customers: npm run demo -- --reset
`);
