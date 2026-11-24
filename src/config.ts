import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  TIMEZONE: z.string().default('Europe/Amsterdam'),
  TRUST_PROXY: bool.default(false),


  // Deposit asked when a booking is confirmed (in cents).
  DEPOSIT_CENTS: z.coerce.number().int().min(0).default(10000),
  // Price per extra game station on top of the package price (in cents).
  EXTRA_STATION_CENTS: z.coerce.number().int().min(0).default(2500),
  // Price of the decoration extra with the Standaard package (it is included in Ultimate).
  DECORATION_CENTS: z.coerce.number().int().min(0).default(2500),
  // Optional payment instructions added to the confirmation email, e.g. an IBAN.
  PAYMENT_INFO: z.string().default(''),
  // Travel costs: cents per km of the round trip (so per km one way it is double), with a maximum.
  TRAVEL_CENTS_PER_KM: z.coerce.number().int().min(0).default(50),
  TRAVEL_MAX_CENTS: z.coerce.number().int().min(0).default(10000),
  // Surcharge when the party ends after 19:30.
  EVENING_SURCHARGE_CENTS: z.coerce.number().int().min(0).default(5000),
  // Time needed on location before and after a party, for the day planning.
  SETUP_MINUTES: z.coerce.number().int().min(0).max(240).default(60),
  TEARDOWN_MINUTES: z.coerce.number().int().min(0).max(240).default(45),
  // Where the bus leaves from, used to calculate travel distance (a postcode or address).
  BASE_LOCATION: z.string().default('5611AB Eindhoven'),
  // Address lookup (PDOK Locatieserver, free) and driving distance (OSRM).
  GEOCODER_URL: z.url().default('https://api.pdok.nl/bzk/locatieserver/search/v3_1/free'),
  ROUTING_URL: z.url().default('https://router.project-osrm.org'),
  // Mollie API key (test_... or live_...). Leave empty to switch online payment off.
  MOLLIE_API_KEY: z.string().regex(/^((test|live)_\w+)?$/, 'MOLLIE_API_KEY must start with test_ or live_').default(''),
  // Only for testing against a stand-in for Mollie.
  MOLLIE_API_URL: z.url().default('https://api.mollie.com/v2'),
  // Link for leaving a Google review (from your Google Business Profile: "Ask for reviews").
  GOOGLE_REVIEW_URL: z.string().default(''),
  // Days after the party that the review request is emailed by itself. 0 switches it off.
  AUTO_REVIEW_DAYS: z.coerce.number().int().min(0).max(13).default(2),

  // API token of e-Boekhouden.nl (Beheer > API). Leave empty to switch invoicing off.
  EBOEKHOUDEN_TOKEN: z.string().default(''),
  // Folders with the database backups and the weekly maintenance reports, for the status page.
  BACKUP_DIR: z.string().default(''),
  REPORTS_DIR: z.string().default(''),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  // When SMTP_HOST is empty, emails are logged instead of sent.
  SMTP_HOST: z.string().default(''),
  // How long the login link and code sent by email stay valid.
  LOGIN_LINK_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default('Gamer Xperience <contact@gamerxp.nl>'),
  // Mailbox to import customer emails from (IMAP). Leave IMAP_HOST empty to switch the import off.
  IMAP_HOST: z.string().default(''),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_SECURE: bool.default(true),
  IMAP_USER: z.string().default(''),
  IMAP_PASS: z.string().default(''),
  IMAP_MAILBOX: z.string().default('INBOX'),
  // How often the mailbox is checked, and how far back the first check looks.
  IMAP_POLL_MINUTES: z.coerce.number().int().positive().default(5),
  IMAP_LOOKBACK_DAYS: z.coerce.number().int().positive().default(14),
  // Where new booking and contact notifications are sent.
  OWNER_EMAIL: z.string().default(''),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
