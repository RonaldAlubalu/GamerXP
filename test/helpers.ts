import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/auth.js';
import { addDays, today } from '../src/lib/dates.js';
import type { Mail } from '../src/lib/mailer.js';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  config: Config;
  sent: Mail[];
  packageId: number;
}

export async function setupApp(overrides: Partial<Config> = {}): Promise<TestContext> {
  const config = { ...loadConfig(), OWNER_EMAIL: 'owner@gamerxp.nl', ...overrides };
  const db = createPool(config.DATABASE_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO packages (slug, name, max_players, duration_hours, price_cents)
     VALUES ('basis', 'LAN-Party Basis', 8, 3, 19900) RETURNING id`,
  );
  const sent: Mail[] = [];
  const app = await buildApp({ config, db, logger: false, mailer: { send: async (m) => void sent.push(m) } });
  return { app, db, config, sent, packageId: rows[0]!.id };
}

export async function teardown(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.db.end();
}

export function futureDate(ctx: TestContext, days = 14): string {
  return addDays(today(ctx.config.TIMEZONE), days);
}

export function bookingBody(ctx: TestContext, overrides: Record<string, unknown> = {}) {
  return {
    packageId: ctx.packageId,
    partyDate: futureDate(ctx),
    startTime: '14:00',
    parentName: 'Sanne de Vries',
    email: 'sanne@example.nl',
    phone: '06 12345678',
    street: 'Dorpsstraat 1',
    postalCode: '1234ab',
    city: 'Utrecht',
    childName: 'Daan',
    childAge: 9,
    guestCount: 8,
    notes: '',
    privacyConsent: true,
    ...overrides,
  };
}

export async function loginAdmin(ctx: TestContext): Promise<string> {
  await ctx.db.query('INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)', [
    'admin@gamerxp.nl',
    await hashPassword('correct-horse-battery'),
  ]);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { email: 'admin@gamerxp.nl', password: 'correct-horse-battery' },
  });
  return res.json().token;
}
