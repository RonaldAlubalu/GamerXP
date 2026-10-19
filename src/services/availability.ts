import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { addDays, today } from '../lib/dates.js';
import type pg from 'pg';

// Statuses that occupy a party setup on their date.
export const OCCUPYING_STATUSES = ['pending', 'confirmed'] as const;

export function bookingWindow(config: Config, now?: Date): { minDate: string; maxDate: string } {
  const t = today(config.TIMEZONE, now);
  return { minDate: addDays(t, config.MIN_LEAD_DAYS), maxDate: addDays(t, config.MAX_ADVANCE_DAYS) };
}

// Returns the dates between from and to (inclusive) that cannot be booked:
// blocked dates and dates that are fully booked.
export async function unavailableDates(
  db: Db | pg.PoolClient,
  config: Config,
  from: string,
  to: string,
): Promise<string[]> {
  const { rows } = await db.query<{ date: string }>(
    `SELECT date FROM blocked_dates WHERE date BETWEEN $1 AND $2
     UNION
     SELECT party_date AS date FROM bookings
      WHERE party_date BETWEEN $1 AND $2 AND status = ANY($3)
      GROUP BY party_date HAVING count(*) >= $4
     ORDER BY date`,
    [from, to, OCCUPYING_STATUSES, config.DAILY_CAPACITY],
  );
  return rows.map((r) => r.date);
}
