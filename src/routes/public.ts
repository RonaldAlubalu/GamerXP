import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { daysBetween } from '../lib/dates.js';
import { bookingOwnerNotification, bookingReceivedMail, contactOwnerNotification, statusUrl } from '../lib/emails.js';
import { HttpError } from '../lib/errors.js';
import type { Mail } from '../lib/mailer.js';
import { bookingRequest, contactRequest, dateString } from '../lib/schemas.js';
import { availableSlots, bookingWindow, getTimeSlots } from '../services/availability.js';
import { createBooking } from '../services/bookings.js';
import { STAGE_INFO, STAGES, stageIndex, type Status } from '../services/pipeline.js';

export const publicRoutes: FastifyPluginAsync = async (app) => {
  // Email problems must never make a booking fail; they are logged instead.
  const sendSafely = (mail: Mail) =>
    app.mailer.send(mail).catch((err) => app.log.error({ err, subject: mail.subject }, 'Failed to send email'));

  app.get('/health', async () => {
    await app.db.query('SELECT 1');
    return { status: 'ok' };
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
    if (from > to) return { ...window, from, to, slots, days: {} };
    if (daysBetween(from, to) > 400) throw new HttpError(400, 'Periode is te lang.');
    return { ...window, from, to, slots, days: await availableSlots(app.db, app.config, from, to) };
  });

  app.post(
    '/bookings',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { termsAccepted: _terms, website: _honeypot, ...input } = bookingRequest.parse(req.body);
      const booking = await createBooking(app.db, app.config, input);

      await sendSafely(bookingReceivedMail(booking, { publicUrl: app.config.PUBLIC_URL }));
      if (app.config.OWNER_EMAIL) {
        await sendSafely(
          bookingOwnerNotification(booking, app.config.OWNER_EMAIL, `${app.config.PUBLIC_URL}/admin/#/bookings/${booking.id}`),
        );
      }

      return reply.status(201).send({
        reference: booking.reference,
        status: booking.status,
        statusUrl: statusUrl(app.config.PUBLIC_URL, booking.statusToken),
      });
    },
  );

  app.post(
    '/contact',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { website: _honeypot, ...msg } = contactRequest.parse(req.body);
      await app.db.query('INSERT INTO contact_messages (name, email, phone, message) VALUES ($1, $2, $3, $4)', [
        msg.name, msg.email, msg.phone, msg.message,
      ]);
      if (app.config.OWNER_EMAIL) await sendSafely(contactOwnerNotification(msg, app.config.OWNER_EMAIL));
      return reply.status(201).send({ ok: true });
    },
  );

  // Parent-facing progress page. Only shows what the parent needs: no address or contact details.
  app.get(
    '/status/:token',
    { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } },
    async (req) => {
      const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.params);
      const { rows } = await app.db.query<{
        reference: string; status: Status; partyDate: string; timeSlot: string; startTime: string | null;
        packageName: string; extraStations: number; childName: string; guestCount: number | null;
        priceCents: number; depositCents: number; paidCents: number;
      }>(
        `SELECT b.reference, b.status, b.party_date AS "partyDate", b.time_slot AS "timeSlot",
                to_char(b.start_time, 'HH24:MI') AS "startTime", p.name AS "packageName", b.extra_stations AS "extraStations", b.child_name AS "childName", b.guest_count AS "guestCount",
                b.price_cents AS "priceCents", b.deposit_cents AS "depositCents", b.paid_cents AS "paidCents"
           FROM bookings b JOIN packages p ON p.id = b.package_id
          WHERE b.status_token = $1`,
        [token],
      );
      const booking = rows[0];
      if (!booking) throw new HttpError(404, 'Deze boeking kunnen we niet vinden.', 'not_found');

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
