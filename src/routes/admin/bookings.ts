import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { addDays, today } from '../../lib/dates.js';
import { formatEuro, reviewRequestMail, statusChangeMail, withSignature } from '../../lib/emails.js';
import { HttpError } from '../../lib/errors.js';
import { bookingStatus, dateString, TIME_SLOTS, timeString } from '../../lib/schemas.js';
import { getBookingMailData, recalculatePaid, recalculatePrice } from '../../services/bookings.js';
import { logCommunication, sendAndLog } from '../../services/communications.js';
import { addEvent, createDefaultTasks, STAGE_INFO, STATUSES, type Status } from '../../services/pipeline.js';
import { calculatePrice, type PriceExtra } from '../../services/pricing.js';

const BOOKING_COLUMNS = `
  b.id, b.reference, b.package_id AS "packageId", p.name AS "packageName",
  b.party_date AS "partyDate", b.time_slot AS "timeSlot", to_char(b.start_time, 'HH24:MI') AS "startTime",
  b.extra_stations AS "extraStations",
  b.parent_name AS "parentName", b.email, b.phone, b.street, b.postal_code AS "postalCode", b.city,
  b.child_name AS "childName", b.child_age AS "childAge", b.guest_count AS "guestCount",
  b.notes, b.status, b.admin_notes AS "adminNotes", b.waiting_on AS "waitingOn",
  b.package_price_cents AS "packagePriceCents", b.travel_km::float AS "travelKm",
  b.evening_surcharge AS "eveningSurcharge", b.price_extras AS "priceExtras",
  b.price_cents AS "priceCents", b.deposit_cents AS "depositCents", b.paid_cents AS "paidCents",
  (b.deposit_cents > 0 AND b.paid_cents >= b.deposit_cents) AS "depositPaid",
  greatest(b.price_cents - b.paid_cents, 0) AS "outstandingCents",
  coalesce((SELECT sum(CASE WHEN pay.kind = 'security_deposit' THEN pay.amount_cents ELSE -pay.amount_cents END)
              FROM payments pay WHERE pay.booking_id = b.id
               AND pay.kind IN ('security_deposit', 'security_deposit_returned')), 0)::int AS "securityDepositHeldCents",
  b.review_status AS "reviewStatus", b.review_requested_at AS "reviewRequestedAt",
  b.status_token AS "statusToken", b.created_at AS "createdAt", b.updated_at AS "updatedAt",
  (SELECT max(c.created_at) FROM communications c WHERE c.booking_id = b.id) AS "lastMessageAt",
  (SELECT count(*) FILTER (WHERE t.done) FROM booking_tasks t WHERE t.booking_id = b.id)::int AS "tasksDone",
  (SELECT count(*) FROM booking_tasks t WHERE t.booking_id = b.id)::int AS "tasksTotal"`;

const FROM_BOOKINGS = 'FROM bookings b JOIN packages p ON p.id = b.package_id';
const SLOT_ORDER = "array_position(ARRAY['ochtend', 'middag', 'avond'], b.time_slot)";

const idParam = z.object({ id: z.uuid('Ongeldig boekings-ID.') });
const taskParams = idParam.extend({ taskId: z.coerce.number().int().positive() });
const itemParams = idParam.extend({ itemId: z.coerce.number().int().positive() });

export const waitingOn = z.enum(['me', 'customer', 'nobody']);
export const messageInput = z.object({
  direction: z.enum(['in', 'out']),
  channel: z.enum(['email', 'whatsapp', 'phone', 'in_person', 'other']),
  subject: z.string().trim().max(200).default(''),
  body: z.string().trim().min(1, 'Bericht is leeg.').max(20000),
  // For outgoing email: actually send it (otherwise it's only logged).
  send: z.boolean().default(false),
});

const PAYMENT_KINDS = {
  deposit: 'Aanbetaling',
  payment: 'Betaling',
  refund: 'Terugbetaling',
  security_deposit: 'Borg ontvangen',
  security_deposit_returned: 'Borg terugbetaald',
} as const;
const PAYMENT_METHODS = { bank: 'overboeking', cash: 'contant', tikkie: 'Tikkie', other: 'anders' } as const;

export const actorOf = (req: FastifyRequest) => req.admin?.email ?? 'admin';

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  const mailContext = () => ({
    publicUrl: app.config.PUBLIC_URL,
    paymentInfo: app.config.PAYMENT_INFO,
    reviewUrl: app.config.GOOGLE_REVIEW_URL,
  });

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

  // Numbers for the top of the pipeline page.
  app.get('/overview', async () => {
    const t = today(app.config.TIMEZONE);
    const { rows } = await app.db.query(
      `SELECT
         count(*) FILTER (WHERE waiting_on = 'me' AND status NOT IN ('completed', 'cancelled'))::int AS "waitingOnMe",
         count(*) FILTER (WHERE waiting_on = 'customer' AND status NOT IN ('completed', 'cancelled'))::int AS "waitingOnCustomer",
         count(*) FILTER (WHERE status = 'confirmed' AND paid_cents < deposit_cents)::int AS "depositOpen",
         coalesce(sum(greatest(price_cents - paid_cents, 0)) FILTER (WHERE status NOT IN ('cancelled')), 0)::int AS "outstandingCents",
         count(*) FILTER (WHERE status NOT IN ('cancelled') AND party_date BETWEEN $1 AND $2)::int AS "nextSevenDays",
         count(*) FILTER (WHERE status IN ('party_held', 'completed') AND review_status = 'none')::int AS "reviewsToRequest"
       FROM bookings`,
      [t, addDays(t, 7)],
    );
    const messages = await app.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM contact_messages WHERE waiting_on = 'me' AND NOT handled",
    );
    return { ...rows[0], messagesWaiting: messages.rows[0]!.count };
  });

  // Board view: every open booking, plus recently finished or cancelled ones.
  app.get('/pipeline', async () => {
    const recent = addDays(today(app.config.TIMEZONE), -30);
    const { rows } = await app.db.query<{ status: Status }>(
      `SELECT ${BOOKING_COLUMNS} ${FROM_BOOKINGS}
        WHERE b.status NOT IN ('completed', 'cancelled') OR b.party_date >= $1 OR b.updated_at >= $1
        ORDER BY b.party_date, ${SLOT_ORDER}, b.start_time`,
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
        waitingOn: waitingOn.optional(),
        payment: z.enum(['deposit_open', 'outstanding']).optional(),
        review: z.enum(['none', 'requested', 'received', 'declined']).optional(),
      })
      .parse(req.query);
    const { rows } = await app.db.query(
      `SELECT ${BOOKING_COLUMNS} ${FROM_BOOKINGS}
        WHERE ($1::text IS NULL OR b.status = $1)
          AND ($2::date IS NULL OR b.party_date >= $2)
          AND ($3::date IS NULL OR b.party_date <= $3)
          AND ($4::text IS NULL OR concat_ws(' ', b.reference, b.parent_name, b.child_name, b.email, b.city) ILIKE '%' || $4 || '%')
          AND ($5::text IS NULL OR (b.waiting_on = $5 AND b.status NOT IN ('completed', 'cancelled')))
          AND ($6::text IS NULL
               OR ($6 = 'deposit_open' AND b.status NOT IN ('cancelled') AND b.paid_cents < b.deposit_cents)
               OR ($6 = 'outstanding' AND b.status NOT IN ('cancelled') AND b.paid_cents < b.price_cents))
          AND ($7::text IS NULL OR (b.review_status = $7 AND b.status IN ('party_held', 'completed')))
        ORDER BY b.party_date, ${SLOT_ORDER}, b.start_time`,
      [q.status ?? null, q.from ?? null, q.to ?? null, q.q || null, q.waitingOn ?? null, q.payment ?? null, q.review ?? null],
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

    const [tasks, events, communications, agreements, payments] = await Promise.all([
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
      app.db.query(
        `SELECT id, direction, channel, subject, body, delivery, actor, created_at AS "createdAt"
           FROM communications WHERE booking_id = $1 ORDER BY created_at DESC, id DESC`,
        [id],
      ),
      app.db.query('SELECT id, text, actor, created_at AS "createdAt" FROM agreements WHERE booking_id = $1 ORDER BY id', [
        id,
      ]),
      app.db.query(
        `SELECT id, kind, amount_cents AS "amountCents", method, paid_on AS "paidOn", note, actor
           FROM payments WHERE booking_id = $1 ORDER BY paid_on, id`,
        [id],
      ),
    ]);
    const { lines } = calculatePrice(
      {
        packageName: booking.packageName,
        packagePriceCents: booking.packagePriceCents,
        extraStations: booking.extraStations,
        travelKm: booking.travelKm,
        eveningSurcharge: booking.eveningSurcharge,
        extras: booking.priceExtras,
      },
      app.config,
    );
    return {
      ...booking,
      priceLines: lines,
      tasks: tasks.rows,
      events: events.rows,
      communications: communications.rows,
      agreements: agreements.rows,
      payments: payments.rows,
    };
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
        travelKm: z.number().min(0).max(2000).nullable().optional(),
        eveningSurcharge: z.boolean().optional(),
        priceExtras: z
          .array(z.object({ label: z.string().trim().min(1).max(100), amountCents: z.number().int().min(-100000).max(100000) }))
          .max(20)
          .optional(),
        depositCents: z.number().int().min(0).optional(),
        waitingOn: waitingOn.optional(),
        reviewStatus: z.enum(['none', 'requested', 'received', 'declined']).optional(),
        // Set to false to change the status without emailing the parent.
        notifyCustomer: z.boolean().default(true),
      })
      .parse(req.body);

    const before = await loadBooking(id);
    const by = actorOf(req);

    await app.db.query(
      `UPDATE bookings SET
         status            = COALESCE($2, status),
         admin_notes       = COALESCE($3, admin_notes),
         party_date        = COALESCE($4, party_date),
         start_time        = CASE WHEN $5 THEN $6::time ELSE start_time END,
         time_slot         = COALESCE($7, time_slot),
         extra_stations    = COALESCE($8, extra_stations),
         travel_km         = CASE WHEN $9 THEN $10::numeric ELSE travel_km END,
         evening_surcharge = COALESCE($11, evening_surcharge),
         price_extras      = COALESCE($12::jsonb, price_extras),
         deposit_cents     = COALESCE($13, deposit_cents),
         waiting_on        = COALESCE($14, waiting_on),
         review_status     = COALESCE($15, review_status),
         updated_at        = now()
       WHERE id = $1`,
      [
        id, body.status ?? null, body.adminNotes ?? null, body.partyDate ?? null,
        body.startTime !== undefined, body.startTime ?? null, body.timeSlot ?? null, body.extraStations ?? null,
        body.travelKm !== undefined, body.travelKm ?? null, body.eveningSurcharge ?? null,
        body.priceExtras ? JSON.stringify(body.priceExtras) : null, body.depositCents ?? null,
        body.waitingOn ?? null, body.reviewStatus ?? null,
      ],
    );
    await recalculatePrice(app.db, app.config, id);
    const after = await loadBooking(id);

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
    if (body.travelKm !== undefined && body.travelKm !== before.travelKm) {
      changes.push(`Afstand: ${before.travelKm ?? '–'} → ${body.travelKm ?? '–'} km`);
    }
    if (body.eveningSurcharge !== undefined && body.eveningSurcharge !== before.eveningSurcharge) {
      changes.push(`Avondtoeslag: ${body.eveningSurcharge ? 'aan' : 'uit'}`);
    }
    if (body.priceExtras && JSON.stringify(body.priceExtras) !== JSON.stringify(before.priceExtras)) {
      changes.push(`Extra's: ${body.priceExtras.map((e: PriceExtra) => `${e.label} ${formatEuro(e.amountCents)}`).join(', ') || 'geen'}`);
    }
    if (body.depositCents !== undefined && body.depositCents !== before.depositCents) {
      changes.push(`Aanbetaling: ${formatEuro(before.depositCents)} → ${formatEuro(body.depositCents)}`);
    }
    if (after.priceCents !== before.priceCents) {
      changes.push(`Totaalprijs: ${formatEuro(before.priceCents)} → ${formatEuro(after.priceCents)}`);
    }
    if (body.reviewStatus && body.reviewStatus !== before.reviewStatus) changes.push(`Review: ${body.reviewStatus}`);
    if (changes.length) await addEvent(app.db, id, { type: 'update', message: changes.join('\n'), actor: by });

    if (body.status && body.status !== before.status) {
      await addEvent(app.db, id, { type: 'status', fromStatus: before.status, toStatus: body.status, actor: by });
      if (body.status === 'completed' || body.status === 'cancelled') {
        await app.db.query("UPDATE bookings SET waiting_on = 'nobody' WHERE id = $1", [id]);
      }
      const mail = body.notifyCustomer
        ? statusChangeMail(body.status, (await getBookingMailData(app.db, id))!, mailContext())
        : undefined;
      if (mail) {
        const sent = await sendAndLog(app, { bookingId: id }, mail, by);
        await addEvent(app.db, id, {
          type: 'email',
          message: sent ? `E-mail verstuurd: ${mail.subject}` : `E-mail versturen MISLUKT: ${mail.subject}`,
          actor: by,
        });
        if (sent && body.status === 'completed' && app.config.GOOGLE_REVIEW_URL) {
          await app.db.query(
            "UPDATE bookings SET review_status = 'requested', review_requested_at = now() WHERE id = $1 AND review_status = 'none'",
            [id],
          );
        }
      }
    }

    return loadBooking(id);
  });

  // Looks up the driving distance from the base location to the party address.
  app.post('/bookings/:id/distance', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = await loadBooking(id);
    const km = await app.distance.drivingKm(b.postalCode, b.city);
    if (km === null) {
      throw new HttpError(422, 'Afstand kon niet worden berekend. Vul het aantal kilometers zelf in.', 'distance_unknown');
    }
    await app.db.query('UPDATE bookings SET travel_km = $2 WHERE id = $1', [id, km]);
    await recalculatePrice(app.db, app.config, id);
    await addEvent(app.db, id, { type: 'update', message: `Afstand berekend: ${km} km enkele reis`, actor: actorOf(req) });
    return loadBooking(id);
  });

  // Messages: send an email to the customer, or log a WhatsApp, call or incoming email.
  app.post('/bookings/:id/messages', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const m = messageInput.parse(req.body);
    const b = await loadBooking(id);
    const by = actorOf(req);
    if (m.direction === 'out' && m.channel === 'email' && m.send) {
      const sent = await sendAndLog(
        app,
        { bookingId: id },
        { to: b.email, subject: m.subject || `Je aanvraag bij Gamer Xperience (${b.reference})`, text: withSignature(m.body) },
        by,
      );
      if (!sent) throw new HttpError(502, 'De e-mail kon niet worden verstuurd. Hij staat wel in het logboek.', 'send_failed');
    } else {
      await logCommunication(app, { bookingId: id, ...m, actor: m.direction === 'in' ? b.parentName : by });
    }
    await addEvent(app.db, id, {
      type: 'message',
      message: `${m.direction === 'in' ? 'Bericht ontvangen' : m.send ? 'E-mail verstuurd' : 'Bericht gelogd'} (${m.channel})${m.subject ? `: ${m.subject}` : ''}`,
      actor: by,
    });
    return reply.status(201).send(await loadBooking(id));
  });

  app.post('/bookings/:id/review-request', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!app.config.GOOGLE_REVIEW_URL) {
      throw new HttpError(422, 'Stel eerst GOOGLE_REVIEW_URL in (de reviewlink uit je Google Bedrijfsprofiel).', 'no_review_url');
    }
    const data = await getBookingMailData(app.db, id);
    if (!data) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');
    const sent = await sendAndLog(app, { bookingId: id }, reviewRequestMail(data, mailContext()), actorOf(req));
    if (!sent) throw new HttpError(502, 'De e-mail kon niet worden verstuurd.', 'send_failed');
    await app.db.query("UPDATE bookings SET review_status = 'requested', review_requested_at = now() WHERE id = $1", [id]);
    await addEvent(app.db, id, { type: 'review', message: 'Reviewverzoek verstuurd', actor: actorOf(req) });
    return loadBooking(id);
  });

  // Agreements.
  app.post('/bookings/:id/agreements', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body);
    await assertExists(id);
    const { rows } = await app.db.query(
      'INSERT INTO agreements (booking_id, text, actor) VALUES ($1, $2, $3) RETURNING id, text, actor, created_at AS "createdAt"',
      [id, text, actorOf(req)],
    );
    await addEvent(app.db, id, { type: 'agreement', message: `Afspraak: ${text}`, actor: actorOf(req) });
    return reply.status(201).send(rows[0]);
  });

  app.delete('/bookings/:id/agreements/:itemId', async (req, reply) => {
    const { id, itemId } = itemParams.parse(req.params);
    const { rows } = await app.db.query<{ text: string }>(
      'DELETE FROM agreements WHERE id = $2 AND booking_id = $1 RETURNING text',
      [id, itemId],
    );
    if (rows[0]) await addEvent(app.db, id, { type: 'agreement', message: `Afspraak verwijderd: ${rows[0].text}`, actor: actorOf(req) });
    return reply.status(204).send();
  });

  // Payments.
  app.post('/bookings/:id/payments', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const p = z
      .object({
        kind: z.enum(Object.keys(PAYMENT_KINDS) as [keyof typeof PAYMENT_KINDS]),
        amountCents: z.number().int().positive('Bedrag moet groter dan 0 zijn.').max(1000000),
        method: z.enum(Object.keys(PAYMENT_METHODS) as [keyof typeof PAYMENT_METHODS]),
        paidOn: dateString,
        note: z.string().trim().max(500).default(''),
      })
      .parse(req.body);
    await assertExists(id);
    await app.db.query(
      `INSERT INTO payments (booking_id, kind, amount_cents, method, paid_on, note, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, p.kind, p.amountCents, p.method, p.paidOn, p.note, actorOf(req)],
    );
    await recalculatePaid(app.db, id);
    await addEvent(app.db, id, {
      type: 'payment',
      message: `${PAYMENT_KINDS[p.kind]}: ${formatEuro(p.amountCents)} (${PAYMENT_METHODS[p.method]})${p.note ? ` – ${p.note}` : ''}`,
      actor: actorOf(req),
    });
    return reply.status(201).send(await loadBooking(id));
  });

  app.delete('/bookings/:id/payments/:itemId', async (req) => {
    const { id, itemId } = itemParams.parse(req.params);
    const { rows } = await app.db.query<{ kind: keyof typeof PAYMENT_KINDS; amount_cents: number }>(
      'DELETE FROM payments WHERE id = $2 AND booking_id = $1 RETURNING kind, amount_cents',
      [id, itemId],
    );
    if (!rows[0]) throw new HttpError(404, 'Betaling niet gevonden.', 'not_found');
    await recalculatePaid(app.db, id);
    await addEvent(app.db, id, {
      type: 'payment',
      message: `Betaling verwijderd: ${PAYMENT_KINDS[rows[0].kind]} ${formatEuro(rows[0].amount_cents)}`,
      actor: actorOf(req),
    });
    return loadBooking(id);
  });

  // Internal notes on the timeline.
  app.post('/bookings/:id/notes', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { message } = z.object({ message: z.string().trim().min(1, 'Notitie is leeg.').max(5000) }).parse(req.body);
    await assertExists(id);
    await addEvent(app.db, id, { type: 'note', message, actor: actorOf(req) });
    return reply.status(201).send({ ok: true });
  });

  // Checklist.
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
    await addEvent(app.db, id, { type: 'task', message: `${done ? '✓' : '✗'} ${rows[0].label}`, actor: actorOf(req) });
    return rows[0];
  });

  app.delete('/bookings/:id/tasks/:taskId', async (req, reply) => {
    const { id, taskId } = taskParams.parse(req.params);
    await app.db.query('DELETE FROM booking_tasks WHERE id = $2 AND booking_id = $1', [id, taskId]);
    return reply.status(204).send();
  });
};
