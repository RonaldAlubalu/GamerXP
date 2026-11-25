import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../db/pool.js';

export interface Discount {
  code: string;
  percent: number;
}

type Queryable = Db | pg.PoolClient;
type Found = { discount: Discount } | { reason: string };

// The start of the price line a discount code leaves on a booking.
export const DISCOUNT_PREFIX = 'Kortingscode ';

interface CodeRow { code: string; percent: number; validFrom: string | null; validUntil: string | null; active: boolean; personal: boolean }
const CODE_COLUMNS = `d.code, d.percent, d.valid_from::text AS "validFrom", d.valid_until::text AS "validUntil", d.active, d.personal`;

// Whether the code counts for a party on this date.
function inPeriod(found: CodeRow, partyDate: string): Found {
  if (!found.active) return { reason: 'Deze korting is niet meer geldig.' };
  const day = (d: string) => `${Number(d.slice(8, 10))}-${Number(d.slice(5, 7))}-${d.slice(0, 4)}`;
  if (found.validFrom && partyDate < found.validFrom) return { reason: `Deze korting geldt voor feestjes vanaf ${day(found.validFrom)}.` };
  if (found.validUntil && partyDate > found.validUntil) return { reason: `Deze korting gold voor feestjes tot en met ${day(found.validUntil)}.` };
  return { discount: { code: found.code, percent: found.percent } };
}

// A code that was typed in. A personal code is refused here: it only works through its link.
export async function findDiscount(db: Queryable, code: string, partyDate: string): Promise<Found> {
  const { rows } = await db.query<CodeRow>(`SELECT ${CODE_COLUMNS} FROM discount_codes d WHERE upper(d.code) = upper($1)`, [code.trim()]);
  const found = rows[0];
  if (!found || !found.active) return { reason: 'Deze kortingscode kennen we niet.' };
  if (found.personal) return { reason: 'Deze korting werkt alleen via de persoonlijke link uit je mail.' };
  return inPeriod(found, partyDate);
}

// A personal link from a mailing: good for one booking, as long as that booking stands.
export async function findDiscountByLink(db: Queryable, token: string, partyDate: string | null): Promise<Found> {
  const { rows } = await db.query<CodeRow & { used: boolean }>(
    `SELECT ${CODE_COLUMNS}, EXISTS (SELECT 1 FROM bookings b WHERE b.discount_link = l.token AND b.status <> 'cancelled') AS used
       FROM discount_links l JOIN discount_codes d ON d.id = l.code_id WHERE l.token = $1`,
    [token],
  );
  const found = rows[0];
  if (!found) return { reason: 'Deze kortingslink kennen we niet.' };
  if (found.used) return { reason: 'Deze kortingslink is al voor een feestje gebruikt.' };
  // Without a date yet, only say what the link is worth.
  if (!partyDate) return found.active ? { discount: { code: found.code, percent: found.percent } } : { reason: 'Deze korting is niet meer geldig.' };
  return inPeriod(found, partyDate);
}

// The personal link of one person for one discount: made the first time it is needed.
export async function personalLinkToken(db: Queryable, codeId: number, contactId: number, note = 'Mailing'): Promise<string> {
  // A link that is still unused is given again, so sending twice does not hand out two discounts.
  const open = await db.query<{ token: string }>(
    `SELECT l.token FROM discount_links l
      WHERE l.code_id = $1 AND l.contact_id = $2 AND l.booking_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.discount_link = l.token AND b.status <> 'cancelled')
      ORDER BY l.created_at LIMIT 1`,
    [codeId, contactId],
  );
  if (open.rows[0]) return open.rows[0].token;
  const { rows } = await db.query<{ token: string }>(
    'INSERT INTO discount_links (token, code_id, contact_id, note) VALUES ($1, $2, $3, $4) RETURNING token',
    [randomBytes(12).toString('base64url'), codeId, contactId, note],
  );
  return rows[0]!.token;
}

// The person behind an e-mail address on the mailing list; added when not there yet.
export async function contactFor(db: Queryable, email: string, name: string, note: string): Promise<{ id: number; unsubscribed: boolean }> {
  const { rows } = await db.query<{ id: number; unsubscribed: boolean }>(
    `INSERT INTO mail_contacts (email, name, note, token) VALUES ($1, $2, $3, $4)
     ON CONFLICT (lower(email)) DO UPDATE SET name = CASE WHEN mail_contacts.name = '' THEN EXCLUDED.name ELSE mail_contacts.name END
     RETURNING id, unsubscribed_at IS NOT NULL AS unsubscribed`,
    [email, name, note, randomBytes(18).toString('base64url')],
  );
  return rows[0]!;
}

// The thank-you link of a booking by a returning customer: one per booking, good for one party.
export async function thankYouLink(db: Queryable, bookingId: string, codeId: number, contactId: number): Promise<{ token: string; fresh: boolean }> {
  const existing = await db.query<{ token: string }>('SELECT token FROM discount_links WHERE booking_id = $1', [bookingId]);
  if (existing.rows[0]) return { token: existing.rows[0].token, fresh: false };
  const { rows } = await db.query<{ token: string }>(
    `INSERT INTO discount_links (token, code_id, contact_id, note, booking_id) VALUES ($1, $2, $3, 'Bedankje terugkerende klant', $4) RETURNING token`,
    [randomBytes(12).toString('base64url'), codeId, contactId, bookingId],
  );
  return { token: rows[0]!.token, fresh: true };
}

// The discount as a price line: a percentage of the package price, nothing else.
export function discountLine(discount: Discount, packagePriceCents: number): { label: string; amountCents: number } {
  return {
    label: `${DISCOUNT_PREFIX}${discount.code} (${discount.percent}% op het pakket)`,
    amountCents: -Math.round((packagePriceCents * discount.percent) / 100),
  };
}
