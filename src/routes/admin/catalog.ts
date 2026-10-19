import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { dateString } from '../../lib/schemas.js';

const PACKAGE_COLUMNS = `
  id, slug, name, description, max_players AS "maxPlayers", duration_hours AS "durationHours",
  price_cents AS "priceCents", active, sort_order AS "sortOrder"`;

const packageInput = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug mag alleen kleine letters, cijfers en - bevatten.').max(50),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(5000).default(''),
  maxPlayers: z.number().int().positive(),
  durationHours: z.number().positive().max(24),
  priceCents: z.number().int().min(0),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  // Packages -----------------------------------------------------------------
  app.get('/packages', async () => {
    const { rows } = await app.db.query(`SELECT ${PACKAGE_COLUMNS} FROM packages ORDER BY sort_order, id`);
    return rows;
  });

  app.post('/packages', async (req, reply) => {
    const p = packageInput.parse(req.body);
    const { rows } = await app.db.query(
      `INSERT INTO packages (slug, name, description, max_players, duration_hours, price_cents, active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PACKAGE_COLUMNS}`,
      [p.slug, p.name, p.description, p.maxPlayers, p.durationHours, p.priceCents, p.active, p.sortOrder],
    );
    return reply.status(201).send(rows[0]);
  });

  // Packages are never deleted (bookings refer to them); set active=false instead.
  app.patch('/packages/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const p = packageInput.partial().parse(req.body);
    const { rows } = await app.db.query(
      `UPDATE packages SET
         slug = COALESCE($2, slug), name = COALESCE($3, name), description = COALESCE($4, description),
         max_players = COALESCE($5, max_players), duration_hours = COALESCE($6, duration_hours),
         price_cents = COALESCE($7, price_cents), active = COALESCE($8, active),
         sort_order = COALESCE($9, sort_order), updated_at = now()
       WHERE id = $1 RETURNING ${PACKAGE_COLUMNS}`,
      [
        id, p.slug ?? null, p.name ?? null, p.description ?? null, p.maxPlayers ?? null,
        p.durationHours ?? null, p.priceCents ?? null, p.active ?? null, p.sortOrder ?? null,
      ],
    );
    if (!rows[0]) throw new HttpError(404, 'Pakket niet gevonden.', 'not_found');
    return rows[0];
  });

  // Blocked dates ------------------------------------------------------------
  app.get('/blocked-dates', async () => {
    const { rows } = await app.db.query('SELECT date, reason FROM blocked_dates WHERE date >= CURRENT_DATE ORDER BY date');
    return rows;
  });

  app.put('/blocked-dates/:date', async (req) => {
    const { date } = z.object({ date: dateString }).parse(req.params);
    const { reason } = z.object({ reason: z.string().max(200).default('') }).parse(req.body ?? {});
    await app.db.query(
      'INSERT INTO blocked_dates (date, reason) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET reason = $2',
      [date, reason],
    );
    return { date, reason };
  });

  app.delete('/blocked-dates/:date', async (req, reply) => {
    const { date } = z.object({ date: dateString }).parse(req.params);
    await app.db.query('DELETE FROM blocked_dates WHERE date = $1', [date]);
    return reply.status(204).send();
  });

  // Contact messages ---------------------------------------------------------
  app.get('/messages', async () => {
    const { rows } = await app.db.query(
      'SELECT id, name, email, phone, message, handled, created_at AS "createdAt" FROM contact_messages ORDER BY created_at DESC LIMIT 200',
    );
    return rows;
  });

  app.patch('/messages/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { handled } = z.object({ handled: z.boolean() }).parse(req.body);
    const { rowCount } = await app.db.query('UPDATE contact_messages SET handled = $2 WHERE id = $1', [id, handled]);
    if (!rowCount) throw new HttpError(404, 'Bericht niet gevonden.', 'not_found');
    return { id, handled };
  });
};
