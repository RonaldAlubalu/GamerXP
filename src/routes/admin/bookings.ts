import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { addDays, today } from '../../lib/dates.js';
import { formatEuro, statusChangeMail } from '../../lib/emails.js';
import { HttpError } from '../../lib/errors.js';
import { bookingStatus, dateString, TIME_SLOTS, timeString } from '../../lib/schemas.js';
import { getBookingMailData } from '../../services/bookings.js';
import { addEvent, createDefaultTasks, STAGE_INFO, STATUSES, type Status } from '../../services/pipeline.js';

const BOOKING_COLUMNS = `
  b.id, b.reference, b.package_id AS "packageId", p.name AS "packageName",
  b.party_date AS "partyDate", b.time_slot AS "timeSlot", to_char(b.start_time, 'HH24:MI') AS "startTime",
  b.extra_stations AS "extraStations",
  b.parent_name AS "parentName", b.email, b.phone, b.street, b.postal_code AS "postalCode", b.city,
  b.child_name AS "childName", b.child_age AS "childAge", b.guest_count AS "guestCount",
  b.notes, b.status, b.admin_notes AS "adminNotes",
  b.price_cents AS "priceCents", b.deposit_cents AS "depositCents", b.paid_cents AS "paidCents",
  b.status_token AS "statusToken", b.created_at AS "createdAt", b.updated_at AS "updatedAt",
  (SELECT count(*) FILTER (WHERE t.done) FROM booking_tasks t WHERE t.booking_id = b.id)::int AS "tasksDone",
  (SELECT count(*) FROM booking_tasks t WHERE t.booking_id = b.id)::int AS "tasksTotal"`;

const FROM_BOOKINGS = 'FROM bookings b JOIN packages p ON p.id = b.package_id';

const idParam = z.object({ id: z.uuid('Ongeldig boekings-ID.') });
const taskParams = idParam.extend({ taskId: z.coerce.number().int().positive() });

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  const actor = (req: { admin?: { email: string } }) => req.admin?.email ?? 'admin';

  async function loadBooking(id: string) {
    const { rows } = await app.db.query(`SELECT ${BOOKING_COLUMNS} ${FROM_BOOKINGS} WHERE b.id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');
    return rows[0];
  }

  async function assertExists(id: string) {
    const { rowCount } = await app.db.query('SELECT 1 FROM bookings WHERE id = $1', [id]);
    if (!rowCount) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');
  }

  app.get('/stages', async () => STATUSES.map((key) => ({ key, label: STAGE_INFO[key].label })));

  // Board view: every open booking, plus recently finished or cancelled ones.
  app.get('/pipeline', async () => {
    const recent = addDays(today(app.config.TIMEZONE), -30);
    const { rows } = await app.db.query<{ status: Status }>(
      `SELECT ${BOOKING_COLUMNS} ${FROM_BOOKINGS}
        WHERE b.status NOT IN ('completed', 'cancelled') OR b.party_date >= $1 OR b.updated_at >= $1
        ORDER BY b.party_date, array_position(ARRAY['ochtend', 'middag', 'avond'], b.time_slot), b.start_time`,
      [recent],
    );
    return STATUSES.map((key) => ({
      key,
      label: STAGE_INFO[key].label,
      bookings: rows.filter((b) => b.status === key),
    }));
  });

  app.get('/bookings', async (req) => {
    const q = z
      .object({
        status: bookingStatus.optional(),
        from: dateString.optional(),
        to: dateString.optional(),
        q: z.string().trim().max(100).optional(),
      })
      .parse(req.query);
    const { rows } = await app.db.query(
      `SELECT ${BOOKING_COLUMNS} ${FROM_BOOKINGS}
        WHERE ($1::text IS NULL OR b.status = $1)
          AND ($2::date IS NULL OR b.party_date >= $2)
          AND ($3::date IS NULL OR b.party_date <= $3)
          AND ($4::text IS NULL OR concat_ws(' ', b.reference, b.parent_name, b.child_name, b.email, b.city) ILIKE '%' || $4 || '%')
        ORDER BY b.party_date, array_position(ARRAY['ochtend', 'middag', 'avond'], b.time_slot), b.start_time`,
      [q.status ?? null, q.from ?? null, q.to ?? null, q.q || null],
    );
    return rows;
  });

  app.get('/bookings/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    let booking = await loadBooking(id);
    // Bookings made before the pipeline existed get their checklist on first view.
    if (booking.tasksTotal === 0) {
      await createDefaultTasks(app.db, id);
      booking = await loadBooking(id);
    }

    const [tasks, events] = await Promise.all([
      app.db.query(
        `SELECT id, stage, label, done, done_at AS "doneAt" FROM booking_tasks
          WHERE booking_id = $1 ORDER BY sort_order, id`,
        [id],
      ),
      app.db.query(
        `SELECT id, type, from_status AS "fromStatus", to_status AS "toStatus", message, actor, created_at AS "createdAt"
           FROM booking_events WHERE booking_id = $1 ORDER BY created_at DESC, id DESC`,
        [id],
      ),
    ]);
    return { ...booking, tasks: tasks.rows, events: events.rows };
  });

  app.patch('/bookings/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        status: bookingStatus.optional(),
        adminNotes: z.string().max(5000).optional(),
        partyDate: dateString.optional(),
        timeSlot: z.enum(TIME_SLOTS).optional(),
        // The exact start time is agreed with the parent; null clears it.
        startTime: timeString.nullable().optional(),
        extraStations: z.number().int().min(0).max(2).optional(),
        priceCents: z.number().int().min(0).optional(),
        depositCents: z.number().int().min(0).optional(),
        paidCents: z.number().int().min(0).optional(),
        // Set to false to change the status without emailing the parent.
        notifyCustomer: z.boolean().default(true),
      })
      .parse(req.body);

    const before = await loadBooking(id);
    const by = actor(req);

    await app.db.query(
      `UPDATE bookings SET
         status        = COALESCE($2, status),
         admin_notes   = COALESCE($3, admin_notes),
         party_date    = COALESCE($4, party_date),
         start_time    = CASE WHEN $5 THEN $6::time ELSE start_time END,
         price_cents   = COALESCE($7, price_cents),
         deposit_cents = COALESCE($8, deposit_cents),
         paid_cents    = COALESCE($9, paid_cents),
         time_slot     = COALESCE($10, time_slot),
         extra_stations = COALESCE($11, extra_stations),
         updated_at    = now()
       WHERE id = $1`,
      [
        id, body.status ?? null, body.adminNotes ?? null, body.partyDate ?? null,
        body.startTime !== undefined, body.startTime ?? null,
        body.priceCents ?? null, body.depositCents ?? null, body.paidCents ?? null,
        body.timeSlot ?? null, body.extraStations ?? null,
      ],
    );

    // Record what changed on the timeline.
    const changes: string[] = [];
    if (body.partyDate && body.partyDate !== before.partyDate) changes.push(`Datum: ${before.partyDate} → ${body.partyDate}`);
    if (body.startTime !== undefined && body.startTime !== before.startTime) {
      changes.push(`Starttijd: ${before.startTime ?? '–'} → ${body.startTime ?? '–'}`);
    }
    if (body.timeSlot && body.timeSlot !== before.timeSlot) changes.push(`Tijdslot: ${before.timeSlot} → ${body.timeSlot}`);
    if (body.extraStations !== undefined && body.extraStations !== before.extraStations) {
      changes.push(`Extra gamestations: ${before.extraStations} → ${body.extraStations}`);
    }
    for (const [key, label] of [['priceCents', 'Prijs'], ['depositCents', 'Aanbetaling'], ['paidCents', 'Betaald']] as const) {
      const value = body[key];
      if (value !== undefined && value !== before[key]) changes.push(`${label}: ${formatEuro(before[key])} → ${formatEuro(value)}`);
    }
    if (changes.length) await addEvent(app.db, id, { type: 'update', message: changes.join('\n'), actor: by });

    if (body.status && body.status !== before.status) {
      await addEvent(app.db, id, { type: 'status', fromStatus: before.status, toStatus: body.status, actor: by });
      const mail = body.notifyCustomer
        ? statusChangeMail(body.status, (await getBookingMailData(app.db, id))!, {
            publicUrl: app.config.PUBLIC_URL,
            paymentInfo: app.config.PAYMENT_INFO,
          })
        : undefined;
      if (mail) {
        try {
          await app.mailer.send(mail);
          await addEvent(app.db, id, { type: 'email', message: `E-mail verstuurd: ${mail.subject}`, actor: by });
        } catch (err) {
          req.log.error({ err }, 'Failed to send status email');
          await addEvent(app.db, id, { type: 'email', message: `E-mail versturen MISLUKT: ${mail.subject}`, actor: by });
        }
      }
    }

    return loadBooking(id);
  });

  app.post('/bookings/:id/notes', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { message } = z.object({ message: z.string().trim().min(1, 'Notitie is leeg.').max(5000) }).parse(req.body);
    await assertExists(id);
    await addEvent(app.db, id, { type: 'note', message, actor: actor(req) });
    return reply.status(201).send({ ok: true });
  });

  app.post('/bookings/:id/tasks', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { stage, label } = z
      .object({ stage: bookingStatus, label: z.string().trim().min(1).max(200) })
      .parse(req.body);
    await assertExists(id);
    const { rows } = await app.db.query(
      `INSERT INTO booking_tasks (booking_id, stage, label, sort_order)
       VALUES ($1, $2, $3, (SELECT coalesce(max(sort_order), 0) + 1 FROM booking_tasks WHERE booking_id = $1))
       RETURNING id, stage, label, done, done_at AS "doneAt"`,
      [id, stage, label],
    );
    return reply.status(201).send(rows[0]);
  });

  app.patch('/bookings/:id/tasks/:taskId', async (req) => {
    const { id, taskId } = taskParams.parse(req.params);
    const { done } = z.object({ done: z.boolean() }).parse(req.body);
    const { rows } = await app.db.query<{ label: string }>(
      `UPDATE booking_tasks SET done = $3, done_at = CASE WHEN $3 THEN now() END
        WHERE id = $2 AND booking_id = $1
        RETURNING id, stage, label, done, done_at AS "doneAt"`,
      [id, taskId, done],
    );
    if (!rows[0]) throw new HttpError(404, 'Taak niet gevonden.', 'not_found');
    await addEvent(app.db, id, {
      type: 'task',
      message: `${done ? '✓' : '✗'} ${rows[0].label}`,
      actor: actor(req),
    });
    return rows[0];
  });

  app.delete('/bookings/:id/tasks/:taskId', async (req, reply) => {
    const { id, taskId } = taskParams.parse(req.params);
    await app.db.query('DELETE FROM booking_tasks WHERE id = $2 AND booking_id = $1', [id, taskId]);
    return reply.status(204).send();
  });
};
