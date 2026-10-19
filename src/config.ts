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
  // Optional payment instructions added to the confirmation email, e.g. an IBAN.
  PAYMENT_INFO: z.string().default(''),
  // Travel costs: cents per km of the round trip (so per km one way it is double), with a maximum.
  TRAVEL_CENTS_PER_KM: z.coerce.number().int().min(0).default(50),
  TRAVEL_MAX_CENTS: z.coerce.number().int().min(0).default(10000),
  // Surcharge when the party ends after 19:30.
  EVENING_SURCHARGE_CENTS: z.coerce.number().int().min(0).default(5000),
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

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  // When SMTP_HOST is empty, emails are logged instead of sent.
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default('Gamer Xperience <contact@gamerxp.nl>'),
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
