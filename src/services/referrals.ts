import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../db/pool.js';

type Queryable = Db | pg.PoolClient;

// What recommending is worth. The new customer gets a discount on the package; the customer who
// recommended earns a step per party that has taken place, up to a maximum.
export const REFERRAL_NEW_PERCENT = 10;
export const REWARD_STEP_PERCENT = 5;
export const REWARD_MAX_PERCENT = 25;

export const REFERRAL_LABEL = `Aanbevolen door een klant (${REFERRAL_NEW_PERCENT}% op het pakket)`;
export const REWARD_PREFIX = 'Beloning voor aanbevelen ';
const HELD = "('party_held', 'completed')";

// Any price line that is a percentage of the package: "... (10% op het pakket)".
export const packagePercent = (label: string): number | null => {
  const m = /\((\d+)% op het pakket\)$/.exec(label);
  return m ? Number(m[1]) : null;
};

// The recommending link of one person, made the first time it is needed.
export async function referralToken(db: Queryable, contactId: number): Promise<string> {
  const { rows } = await db.query<{ token: string }>(
    'UPDATE mail_contacts SET referral_token = COALESCE(referral_token, $2) WHERE id = $1 RETURNING referral_token AS token',
    [contactId, randomBytes(9).toString('base64url')],
  );
  return rows[0]!.token;
}

// Who is behind a recommending link.
export async function findReferrer(db: Queryable, token: string): Promise<{ id: number; email: string } | null> {
  const { rows } = await db.query<{ id: number; email: string }>('SELECT id, email FROM mail_contacts WHERE referral_token = $1', [token]);
  return rows[0] ?? null;
}

export interface Reward {
  // Recommended parties that have taken place and are not cashed in yet.
  held: number;
  // Recommended bookings whose party is still to come.
  upcoming: number;
  // What that is worth on the next party of this customer.
  percent: number;
}

export async function rewardOf(db: Queryable, contactId: number): Promise<Reward> {
  const { rows } = await db.query<{ held: number; upcoming: number }>(
    `SELECT count(*) FILTER (WHERE status IN ${HELD} AND referral_redeemed_on IS NULL)::int AS held,
            count(*) FILTER (WHERE status NOT IN ${HELD} AND status <> 'cancelled')::int AS upcoming
       FROM bookings WHERE referred_by = $1`,
    [contactId],
  );
  const { held, upcoming } = rows[0]!;
  return { held, upcoming, percent: Math.min(REWARD_MAX_PERCENT, held * REWARD_STEP_PERCENT) };
}

// Cashes the reward in on one booking: the recommendations it was built from are used up.
export async function redeemReward(db: Queryable, contactId: number, bookingId: string): Promise<number> {
  const steps = REWARD_MAX_PERCENT / REWARD_STEP_PERCENT;
  const { rowCount } = await db.query(
    `UPDATE bookings SET referral_redeemed_on = $2 WHERE id IN (
       SELECT id FROM bookings WHERE referred_by = $1 AND status IN ${HELD} AND referral_redeemed_on IS NULL ORDER BY party_date, created_at LIMIT ${steps})`,
    [contactId, bookingId],
  );
  return Math.min(REWARD_MAX_PERCENT, (rowCount ?? 0) * REWARD_STEP_PERCENT);
}
