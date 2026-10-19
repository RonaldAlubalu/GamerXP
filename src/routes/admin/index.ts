import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateSessionToken, hashToken, verifyPassword } from '../../lib/auth.js';
import { HttpError } from '../../lib/errors.js';
import { bookingRoutes } from './bookings.js';
import { catalogRoutes } from './catalog.js';

declare module 'fastify' {
  interface FastifyRequest {
    admin?: { id: number; email: string };
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
      const { rows } = await app.db.query<{ id: number; email: string }>(
        `SELECT u.id, u.email FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hashToken(token)],
      );
      if (!rows[0]) throw new HttpError(401, 'Sessie verlopen, log opnieuw in.', 'unauthenticated');
      req.admin = rows[0];
    });

    secured.get('/me', async (req) => req.admin);

    secured.post('/logout', async (req, reply) => {
      await app.db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(bearerToken(req)!)]);
      return reply.status(204).send();
    });

    await secured.register(bookingRoutes);
    await secured.register(catalogRoutes);
  });
};
