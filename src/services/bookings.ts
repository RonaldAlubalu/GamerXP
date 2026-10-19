import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { generateReference, generateSessionToken } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import type { BookingMailData } from '../lib/emails.js';
import { availableSlots, bookingWindow } from './availability.js';
import { addEvent, createDefaultTasks } from './pipeline.js';

export interface NewBooking {
  packageId: number;
  extraStations: number;
  partyDate: string;
  timeSlot: 'ochtend' | 'middag' | 'avond';
  parentName: string;
  email: string;
  phone: string;
  street: string;
  postalCode: string;
  city: string;
  childName: string;
  childAge?: number;
  guestCount?: number;
  notes: string;
}

export async function createBooking(
  db: Db,
  config: Config,
  input: NewBooking,
): Promise<BookingMailData & { id: string; status: string }> {
  const { minDate, maxDate } = await bookingWindow(db, config);
  if (input.partyDate < minDate || input.partyDate > maxDate) {
    throw new HttpError(422, `Je kunt boeken van ${minDate} tot en met ${maxDate}.`, 'date_out_of_range');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialize bookings per date so two parents can't grab the last slot at once.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('booking:' || $1))", [input.partyDate]);

    const pkg = await client.query<{ name: string; price_cents: number }>(
      'SELECT name, price_cents FROM packages WHERE id = $1 AND active',
      [input.packageId],
    );
    if (!pkg.rows[0]) throw new HttpError(422, 'Dit pakket bestaat niet (meer).', 'unknown_package');

    const free = await availableSlots(client, config, input.partyDate, input.partyDate);
    if (!free[input.partyDate]?.includes(input.timeSlot)) {
      throw new HttpError(
        409,
        'Dit tijdslot is helaas niet (meer) beschikbaar. Kies een ander moment.',
        'slot_unavailable',
      );
    }

    // Price is fixed at booking time: package plus extra stations. Travel costs and
    // an evening surcharge are agreed afterwards and added in the admin page.
    const priceCents = pkg.rows[0].price_cents + input.extraStations * config.EXTRA_STATION_CENTS;

    // Retry on the (very unlikely) event of a reference collision.
    for (let attempt = 0; ; attempt++) {
      const reference = generateReference();
      const statusToken = generateSessionToken();
      await client.query('SAVEPOINT insert_booking');
      try {
        const { rows } = await client.query<{ id: string; status: string }>(
          `INSERT INTO bookings (reference, package_id, extra_stations, party_date, time_slot, parent_name, email,
                                 phone, street, postal_code, city, child_name, child_age, guest_count, notes,
                                 price_cents, deposit_cents, status_token)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           RETURNING id, status`,
          [
            reference, input.packageId, input.extraStations, input.partyDate, input.timeSlot, input.parentName,
            input.email, input.phone, input.street, input.postalCode, input.city, input.childName,
            input.childAge ?? null, input.guestCount ?? null, input.notes, priceCents, config.DEPOSIT_CENTS,
            statusToken,
          ],
        );
        const booking = rows[0]!;
        await createDefaultTasks(client, booking.id);
        await addEvent(client, booking.id, { type: 'created', toStatus: booking.status, actor: input.parentName });
        await client.query('COMMIT');
        return {
          ...input,
          ...booking,
          reference,
          statusToken,
          startTime: null,
          packageName: pkg.rows[0].name,
          priceCents,
          depositCents: config.DEPOSIT_CENTS,
        };
      } catch (err) {
        if ((err as { code?: string }).code === '23505' && attempt < 5) {
          await client.query('ROLLBACK TO SAVEPOINT insert_booking');
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Loads a booking in the shape the email templates expect.
export async function getBookingMailData(db: Db, id: string): Promise<BookingMailData | undefined> {
  const { rows } = await db.query<BookingMailData>(
    `SELECT b.reference, p.name AS "packageName", b.party_date AS "partyDate", to_char(b.start_time, 'HH24:MI') AS "startTime",
            b.time_slot AS "timeSlot", b.extra_stations AS "extraStations",
            b.parent_name AS "parentName", b.email, b.phone, b.street, b.postal_code AS "postalCode", b.city,
            b.child_name AS "childName", b.child_age AS "childAge", b.guest_count AS "guestCount", b.notes,
            b.status_token AS "statusToken", b.price_cents AS "priceCents", b.deposit_cents AS "depositCents",
            b.paid_cents AS "paidCents"
       FROM bookings b JOIN packages p ON p.id = b.package_id
      WHERE b.id = $1`,
    [id],
  );
  return rows[0];
}
