import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { addDays, today } from '../lib/dates.js';
import type pg from 'pg';

export function bookingWindow(config: Config, now?: Date): { minDate: string; maxDate: string } {
  const t = today(config.TIMEZONE, now);
  return { minDate: addDays(t, config.MIN_LEAD_DAYS), maxDate: addDays(t, config.MAX_ADVANCE_DAYS) };
}

// Returns the dates between from and to (inclusive) that cannot be booked:
// blocked dates and dates that are fully booked (every booking except a
// cancelled one occupies a party setup).
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
      WHERE party_date BETWEEN $1 AND $2 AND status <> 'cancelled'
      GROUP BY party_date HAVING count(*) >= $3
     ORDER BY date`,
    [from, to, config.DAILY_CAPACITY],
  );
  return rows.map((r) => r.date);
}
