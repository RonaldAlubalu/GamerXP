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
