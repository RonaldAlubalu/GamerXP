import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { bookingCancelledMail, bookingConfirmedMail } from '../../lib/emails.js';
import { HttpError } from '../../lib/errors.js';
import { bookingStatus, dateString, timeString } from '../../lib/schemas.js';
import { getBookingMailData } from '../../services/bookings.js';

const BOOKING_COLUMNS = `
  b.id, b.reference, b.package_id AS "packageId", p.name AS "packageName",
  b.party_date AS "partyDate", to_char(b.start_time, 'HH24:MI') AS "startTime",
  b.parent_name AS "parentName", b.email, b.phone, b.street, b.postal_code AS "postalCode", b.city,
  b.child_name AS "childName", b.child_age AS "childAge", b.guest_count AS "guestCount",
  b.notes, b.status, b.admin_notes AS "adminNotes", b.created_at AS "createdAt", b.updated_at AS "updatedAt"`;

const idParam = z.object({ id: z.uuid('Ongeldig boekings-ID.') });

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/bookings', async (req) => {
    const q = z
      .object({ status: bookingStatus.optional(), from: dateString.optional(), to: dateString.optional() })
      .parse(req.query);
    const { rows } = await app.db.query(
      `SELECT ${BOOKING_COLUMNS} FROM bookings b JOIN packages p ON p.id = b.package_id
        WHERE ($1::text IS NULL OR b.status = $1)
          AND ($2::date IS NULL OR b.party_date >= $2)
          AND ($3::date IS NULL OR b.party_date <= $3)
        ORDER BY b.party_date, b.start_time`,
      [q.status ?? null, q.from ?? null, q.to ?? null],
    );
    return rows;
  });

  app.get('/bookings/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT ${BOOKING_COLUMNS} FROM bookings b JOIN packages p ON p.id = b.package_id WHERE b.id = $1`,
      [id],
    );
    if (!rows[0]) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');
    return rows[0];
  });

  app.patch('/bookings/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        status: bookingStatus.optional(),
        adminNotes: z.string().max(5000).optional(),
        partyDate: dateString.optional(),
        startTime: timeString.optional(),
        // Set to false to change the status without emailing the parent.
        notifyCustomer: z.boolean().default(true),
      })
      .parse(req.body);

    const before = await app.db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [id]);
    if (!before.rows[0]) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');

    await app.db.query(
      `UPDATE bookings SET
         status      = COALESCE($2, status),
         admin_notes = COALESCE($3, admin_notes),
         party_date  = COALESCE($4, party_date),
         start_time  = COALESCE($5, start_time),
         updated_at  = now()
       WHERE id = $1`,
      [id, body.status ?? null, body.adminNotes ?? null, body.partyDate ?? null, body.startTime ?? null],
    );

    const statusChanged = body.status && body.status !== before.rows[0].status;
    if (statusChanged && body.notifyCustomer && (body.status === 'confirmed' || body.status === 'cancelled')) {
      const data = (await getBookingMailData(app.db, id))!;
      const mail = body.status === 'confirmed' ? bookingConfirmedMail(data) : bookingCancelledMail(data);
      await app.mailer.send(mail).catch((err) => req.log.error({ err }, 'Failed to send status email'));
    }

    const { rows } = await app.db.query(
      `SELECT ${BOOKING_COLUMNS} FROM bookings b JOIN packages p ON p.id = b.package_id WHERE b.id = $1`,
      [id],
    );
    return rows[0];
  });
};
