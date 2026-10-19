import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/auth.js';
import { addDays, today } from '../src/lib/dates.js';
import type { Mail } from '../src/lib/mailer.js';
import type { MollieClient, MolliePayment } from '../src/services/mollie.js';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  config: Config;
  sent: Mail[];
  packageId: number;
}

export async function setupApp(overrides: Partial<Config> = {}, mollie: MollieClient | null = null): Promise<TestContext> {
  const config = { ...loadConfig(), OWNER_EMAIL: 'owner@gamerxp.nl', ...overrides };
  const db = createPool(config.DATABASE_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  // Open every slot so tests don't depend on the starting schedule.
  await db.query('UPDATE weekly_availability SET open = true');
  // Migrations create the real packages: Standaard (€275) and Ultimate (€350).
  const { rows } = await db.query<{ id: number }>("SELECT id FROM packages WHERE slug = 'standaard'");
  const sent: Mail[] = [];
  const app = await buildApp({
    config,
    db,
    logger: false,
    mailer: { send: async (m) => void sent.push(m) },
    // Never call the real address lookup in tests: every address is 30 km away.
    distance: { drivingKm: async () => 30 },
    mollie,
  });
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
    timeSlot: 'middag',
    extraStations: 0,
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
    termsAccepted: true,
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

// A fake Mollie: payments start 'open'; tests mark them paid with pay().
export function fakeMollie() {
  const payments = new Map<string, MolliePayment & { redirectUrl: string; webhookUrl?: string }>();
  let n = 0;
  const client: MollieClient = {
    async createPayment(input) {
      const id = `tr_test${++n}`;
      const p = {
        id, status: 'open' as const, amount: { currency: 'EUR', value: (input.amountCents / 100).toFixed(2) },
        metadata: input.metadata, checkoutUrl: `https://www.mollie.com/checkout/${id}`,
        redirectUrl: input.redirectUrl, webhookUrl: input.webhookUrl,
      };
      payments.set(id, p);
      return p;
    },
    async getPayment(id) {
      const p = payments.get(id);
      if (!p) throw new Error('Mollie 404');
      return p;
    },
  };
  return { client, payments, pay: (id: string, status: MolliePayment['status'] = 'paid') => void (payments.get(id)!.status = status) };
}
