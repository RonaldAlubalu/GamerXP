import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../lib/auth.js';
import { HttpError } from '../../lib/errors.js';
import { notify, vapidKeys } from '../../services/push.js';

export type Role = 'owner' | 'assistant';

// What an assistant may do: look at bookings and the calendar, and change the availability.
const ASSISTANT_READ = [/^\/me$/, /^\/push\/key$/, /^\/stages$/, /^\/overview$/, /^\/pipeline$/, /^\/bookings(\/[^/]+)?$/, /^\/calendar$/, /^\/packages$/, /^\/availability(\/|$)/, /^\/blocked-dates(\/|$)/];
const ASSISTANT_WRITE = [/^\/logout$/, /^\/me\/password$/, /^\/push\//, /^\/availability(\/|$)/, /^\/blocked-dates(\/|$)/];

export function assistantMayCall(method: string, path: string): boolean {
  return (method === 'GET' ? ASSISTANT_READ : ASSISTANT_WRITE).some((allowed) => allowed.test(path));
}

const password = z.string().min(12, 'Het wachtwoord moet minimaal 12 tekens zijn.').max(200);
const role = z.enum(['owner', 'assistant']);
const idParam = z.object({ id: z.coerce.number().int().positive() });
const COLUMNS = 'id, email, name, role, created_at AS "createdAt"';

function requireOwner(req: FastifyRequest) {
  if (req.admin?.role !== 'owner') throw new HttpError(403, 'Alleen een eigenaar kan gebruikers beheren.', 'forbidden');
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  // Everyone can change their own password. Other sessions of that user are logged out.
  app.post('/me/password', async (req, reply) => {
    const body = z.object({ current: z.string().min(1), password }).parse(req.body);
    const { rows } = await app.db.query<{ password_hash: string }>('SELECT password_hash FROM admin_users WHERE id = $1', [req.admin!.id]);
    if (!(await verifyPassword(body.current, rows[0]!.password_hash))) {
      throw new HttpError(400, 'Je huidige wachtwoord klopt niet.', 'invalid_credentials');
    }
    await app.db.query('UPDATE admin_users SET password_hash = $2 WHERE id = $1', [req.admin!.id, await hashPassword(body.password)]);
    await app.db.query('DELETE FROM admin_sessions WHERE user_id = $1 AND token_hash <> $2', [req.admin!.id, req.admin!.tokenHash]);
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
