import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { dateString } from '../../lib/schemas.js';

const COLUMNS = `id, code, percent, valid_from::text AS "validFrom", valid_until::text AS "validUntil", active, note,
  (SELECT count(*)::int FROM bookings b WHERE upper(b.discount_code) = upper(discount_codes.code) AND b.status <> 'cancelled') AS used`;
const idParam = z.object({ id: z.coerce.number().int().positive() });
const optionalDate = z.union([dateString, z.literal('')]).nullable().default(null).transform((v) => v || null);
const code = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,40}$/, 'Gebruik 3 tot 40 letters, cijfers of streepjes, zonder spaties.'),
  percent: z.coerce.number().int().min(1, 'Minimaal 1%.').max(100, 'Maximaal 100%.'),
  validFrom: optionalDate,
  validUntil: optionalDate,
  active: z.boolean().default(true),
  note: z.string().trim().max(200).default(''),
});

// Discount codes: a percentage off the package price for parties within a period.
export const discountRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    if (req.admin?.role !== 'owner') throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
  });

  app.get('/discount-codes', async () => (await app.db.query(`SELECT ${COLUMNS} FROM discount_codes ORDER BY active DESC, id DESC`)).rows);

  app.post('/discount-codes', async (req, reply) => {
    const c = code.parse(req.body);
    const exists = await app.db.query('SELECT 1 FROM discount_codes WHERE upper(code) = $1', [c.code]);
    if (exists.rowCount) throw new HttpError(409, `De code ${c.code} bestaat al.`, 'exists');
    const { rows } = await app.db.query(
      `INSERT INTO discount_codes (code, percent, valid_from, valid_until, active, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [c.code, c.percent, c.validFrom, c.validUntil, c.active, c.note],
    );
    return reply.status(201).send(rows[0]);
  });

  app.patch('/discount-codes/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const c = code.omit({ code: true }).parse(req.body);
    const { rows } = await app.db.query(
      `UPDATE discount_codes SET percent = $2, valid_from = $3, valid_until = $4, active = $5, note = $6 WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, c.percent, c.validFrom, c.validUntil, c.active, c.note],
    );
    if (!rows[0]) throw new HttpError(404, 'Deze code bestaat niet (meer).', 'not_found');
    return rows[0];
  });

  app.delete('/discount-codes/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await app.db.query('DELETE FROM discount_codes WHERE id = $1', [id]);
    return reply.status(204).send();
  });
};
