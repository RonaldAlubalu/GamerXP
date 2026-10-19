import type { FastifyInstance } from 'fastify';
import { formatEuro, statusChangeMail } from '../lib/emails.js';
import { HttpError } from '../lib/errors.js';
import { today } from '../lib/dates.js';
import { getBookingMailData, recalculatePaid } from './bookings.js';
import { sendAndLog } from './communications.js';
import { valueToCents } from './mollie.js';
import { addEvent } from './pipeline.js';

export type OnlineKind = 'deposit' | 'payment';

// Dutch words used in payment links: /betalen/<token>/aanbetaling and /restbedrag.
export const KIND_SLUGS: Record<string, OnlineKind> = { aanbetaling: 'deposit', restbedrag: 'payment' };

interface DueRow {
  id: string;
  reference: string;
  status: string;
  statusToken: string;
  depositCents: number;
  paidCents: number;
  priceCents: number;
}

// What can be paid online right now: the deposit once the date is confirmed,
// and the remaining amount once the deposit is in.
export function amountsDue(b: DueRow): { deposit: number | null; payment: number | null } {
  const depositDue = Math.max(b.depositCents - b.paidCents, 0);
  const outstanding = Math.max(b.priceCents - b.paidCents, 0);
  return {
    deposit: b.status === 'confirmed' && depositDue > 0 ? depositDue : null,
    payment:
      ['deposit_paid', 'scheduled', 'party_held'].includes(b.status) && outstanding > 0 && b.paidCents >= b.depositCents
        ? outstanding
        : null,
  };
}

export async function loadDue(app: FastifyInstance, where: { token: string } | { id: string }): Promise<DueRow | undefined> {
  const { rows } = await app.db.query<DueRow>(
    `SELECT id, reference, status, status_token AS "statusToken", deposit_cents AS "depositCents",
            paid_cents AS "paidCents", price_cents AS "priceCents"
       FROM bookings WHERE ${'token' in where ? 'status_token' : 'id'} = $1`,
    ['token' in where ? where.token : where.id],
  );
  return rows[0];
}

// Stable link for emails and the status page; the Mollie payment is created when it's opened.
export function paymentLink(publicUrl: string, token: string, kind: OnlineKind): string {
  const slug = kind === 'deposit' ? 'aanbetaling' : 'restbedrag';
  return `${publicUrl}/betalen/${encodeURIComponent(token)}/${slug}`;
}

// Mollie can only call webhooks on a public https address.
function webhookUrl(publicUrl: string): string | undefined {
  const url = new URL(publicUrl);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname) || url.hostname.endsWith('.local');
  return url.protocol === 'https:' && !local ? `${publicUrl}/api/mollie/webhook` : undefined;
}

// Creates a Mollie payment (or reuses a recent open one) and returns its checkout URL.
export async function startPayment(app: FastifyInstance, booking: DueRow, kind: OnlineKind): Promise<string> {
  if (!app.mollie) throw new HttpError(503, 'Online betalen is (nog) niet beschikbaar.', 'payments_disabled');
  const amount = amountsDue(booking)[kind];
  if (!amount) throw new HttpError(409, 'Er staat op dit moment niets open om online te betalen.', 'nothing_due');

  const recent = await app.db.query<{ checkout_url: string }>(
    `SELECT checkout_url FROM mollie_payments
      WHERE booking_id = $1 AND kind = $2 AND amount_cents = $3 AND status = 'open'
        AND checkout_url IS NOT NULL AND created_at > now() - interval '30 minutes'
      ORDER BY created_at DESC LIMIT 1`,
    [booking.id, kind, amount],
  );
  if (recent.rows[0]) return recent.rows[0].checkout_url;

  const publicUrl = app.config.PUBLIC_URL;
  const payment = await app.mollie.createPayment({
    amountCents: amount,
    description: `${kind === 'deposit' ? 'Aanbetaling' : 'Restbedrag'} Gamer Xperience ${booking.reference}`,
    redirectUrl: `${publicUrl}/status?t=${encodeURIComponent(booking.statusToken)}&betaling=1`,
    webhookUrl: webhookUrl(publicUrl),
    metadata: { bookingId: booking.id, kind },
  });
  if (!payment.checkoutUrl) throw new HttpError(502, 'Mollie gaf geen betaalpagina terug.', 'mollie_error');
  await app.db.query(
    `INSERT INTO mollie_payments (id, booking_id, kind, amount_cents, status, checkout_url) VALUES ($1, $2, $3, $4, $5, $6)`,
    [payment.id, booking.id, kind, amount, payment.status, payment.checkoutUrl],
  );
  await addEvent(app.db, booking.id, {
    type: 'payment',
    message: `Online betaling gestart: ${kind === 'deposit' ? 'aanbetaling' : 'restbedrag'} ${formatEuro(amount)}`,
    actor: 'Mollie',
  });
  return payment.checkoutUrl;
}

// Fetches the latest status from Mollie and, when paid, registers the payment once.
// Called by the webhook and when the customer returns from the payment page.
export async function syncPayment(app: FastifyInstance, molliePaymentId: string): Promise<void> {
  if (!app.mollie) return;
  const known = await app.db.query<{ booking_id: string; kind: OnlineKind }>(
    'SELECT booking_id, kind FROM mollie_payments WHERE id = $1',
    [molliePaymentId],
  );
  // Ignore ids we didn't create: the webhook can be called by anyone.
  if (!known.rows[0]) return;
  const { booking_id: bookingId, kind } = known.rows[0];

  const payment = await app.mollie.getPayment(molliePaymentId);
  const amountCents = valueToCents(payment.amount.value);

  const client = await app.db.connect();
  let registered = false;
  try {
    await client.query('BEGIN');
    const row = await client.query<{ payment_id: number | null }>(
      'SELECT payment_id FROM mollie_payments WHERE id = $1 FOR UPDATE',
      [molliePaymentId],
    );
    await client.query('UPDATE mollie_payments SET status = $2, updated_at = now() WHERE id = $1', [molliePaymentId, payment.status]);
    if (payment.status === 'paid' && row.rows[0]!.payment_id === null) {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO payments (booking_id, kind, amount_cents, method, paid_on, note, actor)
         VALUES ($1, $2, $3, 'mollie', $4, $5, 'Mollie') RETURNING id`,
        [bookingId, kind, amountCents, today(app.config.TIMEZONE), `Online betaald (${molliePaymentId})`],
      );
      await client.query('UPDATE mollie_payments SET payment_id = $2 WHERE id = $1', [molliePaymentId, inserted.rows[0]!.id]);
      registered = true;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (!registered) return;

  await recalculatePaid(app.db, bookingId);
  await addEvent(app.db, bookingId, {
    type: 'payment',
    message: `Online betaald via Mollie: ${kind === 'deposit' ? 'aanbetaling' : 'restbedrag'} ${formatEuro(amountCents)}`,
    actor: 'Mollie',
  });

  // A paid deposit moves a confirmed booking on to "Aanbetaling ontvangen", with the usual email.
  const booking = await loadDue(app, { id: bookingId });
  if (kind === 'deposit' && booking && ['new', 'contacted', 'confirmed'].includes(booking.status) && booking.paidCents >= booking.depositCents) {
    await app.db.query("UPDATE bookings SET status = 'deposit_paid', waiting_on = 'me', updated_at = now() WHERE id = $1", [bookingId]);
    await addEvent(app.db, bookingId, { type: 'status', fromStatus: booking.status, toStatus: 'deposit_paid', actor: 'Mollie' });
    const mail = statusChangeMail('deposit_paid', (await getBookingMailData(app.db, bookingId))!, { publicUrl: app.config.PUBLIC_URL });
    if (mail) await sendAndLog(app, { bookingId }, mail, 'Mollie');
    // The thank-you email above shouldn't make it look like we're waiting on the customer.
    await app.db.query("UPDATE bookings SET waiting_on = 'me' WHERE id = $1", [bookingId]);
  }
}

// Checks every unfinished Mollie payment of a booking (used when no webhook can reach us).
export async function syncOpenPayments(app: FastifyInstance, bookingId: string): Promise<void> {
  const { rows } = await app.db.query<{ id: string }>(
    `SELECT id FROM mollie_payments WHERE booking_id = $1 AND status IN ('open', 'pending', 'authorized')`,
    [bookingId],
  );
  for (const r of rows) await syncPayment(app, r.id);
}
