// Test customers in every phase of the pipeline, so the admin can be tried out
// without real bookings. Everything goes through the real API, exactly as a
// visitor and you would do it. Test customers use @example.nl email addresses.
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { hashPassword } from '../lib/auth.js';
import { addDays, today } from '../lib/dates.js';

const DEMO_DOMAIN = '@example.nl';
export const DEMO_ADMIN = 'demo@gamerxp.nl';

// Rough one-way distances from Eindhoven, so no address lookups are needed.
const DISTANCES: Record<string, number> = {
  Utrecht: 87.1, Eindhoven: 4.2, "'s-Hertogenbosch": 31.9, Helmond: 14.8, Tilburg: 36.5,
  Amersfoort: 104.3, Woerden: 112.6, Veldhoven: 8.9, Nijmegen: 66.2,
};

interface DemoCustomer {
  parentName: string; email: string; phone: string; street: string; postalCode: string; city: string;
  childName: string; childAge: number; guestCount: number; notes: string;
  package: 'standaard' | 'ultimate'; extraStations: number;
  // Final phase, and days from today for the party (negative = in the past).
  status: string; days: number;
  script: (b: Booked, api: AdminApi) => Promise<void>;
}

interface Booked { id: string; reference: string }
type AdminApi = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => Promise<Record<string, unknown>>;

const todayIso = () => new Date().toISOString().slice(0, 10);
const msg = (direction: 'in' | 'out', channel: string, body: string, subject = '', send = false) =>
  ({ direction, channel, body, subject, send });

const CUSTOMERS: DemoCustomer[] = [
  {
    parentName: 'Sanne de Vries', email: `sanne${DEMO_DOMAIN}`, phone: '06 12345678', street: 'Oudegracht 120',
    postalCode: '3511AX', city: 'Utrecht', childName: 'Daan', childAge: 9, guestCount: 8,
    notes: 'Daan is gek op Fortnite en Rocket League. Kan het in de woonkamer?', package: 'ultimate', extraStations: 0,
    status: 'new', days: 12, script: async () => {},
  },
  {
    parentName: 'Mark de Boer', email: `mark${DEMO_DOMAIN}`, phone: '06 23456789', street: 'Stratumseind 12',
    postalCode: '5611ET', city: 'Eindhoven', childName: 'Lotte', childAge: 10, guestCount: 10,
    notes: 'Graag Roblox en Minecraft, ook een paar meiden die weinig gamen.', package: 'ultimate', extraStations: 2,
    status: 'contacted', days: 16,
    script: async (b, api) => {
      await api('POST', `/bookings/${b.id}/messages`, msg('out', 'email',
        'Hoi Mark,\n\nLeuk dat jullie een feest willen! Met 10 kinderen raad ik 2 extra stations aan, dat heb je al gekozen. Hoe groot is de ruimte waar het feest plaatsvindt?',
        'Je aanvraag bij Gamer Xperience', true));
    },
  },
  {
    parentName: 'Fatima Yilmaz', email: `fatima${DEMO_DOMAIN}`, phone: '06 34567890', street: 'Hinthamerstraat 45',
    postalCode: '5211MG', city: "'s-Hertogenbosch", childName: 'Noah', childAge: 8, guestCount: 7,
    notes: '', package: 'standaard', extraStations: 0, status: 'confirmed', days: 20,
    script: async (b, api) => {
      await api('POST', `/bookings/${b.id}/messages`, msg('in', 'whatsapp', 'Hoi! Kan het ook om 14:00 beginnen? Groetjes Fatima'));
      await api('POST', `/bookings/${b.id}/agreements`, { text: 'Starttijd 14:00' });
      await api('PATCH', `/bookings/${b.id}`, { startTime: '14:00' });
    },
  },
  {
    parentName: 'Jeroen Bakker', email: `jeroen${DEMO_DOMAIN}`, phone: '06 45678901', street: 'Markt 3',
    postalCode: '5701RK', city: 'Helmond', childName: 'Sem', childAge: 11, guestCount: 9,
    notes: 'FIFA-toernooi graag!', package: 'ultimate', extraStations: 1, status: 'deposit_paid', days: 25,
    script: async (b, api) => {
      await api('POST', `/bookings/${b.id}/payments`, { kind: 'deposit', amountCents: 10000, method: 'bank', paidOn: todayIso(), note: 'Via de bank' });
      await api('POST', `/bookings/${b.id}/agreements`, { text: 'FIFA-toernooi met prijsuitreiking' });
    },
  },
  {
    parentName: 'Lisa Jansen', email: `lisa${DEMO_DOMAIN}`, phone: '06 56789012', street: 'Heuvelring 88',
    postalCode: '5038CK', city: 'Tilburg', childName: 'Mila', childAge: 12, guestCount: 8,
    notes: 'Feest in de garage, daar zijn genoeg stopcontacten.', package: 'standaard', extraStations: 0,
    status: 'scheduled', days: 6,
    script: async (b, api) => {
      await api('POST', `/bookings/${b.id}/payments`, { kind: 'deposit', amountCents: 10000, method: 'tikkie', paidOn: todayIso() });
      await api('POST', `/bookings/${b.id}/agreements`, { text: 'Feest in de garage, 3 tafels' });
      await api('POST', `/bookings/${b.id}/agreements`, { text: 'Games: Fortnite, Fall Guys, Among Us' });
      await api('PATCH', `/bookings/${b.id}`, { startTime: '13:30' });
      await api('POST', `/bookings/${b.id}/messages`, msg('out', 'whatsapp', 'Ik ben er zaterdag om 12:30 om op te bouwen!'));
    },
  },
  {
    parentName: 'Ahmed El Amrani', email: `ahmed${DEMO_DOMAIN}`, phone: '06 67890123', street: 'Grote Markt 1',
    postalCode: '6511KB', city: 'Nijmegen', childName: 'Yassin', childAge: 10, guestCount: 8,
    notes: '', package: 'standaard', extraStations: 0, status: 'party_held', days: -3,
    script: async (b, api) => {
      await api('POST', `/bookings/${b.id}/payments`, { kind: 'deposit', amountCents: 10000, method: 'bank', paidOn: todayIso() });
      await api('POST', `/bookings/${b.id}/payments`, { kind: 'security_deposit', amountCents: 10000, method: 'cash', paidOn: todayIso(), note: 'Borg Standaard' });
    },
  },
  {
    parentName: 'Emma Visser', email: `emma${DEMO_DOMAIN}`, phone: '06 78901234', street: 'Langestraat 22',
    postalCode: '3811AA', city: 'Amersfoort', childName: 'Lucas', childAge: 9, guestCount: 10,
    notes: 'Minecraft-thema!', package: 'ultimate', extraStations: 1, status: 'completed', days: -10,
    script: async (b, api) => {
      const booking = await api('GET', `/bookings/${b.id}`);
      await api('POST', `/bookings/${b.id}/payments`, { kind: 'deposit', amountCents: 10000, method: 'bank', paidOn: todayIso() });
      await api('POST', `/bookings/${b.id}/payments`, {
        kind: 'payment', amountCents: (booking.priceCents as number) - 10000, method: 'cash', paidOn: todayIso(), note: 'Restbedrag op de dag zelf',
      });
      await api('POST', `/bookings/${b.id}/messages`, msg('in', 'email', 'Wat een topfeest, Lucas praat nergens anders meer over!'));
    },
  },
  {
    parentName: 'Tom Peters', email: `tom${DEMO_DOMAIN}`, phone: '06 89012345', street: 'Kerkstraat 5',
    postalCode: '3441BG', city: 'Woerden', childName: 'Jesse', childAge: 7, guestCount: 6,
    notes: '', package: 'standaard', extraStations: 0, status: 'cancelled', days: 30,
    script: async (b, api) => {
      await api('POST', `/bookings/${b.id}/messages`, msg('in', 'phone', 'Gebeld: feest gaat niet door, opa is ziek. Wil later opnieuw plannen.'));
    },
  },
];

const PIPELINE = ['new', 'contacted', 'confirmed', 'deposit_paid', 'scheduled', 'party_held', 'completed'];

export async function clearDemoData(db: Db): Promise<void> {
  const bookings = await db.query(`DELETE FROM bookings WHERE email LIKE '%${DEMO_DOMAIN}'`);
  const messages = await db.query(`DELETE FROM contact_messages WHERE email LIKE '%${DEMO_DOMAIN}'`);
  console.log(`Removed ${bookings.rowCount} test bookings and ${messages.rowCount} test messages.`);
}

async function seed(app: FastifyInstance, log: (msg: string) => void) {
  // Log in as an admin through a temporary session.
  const { rows } = await app.db.query<{ email: string }>('SELECT email FROM admin_users ORDER BY id LIMIT 1');
  const adminEmail = rows[0]?.email;
  if (!adminEmail) throw new Error('Create an admin first (npm run create-admin), or set DEMO_ADMIN_PASSWORD.');
  const tempPassword = `seed-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const original = await app.db.query<{ password_hash: string }>('SELECT password_hash FROM admin_users WHERE email = $1', [adminEmail]);
  await app.db.query('UPDATE admin_users SET password_hash = $2 WHERE email = $1', [adminEmail, await hashPassword(tempPassword)]);
  let token: string;
  try {
    const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { email: adminEmail, password: tempPassword } });
    token = login.json().token;
  } finally {
    await app.db.query('UPDATE admin_users SET password_hash = $2 WHERE email = $1', [adminEmail, original.rows[0]!.password_hash]);
  }

  const api: AdminApi = async (method, url, payload) => {
    const res = await app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${token}` }, payload });
    if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.body}`);
    return res.statusCode === 204 ? {} : res.json();
  };

  // Make sure every slot can be booked while seeding, and restore the schedule afterwards.
  const schedule = await app.db.query('SELECT weekday, slot, open FROM weekly_availability');
  await app.db.query('UPDATE weekly_availability SET open = true');
  const packages = (await app.inject('/api/packages')).json() as { id: number; slug: string }[];
  try {
    const availability = (await app.inject('/api/availability')).json() as { days: Record<string, string[]> };
    const freeDates = Object.keys(availability.days).sort();
    const t = today(app.config.TIMEZONE);

    for (const [i, c] of CUSTOMERS.entries()) {
      // Book on a free date close to the wanted one, then move past parties to their real date.
      const wanted = addDays(t, Math.max(c.days, 4));
      const date = freeDates.find((d) => d >= wanted && availability.days[d]!.length) ?? freeDates[i]!;
      const free = availability.days[date]!;
      const slot = free.includes('middag') ? 'middag' : free[0]!;
      free.splice(free.indexOf(slot), 1);
      const res = await app.inject({
        method: 'POST',
        url: '/api/bookings',
        remoteAddress: `10.99.0.${i + 1}`,
        payload: {
          packageId: packages.find((p) => p.slug === c.package)!.id, extraStations: c.extraStations,
          partyDate: date, timeSlot: slot, parentName: c.parentName, email: c.email, phone: c.phone, street: c.street,
          postalCode: c.postalCode, city: c.city, childName: c.childName, childAge: c.childAge, guestCount: c.guestCount,
          notes: c.notes, termsAccepted: true,
        },
      });
      if (res.statusCode !== 201) throw new Error(`Booking for ${c.parentName} failed: ${res.body}`);
      const [booked] = (await api('GET', `/bookings?q=${encodeURIComponent(res.json().reference)}`)) as unknown as Booked[];

      if (c.days < 0) await api('PATCH', `/bookings/${booked!.id}`, { partyDate: addDays(t, c.days) });

      // Walk through the phases like you would, ticking off the checklist on the way.
      const target = c.status === 'cancelled' ? 0 : PIPELINE.indexOf(c.status);
      const detail = (await api('GET', `/bookings/${booked!.id}`)) as { tasks: { id: number; stage: string }[] };
      for (let s = 1; s <= target; s++) {
        for (const task of detail.tasks.filter((t) => t.stage === PIPELINE[s - 1])) {
          await api('PATCH', `/bookings/${booked!.id}/tasks/${task.id}`, { done: true });
        }
        // Parties that already happened get their payments and messages just before the last step.
        if (s === target && target >= PIPELINE.indexOf('party_held')) await c.script(booked!, api);
        await api('PATCH', `/bookings/${booked!.id}`, { status: PIPELINE[s] });
      }
      if (target < PIPELINE.indexOf('party_held')) await c.script(booked!, api);
      if (c.status === 'cancelled') await api('PATCH', `/bookings/${booked!.id}`, { status: 'cancelled' });
      if (c.status === 'completed' && !app.config.GOOGLE_REVIEW_URL) {
        await api('PATCH', `/bookings/${booked!.id}`, { reviewStatus: 'requested' });
      }
      log(`  ${c.parentName.padEnd(18)} ${c.status.padEnd(13)} ${date} ${slot}`);
    }
  } finally {
    for (const r of schedule.rows) {
      await app.db.query('UPDATE weekly_availability SET open = $3 WHERE weekday = $1 AND slot = $2', [r.weekday, r.slot, r.open]);
    }
  }

  // Two contact form messages: one answered, one still waiting.
  for (const [i, m] of [
    { name: 'Petra Smit', email: `petra${DEMO_DOMAIN}`, message: 'Doen jullie ook schoolfeesten? Het gaat om groep 7, ongeveer 25 kinderen.' },
    { name: 'Kees Mulder', email: `kees${DEMO_DOMAIN}`, message: 'Hoeveel ruimte hebben jullie nodig voor 8 stations?' },
  ].entries()) {
    await app.inject({ method: 'POST', url: '/api/contact', remoteAddress: `10.99.1.${i + 1}`, payload: m });
  }
  const kees = ((await api('GET', '/messages')) as unknown as { id: number; name: string }[]).find((m) => m.name === 'Kees Mulder');
  if (kees) {
    await api('POST', `/messages/${kees.id}/replies`, msg('out', 'email', 'Hoi Kees, een grote eettafel voor 6 personen is genoeg. Wij bouwen alles compact op.', '', true));
  }
}


// Adds the test customers (and the demo admin login when a password is given).
export async function addDemoData(
  config: Config,
  db: Db,
  options: { adminPassword?: string; log?: (msg: string) => void } = {},
): Promise<void> {
  const log = options.log ?? console.log;
  if (options.adminPassword) {
    await db.query(
      `INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [DEMO_ADMIN, await hashPassword(options.adminPassword)],
    );
  }
  // Emails to test customers are only logged, and distances come from the table above.
  const app = await buildApp({
    config,
    db,
    logger: false,
    mailer: { send: async () => {} },
    distance: { drivingKm: async (_postalCode, city) => DISTANCES[city] ?? 50 },
    mollie: null,
  });
  try {
    log('Adding test customers:');
    await seed(app, log);
  } finally {
    await app.close();
  }
}
