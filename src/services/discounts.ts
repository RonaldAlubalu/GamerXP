import type pg from 'pg';
import type { Db } from '../db/pool.js';

export interface Discount {
  code: string;
  percent: number;
}

// The start of the price line a discount code leaves on a booking.
export const DISCOUNT_PREFIX = 'Kortingscode ';

// The code as it counts for a party on this date, or why it does not.
export async function findDiscount(db: Db | pg.PoolClient, code: string, partyDate: string): Promise<{ discount: Discount } | { reason: string }> {
  const { rows } = await db.query<{ code: string; percent: number; validFrom: string | null; validUntil: string | null; active: boolean }>(
    `SELECT code, percent, valid_from::text AS "validFrom", valid_until::text AS "validUntil", active
       FROM discount_codes WHERE upper(code) = upper($1)`,
    [code.trim()],
  );
  const found = rows[0];
  if (!found || !found.active) return { reason: 'Deze kortingscode kennen we niet.' };
  const day = (d: string) => `${Number(d.slice(8, 10))}-${Number(d.slice(5, 7))}-${d.slice(0, 4)}`;
  if (found.validFrom && partyDate < found.validFrom) return { reason: `Deze code geldt voor feestjes vanaf ${day(found.validFrom)}.` };
  if (found.validUntil && partyDate > found.validUntil) return { reason: `Deze code gold voor feestjes tot en met ${day(found.validUntil)}.` };
  return { discount: { code: found.code, percent: found.percent } };
}

// The discount as a price line: a percentage of the package price, nothing else.
export function discountLine(discount: Discount, packagePriceCents: number): { label: string; amountCents: number } {
  return {
    label: `${DISCOUNT_PREFIX}${discount.code} (${discount.percent}% op het pakket)`,
    amountCents: -Math.round((packagePriceCents * discount.percent) / 100),
  };
}
