import type { Db } from '../db/pool.js';
import { addDays } from '../lib/dates.js';

// A year (or two, three…) after a party the child has a birthday again. The party date stands in
// for the birthday: close enough to know when to get in touch.
export interface Birthday {
  id: string;
  reference: string;
  parentName: string;
  firstName: string;
  childName: string;
  // The age the child turns, when the age at the party is known.
  turning: number | null;
  // Around this date the next birthday falls.
  around: string;
  lastParty: string;
  city: string;
  email: string;
  packageName: string;
}

export const BIRTHDAY_WEEKS_AHEAD = 10;
const DAYS_BACK = 14;

// The first anniversary of the party that is not long past.
function nextAnniversary(partyDate: string, today: string): { date: string; years: number } {
  const from = addDays(today, -DAYS_BACK);
  let years = Math.max(1, Number(from.slice(0, 4)) - Number(partyDate.slice(0, 4)));
  const on = (n: number) => {
    const year = Number(partyDate.slice(0, 4)) + n;
    // 29 February becomes 28 February in other years.
    const day = partyDate.slice(5) === '02-29' && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? '02-28' : partyDate.slice(5);
    return `${year}-${day}`;
  };
  if (on(years) < from) years++;
  return { date: on(years), years };
}

// Customers to get in touch with: their child's birthday is coming up, they have not booked again
// and the owner has not dealt with this year's reminder yet. Who unsubscribed is left alone.
export async function upcomingBirthdays(db: Db, today: string): Promise<Birthday[]> {
  const { rows } = await db.query<Omit<Birthday, 'turning' | 'around'> & { childAge: number | null; handledOn: string | null }>(
    `SELECT DISTINCT ON (lower(b.email), lower(b.child_name))
            b.id, b.reference, b.parent_name AS "parentName", b.first_name AS "firstName", b.child_name AS "childName", b.child_age AS "childAge",
            b.party_date::text AS "lastParty", b.city, b.email, p.name AS "packageName", b.birthday_handled_on::text AS "handledOn"
       FROM bookings b JOIN packages p ON p.id = b.package_id
      WHERE b.email <> '' AND b.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM mail_contacts c WHERE lower(c.email) = lower(b.email) AND c.unsubscribed_at IS NOT NULL)
      ORDER BY lower(b.email), lower(b.child_name), b.party_date DESC`,
  );
  const until = addDays(today, BIRTHDAY_WEEKS_AHEAD * 7);
  const found: Birthday[] = [];
  for (const { childAge, handledOn, ...b } of rows) {
    // The latest party of this child is still to come, or only just over: nothing to remind of.
    if (b.lastParty > addDays(today, -200)) continue;
    const next = nextAnniversary(b.lastParty, today);
    if (next.date > until) continue;
    if (handledOn && handledOn > addDays(next.date, -200)) continue;
    const turning = childAge ? childAge + next.years : null;
    if (turning && turning > 16) continue;
    found.push({ ...b, turning, around: next.date });
  }
  return found.sort((a, b) => a.around.localeCompare(b.around));
}
