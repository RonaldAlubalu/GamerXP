import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { generateReference } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import type { BookingMailData } from '../lib/emails.js';
import { bookingWindow, unavailableDates } from './availability.js';

export interface NewBooking {
  packageId: number;
  partyDate: string;
  startTime: string;
  parentName: string;
  email: string;
  phone: string;
  street: string;
  postalCode: string;
  city: string;
  childName: string;
  childAge: number;
  guestCount: number;
  notes: string;
}

export async function createBooking(
  db: Db,
  config: Config,
  input: NewBooking,
): Promise<BookingMailData & { id: string; status: string }> {
  const { minDate, maxDate } = bookingWindow(config);
  if (input.partyDate < minDate || input.partyDate > maxDate) {
    throw new HttpError(422, `Je kunt boeken van ${minDate} tot en met ${maxDate}.`, 'date_out_of_range');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialize bookings per date so two parents can't grab the last slot at once.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('booking:' || $1))", [input.partyDate]);

    const pkg = await client.query<{ name: string }>('SELECT name FROM packages WHERE id = $1 AND active', [
      input.packageId,
    ]);
    if (!pkg.rows[0]) throw new HttpError(422, 'Dit pakket bestaat niet (meer).', 'unknown_package');

    const unavailable = await unavailableDates(client, config, input.partyDate, input.partyDate);
    if (unavailable.length > 0) {
      throw new HttpError(409, 'Deze datum is helaas niet meer beschikbaar. Kies een andere datum.', 'date_unavailable');
    }

    // Retry on the (very unlikely) event of a reference collision.
    for (let attempt = 0; ; attempt++) {
      const reference = generateReference();
      await client.query('SAVEPOINT insert_booking');
      try {
        const { rows } = await client.query<{ id: string; status: string }>(
          `INSERT INTO bookings (reference, package_id, party_date, start_time, parent_name, email, phone,
                                 street, postal_code, city, child_name, child_age, guest_count, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id, status`,
          [
            reference, input.packageId, input.partyDate, input.startTime, input.parentName, input.email,
            input.phone, input.street, input.postalCode, input.city, input.childName, input.childAge,
            input.guestCount, input.notes,
          ],
        );
        await client.query('COMMIT');
        return { ...input, ...rows[0]!, reference, packageName: pkg.rows[0].name };
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
    `SELECT b.reference, p.name AS "packageName", b.party_date AS "partyDate", b.start_time AS "startTime",
            b.parent_name AS "parentName", b.email, b.phone, b.street, b.postal_code AS "postalCode", b.city,
            b.child_name AS "childName", b.child_age AS "childAge", b.guest_count AS "guestCount", b.notes
       FROM bookings b JOIN packages p ON p.id = b.package_id
      WHERE b.id = $1`,
    [id],
  );
  return rows[0];
}
