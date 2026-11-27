import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { daysBetween, formatDutchDate, today } from '../lib/dates.js';
import { recordVisit, sourceOf } from '../services/visits.js';
import { bookingOwnerNotification, bookingReceivedMail, contactOwnerNotification, statusUrl } from '../lib/emails.js';
import { HttpError } from '../lib/errors.js';
import type { Mail } from '../lib/mailer.js';
import { contactFor, findDiscount, findDiscountByLink } from '../services/discounts.js';
import { findReferrer, REFERRAL_NEW_PERCENT, referralToken, REWARD_MAX_PERCENT, REWARD_STEP_PERCENT, rewardOf } from '../services/referrals.js';
import { bookingRequest, contactRequest, dateString } from '../lib/schemas.js';
import { availableSlots, bookingWindow, getSettings, getTimeSlots, isoWeekday } from '../services/availability.js';
import { createBooking, recalculatePrice } from '../services/bookings.js';
import { sendAndLog } from '../services/communications.js';
import { estimateTravelMinutes } from '../lib/schedule.js';
import { notify } from '../services/push.js';
import { travelCents } from '../services/pricing.js';
import { amountsDue, paymentLink } from '../services/online-payments.js';
import { STAGE_INFO, STAGES, stageIndex, type Status } from '../services/pipeline.js';

export const publicRoutes: FastifyPluginAsync = async (app) => {
  // Email problems must never make a booking fail; they are logged instead.
  const sendSafely = (mail: Mail) =>
    app.mailer.send(mail).catch((err) => app.log.error({ err, subject: mail.subject }, 'Failed to send email'));

  app.get('/health', async () => {
    await app.db.query('SELECT 1');
    return app.config.DEMO_MODE ? { status: 'ok', demo: true } : { status: 'ok' };
  });

  app.get('/packages', async () => {
    const { rows } = await app.db.query(
      `SELECT id, slug, name, description, max_players AS "maxPlayers", duration_hours AS "durationHours",
              price_cents AS "priceCents"
         FROM packages WHERE active ORDER BY sort_order, id`,
    );
    return rows;
  });

  // Bookable dates and time slots for the booking calendar.
  app.get('/availability', async (req) => {
    const window = await bookingWindow(app.db, app.config);
    const query = z
      .object({ from: dateString.optional(), to: dateString.optional() })
      .parse(req.query);
    const from = query.from && query.from > window.minDate ? query.from : window.minDate;
    const to = query.to && query.to < window.maxDate ? query.to : window.maxDate;
    const slots = await getTimeSlots(app.db);
    if (from > to) return { ...window, from, to, slots, days: {}, onRequest: [] };
    if (daysBetween(from, to) > 400) throw new HttpError(400, 'Periode is te lang.');
    const days = await availableSlots(app.db, app.config, from, to);
    // Days that can be asked for, but are not certain yet: the calendar shows them in another colour.
    const { onRequestWeekdays } = await getSettings(app.db);
    return { ...window, from, to, slots, days, onRequest: Object.keys(days).filter((d) => onRequestWeekdays.includes(isoWeekday(d))) };
  });

  app.post(
    '/bookings',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { termsAccepted: _terms, website: _honeypot, ...input } = bookingRequest.parse(req.body);
      const booking = await createBooking(app.db, app.config, input);

      // Look up the travel distance for the price breakdown. A slow or failing lookup
      // never holds up the booking: the distance can be filled in from the admin page.
      const lookup = app.distance.drivingKm(input.postalCode, input.city).then(async (km) => {
        if (km === null) return;
        const minutes = app.distance.drivingMinutes?.(input.postalCode, input.city) ?? estimateTravelMinutes(km);
        await app.db.query('UPDATE bookings SET travel_km = $2, travel_minutes = $3 WHERE id = $1 AND travel_km IS NULL', [booking.id, km, minutes]);
        await recalculatePrice(app.db, app.config, booking.id);
      });
      await Promise.race([lookup, new Promise((r) => setTimeout(r, 4000))]).catch((err) =>
        req.log.warn({ err }, 'Travel distance lookup failed'),
      );

      await sendAndLog(app, { bookingId: booking.id }, bookingReceivedMail(booking, { publicUrl: app.config.PUBLIC_URL }), 'Website', {
        keepTurn: true,
      });
      if (app.config.OWNER_EMAIL) {
        await sendSafely(
          bookingOwnerNotification(booking, app.config.OWNER_EMAIL, `${app.config.PUBLIC_URL}/admin/#/bookings/${booking.id}`),
        );
      }

      void notify(app, {
        title: 'Nieuwe aanvraag',
        body: `${booking.parentName} · ${formatDutchDate(booking.partyDate)} · ${booking.packageName} in ${booking.city}`,
        url: `#/bookings/${booking.id}`,
      });

      return reply.status(201).send({
        reference: booking.reference,
        status: booking.status,
        statusUrl: statusUrl(app.config.PUBLIC_URL, booking.statusToken),
      });
    },
  );

  // Is this discount code good for a party on this date? For the price shown in the booking form.
  app.get(
    '/discount',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req) => {
      const q = z
        .object({ code: z.string().trim().max(40).default(''), link: z.string().trim().max(60).default(''), partyDate: z.union([dateString, z.literal('')]).default('') })
        .refine((v) => v.link || (v.code && v.partyDate), 'Geef een code en een datum, of een kortingslink.')
        .parse(req.query);
      const found = q.link ? await findDiscountByLink(app.db, q.link, q.partyDate || null) : await findDiscount(app.db, q.code, q.partyDate);
      return 'reason' in found ? { valid: false, reason: found.reason } : { valid: true, ...found.discount };
    },
  );

  // Does this recommending link exist? For the banner and the price in the booking form.
  app.get(
    '/referral',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req) => {
      const { token } = z.object({ token: z.string().trim().min(4).max(40) }).parse(req.query);
      return (await findReferrer(app.db, token)) ? { valid: true, percent: REFERRAL_NEW_PERCENT } : { valid: false };
    },
  );

  // Travel cost estimate for the booking form.
  app.get(
    '/quote',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (req) => {
      const { postalCode, city } = z
        .object({ postalCode: z.string().trim().min(4).max(7), city: z.string().trim().min(2).max(100) })
        .parse(req.query);
      const km = await app.distance.drivingKm(postalCode, city);
      return km === null
        ? { km: null, travelCents: null }
        : { km, travelCents: travelCents(km, app.config), maxCents: app.config.TRAVEL_MAX_CENTS };
    },
  );

  app.post(
    '/contact',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { website: _honeypot, ...msg } = contactRequest.parse(req.body);
      const { rows } = await app.db.query<{ id: number }>(
        'INSERT INTO contact_messages (name, email, phone, message) VALUES ($1, $2, $3, $4) RETURNING id',
        [msg.name, msg.email, msg.phone, msg.message],
      );
      await app.db.query(
        `INSERT INTO communications (contact_message_id, direction, channel, subject, body, actor)
         VALUES ($1, 'in', 'website', 'Contactformulier', $2, $3)`,
        [rows[0]!.id, msg.message, msg.name],
      );
      if (app.config.OWNER_EMAIL) await sendSafely(contactOwnerNotification(msg, app.config.OWNER_EMAIL));
      void notify(app, { title: `Bericht van ${msg.name}`, body: msg.message.slice(0, 140), url: `#/messages/${rows[0]!.id}` });
      return reply.status(201).send({ ok: true });
    },
  );

  // Parent-facing progress page. Only shows what the parent needs: no address or contact details.
  // The picture at the top of a mailing; mail programs fetch it from here.
  app.get('/mail-image/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().max(40) }).parse(req.params);
    const { rows } = await app.db.query<{ mime: string; data: Buffer }>('SELECT mime, data FROM mailing_images WHERE token = $1', [token]);
    if (!rows[0]) throw new HttpError(404, 'Niet gevonden.', 'not_found');
    // Mail programs in a browser load it from another site.
    return reply.header('Content-Type', rows[0].mime).header('Cross-Origin-Resource-Policy', 'cross-origin').header('Cache-Control', 'public, max-age=31536000, immutable').send(rows[0].data);
  });

  // One page seen by a visitor. Counted without cookies; see services/visits.ts.
  app.post('/hit', { config: { rateLimit: { max: 120, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const body = z.object({ path: z.string().max(300), referrer: z.string().max(500).default(''), source: z.string().max(100).default('') }).safeParse(req.body);
    const path = body.success ? body.data.path.replace(/(.)\/$/, '$1') : '';
    if (body.success && app.sitePaths.has(path)) {
      await recordVisit(app.db, {
        day: today(app.config.TIMEZONE),
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] ?? ''),
        path,
        source: sourceOf(body.data.referrer, body.data.source, new URL(app.config.PUBLIC_URL).hostname),
      });
    }
    return reply.status(204).send();
  });

  // A photo the owner added to the strip on the website.
  app.get('/site-photo/:id', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { rows } = await app.db.query<{ mime: string; data: Buffer }>('SELECT mime, data FROM site_photos WHERE id = $1 AND data IS NOT NULL', [id]);
    if (!rows[0]) throw new HttpError(404, 'Niet gevonden.', 'not_found');
    return reply.header('Content-Type', rows[0].mime).header('Cache-Control', 'public, max-age=31536000, immutable').send(rows[0].data);
  });

  // The photo of a social media post: Facebook and Instagram fetch it from here.
  app.get('/social-image/:key', async (req, reply) => {
    const { key } = z.object({ key: z.string().regex(/^[\w-]{10,60}\.jpg$/) }).parse(req.params);
    const { rows } = await app.db.query<{ image: Buffer }>('SELECT image FROM social_posts WHERE image_key = $1 AND image IS NOT NULL', [key.slice(0, -4)]);
    if (!rows[0]) throw new HttpError(404, 'Niet gevonden.', 'not_found');
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=31536000, immutable').header('Cross-Origin-Resource-Policy', 'cross-origin').send(rows[0].image);
  });

  // A photo the owner put in place of one on a page.
  app.get('/site-image/:id', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { rows } = await app.db.query<{ mime: string; data: Buffer }>('SELECT mime, data FROM site_images WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'Niet gevonden.', 'not_found');
    return reply.header('Content-Type', rows[0].mime).header('Cache-Control', 'public, max-age=31536000, immutable').send(rows[0].data);
  });

  // The way out of the mailings: the link at the bottom of every mailing leads here.
  app.post(
    '/unsubscribe',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req) => {
      const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.body);
      const { rows } = await app.db.query<{ email: string }>(
        'UPDATE mail_contacts SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE token = $1 RETURNING email',
        [token],
      );
      if (!rows[0]) throw new HttpError(404, 'Deze afmeldlink kennen we niet (meer).', 'not_found');
      // Enough of the address to recognise it, not all of it.
      return { email: rows[0].email.replace(/^(.).*(@.*)$/, '$1…$2') };
    },
  );

  // Optional, after unsubscribing: why. Never asked before the unsubscribing itself is done.
  app.post(
    '/unsubscribe/reason',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req) => {
      const { token, reason } = z.object({ token: z.string().min(10).max(100), reason: z.string().trim().min(1).max(300) }).parse(req.body);
      const res = await app.db.query('UPDATE mail_contacts SET unsubscribe_reason = $2 WHERE token = $1 AND unsubscribed_at IS NOT NULL', [token, reason]);
      if (!res.rowCount) throw new HttpError(404, 'Deze afmeldlink kennen we niet (meer).', 'not_found');
      return { ok: true };
    },
  );

  // The PDF of one invoice, for the customer who has the status link. Fetched from the bookkeeping
  // here, so the customer gets it from this site.
  app.get(
    '/status/:token/invoice/:kind',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { token, kind } = z.object({ token: z.string().min(20).max(100), kind: z.enum(['deposit', 'final']) }).parse(req.params);
      const { rows } = await app.db.query<{ number: string; pdfUrl: string }>(
        `SELECT i.number, i.pdf_url AS "pdfUrl" FROM invoices i JOIN bookings b ON b.id = i.booking_id
          WHERE b.status_token = $1 AND i.kind = $2 AND b.status <> 'cancelled'`,
        [token, kind],
      );
      const invoice = rows[0];
      if (!invoice?.pdfUrl.startsWith('https://')) throw new HttpError(404, 'Deze factuur kunnen we niet vinden.', 'not_found');
      const res = await fetch(invoice.pdfUrl, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!res?.ok) throw new HttpError(502, 'De factuur kan nu niet worden opgehaald. Probeer het later opnieuw, of kijk in je e-mail.', 'invoice_unavailable');
      return reply
        .type('application/pdf')
        .header('content-disposition', `inline; filename="Factuur ${invoice.number.replace(/[^\w.-]/g, '')}.pdf"`)
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(await res.arrayBuffer()));
    },
  );

  app.get(
    '/status/:token',
    { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } },
    async (req) => {
      const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.params);
      const { rows } = await app.db.query<{
        reference: string; status: Status; partyDate: string; timeSlot: string; startTime: string | null; endTime: string | null;
        packageName: string; extraStations: number; childName: string; guestCount: number | null;
        priceCents: number; depositCents: number; paidCents: number; id: string; statusToken: string;
      }>(
        `SELECT b.reference, b.status, b.party_date AS "partyDate", b.time_slot AS "timeSlot",
                to_char(b.start_time, 'HH24:MI') AS "startTime", to_char(b.end_time, 'HH24:MI') AS "endTime", p.name AS "packageName", b.extra_stations AS "extraStations", b.child_name AS "childName", b.guest_count AS "guestCount",
                b.price_cents AS "priceCents", b.deposit_cents AS "depositCents", b.paid_cents AS "paidCents",
                b.id, b.status_token AS "statusToken"
           FROM bookings b JOIN packages p ON p.id = b.package_id
          WHERE b.status_token = $1`,
        [token],
      );
      const found = rows[0];
      if (!found) throw new HttpError(404, 'Deze boeking kunnen we niet vinden.', 'not_found');
      const { id: _id, statusToken: _token, ...booking } = found;
      // Online payment buttons for the status page.
      const due = app.mollie ? amountsDue(found) : { deposit: null, payment: null };
      const pay = {
        deposit: due.deposit ? { amountCents: due.deposit, url: paymentLink('', token, 'deposit') } : null,
        payment: due.payment ? { amountCents: due.payment, url: paymentLink('', token, 'payment') } : null,
      };

      // The invoices of this party, each with a link to its PDF (the QR code on it pays in one scan).
      const { rows: invoices } = await app.db.query<{ kind: string; number: string; amountCents: number; paidCents: number }>(
        `SELECT kind, number, amount_cents AS "amountCents", paid_cents AS "paidCents" FROM invoices
          WHERE booking_id = $1 AND pdf_url <> '' ORDER BY kind = 'deposit' DESC, id`,
        [found.id],
      );

      // The customer's own recommending link, and what it has earned so far.
      let referral = null;
      const owner = await app.db.query<{ email: string; name: string }>('SELECT email, parent_name AS name FROM bookings WHERE id = $1', [found.id]);
      if (owner.rows[0]?.email && booking.status !== 'cancelled') {
        const contact = await contactFor(app.db, owner.rows[0].email, owner.rows[0].name, 'Klant');
        const reward = await rewardOf(app.db, contact.id);
        referral = {
          url: `${app.config.PUBLIC_URL}/reserveer?via=${await referralToken(app.db, contact.id)}`,
          ...reward, newPercent: REFERRAL_NEW_PERCENT, stepPercent: REWARD_STEP_PERCENT, maxPercent: REWARD_MAX_PERCENT,
        };
      }

      const current = stageIndex(booking.status);
      const { rows: history } = await app.db.query<{ status: string; at: Date }>(
        `SELECT to_status AS status, max(created_at) AS at FROM booking_events
          WHERE booking_id = (SELECT id FROM bookings WHERE status_token = $1) AND to_status IS NOT NULL
          GROUP BY to_status`,
        [token],
      );
      const reachedAt = new Map(history.map((h) => [h.status, h.at]));
      return {
        ...booking,
        pay,
        referral,
        invoices: booking.status === 'cancelled' ? [] : invoices.map((i) => ({ ...i, url: `/api/status/${encodeURIComponent(token)}/invoice/${i.kind}` })),
        statusLabel: STAGE_INFO[booking.status].customerLabel,
        statusText: STAGE_INFO[booking.status].customerText,
        steps:
          booking.status === 'cancelled'
            ? []
            : STAGES.map((stage, i) => ({
                key: stage,
                label: STAGE_INFO[stage].customerLabel,
                state: i < current ? 'done' : i === current ? 'current' : 'todo',
                at: i <= current ? (reachedAt.get(stage) ?? null) : null,
              })),
      };
    },
  );

  // Lets a parent who lost the email find their status page.
  app.post(
    '/status/lookup',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req) => {
      const { reference, email } = z
        .object({ reference: z.string().trim().toUpperCase().max(20), email: z.string().trim().max(200) })
        .parse(req.body);
      const { rows } = await app.db.query<{ status_token: string }>(
        'SELECT status_token FROM bookings WHERE reference = $1 AND lower(email) = lower($2)',
        [reference, email],
      );
      if (!rows[0]) throw new HttpError(404, 'Geen boeking gevonden met deze referentie en dit e-mailadres.', 'not_found');
      return { token: rows[0].status_token };
    },
  );
};
