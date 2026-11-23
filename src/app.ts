import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { HttpError } from './lib/errors.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { createDistanceService, type DistanceService } from './services/distance.js';
import { createImapSource, runMailImport, type MailSource } from './services/mail-import.js';
import { createMollieClient, type MollieClient } from './services/mollie.js';
import { paymentRoutes } from './routes/payments.js';
import { publicRoutes } from './routes/public.js';
import { adminRoutes } from './routes/admin/index.js';
import { checkSystem, type SystemStatus } from './services/status.js';
import { registerSite } from './site.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
    mailer: Mailer;
    distance: DistanceService;
    mollie: MollieClient | null;
    mailSource: MailSource | null;
    // Latest result of the connection checks, refreshed in the background.
    systemStatus: { current: SystemStatus | null };
    // The most recent emails the site tried to send, newest first, for the status page.
    mailLog: { at: string; to: string; subject: string; error?: string }[];
  }
}

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export interface AppOptions {
  config: Config;
  db: Db;
  mailer?: Mailer;
  distance?: DistanceService;
  // Pass null to switch online payment off, or a fake client in tests.
  mollie?: MollieClient | null;
  // Pass null to switch the email import off, or a fake mailbox in tests.
  mailSource?: MailSource | null;
  logger?: boolean;
}

export async function buildApp({ config, db, mailer, distance, mollie, mailSource, logger = true }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger && {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      // Keep personal data (and admin tokens) out of the logs.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 64 * 1024,
  });

  app.decorate('config', config);
  app.decorate('db', db);
  // Remember the last few emails and whether the mail server accepted them.
  const realMailer = mailer ?? createMailer(config, (msg) => app.log.info(msg));
  app.decorate('mailLog', []);
  app.decorate('mailer', {
    ...realMailer,
    async send(mail) {
      const entry: FastifyInstance['mailLog'][number] = { at: new Date().toISOString(), to: mail.to, subject: mail.subject };
      app.mailLog.unshift(entry);
      app.mailLog.length = Math.min(app.mailLog.length, 5);
      try {
        await realMailer.send(mail);
      } catch (err) {
        entry.error = (err as Error).message;
        throw err;
      }
    },
  });
  app.decorate('distance', distance ?? createDistanceService(config, (msg, err) => app.log.warn({ err }, msg)));
  app.decorate('mollie', mollie === undefined ? createMollieClient(config) : mollie);
  app.decorate('mailSource', mailSource === undefined ? createImapSource(config) : mailSource);

  // Check the mailbox for customer emails every few minutes.
  if (app.mailSource && config.NODE_ENV !== 'test') {
    const check = () =>
      runMailImport(app)
        .then((r) => r.imported && app.log.info(r, 'Imported customer emails'))
        .catch((err) => app.log.error({ err }, 'Email import failed'));
    const timer = setInterval(check, config.IMAP_POLL_MINUTES * 60_000);
    app.addHook('onReady', async () => void check());
    app.addHook('onClose', async () => clearInterval(timer));
  }

  // Test the outside connections every ten minutes, so the dashboard can warn without waiting.
  app.decorate('systemStatus', { current: null });
  if (config.NODE_ENV !== 'test') {
    const refresh = () =>
      checkSystem(app)
        .then((status) => void (app.systemStatus.current = status))
        .catch((err) => app.log.error({ err }, 'System check failed'));
    const timer = setInterval(refresh, 10 * 60_000);
    app.addHook('onReady', async () => void refresh());
    app.addHook('onClose', async () => clearInterval(timer));
  }

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { 'img-src': ["'self'", 'data:'] },
    },
  });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: err.issues[0]?.message ?? 'Ongeldige invoer.',
        code: 'validation_error',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, code: err.code });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error(err);
      return reply.status(500).send({ error: 'Er ging iets mis. Probeer het later opnieuw.', code: 'internal_error' });
    }
    return reply.status(status).send({ error: (err as Error).message, code: (err as { code?: string }).code });
  });

  await app.register(publicRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(paymentRoutes);

  await registerSite(app);
  // Assets and the admin page. Website pages come from site/ (see site.ts).
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    index: ['index.html'],
    maxAge: config.NODE_ENV === 'production' ? '1d' : 0,
  });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Niet gevonden.', code: 'not_found' });
    }
    return reply.status(404).type('text/html; charset=utf-8').send(await app.notFoundPage());
  });

  return app;
}
