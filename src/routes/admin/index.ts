import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateSessionToken, hashToken, verifyPassword } from '../../lib/auth.js';
import { HttpError } from '../../lib/errors.js';
import { verifyCode } from '../../lib/totp.js';
import { runMailImport } from '../../services/mail-import.js';
import { checkSystem } from '../../services/status.js';
import { availabilityRoutes } from './availability.js';
import { bookingRoutes } from './bookings.js';
import { catalogRoutes } from './catalog.js';
import { inventoryRoutes } from './inventory.js';
import { mailingRoutes } from './mailings.js';
import { messageRoutes } from './messages.js';
import { assistantMayCall, userRoutes, type Role } from './users.js';

declare module 'fastify' {
  interface FastifyRequest {
    admin?: { id: number; email: string; name: string; role: Role; twoFactor: boolean; tokenHash: string };
  }
}

function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

// A dummy hash so a login for an unknown email takes as long as a wrong password.
const DUMMY_HASH = '$2b$12$S7333sHhnxTEx1ayGNjnRuORrSn9Jxd0CQNP9DvJqelEUm2piol6G';

async function startSession(app: FastifyInstance, userId: number) {
  const token = generateSessionToken();
  const expires = await app.db.query<{ expires_at: Date }>(
    `INSERT INTO admin_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3)) RETURNING expires_at`,
    [hashToken(token), userId, app.config.SESSION_TTL_HOURS],
  );
  // Opportunistically clean up old sessions.
  await app.db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
  return { token, expiresAt: expires.rows[0]!.expires_at };
}

const MAX_LINK_ATTEMPTS = 5;
const TRUST_DAYS = 30;

// Remembers the device that just passed the second step. The token goes to that browser only.
async function trustDevice(app: FastifyInstance, userId: number, req: FastifyRequest): Promise<string> {
  const token = generateSessionToken();
  await app.db.query('DELETE FROM trusted_devices WHERE expires_at < now()');
  await app.db.query(
    `INSERT INTO trusted_devices (user_id, token_hash, label, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, hashToken(token), String(req.headers['user-agent'] ?? '').slice(0, 200), TRUST_DAYS],
  );
  return token;
}


export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req) => {
      const { email, password, code, device, remember } = z
        .object({
          email: z.string().trim().toLowerCase(),
          password: z.string().min(1),
          code: z.string().trim().max(20).optional(),
          // The token of a device that was remembered at an earlier login.
          device: z.string().max(200).optional(),
          remember: z.boolean().default(false),
        })
        .parse(req.body);
      const { rows } = await app.db.query<{
        id: number; password_hash: string; totp_enabled: boolean; totp_secret: string | null; totp_last_step: string; recovery_codes: string[];
      }>(
        'SELECT id, password_hash, totp_enabled, totp_secret, totp_last_step, recovery_codes FROM admin_users WHERE email = $1',
        [email],
      );
      const user = rows[0];
      const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok) throw new HttpError(401, 'Onjuist e-mailadres of wachtwoord.', 'invalid_credentials');

      // A remembered device has passed the second step within the last 30 days.
      if (device) {
        const known = await app.db.query(
          'SELECT 1 FROM trusted_devices WHERE user_id = $1 AND token_hash = $2 AND expires_at > now()',
          [user.id, hashToken(device)],
        );
        if (known.rowCount) return startSession(app, user.id);
      }

      // Second step: a code from the authenticator app, or a one-time backup code.
      if (user.totp_enabled && user.totp_secret) {
        if (!code) throw new HttpError(401, 'Vul de code uit je authenticator-app in.', 'two_factor_required');
        const step = verifyCode(user.totp_secret, code, Number(user.totp_last_step));
        const backup = hashToken(code.toLowerCase());
        if (step !== null) {
          await app.db.query('UPDATE admin_users SET totp_last_step = $2 WHERE id = $1', [user.id, step]);
        } else if (user.recovery_codes.includes(backup)) {
          await app.db.query('UPDATE admin_users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1', [user.id, backup]);
        } else {
          throw new HttpError(401, 'Deze code klopt niet of is al gebruikt. Probeer de volgende code.', 'invalid_code');
        }
        const session = await startSession(app, user.id);
        return remember ? { ...session, deviceToken: await trustDevice(app, user.id, req) } : session;
      }

      // Without an authenticator app the second step goes by email: a link and a code that are
      // valid for a short while. They only work together with "pending", which stays in the
      // browser that typed the password, so a stolen mail on its own opens nothing.
      if (!(user.totp_enabled && user.totp_secret) && app.config.SMTP_HOST) {
        const minutes = app.config.LOGIN_LINK_MINUTES;
        const pending = generateSessionToken();
        const linkToken = generateSessionToken();
        const mailCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
        await app.db.query('DELETE FROM login_links WHERE user_id = $1 OR expires_at < now()', [user.id]);
        await app.db.query(
          `INSERT INTO login_links (user_id, pending_hash, token_hash, code_hash, expires_at, remember)
           VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6)`,
          [user.id, hashToken(pending), hashToken(linkToken), hashToken(mailCode), minutes, remember],
        );
        try {
          await app.mailer.send({
            to: email,
            subject: `Je inlogcode voor Gamer Xperience Admin: ${mailCode}`,
            text:
              `Iemand logt in op de admin van Gamer Xperience met jouw wachtwoord.\n\n` +
              `Ben jij dat? Open dan deze link op het apparaat waarop je inlogt:\n` +
              `${app.config.PUBLIC_URL}/admin/#/inloggen?t=${linkToken}\n\n` +
              `Of typ deze code over in het inlogscherm: ${mailCode}\n\n` +
              `De link en de code zijn ${minutes} minuten geldig en werken één keer.\n\n` +
              `Was jij dit niet? Dan kent iemand je wachtwoord. Wijzig het zo snel mogelijk; ` +
              `zonder deze mail komt diegene niet binnen.`,
            plain: true,
          });
        } catch (err) {
          app.log.error({ err }, 'Login mail could not be sent');
          await app.db.query('DELETE FROM login_links WHERE user_id = $1', [user.id]);
          throw new HttpError(503, 'De inlogmail kon niet worden verstuurd. Probeer het over een paar minuten opnieuw.', 'login_mail_failed');
        }
        return { step: 'email' as const, pending, minutes };
      }

      return startSession(app, user.id);
    },
  );

  // Second step by email: the link from the mail, or the code typed over.
  app.post(
    '/login/link',
    { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (req) => {
      const { pending, token, code } = z
        .object({ pending: z.string().min(20).max(200), token: z.string().max(200).optional(), code: z.string().trim().max(20).optional() })
        .parse(req.body);
      const expired = new HttpError(401, 'Deze inloglink is verlopen of al gebruikt. Log opnieuw in.', 'link_expired');
      const { rows } = await app.db.query<{ id: string; user_id: number; token_hash: string; code_hash: string; attempts: number; remember: boolean }>(
        `UPDATE login_links SET attempts = attempts + 1
          WHERE pending_hash = $1 AND expires_at > now() AND attempts < $2
          RETURNING id, user_id, token_hash, code_hash, attempts, remember`,
        [hashToken(pending), MAX_LINK_ATTEMPTS],
      );
      const link = rows[0];
      if (!link) throw expired;
      const ok = (token && hashToken(token) === link.token_hash) || (code && hashToken(code.replace(/\s/g, '')) === link.code_hash);
      if (!ok) {
        if (token) throw new HttpError(401, 'Deze link hoort bij een andere inlogpoging. Gebruik de nieuwste mail.', 'invalid_code');
        throw new HttpError(401, link.attempts >= MAX_LINK_ATTEMPTS ? 'Te vaak een verkeerde code. Log opnieuw in.' : 'Deze code klopt niet.', 'invalid_code');
      }
      // One use only.
      const used = await app.db.query('DELETE FROM login_links WHERE id = $1', [link.id]);
      if (!used.rowCount) throw expired;
      const session = await startSession(app, link.user_id);
      return link.remember ? { ...session, deviceToken: await trustDevice(app, link.user_id, req) } : session;
    },
  );

  // Everything registered below requires a valid session.
  await app.register(async (secured) => {
    secured.addHook('onRequest', async (req) => {
      const token = bearerToken(req);
      if (!token) throw new HttpError(401, 'Niet ingelogd.', 'unauthenticated');
      const tokenHash = hashToken(token);
      const { rows } = await app.db.query<{ id: number; email: string; name: string; role: Role; twoFactor: boolean }>(
        `SELECT u.id, u.email, u.name, u.role, u.totp_enabled AS "twoFactor" FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
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
      trustedDevices: (await app.db.query('SELECT 1 FROM trusted_devices WHERE user_id = $1 AND expires_at > now()', [req.admin!.id])).rowCount ?? 0,
      id: req.admin!.id,
      email: req.admin!.email,
      name: req.admin!.name,
      avatar: (await app.db.query<{ avatar: string }>('SELECT avatar FROM admin_users WHERE id = $1', [req.admin!.id])).rows[0]?.avatar ?? '',
      role: req.admin!.role,
      twoFactor: req.admin!.twoFactor,
      // Lets the admin page point out missing setup.
      reviewUrlConfigured: Boolean(app.config.GOOGLE_REVIEW_URL),
      emailConfigured: Boolean(app.config.SMTP_HOST),
      onlinePayments: Boolean(app.mollie),
      mailImportConfigured: Boolean(app.mailSource),
      bookkeepingConfigured: Boolean(app.bookkeeping),
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
    await secured.register(inventoryRoutes);
    await secured.register(mailingRoutes);
  });
};
