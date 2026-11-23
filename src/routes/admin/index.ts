import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateSessionToken, hashToken, verifyPassword } from '../../lib/auth.js';
import { HttpError } from '../../lib/errors.js';
import { runMailImport } from '../../services/mail-import.js';
import { checkSystem } from '../../services/status.js';
import { availabilityRoutes } from './availability.js';
import { bookingRoutes } from './bookings.js';
import { catalogRoutes } from './catalog.js';
import { messageRoutes } from './messages.js';
import { assistantMayCall, userRoutes, type Role } from './users.js';

declare module 'fastify' {
  interface FastifyRequest {
    admin?: { id: number; email: string; name: string; role: Role; tokenHash: string };
  }
}

function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

// A dummy hash so a login for an unknown email takes as long as a wrong password.
const DUMMY_HASH = '$2b$12$S7333sHhnxTEx1ayGNjnRuORrSn9Jxd0CQNP9DvJqelEUm2piol6G';

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req) => {
      const { email, password } = z
        .object({ email: z.string().trim().toLowerCase(), password: z.string().min(1) })
        .parse(req.body);
      const { rows } = await app.db.query<{ id: number; password_hash: string }>(
        'SELECT id, password_hash FROM admin_users WHERE email = $1',
        [email],
      );
      const user = rows[0];
      const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok) throw new HttpError(401, 'Onjuist e-mailadres of wachtwoord.', 'invalid_credentials');

      const token = generateSessionToken();
      const expires = await app.db.query<{ expires_at: Date }>(
        `INSERT INTO admin_sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + make_interval(hours => $3)) RETURNING expires_at`,
        [hashToken(token), user.id, app.config.SESSION_TTL_HOURS],
      );
      // Opportunistically clean up old sessions.
      await app.db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
      return { token, expiresAt: expires.rows[0]!.expires_at };
    },
  );

  // Everything registered below requires a valid session.
  await app.register(async (secured) => {
    secured.addHook('onRequest', async (req) => {
      const token = bearerToken(req);
      if (!token) throw new HttpError(401, 'Niet ingelogd.', 'unauthenticated');
      const tokenHash = hashToken(token);
      const { rows } = await app.db.query<{ id: number; email: string; name: string; role: Role }>(
        `SELECT u.id, u.email, u.name, u.role FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [tokenHash],
      );
      if (!rows[0]) throw new HttpError(401, 'Sessie verlopen, log opnieuw in.', 'unauthenticated');
      req.admin = { ...rows[0], tokenHash };
      const path = req.url.split('?')[0]!.replace(/^\/api\/admin/, '');
      if (req.admin.role === 'assistant' && !assistantMayCall(req.method, path)) {
        throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
      }
    });

    secured.get('/me', async (req) => ({
      id: req.admin!.id,
      email: req.admin!.email,
      name: req.admin!.name,
      role: req.admin!.role,
      // Lets the admin page point out missing setup.
      reviewUrlConfigured: Boolean(app.config.GOOGLE_REVIEW_URL),
      emailConfigured: Boolean(app.config.SMTP_HOST),
      onlinePayments: Boolean(app.mollie),
      mailImportConfigured: Boolean(app.mailSource),
    }));

    // Check the mailbox now instead of waiting for the next automatic check.
    secured.post('/mail-import', async () => {
      if (!app.mailSource) throw new HttpError(409, 'E-mail importeren is nog niet ingesteld (IMAP).', 'not_configured');
      try {
        return await runMailImport(app);
      } catch (err) {
        app.log.error({ err }, 'Email import failed');
        throw new HttpError(502, 'De mailbox kon niet worden gelezen. Controleer de IMAP-instellingen.', 'import_failed');
      }
    });

    // Connection status of everything the site depends on. ?fresh=1 tests again right now.
    secured.get('/status', async (req) => {
      if (req.admin!.role !== 'owner') throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
      const { fresh } = z.object({ fresh: z.string().optional() }).parse(req.query);
      if (fresh || !app.systemStatus.current) app.systemStatus.current = await checkSystem(app);
      return app.systemStatus.current;
    });

    secured.post('/logout', async (req, reply) => {
      await app.db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(bearerToken(req)!)]);
      return reply.status(204).send();
    });

    await secured.register(bookingRoutes);
    await secured.register(catalogRoutes);
    await secured.register(availabilityRoutes);
    await secured.register(messageRoutes);
    await secured.register(userRoutes);
  });
};
