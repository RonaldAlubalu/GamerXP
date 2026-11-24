import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { dateString } from '../../lib/schemas.js';

const short = z.string().trim().max(200).default('');

// Per kind, the extra fields an item can have. Unknown fields are dropped.
const details = z
  .object({
    // station
    consoleSerial: short, controllerSerial: short, accountEmail: short, gamertag: short, epicName: short,
    otherAccounts: short, homeConsole: short, gamePass: z.boolean().default(false), gamePassNote: short,
    // game
    source: z.enum(['', 'free', 'gamepass', 'bought', 'gamepass_or_bought']).default(''),
    // other gear
    category: short, serial: short,
    // subscription
    period: z.enum(['', 'month', 'year', 'once']).default(''), autoRenew: z.boolean().default(false), provider: short,
  })
  .partial();

const item = z.object({
  kind: z.enum(['station', 'game', 'other', 'subscription']),
  name: z.string().trim().min(1, 'Vul een naam in.').max(200),
  quantity: z.coerce.number().int().min(0).max(100000).default(1),
  status: z.enum(['in_use', 'spare', 'broken', 'gone']).default('in_use'),
  priceCents: z.number().int().min(0).nullable().default(null),
  details: details.default({}),
  notes: z.string().trim().max(2000).default(''),
  expiresOn: z.union([dateString, z.literal('')]).nullable().default(null).transform((v) => v || null),
});

const COLUMNS = `id, kind, name, quantity, status, price_cents AS "priceCents", details, notes, expires_on::text AS "expiresOn", updated_at AS "updatedAt"`;
const idParam = z.object({ id: z.coerce.number().int().positive() });
const bookingParam = z.object({ id: z.uuid() });

// Looks like a password field: refused, so secrets don't end up in the inventory by accident.
const SECRET_KEY = /password|passwd|wachtwoord|^ww$|pwd|secret|token/i;

export const inventoryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    if (req.admin?.role !== 'owner') throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
  });

  app.get('/inventory', async () => {
    const { rows } = await app.db.query(`SELECT ${COLUMNS} FROM inventory_items ORDER BY kind, length(name), name, id`);
    return rows;
  });

  app.post('/inventory', async (req, reply) => {
    const i = item.parse(req.body);
    const { rows } = await app.db.query(
      `INSERT INTO inventory_items (kind, name, quantity, status, price_cents, details, notes, expires_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [i.kind, i.name, i.quantity, i.status, i.priceCents, JSON.stringify(i.details), i.notes, i.expiresOn],
    );
    return reply.status(201).send(rows[0]);
  });

  app.patch('/inventory/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const i = item.parse(req.body);
    const { rows } = await app.db.query(
      // A new end date means new notices.
      `UPDATE inventory_items SET kind = $2, name = $3, quantity = $4, status = $5, price_cents = $6, details = $7, notes = $8,
              expiry_notice = CASE WHEN expires_on IS DISTINCT FROM $9::date THEN 0 ELSE expiry_notice END, expires_on = $9, updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, i.kind, i.name, i.quantity, i.status, i.priceCents, JSON.stringify(i.details), i.notes, i.expiresOn],
    );
    if (!rows[0]) throw new HttpError(404, 'Dit item bestaat niet (meer).', 'not_found');
    return rows[0];
  });

  app.delete('/inventory/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await app.db.query('DELETE FROM inventory_items WHERE id = $1', [id]);
    return reply.status(204).send();
  });

  // Where an item has been: the parties it was assigned to, newest first.
  app.get('/inventory/:id/history', async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT b.id, b.reference, b.party_date::text AS "partyDate", b.time_slot AS "timeSlot", b.parent_name AS "parentName", b.city, b.status
         FROM booking_inventory bi JOIN bookings b ON b.id = bi.booking_id
        WHERE bi.item_id = $1 ORDER BY b.party_date DESC, b.id`,
      [id],
    );
    return rows;
  });

  // The gear of one party: every item that can go along, whether it is assigned to this party,
  // and whether another party on the same day already has it.
  app.get('/bookings/:id/inventory', async (req) => {
    const { id } = bookingParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT i.id, i.kind, i.name, i.status, i.quantity,
              EXISTS (SELECT 1 FROM booking_inventory bi WHERE bi.item_id = i.id AND bi.booking_id = $1) AS assigned,
              (SELECT string_agg(o.reference || ' (' || o.time_slot || ')', ', ')
                 FROM booking_inventory bi JOIN bookings o ON o.id = bi.booking_id
                WHERE bi.item_id = i.id AND o.id <> $1 AND o.status <> 'cancelled'
                  AND o.party_date = (SELECT party_date FROM bookings WHERE id = $1)) AS "alsoAt"
         FROM inventory_items i
        WHERE i.kind IN ('station', 'other') AND (i.status IN ('in_use', 'spare') OR EXISTS (SELECT 1 FROM booking_inventory bi WHERE bi.item_id = i.id AND bi.booking_id = $1))
        ORDER BY i.kind DESC, length(i.name), i.name`,
      [id],
    );
    return rows;
  });

  app.put('/bookings/:id/inventory', async (req) => {
    const { id } = bookingParam.parse(req.params);
    const { itemIds } = z.object({ itemIds: z.array(z.coerce.number().int().positive()).max(500) }).parse(req.body);
    const client = await app.db.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT 1 FROM bookings WHERE id = $1', [id]);
      if (!exists.rowCount) throw new HttpError(404, 'Deze boeking bestaat niet (meer).', 'not_found');
      await client.query('DELETE FROM booking_inventory WHERE booking_id = $1', [id]);
      if (itemIds.length) {
        await client.query(
          `INSERT INTO booking_inventory (booking_id, item_id)
           SELECT $1, i.id FROM inventory_items i WHERE i.id = ANY($2::bigint[]) ON CONFLICT DO NOTHING`,
          [id, itemIds],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { assigned: itemIds.length };
  });

  // Adds a list of items in one go (a file exported from a spreadsheet). An item whose kind and
  // name already exist is updated instead of added twice.
  app.post('/inventory/import', async (req) => {
    const body = z.object({ items: z.array(z.unknown()).min(1).max(500) }).parse(req.body);
    for (const raw of body.items) {
      const keys = Object.keys((raw as { details?: object })?.details ?? {}).concat(Object.keys((raw as object) ?? {}));
      if (keys.some((k) => SECRET_KEY.test(k))) {
        throw new HttpError(400, 'Dit bestand bevat wachtwoorden. Die horen niet in de inventaris; haal ze eruit en probeer opnieuw.', 'secrets_in_import');
      }
    }
    const items = body.items.map((raw) => item.parse(raw));
    let added = 0;
    let updated = 0;
    const client = await app.db.connect();
    try {
      await client.query('BEGIN');
      for (const i of items) {
        const values = [i.kind, i.name, i.quantity, i.status, i.priceCents, JSON.stringify(i.details), i.notes, i.expiresOn];
        const existing = await client.query(
          `UPDATE inventory_items SET quantity = $3, status = $4, price_cents = $5, details = $6, notes = $7,
                  expiry_notice = CASE WHEN expires_on IS DISTINCT FROM $8::date THEN 0 ELSE expiry_notice END, expires_on = $8, updated_at = now()
            WHERE kind = $1 AND lower(name) = lower($2)`,
          values,
        );
        if (existing.rowCount) {
          updated++;
          continue;
        }
        await client.query(
          `INSERT INTO inventory_items (kind, name, quantity, status, price_cents, details, notes, expires_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          values,
        );
        added++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { added, updated };
  });
};
