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
import { publicRoutes } from './routes/public.js';
import { adminRoutes } from './routes/admin/index.js';
import { registerSite } from './site.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
    mailer: Mailer;
  }
}

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export interface AppOptions {
  config: Config;
  db: Db;
  mailer?: Mailer;
  logger?: boolean;
}

export async function buildApp({ config, db, mailer, logger = true }: AppOptions): Promise<FastifyInstance> {
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
  app.decorate('mailer', mailer ?? createMailer(config, (msg) => app.log.info(msg)));

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
