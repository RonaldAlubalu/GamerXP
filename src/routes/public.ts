import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { daysBetween } from '../lib/dates.js';
import { bookingOwnerNotification, bookingReceivedMail, contactOwnerNotification } from '../lib/emails.js';
import { HttpError } from '../lib/errors.js';
import type { Mail } from '../lib/mailer.js';
import { bookingRequest, contactRequest, dateString } from '../lib/schemas.js';
import { bookingWindow, unavailableDates } from '../services/availability.js';
import { createBooking } from '../services/bookings.js';

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

  app.get('/availability', async (req) => {
    const window = bookingWindow(app.config);
    const query = z
      .object({ from: dateString.optional(), to: dateString.optional() })
      .parse(req.query);
    const from = query.from && query.from > window.minDate ? query.from : window.minDate;
    const to = query.to && query.to < window.maxDate ? query.to : window.maxDate;
    if (from > to) return { ...window, from, to, unavailable: [] };
    if (daysBetween(from, to) > 400) throw new HttpError(400, 'Periode is te lang.');
    return { ...window, from, to, unavailable: await unavailableDates(app.db, app.config, from, to) };
  });

  app.post(
    '/bookings',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { privacyConsent: _consent, website: _honeypot, ...input } = bookingRequest.parse(req.body);
      const booking = await createBooking(app.db, app.config, input);

      await sendSafely(bookingReceivedMail(booking));
      if (app.config.OWNER_EMAIL) {
        await sendSafely(
          bookingOwnerNotification(booking, app.config.OWNER_EMAIL, `${app.config.PUBLIC_URL}/admin/#/bookings/${booking.id}`),
        );
      }

      return reply.status(201).send({ reference: booking.reference, status: booking.status });
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
};
