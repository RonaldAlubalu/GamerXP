import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import { hashPassword, hashToken, verifyPassword } from '../../lib/auth.js';
import { generateRecoveryCodes, generateSecret, otpauthUrl, verifyCode } from '../../lib/totp.js';
import { HttpError } from '../../lib/errors.js';
import { notify, vapidKeys } from '../../services/push.js';

export type Role = 'owner' | 'assistant';

// What an assistant may do: look at bookings and the calendar, and change the availability.
const ASSISTANT_READ = [/^\/me$/, /^\/staff$/, /^\/push\/key$/, /^\/stages$/, /^\/overview$/, /^\/pipeline$/, /^\/bookings(\/[^/]+)?$/, /^\/calendar$/, /^\/packages$/, /^\/availability(\/|$)/, /^\/blocked-dates(\/|$)/];
const ASSISTANT_WRITE = [/^\/logout$/, /^\/me\/password$/, /^\/me\/profile$/, /^\/me\/2fa\//, /^\/me\/devices\//, /^\/push\//, /^\/availability(\/|$)/, /^\/blocked-dates(\/|$)/];

export function assistantMayCall(method: string, path: string): boolean {
  return (method === 'GET' ? ASSISTANT_READ : ASSISTANT_WRITE).some((allowed) => allowed.test(path));
}

const password = z.string().min(12, 'Het wachtwoord moet minimaal 12 tekens zijn.').max(200);
const role = z.enum(['owner', 'assistant']);
const idParam = z.object({ id: z.coerce.number().int().positive() });
const COLUMNS = 'id, email, name, role, totp_enabled AS "twoFactor", created_at AS "createdAt"';

function requireOwner(req: FastifyRequest) {
  if (req.admin?.role !== 'owner') throw new HttpError(403, 'Alleen een eigenaar kan gebruikers beheren.', 'forbidden');
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  // Who works here, by e-mail address: the timeline stores who did something by address, and
  // shows the name and photo that belong to it.
  app.get('/staff', async () => {
    const { rows } = await app.db.query('SELECT email, name, avatar FROM admin_users ORDER BY id');
    return rows;
  });

  // Everyone can set their own name and photo. The photo is made small in the browser first.
  app.post('/me/profile', async (req) => {
    const body = z
      .object({
        name: z.string().trim().max(100),
        avatar: z.union([z.literal(''), z.string().max(90_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'Deze foto kan niet worden gebruikt.')]).optional(),
      })
      .parse(req.body);
    const { rows } = await app.db.query(
      'UPDATE admin_users SET name = $2, avatar = COALESCE($3, avatar) WHERE id = $1 RETURNING email, name, avatar',
      [req.admin!.id, body.name, body.avatar ?? null],
    );
    return rows[0];
  });

  // Everyone can change their own password. Other sessions of that user are logged out.
  app.post('/me/password', async (req, reply) => {
    const body = z.object({ current: z.string().min(1), password }).parse(req.body);
    const { rows } = await app.db.query<{ password_hash: string }>('SELECT password_hash FROM admin_users WHERE id = $1', [req.admin!.id]);
    if (!(await verifyPassword(body.current, rows[0]!.password_hash))) {
      throw new HttpError(400, 'Je huidige wachtwoord klopt niet.', 'invalid_credentials');
    }
    await app.db.query('UPDATE admin_users SET password_hash = $2 WHERE id = $1', [req.admin!.id, await hashPassword(body.password)]);
    await app.db.query('DELETE FROM admin_sessions WHERE user_id = $1 AND token_hash <> $2', [req.admin!.id, req.admin!.tokenHash]);
    await app.db.query('DELETE FROM trusted_devices WHERE user_id = $1', [req.admin!.id]);
    return reply.status(204).send();
  });

  // Two-step login. Step 1: get a secret to scan with an authenticator app.
  // Forget every remembered device: the next login on each asks for the second step again.
  app.post('/me/devices/forget', async (req, reply) => {
    await app.db.query('DELETE FROM trusted_devices WHERE user_id = $1', [req.admin!.id]);
    return reply.status(204).send();
  });

  app.post('/me/2fa/setup', async (req) => {
    if (req.admin!.twoFactor) throw new HttpError(409, 'Tweestapsverificatie staat al aan.', 'already_enabled');
    const secret = generateSecret();
    await app.db.query('UPDATE admin_users SET totp_secret = $2 WHERE id = $1', [req.admin!.id, secret]);
    const url = otpauthUrl(secret, req.admin!.email, 'Gamer Xperience Admin');
    return { secret, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1 }) };
  });

  // Step 2: prove the app works with a code. From then on every login asks for one.
  app.post('/me/2fa/enable', async (req) => {
    const { code } = z.object({ code: z.string().trim().min(6).max(10) }).parse(req.body);
    const { rows } = await app.db.query<{ totp_secret: string | null; totp_enabled: boolean }>(
      'SELECT totp_secret, totp_enabled FROM admin_users WHERE id = $1',
      [req.admin!.id],
    );
    if (rows[0]!.totp_enabled) throw new HttpError(409, 'Tweestapsverificatie staat al aan.', 'already_enabled');
    const step = rows[0]!.totp_secret ? verifyCode(rows[0]!.totp_secret, code) : null;
    if (step === null) throw new HttpError(400, 'Deze code klopt niet. Controleer of de tijd op je telefoon goed staat en probeer de volgende code.', 'invalid_code');
    const recoveryCodes = generateRecoveryCodes();
    await app.db.query(
      'UPDATE admin_users SET totp_enabled = TRUE, totp_last_step = $2, recovery_codes = $3 WHERE id = $1',
      [req.admin!.id, step, recoveryCodes.map((c) => hashToken(c))],
    );
    // Shown once: only their hashes are kept.
    return { recoveryCodes };
  });

  app.post('/me/2fa/disable', async (req, reply) => {
    const { password: current } = z.object({ password: z.string().min(1) }).parse(req.body);
    const { rows } = await app.db.query<{ password_hash: string }>('SELECT password_hash FROM admin_users WHERE id = $1', [req.admin!.id]);
    if (!(await verifyPassword(current, rows[0]!.password_hash))) throw new HttpError(400, 'Je wachtwoord klopt niet.', 'invalid_credentials');
    await app.db.query("UPDATE admin_users SET totp_enabled = FALSE, totp_secret = NULL, recovery_codes = '{}' WHERE id = $1", [req.admin!.id]);
    await app.db.query('DELETE FROM trusted_devices WHERE user_id = $1', [req.admin!.id]);
    return reply.status(204).send();
  });

  // An owner can switch it off for someone who lost their phone; they set it up again themselves.
  app.post('/users/:id/2fa-reset', async (req, reply) => {
    requireOwner(req);
    const { id } = idParam.parse(req.params);
    const { rowCount } = await app.db.query(
      "UPDATE admin_users SET totp_enabled = FALSE, totp_secret = NULL, recovery_codes = '{}' WHERE id = $1",
      [id],
    );
    if (!rowCount) throw new HttpError(404, 'Gebruiker niet gevonden.', 'not_found');
    await app.db.query('DELETE FROM admin_sessions WHERE user_id = $1 AND user_id <> $2', [id, req.admin!.id]);
    await app.db.query('DELETE FROM trusted_devices WHERE user_id = $1', [id]);
    return reply.status(204).send();
  });

  // Notifications on this device. Owners get them for new requests, messages and payments.
  app.get('/push/key', async () => ({ publicKey: (await vapidKeys(app)).publicKey }));

  app.post('/push/subscribe', async (req, reply) => {
    const body = z
      .object({
        endpoint: z.url().max(1000),
        keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
        device: z.string().max(200).default(''),
      })
      .parse(req.body);
    await app.db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys, device) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys, device = EXCLUDED.device`,
      [req.admin!.id, body.endpoint, JSON.stringify(body.keys), body.device],
    );
    return reply.status(204).send();
  });

  app.post('/push/unsubscribe', async (req, reply) => {
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    await app.db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.admin!.id]);
    return reply.status(204).send();
  });

  app.post('/push/test', async (req) => ({
    sent: await notify(app, { title: 'Gamer Xperience', body: 'Meldingen werken op dit apparaat. 🎮', url: '#/board' }, req.admin!.id),
  }));

  // Where the demo is and how to get in, for the owner of the real site to pass on.
  app.get('/system/demo', async (req) => {
    requireOwner(req);
    const { DEMO_DOMAIN, DEMO_ADMIN_PASSWORD, DEMO_MODE } = app.config;
    if (DEMO_MODE || !DEMO_DOMAIN || !DEMO_ADMIN_PASSWORD) return { available: false };
    return { available: true, url: `https://${DEMO_DOMAIN}`, login: 'demo@gamerxp.nl', password: DEMO_ADMIN_PASSWORD };
  });

  // A test for everyone who works here: an e-mail to each login address and a notification to
  // every device of an owner. Shows at once whether mail and notifications really arrive.
  app.post('/system/test', async (req) => {
    requireOwner(req);
    const by = req.admin!.name || req.admin!.email;
    const when = new Date().toLocaleString('nl-NL', { timeZone: app.config.TIMEZONE, dateStyle: 'long', timeStyle: 'short' });
    const { rows: users } = await app.db.query<{ email: string }>('SELECT email FROM admin_users ORDER BY id');
    const mailed: string[] = [];
    const failed: string[] = [];
    for (const user of users) {
      try {
        await app.mailer.send({
          to: user.email,
          subject: 'Testbericht van de Gamer Xperience admin',
          text: `Dit is een testbericht, verstuurd door ${by} op ${when}.\n\nKomt deze mail aan, dan werkt het versturen van e-mail vanuit de site.\n\n${app.config.PUBLIC_URL}/admin/`,
        });
        mailed.push(user.email);
      } catch (err) {
        req.log.warn({ err }, 'Test email failed');
        failed.push(user.email);
      }
    }
    const devices = (await app.db.query("SELECT 1 FROM push_subscriptions s JOIN admin_users u ON u.id = s.user_id WHERE u.role = 'owner'")).rowCount ?? 0;
    const pushed = await notify(app, { title: 'Testmelding', body: `Verstuurd door ${by}. Meldingen werken. 🎮`, url: '#/system' });
    return { mailed, failed, devices, pushed };
  });

  app.get('/users', async (req) => {
    requireOwner(req);
    return (await app.db.query(`SELECT ${COLUMNS} FROM admin_users ORDER BY role DESC, email`)).rows;
  });

  app.post('/users', async (req, reply) => {
    requireOwner(req);
    const body = z
      .object({ email: z.email('Vul een geldig e-mailadres in.').trim().toLowerCase(), name: z.string().trim().max(100).default(''), role, password })
      .parse(req.body);
    const { rows } = await app.db.query(
      `INSERT INTO admin_users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING RETURNING ${COLUMNS}`,
      [body.email, body.name, body.role, await hashPassword(body.password)],
    );
    if (!rows[0]) throw new HttpError(409, 'Er bestaat al een gebruiker met dit e-mailadres.', 'conflict');
    return reply.status(201).send(rows[0]);
  });

  // There must always be an owner left who can manage the rest.
  async function assertOwnerRemains(exceptId: number) {
    const { rows } = await app.db.query("SELECT 1 FROM admin_users WHERE role = 'owner' AND id <> $1 LIMIT 1", [exceptId]);
    if (!rows[0]) throw new HttpError(409, 'Er moet minstens één eigenaar overblijven.', 'last_owner');
  }

  app.patch('/users/:id', async (req) => {
    requireOwner(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ name: z.string().trim().max(100).optional(), role: role.optional(), password: password.optional() }).parse(req.body);
    if (body.role === 'assistant') await assertOwnerRemains(id);
    const { rows } = await app.db.query(
      `UPDATE admin_users SET name = COALESCE($2, name), role = COALESCE($3, role), password_hash = COALESCE($4, password_hash)
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, body.name ?? null, body.role ?? null, body.password ? await hashPassword(body.password) : null],
    );
    if (!rows[0]) throw new HttpError(404, 'Gebruiker niet gevonden.', 'not_found');
    // A new password or role takes effect right away: the user has to log in again.
    if ((body.password || body.role) && id !== req.admin!.id) await app.db.query('DELETE FROM admin_sessions WHERE user_id = $1', [id]);
    if (body.password) await app.db.query('DELETE FROM trusted_devices WHERE user_id = $1', [id]);
    return rows[0];
  });

  app.delete('/users/:id', async (req, reply) => {
    requireOwner(req);
    const { id } = idParam.parse(req.params);
    if (id === req.admin!.id) throw new HttpError(409, 'Je kunt jezelf niet verwijderen.', 'self');
    await assertOwnerRemains(id);
    const { rowCount } = await app.db.query('DELETE FROM admin_users WHERE id = $1', [id]);
    if (!rowCount) throw new HttpError(404, 'Gebruiker niet gevonden.', 'not_found');
    return reply.status(204).send();
  });
};
