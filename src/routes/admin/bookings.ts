import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { addDays, today } from '../../lib/dates.js';
import {
  formatEuro, greetName, paymentLinkMail, reminderMail, reminderText, reviewRequestMail, statusChangeMail, whatsappUrl, withSignature,
} from '../../lib/emails.js';
import { HttpError } from '../../lib/errors.js';
import { daySchedule, estimateTravelMinutes } from '../../lib/schedule.js';
import { bookingRequest, bookingStatus, dateString, TIME_SLOTS, timeString } from '../../lib/schemas.js';
import { createBooking, splitName, DECORATION_LABEL, getBookingMailData, recalculatePaid, recalculatePrice } from '../../services/bookings.js';
import { upcomingBirthdays } from '../../services/birthdays.js';
import { logCommunication, sendAndLog } from '../../services/communications.js';
import { addEvent, createDefaultTasks, STAGE_INFO, STATUSES, type Status } from '../../services/pipeline.js';
import { calculatePrice, type PriceExtra } from '../../services/pricing.js';
import { contactFor, thankYouLink } from '../../services/discounts.js';
import { packagePercent, redeemReward, REWARD_PREFIX, rewardOf } from '../../services/referrals.js';
import { createInvoice, linkInvoice, listInvoices, syncInvoicePayments, unlinkedInvoices } from '../../services/invoices.js';
import { amountsDue, loadDue, paymentLink, syncOpenPayments } from '../../services/online-payments.js';

const BOOKING_COLUMNS = `
  b.id, b.reference, b.package_id AS "packageId", p.name AS "packageName",
  b.party_date AS "partyDate", b.time_slot AS "timeSlot", to_char(b.start_time, 'HH24:MI') AS "startTime", to_char(b.end_time, 'HH24:MI') AS "endTime",
  b.extra_stations AS "extraStations",
  b.parent_name AS "parentName", b.first_name AS "firstName", b.last_name AS "lastName", b.email, b.phone, b.email2, b.phone2, b.street, b.postal_code AS "postalCode", b.city,
  b.discount_code AS "discountCode", b.referred_by AS "referredBy", b.location_name AS "locationName", b.billing_street AS "billingStreet", b.billing_postal_code AS "billingPostalCode", b.billing_city AS "billingCity",
  b.child_name AS "childName", b.child_age AS "childAge", b.guest_count AS "guestCount",
  b.notes, b.parking, b.status, b.admin_notes AS "adminNotes", b.waiting_on AS "waitingOn",
  b.package_price_cents AS "packagePriceCents", b.travel_km::float AS "travelKm", b.travel_minutes AS "travelMinutes",
  p.duration_hours::float AS "packageHours",
  -- How long the party lasts: what was agreed for this booking, else what the package says.
  CASE WHEN b.start_time IS NOT NULL AND b.end_time > b.start_time THEN extract(epoch FROM (b.end_time - b.start_time)) / 3600 ELSE p.duration_hours END::float AS "durationHours",
  (SELECT to_char(ts.start_time, 'HH24:MI') FROM time_slots ts WHERE ts.key = b.time_slot) AS "slotStart",
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
  // For outgoing email on a booking: send this invoice along as a PDF, making it first if needed.
  attachInvoice: z.enum(['deposit', 'final']).optional(),
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
    onlinePayments: Boolean(app.mollie),
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
         count(*) FILTER (WHERE status IN ('party_held', 'completed') AND review_status = 'none')::int AS "reviewsToRequest",
         count(*) FILTER (WHERE status IN ('deposit_paid', 'scheduled') AND party_date = $3 AND reminder_sent_at IS NULL)::int AS "remindersDue"
       FROM bookings`,
      [t, addDays(t, 7), addDays(t, 1)],
    );
    const messages = await app.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM contact_messages WHERE waiting_on = 'me' AND NOT handled",
    );
    // Broken connections (mail, payments, backups), from the latest background check.
    const systemProblems = app.systemStatus.current?.checks.filter((c) => c.state === 'error').length ?? 0;
    const birthdays = (await upcomingBirthdays(app.db, t)).length;
    return { ...rows[0], messagesWaiting: messages.rows[0]!.count, systemProblems, birthdays };
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

  // A booking that was made elsewhere (phone, WhatsApp, the old site). No emails go out.
  app.post('/bookings', async (req, reply) => {
    if (req.admin!.role !== 'owner') throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
    // By phone or WhatsApp not everything is known yet: e-mail and address may follow later.
    const input = bookingRequest
      .omit({ termsAccepted: true, website: true })
      .extend({
        email: z.union([bookingRequest.shape.email, z.literal('')]).default(''),
        street: z.string().trim().max(200).default(''),
        postalCode: z.union([bookingRequest.shape.postalCode, z.literal('')]).default(''),
      })
      .parse(req.body);
    const booking = await createBooking(app.db, app.config, input, { actor: req.admin!.name || req.admin!.email });
    const lookup = app.distance.drivingKm(input.postalCode, input.city).then(async (km) => {
      if (km === null) return;
      const minutes = app.distance.drivingMinutes?.(input.postalCode, input.city) ?? estimateTravelMinutes(km);
      await app.db.query('UPDATE bookings SET travel_km = $2, travel_minutes = $3 WHERE id = $1 AND travel_km IS NULL', [booking.id, km, minutes]);
      await recalculatePrice(app.db, app.config, booking.id);
    });
    await Promise.race([lookup, new Promise((r) => setTimeout(r, 4000))]).catch((err) =>
      req.log.warn({ err }, 'Travel distance lookup failed'),
    );
    return reply.status(201).send({ id: booking.id, reference: booking.reference });
  });

  // Removes a booking for good, with everything noted under it: a double entry or a test. A real
  // party that falls through is cancelled instead, so its history stays.
  app.delete('/bookings/:id', async (req, reply) => {
    if (req.admin!.role !== 'owner') throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
    const { id } = idParam.parse(req.params);
    const { rows } = await app.db.query<{ reference: string }>('DELETE FROM bookings WHERE id = $1 RETURNING reference', [id]);
    if (!rows[0]) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');
    req.log.info({ reference: rows[0].reference, by: actorOf(req) }, 'Booking deleted');
    return reply.status(204).send();
  });

  app.get('/bookings', async (req) => {
    const q = z
      .object({
        // 'open' is every booking that is still running: not completed and not cancelled.
        status: bookingStatus.or(z.literal('open')).optional(),
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
        WHERE ($1::text IS NULL OR b.status = $1 OR ($1 = 'open' AND b.status NOT IN ('completed', 'cancelled')))
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

    const [tasks, events, communications, agreements, payments, mollie] = await Promise.all([
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
      app.db.query(
        `SELECT id, kind, amount_cents AS "amountCents", status, created_at AS "createdAt"
           FROM mollie_payments WHERE booking_id = $1 ORDER BY created_at DESC`,
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
    // A returning customer: how many parties this e-mail address had before this one, and
    // whether the thank-you link for coming back was given already.
    const earlier = booking.email
      ? (await app.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM bookings WHERE lower(email) = lower($1) AND status <> 'cancelled' AND id <> $2 AND created_at < $3`,
          [booking.email, id, booking.createdAt],
        )).rows[0]!.n
      : 0;
    const thanks = (await app.db.query<{ token: string; used: boolean }>(
      `SELECT l.token, EXISTS (SELECT 1 FROM bookings b WHERE b.discount_link = l.token AND b.status <> 'cancelled') AS used
         FROM discount_links l WHERE l.booking_id = $1`,
      [id],
    )).rows[0];
    // Recommending: who sent this customer, and what this customer has earned by recommending.
    const referredBy = booking.referredBy
      ? (await app.db.query<{ name: string; email: string }>('SELECT name, email FROM mail_contacts WHERE id = $1', [booking.referredBy])).rows[0] ?? null
      : null;
    const self = booking.email
      ? (await app.db.query<{ id: number }>('SELECT id FROM mail_contacts WHERE lower(email) = lower($1)', [booking.email])).rows[0]
      : undefined;
    const reward = self ? await rewardOf(app.db, self.id) : { held: 0, upcoming: 0, percent: 0 };
    return {
      ...booking,
      referredByName: referredBy ? referredBy.name || referredBy.email : null,
      reward,
      earlierBookings: earlier,
      thankYouLink: thanks ? { url: `${app.config.PUBLIC_URL}/reserveer?korting=${thanks.token}`, used: thanks.used } : null,
      priceLines: lines,
      // Leaving, building up, the party, breaking down and being home again.
      schedule: daySchedule(booking, { setupMinutes: app.config.SETUP_MINUTES, teardownMinutes: app.config.TEARDOWN_MINUTES }),
      invoices: await listInvoices(app, id),
      tasks: tasks.rows,
      events: events.rows,
      communications: communications.rows,
      agreements: agreements.rows,
      payments: payments.rows,
      molliePayments: mollie.rows,
      onlineDue: app.mollie ? amountsDue(booking) : null,
    };
  });

  // A payment link for the customer (deposit or remaining amount), optionally emailed.
  app.post('/bookings/:id/payment-link', async (req) => {
    const { id } = idParam.parse(req.params);
    const { kind, send, qr } = z
      .object({ kind: z.enum(['deposit', 'payment']), send: z.boolean().default(false), qr: z.boolean().default(false) })
      .parse(req.body);
    if (!app.mollie) throw new HttpError(422, 'Stel eerst MOLLIE_API_KEY in om online betalen te gebruiken.', 'payments_disabled');
    const booking = await loadDue(app, { id });
    if (!booking) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');
    const amount = amountsDue(booking)[kind];
    if (!amount) {
      throw new HttpError(
        409,
        kind === 'deposit'
          ? 'De aanbetaling kan online betaald worden zodra de boeking op "Bevestigd" staat en nog niet betaald is.'
          : 'Het restbedrag kan online betaald worden zodra de aanbetaling binnen is en er nog iets openstaat.',
        'nothing_due',
      );
    }
    const url = paymentLink(app.config.PUBLIC_URL, booking.statusToken, kind);
    if (send) {
      const mail = paymentLinkMail((await getBookingMailData(app.db, id))!, kind, amount, mailContext());
      if (!(await sendAndLog(app, { bookingId: id }, mail, actorOf(req)))) {
        throw new HttpError(502, 'De e-mail kon niet worden verstuurd.', 'send_failed');
      }
      await addEvent(app.db, id, { type: 'email', message: `Betaallink verstuurd: ${formatEuro(amount)}`, actor: actorOf(req) });
    }
    // A QR code of the link, to let the customer scan it from your screen (e.g. at the party).
    const qrSvg = qr ? await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : undefined;
    return { url, amountCents: amount, qrSvg };
  });

  // Checks open Mollie payments of this booking (e.g. when a webhook was missed).
  app.post('/bookings/:id/mollie-sync', async (req) => {
    const { id } = idParam.parse(req.params);
    await assertExists(id);
    await syncOpenPayments(app, id);
    return loadBooking(id);
  });

  // Cashes in what this customer earned by recommending, on this booking. Discounts do not add
  // up: a smaller discount already on the booking makes way, a bigger one stays and nothing is used.
  app.post('/bookings/:id/apply-reward', async (req) => {
    if (req.admin!.role !== 'owner') throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
    const { id } = idParam.parse(req.params);
    const b = await loadBooking(id);
    const self = b.email ? (await app.db.query<{ id: number }>('SELECT id FROM mail_contacts WHERE lower(email) = lower($1)', [b.email])).rows[0] : undefined;
    const reward = self ? await rewardOf(app.db, self.id) : null;
    if (!self || !reward?.percent) throw new HttpError(422, 'Deze klant heeft nog geen beloning opgebouwd.', 'no_reward');
    const extras = b.priceExtras as { label: string; amountCents: number }[];
    const existing = extras.find((x) => packagePercent(x.label) !== null && x.amountCents < 0);
    if (existing && packagePercent(existing.label)! >= reward.percent) {
      throw new HttpError(409, `Op deze boeking staat al een korting van ${packagePercent(existing.label)}%. Kortingen tellen niet op, dus de beloning van ${reward.percent}% blijft bewaard voor een volgend feest.`, 'bigger_discount');
    }
    const percent = await redeemReward(app.db, self.id, id);
    const line = { label: `${REWARD_PREFIX}(${percent}% op het pakket)`, amountCents: -Math.round((b.packagePriceCents * percent) / 100) };
    await app.db.query('UPDATE bookings SET price_extras = $2::jsonb, discount_code = CASE WHEN $3 THEN \'\' ELSE discount_code END WHERE id = $1', [
      id, JSON.stringify([...extras.filter((x) => x !== existing), line]), Boolean(existing),
    ]);
    await recalculatePrice(app.db, app.config, id);
    await addEvent(app.db, id, { type: 'update', message: `Beloning voor aanbevelen toegepast: ${percent}% op het pakket${existing ? ` (in plaats van "${existing.label}")` : ''}`, actor: actorOf(req) });
    return loadBooking(id);
  });

  // A thank-you for a customer who comes back: a personal discount link to use or to share
  // (a brother, sister, friend). One per booking; mailed when there is an address and the
  // customer has not unsubscribed, and always returned so it can also go by WhatsApp.
  app.post('/bookings/:id/thank-you-link', async (req) => {
    if (req.admin!.role !== 'owner') throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
    const { id } = idParam.parse(req.params);
    const { send } = z.object({ send: z.boolean().default(true) }).parse(req.body ?? {});
    const b = await loadBooking(id);
    if (!b.email) throw new HttpError(422, 'Bij deze boeking staat geen e-mailadres. Vul dat eerst in.', 'no_email');
    const code = (await app.db.query<{ id: number; code: string; percent: number }>(
      'SELECT id, code, percent FROM discount_codes WHERE active AND personal ORDER BY id DESC LIMIT 1',
    )).rows[0];
    if (!code) throw new HttpError(422, 'Er is geen actieve kortingscode die "alleen via link" werkt. Maak die eerst aan onder Pakketten.', 'no_code');
    const contact = await contactFor(app.db, b.email, b.parentName, 'Terugkerende klant');
    const link = await thankYouLink(app.db, id, code.id, contact.id);
    const url = `${app.config.PUBLIC_URL}/reserveer?korting=${link.token}`;
    let mailed = false;
    if (send && !contact.unsubscribed) {
      const first = greetName(b);
      mailed = await sendAndLog(app, { bookingId: id }, {
        to: b.email,
        subject: 'Bedankt dat jullie terugkomen! 🎮',
        text: withSignature(
          `Hoi ${first},\n\nWat leuk dat jullie opnieuw voor Gamer Xperience hebben gekozen. Dat vertrouwen waardeer ik enorm.\n\n` +
          `Als bedankje krijgen jullie nog een keer ${code.percent}% korting op het pakket. Gebruik hem zelf, of geef hem door aan een broertje, zusje of vrienden die ook een knalfeest verdienen:\n\n${url}\n\nDe link werkt één keer.`,
        ),
      }, actorOf(req), { keepTurn: true });
    }
    if (link.fresh) await addEvent(app.db, id, { type: 'update', message: `Bedankje voor terugkerende klant: kortingslink ${code.code} (${code.percent}%) gemaakt${mailed ? ' en gemaild' : ''}`, actor: actorOf(req) });
    return { url, mailed, unsubscribed: contact.unsubscribed, fresh: link.fresh };
  });

  // Who the customer is and where the party is: corrected or completed later, e.g. an e-mail
  // address that was not known yet, or the other parent's phone number.
  app.patch('/bookings/:id/contact', async (req) => {
    const { id } = idParam.parse(req.params);
    const shape = bookingRequest.shape;
    const body = z
      .object({
        parentName: shape.parentName,
        firstName: z.string().trim().max(50),
        lastName: z.string().trim().max(60),
        email: z.union([shape.email, z.literal('')]),
        email2: z.union([shape.email, z.literal('')]),
        phone: shape.phone,
        phone2: shape.phone,
        street: z.string().trim().max(200),
        postalCode: z.union([shape.postalCode, z.literal('')]),
        city: shape.city,
        // Where the party is can have a name (a hall), and the invoice can go to another address.
        locationName: z.string().trim().max(100),
        billingStreet: z.string().trim().max(200),
        billingPostalCode: z.union([shape.postalCode, z.literal('')]),
        billingCity: z.string().trim().max(100),
        childName: shape.childName,
        childAge: z.number().int().min(1).max(18).nullable(),
        guestCount: z.number().int().min(1).max(40).nullable(),
        parking: shape.parking,
        notes: shape.notes,
      })
      .partial()
      .parse(req.body);
    type Key = keyof typeof body;
    const before = (await loadBooking(id)) as unknown as Record<Key, unknown>;
    const columns: Record<Key, string> = {
      parentName: 'parent_name', firstName: 'first_name', lastName: 'last_name', email: 'email', email2: 'email2', phone: 'phone', phone2: 'phone2', street: 'street', postalCode: 'postal_code',
      locationName: 'location_name', billingStreet: 'billing_street', billingPostalCode: 'billing_postal_code', billingCity: 'billing_city',
      city: 'city', childName: 'child_name', childAge: 'child_age', guestCount: 'guest_count', parking: 'parking', notes: 'notes',
    };
    const labels: Record<Key, string> = {
      parentName: 'Naam', firstName: 'Voornaam', lastName: 'Achternaam', email: 'E-mail', email2: 'Tweede e-mail', phone: 'Telefoon', phone2: 'Tweede telefoon', street: 'Straat', postalCode: 'Postcode',
      locationName: 'Naam locatie', billingStreet: 'Factuuradres straat', billingPostalCode: 'Factuuradres postcode', billingCity: 'Factuuradres plaats',
      city: 'Plaats', childName: 'Jarige', childAge: 'Leeftijd', guestCount: 'Aantal kinderen', parking: 'Parkeren', notes: 'Details',
    };
    // Only what was actually sent: a field left out keeps its value (some have an empty default).
    const sent = new Set(Object.keys((req.body as object) ?? {}));
    const changed = (Object.keys(body) as Key[]).filter((key) => sent.has(key) && body[key] !== undefined && body[key] !== before[key]);
    if (!changed.length) return loadBooking(id);
    await app.db.query(
      `UPDATE bookings SET ${changed.map((key, i) => `${columns[key]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [id, ...changed.map((key) => body[key])],
    );
    // The full name and its two parts stay in step, whichever of them was changed.
    if (changed.some((key) => key === 'firstName' || key === 'lastName' || key === 'parentName')) {
      const byParts = changed.includes('firstName') || changed.includes('lastName');
      const names = byParts
        ? splitName('', String(body.firstName ?? before.firstName ?? ''), String(body.lastName ?? before.lastName ?? ''))
        : splitName(String(body.parentName ?? ''));
      await app.db.query('UPDATE bookings SET parent_name = $2, first_name = $3, last_name = $4 WHERE id = $1', [id, names.full || before.parentName, names.first, names.last]);
    }
    // Another address means another distance, and with it other travel costs.
    if (changed.includes('postalCode') || changed.includes('city')) {
      const postalCode = String(body.postalCode ?? before.postalCode ?? '');
      const city = String(body.city ?? before.city ?? '');
      await app.db.query('UPDATE bookings SET travel_km = NULL, travel_minutes = NULL WHERE id = $1', [id]);
      const lookup = app.distance.drivingKm(postalCode, city).then(async (km) => {
        if (km === null) return;
        const minutes = app.distance.drivingMinutes?.(postalCode, city) ?? estimateTravelMinutes(km);
        await app.db.query('UPDATE bookings SET travel_km = $2, travel_minutes = $3 WHERE id = $1', [id, km, minutes]);
      });
      await Promise.race([lookup, new Promise((r) => setTimeout(r, 4000))]).catch((err) => req.log.warn({ err }, 'Travel distance lookup failed'));
      await recalculatePrice(app.db, app.config, id);
    }
    await addEvent(app.db, id, { type: 'update', message: `Gegevens gewijzigd: ${changed.map((key) => labels[key]).join(', ')}`, actor: actorOf(req) });
    return loadBooking(id);
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
        // Another package after all, e.g. from Standaard to Ultimate.
        packageId: z.number().int().positive().optional(),
        // An agreed end time, when the party is shorter or longer than the package; null clears it.
        endTime: timeString.nullable().optional(),
        extraStations: z.number().int().min(0).max(2).optional(),
        travelKm: z.number().min(0).max(2000).nullable().optional(),
        travelMinutes: z.number().int().min(0).max(600).nullable().optional(),
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
    const start = body.startTime !== undefined ? body.startTime : before.startTime;
    const end = body.endTime !== undefined ? body.endTime : before.endTime;
    if (end && !start) throw new HttpError(422, 'Vul bij een eindtijd ook de starttijd in.', 'end_without_start');
    if (end && start && end <= start) throw new HttpError(422, 'De eindtijd moet na de starttijd liggen.', 'end_before_start');
    // The new package brings its own price; decoration that is part of Ultimate is no longer an extra.
    let packageChange: string | null = null;
    if (body.packageId !== undefined && body.packageId !== before.packageId) {
      const pkg = await app.db.query<{ name: string; slug: string; priceCents: number }>('SELECT name, slug, price_cents AS "priceCents" FROM packages WHERE id = $1', [body.packageId]);
      if (!pkg.rows[0]) throw new HttpError(422, 'Dit pakket bestaat niet (meer).', 'unknown_package');
      const extras = (before.priceExtras as { label: string; amountCents: number }[])
        .filter((x) => !(pkg.rows[0]!.slug === 'ultimate' && x.label === DECORATION_LABEL))
        // A discount code is a percentage of the package: with another package it is another amount.
        .map((x) => {
          const percent = packagePercent(x.label);
          return percent === null ? x : { ...x, amountCents: -Math.round((pkg.rows[0]!.priceCents * percent) / 100) };
        });
      await app.db.query('UPDATE bookings SET package_id = $2, package_price_cents = $3, price_extras = $4::jsonb WHERE id = $1', [id, body.packageId, pkg.rows[0].priceCents, JSON.stringify(extras)]);
      packageChange = `Pakket: ${before.packageName} → ${pkg.rows[0].name}`;
    }

    await app.db.query(
      `UPDATE bookings SET
         status            = COALESCE($2, status),
         admin_notes       = COALESCE($3, admin_notes),
         party_date        = COALESCE($4, party_date),
         start_time        = CASE WHEN $5 THEN $6::time ELSE start_time END,
         end_time          = CASE WHEN $18 THEN $19::time ELSE end_time END,
         time_slot         = COALESCE($7, time_slot),
         extra_stations    = COALESCE($8, extra_stations),
         travel_km         = CASE WHEN $9 THEN $10::numeric ELSE travel_km END,
         travel_minutes    = CASE WHEN $16 THEN $17::int ELSE travel_minutes END,
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
        // A new distance typed by hand gets an estimated driving time, unless one is given too.
        body.travelMinutes !== undefined || (body.travelKm !== undefined && body.travelKm !== before.travelKm),
        body.travelMinutes !== undefined ? body.travelMinutes : body.travelKm == null ? null : estimateTravelMinutes(body.travelKm),
        body.endTime !== undefined, body.endTime ?? null,
      ],
    );
    await recalculatePrice(app.db, app.config, id);
    const after = await loadBooking(id);

    // Record what changed on the timeline.
    const changes: string[] = [];
    if (packageChange) changes.push(packageChange);
    if (body.partyDate && body.partyDate !== before.partyDate) changes.push(`Datum: ${before.partyDate} → ${body.partyDate}`);
    if (body.startTime !== undefined && body.startTime !== before.startTime) {
      changes.push(`Starttijd: ${before.startTime ?? '–'} → ${body.startTime ?? '–'}`);
    }
    if (body.endTime !== undefined && body.endTime !== before.endTime) changes.push(`Eindtijd: ${before.endTime ?? '–'} → ${body.endTime ?? '–'}`);
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
    const minutes = app.distance.drivingMinutes?.(b.postalCode, b.city) ?? estimateTravelMinutes(km);
    await app.db.query('UPDATE bookings SET travel_km = $2, travel_minutes = $3 WHERE id = $1', [id, km, minutes]);
    await recalculatePrice(app.db, app.config, id);
    await addEvent(app.db, id, { type: 'update', message: `Afstand berekend: ${km} km enkele reis, ongeveer ${minutes} minuten rijden`, actor: actorOf(req) });
    return loadBooking(id);
  });

  // Messages: send an email to the customer, or log a WhatsApp, call or incoming email.
  app.post('/bookings/:id/messages', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const m = messageInput.parse(req.body);
    const b = await loadBooking(id);
    const by = actorOf(req);
    if (m.direction === 'out' && m.channel === 'email' && m.send) {
      let attachments: { filename: string; path: string }[] | undefined;
      if (m.attachInvoice) {
        const invoices = await listInvoices(app, id);
        const invoice =
          invoices.find((i) => i.kind === m.attachInvoice) ??
          (await createInvoice(app, id, m.attachInvoice, by)).find((i) => i.kind === m.attachInvoice)!;
        if (!invoice.pdfUrl) throw new HttpError(502, `Factuur ${invoice.number} is gemaakt, maar e-Boekhouden gaf geen pdf-link. De e-mail is niet verstuurd.`, 'no_pdf');
        attachments = [{ filename: `Factuur ${invoice.number}.pdf`, path: invoice.pdfUrl }];
      }
      const sent = await sendAndLog(
        app,
        { bookingId: id },
        { to: b.email, subject: m.subject || `Je aanvraag bij Gamer Xperience (${b.reference})`, text: withSignature(m.body), attachments },
        by,
      );
      if (!sent) throw new HttpError(502, 'De e-mail kon niet worden verstuurd. Hij staat wel in het logboek.', 'send_failed');
    } else {
      const { attachInvoice: _unused, ...message } = m;
      await logCommunication(app, { bookingId: id, ...message, actor: m.direction === 'in' ? b.parentName : by });
    }
    await addEvent(app.db, id, {
      type: 'message',
      message: `${m.direction === 'in' ? 'Bericht ontvangen' : m.send ? 'E-mail verstuurd' : 'Bericht gelogd'} (${m.channel})${m.subject ? `: ${m.subject}` : ''}`,
      actor: by,
    });
    // Your first reply to a new request is "contact made": the customer's page moves on with it.
    if (m.direction === 'out' && b.status === 'new') {
      await app.db.query("UPDATE bookings SET status = 'contacted', updated_at = now() WHERE id = $1 AND status = 'new'", [id]);
      await addEvent(app.db, id, { type: 'status', fromStatus: 'new', toStatus: 'contacted', actor: by });
    }
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

  // Definite parties that are tomorrow and haven't had their reminder yet.
  app.get('/reminders', async () => {
    const { rows } = await app.db.query<{ id: string }>(
      `SELECT id FROM bookings
        WHERE status IN ('deposit_paid', 'scheduled') AND party_date = $1 AND reminder_sent_at IS NULL
        ORDER BY start_time NULLS LAST, created_at`,
      [addDays(today(app.config.TIMEZONE), 1)],
    );
    return Promise.all(
      rows.map(async ({ id }) => {
        const b = (await getBookingMailData(app.db, id))!;
        const text = reminderText(b);
        return {
          id, reference: b.reference, parentName: b.parentName, childName: b.childName, city: b.city, phone: b.phone,
          partyDate: b.partyDate, timeSlot: b.timeSlot, startTime: b.startTime, text, whatsappUrl: whatsappUrl(b.phone, text),
        };
      }),
    );
  });

  // Records the reminder. By email it is sent here; by WhatsApp you send it yourself and this logs it.
  app.post('/bookings/:id/reminder', async (req) => {
    const { id } = idParam.parse(req.params);
    const { channel } = z.object({ channel: z.enum(['whatsapp', 'email']) }).parse(req.body);
    const data = await getBookingMailData(app.db, id);
    if (!data) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');
    if (channel === 'email') {
      const sent = await sendAndLog(app, { bookingId: id }, reminderMail(data), actorOf(req), { keepTurn: true });
      if (!sent) throw new HttpError(502, 'De e-mail kon niet worden verstuurd.', 'send_failed');
    } else {
      await logCommunication(app, {
        bookingId: id, direction: 'out', channel: 'whatsapp', subject: 'Herinnering: morgen is het zover',
        body: reminderText(data), actor: actorOf(req), keepTurn: true,
      });
    }
    await app.db.query('UPDATE bookings SET reminder_sent_at = now() WHERE id = $1', [id]);
    await addEvent(app.db, id, { type: 'update', message: `Herinnering verstuurd via ${channel === 'email' ? 'e-mail' : 'WhatsApp'}`, actor: actorOf(req) });
    return loadBooking(id);
  });

  // Invoices in the bookkeeping: one for the deposit, one for the rest.
  app.post('/bookings/:id/invoices', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { kind } = z.object({ kind: z.enum(['deposit', 'final']) }).parse(req.body);
    return reply.status(201).send(await createInvoice(app, id, kind, actorOf(req)));
  });

  // Invoices that exist in the bookkeeping and belong to no booking yet.
  app.get('/invoices/unlinked', async () => unlinkedInvoices(app));

  // Link an invoice that already exists in the bookkeeping, instead of making a new one.
  app.post('/bookings/:id/invoices/link', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ kind: z.enum(['deposit', 'final']), number: z.string().trim().min(1).max(40), amountCents: z.number().int().positive().nullable().default(null) })
      .parse(req.body);
    await linkInvoice(app, id, body.kind, body.number, body.amountCents, actorOf(req));
    // An existing invoice may already be (partly) paid: note that right away.
    await syncInvoicePayments(app, id).catch((err) => req.log.warn({ err }, 'Could not check the payment of a linked invoice'));
    return reply.status(201).send(await listInvoices(app, id));
  });

  // Ask the bookkeeping right now whether this booking's invoices have been paid.
  app.post('/bookings/:id/invoices/sync', async (req) => {
    const { id } = idParam.parse(req.params);
    try {
      return { registered: await syncInvoicePayments(app, id) };
    } catch (err) {
      throw new HttpError(502, `e-Boekhouden kon niet worden geraadpleegd. ${(err as Error).message}`, 'bookkeeping_failed');
    }
  });

  // Forgets an invoice here (it is not removed from the bookkeeping), so it can be made again.
  app.delete('/bookings/:id/invoices/:kind', async (req, reply) => {
    const { id, kind } = z.object({ id: z.uuid(), kind: z.enum(['deposit', 'final']) }).parse(req.params);
    const { rows } = await app.db.query<{ number: string }>('DELETE FROM invoices WHERE booking_id = $1 AND kind = $2 RETURNING number', [id, kind]);
    if (!rows[0]) throw new HttpError(404, 'Factuur niet gevonden.', 'not_found');
    await addEvent(app.db, id, { type: 'payment', message: `Factuur ${rows[0].number} losgekoppeld in de admin`, actor: actorOf(req) });
    return reply.status(204).send();
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
