import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { addDays } from '../../lib/dates.js';
import { HttpError } from '../../lib/errors.js';
import { dateString, timeString } from '../../lib/schemas.js';
import {
  getAvailability,
  getSettings,
  getTimeSlots,
  getWeeklySchedule,
  saveSettings,
  SLOT_KEYS,
} from '../../services/availability.js';

const slotKey = z.enum(SLOT_KEYS);
const slotFlags = z.object({ ochtend: z.boolean(), middag: z.boolean(), avond: z.boolean() });

const availabilityInput = z.object({
  settings: z.object({
    slotCapacity: z.number().int().min(1).max(10),
    dailyCapacity: z.number().int().min(1).max(10),
    minLeadDays: z.number().int().min(0).max(60),
    maxAdvanceDays: z.number().int().min(7).max(730),
  }),
  slots: z
    .array(z.object({ key: slotKey, start: timeString, end: timeString }))
    .refine((slots) => slots.every((s) => s.start < s.end), 'Eindtijd moet na de begintijd liggen.'),
  weekly: z.record(z.enum(['1', '2', '3', '4', '5', '6', '7']), slotFlags),
});

export const availabilityRoutes: FastifyPluginAsync = async (app) => {
  app.get('/availability', async () => ({
    settings: await getSettings(app.db),
    slots: await getTimeSlots(app.db),
    weekly: await getWeeklySchedule(app.db),
  }));

  app.put('/availability', async (req) => {
    const input = availabilityInput.parse(req.body);
    const client = await app.db.connect();
    try {
      await client.query('BEGIN');
      await saveSettings(client, input.settings);
      for (const s of input.slots) {
        await client.query('UPDATE time_slots SET start_time = $2, end_time = $3 WHERE key = $1', [s.key, s.start, s.end]);
      }
      for (const [weekday, flags] of Object.entries(input.weekly)) {
        for (const slot of SLOT_KEYS) {
          await client.query(
            `INSERT INTO weekly_availability (weekday, slot, open) VALUES ($1, $2, $3)
             ON CONFLICT (weekday, slot) DO UPDATE SET open = EXCLUDED.open`,
            [Number(weekday), slot, flags[slot]],
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return {
      settings: await getSettings(app.db),
      slots: await getTimeSlots(app.db),
      weekly: await getWeeklySchedule(app.db),
    };
  });

  // Exceptions for one slot on one date (open an extra slot, or close one).
  app.get('/availability/overrides', async () => {
    const { rows } = await app.db.query(
      `SELECT date, slot, open, reason FROM slot_overrides WHERE date >= CURRENT_DATE ORDER BY date, slot`,
    );
    return rows;
  });

  app.put('/availability/overrides/:date/:slot', async (req) => {
    const { date, slot } = z.object({ date: dateString, slot: slotKey }).parse(req.params);
    const { open, reason } = z.object({ open: z.boolean(), reason: z.string().max(200).default('') }).parse(req.body);
    await app.db.query(
      `INSERT INTO slot_overrides (date, slot, open, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (date, slot) DO UPDATE SET open = EXCLUDED.open, reason = EXCLUDED.reason`,
      [date, slot, open, reason],
    );
    return { date, slot, open, reason };
  });

  app.delete('/availability/overrides/:date/:slot', async (req, reply) => {
    const { date, slot } = z.object({ date: dateString, slot: slotKey }).parse(req.params);
    await app.db.query('DELETE FROM slot_overrides WHERE date = $1 AND slot = $2', [date, slot]);
    return reply.status(204).send();
  });

  // Month overview: per day the slots (open, booked, available) and the bookings in them.
  app.get('/calendar', async (req) => {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Gebruik JJJJ-MM.') }).parse(req.query);
    const from = `${month}-01`;
    const next = new Date(`${from}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const to = addDays(next.toISOString().slice(0, 10), -1);
    if (Number.isNaN(next.getTime())) throw new HttpError(400, 'Ongeldige maand.');

    const [days, bookings] = await Promise.all([
      getAvailability(app.db, app.config, from, to),
      app.db.query<{ partyDate: string }>(
        `SELECT b.id, b.reference, b.party_date AS "partyDate", b.time_slot AS "timeSlot",
                to_char(b.start_time, 'HH24:MI') AS "startTime", b.status, b.parent_name AS "parentName",
                b.child_name AS "childName", b.city, p.name AS "packageName"
           FROM bookings b JOIN packages p ON p.id = b.package_id
          WHERE b.party_date BETWEEN $1 AND $2 AND b.status <> 'cancelled'
          ORDER BY b.party_date, array_position(ARRAY['ochtend', 'middag', 'avond'], b.time_slot)`,
        [from, to],
      ),
    ]);
    return {
      month,
      slots: await getTimeSlots(app.db),
      days: days.map((d) => ({ ...d, bookings: bookings.rows.filter((b) => b.partyDate === d.date) })),
    };
  });
};
