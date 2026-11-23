import type { FastifyInstance } from 'fastify';
import { daysBetween, formatDutchDate, today } from '../lib/dates.js';
import { HttpError } from '../lib/errors.js';
import type { InvoiceLine } from './bookkeeping.js';
import { formatEuro, statusChangeMail } from '../lib/emails.js';
import { DECORATION_LABEL, getBookingMailData, recalculatePaid } from './bookings.js';
import { sendAndLog } from './communications.js';
import { addEvent } from './pipeline.js';
import { notify } from './push.js';
import { calculatePrice } from './pricing.js';

export type InvoiceKind = 'deposit' | 'final';

// Product codes as they exist in e-Boekhouden, per package.
const PRODUCTS: Record<string, { full: string; deposit: string }> = {
  ultimate: { full: 'GE263', deposit: 'GE262' },
  standaard: { full: 'GE265', deposit: 'GE264' },
};
const EVENING_PRODUCT = 'GE266';
const STATION_PRODUCT = 'GE267';
const DECORATION_PRODUCT = 'GE268';

interface BookingForInvoice {
  id: string; reference: string; status: string; slug: string; packageName: string; packagePriceCents: number;
  extraStations: number; travelKm: number | null; eveningSurcharge: boolean; priceExtras: { label: string; amountCents: number }[];
  depositCents: number; partyDate: string; childName: string;
  parentName: string; email: string; street: string; postalCode: string; city: string;
}

// The lines of the deposit invoice (one line) or of the final invoice (everything, minus the deposit invoiced before).
export function invoiceLines(b: BookingForInvoice, kind: InvoiceKind, depositInvoice: { number: string; amountCents: number } | null, app: FastifyInstance): InvoiceLine[] {
  const products = PRODUCTS[b.slug];
  if (kind === 'deposit') {
    return [{ description: `${b.packageName} - Aanbetaling`, quantity: 1, priceCents: b.depositCents, productCode: products?.deposit }];
  }
  const { lines } = calculatePrice(
    { packageName: b.packageName, packagePriceCents: b.packagePriceCents, extraStations: b.extraStations, travelKm: b.travelKm, eveningSurcharge: b.eveningSurcharge, extras: b.priceExtras },
    app.config,
  );
  const result: InvoiceLine[] = lines
    .filter((l) => l.amountCents !== 0)
    .map((l) => {
      if (l.key === 'package') return { description: b.packageName, quantity: 1, priceCents: l.amountCents, productCode: products?.full };
      if (l.key === 'extra_stations') return { description: 'Extra gamestation', quantity: b.extraStations, priceCents: app.config.EXTRA_STATION_CENTS, productCode: STATION_PRODUCT };
      if (l.key === 'evening') return { description: 'Avondtarief (eindtijd na 19:30)', quantity: 1, priceCents: l.amountCents, productCode: EVENING_PRODUCT };
      if (l.label === DECORATION_LABEL) return { description: 'Decoratie', quantity: 1, priceCents: l.amountCents, productCode: DECORATION_PRODUCT };
      return { description: l.label, quantity: 1, priceCents: l.amountCents };
    });
  if (depositInvoice) {
    result.push({ description: `Reeds gefactureerde aanbetaling (factuur ${depositInvoice.number})`, quantity: 1, priceCents: -depositInvoice.amountCents });
  }
  return result;
}

export async function listInvoices(app: FastifyInstance, bookingId: string) {
  const { rows } = await app.db.query(
    `SELECT kind, number, amount_cents AS "amountCents", paid_cents AS "paidCents", pdf_url AS "pdfUrl", created_at AS "createdAt"
       FROM invoices WHERE booking_id = $1 ORDER BY created_at`,
    [bookingId],
  );
  return rows as { kind: InvoiceKind; number: string; amountCents: number; paidCents: number; pdfUrl: string; createdAt: string }[];
}

// Makes the invoice in the bookkeeping and remembers its number. Each kind exists once per booking.
export async function createInvoice(app: FastifyInstance, bookingId: string, kind: InvoiceKind, actor: string) {
  if (!app.bookkeeping) throw new HttpError(409, 'De koppeling met e-Boekhouden is nog niet ingesteld.', 'not_configured');
  const { rows } = await app.db.query<BookingForInvoice>(
    `SELECT b.id, b.reference, b.status, p.slug, p.name AS "packageName", b.package_price_cents AS "packagePriceCents",
            b.extra_stations AS "extraStations", b.travel_km::float AS "travelKm", b.evening_surcharge AS "eveningSurcharge",
            b.price_extras AS "priceExtras", b.deposit_cents AS "depositCents", b.party_date AS "partyDate", b.child_name AS "childName",
            b.parent_name AS "parentName", b.email, b.street, b.postal_code AS "postalCode", b.city
       FROM bookings b JOIN packages p ON p.id = b.package_id WHERE b.id = $1`,
    [bookingId],
  );
  const b = rows[0];
  if (!b) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');
  if (b.status === 'cancelled') throw new HttpError(409, 'Deze boeking is geannuleerd.', 'cancelled');
  const existing = await listInvoices(app, bookingId);
  if (existing.some((i) => i.kind === kind)) throw new HttpError(409, 'Deze factuur is al gemaakt.', 'exists');
  if (kind === 'deposit' && b.depositCents <= 0) throw new HttpError(409, 'Voor deze boeking is geen aanbetaling ingesteld.', 'no_deposit');
  if (kind === 'final' && b.travelKm === null) throw new HttpError(409, 'Bereken eerst de reiskosten, zodat de factuur het juiste bedrag heeft.', 'no_travel');

  const deposit = existing.find((i) => i.kind === 'deposit') ?? null;
  const lines = invoiceLines(b, kind, deposit, app);
  const amountCents = lines.reduce((sum, l) => sum + Math.round(l.quantity * l.priceCents), 0);
  if (amountCents <= 0) throw new HttpError(409, 'Er valt niets meer te factureren.', 'nothing_due');

  // The business numbers a party's invoices F000NN-1 (deposit) and F000NN-2 (rest).
  const base = /^(F\d+)-\d+$/i.exec(deposit?.number ?? '')?.[1];
  const number = await (base ? Promise.resolve(`${base}-2`) : app.bookkeeping.nextNumberBase().then((b0) => `${b0}-${kind === 'deposit' ? 1 : 2}`)).catch(
    (err: Error) => {
      throw new HttpError(502, `Het volgende factuurnummer kon niet worden bepaald. ${err.message}`, 'bookkeeping_failed');
    },
  );

  const party = `${b.childName ? `Feest van ${b.childName}` : 'Gamer Xperience feest'} op ${formatDutchDate(b.partyDate)}`;
  const created = await app.bookkeeping
    .createInvoice({
      customer: { code: b.reference, name: b.parentName, street: b.street, postalCode: b.postalCode, city: b.city, email: b.email },
      date: today(app.config.TIMEZONE),
      number,
      // The deposit is due within 5 days; the rest on the day of the party.
      termDays: kind === 'deposit' ? 5 : Math.max(0, daysBetween(today(app.config.TIMEZONE), b.partyDate)),
      reference: b.reference,
      text: `${party}. Referentie ${b.reference}.`,
      lines,
    })
    .catch((err: Error) => {
      app.log.error({ err }, 'Creating the invoice failed');
      throw new HttpError(502, `De factuur kon niet worden gemaakt. ${err.message}`, 'bookkeeping_failed');
    });
  await app.db.query(
    'INSERT INTO invoices (booking_id, kind, external_id, number, amount_cents, pdf_url) VALUES ($1, $2, $3, $4, $5, $6)',
    [bookingId, kind, created.id, created.number, amountCents, created.pdfUrl],
  );
  await addEvent(app.db, bookingId, {
    type: 'payment',
    message: `Factuur ${created.number} gemaakt in e-Boekhouden (${kind === 'deposit' ? 'aanbetaling' : 'restbedrag'})`,
    actor,
  });
  return listInvoices(app, bookingId);
}

// Asks the bookkeeping what has been received on the invoices that are still open (for one
// booking, or all of them) and registers new payments, e.g. after the customer paid with the
// QR code on the invoice. Returns how many payments were registered.
export async function syncInvoicePayments(app: FastifyInstance, bookingId?: string): Promise<number> {
  if (!app.bookkeeping) return 0;
  const { rows } = await app.db.query<{ id: number; bookingId: string; kind: InvoiceKind; number: string; amountCents: number; paidCents: number }>(
    `SELECT i.id, i.booking_id AS "bookingId", i.kind, i.number, i.amount_cents AS "amountCents", i.paid_cents AS "paidCents"
       FROM invoices i JOIN bookings b ON b.id = i.booking_id
      WHERE i.paid_cents < i.amount_cents AND b.status <> 'cancelled' AND ($1::uuid IS NULL OR i.booking_id = $1)`,
    [bookingId ?? null],
  );
  let registered = 0;
  for (const invoice of rows) {
    const paid = Math.min(await app.bookkeeping.paidCents(invoice.number), invoice.amountCents);
    if (paid <= invoice.paidCents) continue;
    await app.db.query('UPDATE invoices SET paid_cents = $2 WHERE id = $1', [invoice.id, paid]);

    // Register only what the admin doesn't know yet: a payment noted by hand or paid
    // through the site must not be counted twice.
    const totals = await app.db.query<{ invoiced: number; known: number; status: string; deposit: number }>(
      `SELECT (SELECT coalesce(sum(paid_cents), 0)::int FROM invoices WHERE booking_id = b.id) AS invoiced,
              b.paid_cents AS known, b.status, b.deposit_cents AS deposit FROM bookings b WHERE b.id = $1`,
      [invoice.bookingId],
    );
    const { invoiced, known, status, deposit } = totals.rows[0]!;
    const fresh = Math.min(paid - invoice.paidCents, Math.max(0, invoiced - known));
    if (fresh > 0) {
      await app.db.query(
        `INSERT INTO payments (booking_id, kind, amount_cents, method, paid_on, note, actor)
         VALUES ($1, $2, $3, 'bank', $4, $5, 'e-Boekhouden')`,
        [invoice.bookingId, invoice.kind === 'deposit' ? 'deposit' : 'payment', fresh, today(app.config.TIMEZONE), `Factuur ${invoice.number} betaald`],
      );
      await recalculatePaid(app.db, invoice.bookingId);
      registered++;
    }
    await addEvent(app.db, invoice.bookingId, {
      type: 'payment',
      message: `Factuur ${invoice.number}: ${formatEuro(paid)} ontvangen volgens e-Boekhouden`,
      actor: 'e-Boekhouden',
    });
    void notify(app, {
      title: 'Betaling ontvangen',
      body: `Factuur ${invoice.number} (${invoice.kind === 'deposit' ? 'aanbetaling' : 'restbedrag'}): ${formatEuro(paid)}`,
      url: `#/bookings/${invoice.bookingId}`,
    });

    // A paid deposit makes the party definite, with the usual thank-you email.
    const after = await app.db.query<{ paid: number }>('SELECT paid_cents AS paid FROM bookings WHERE id = $1', [invoice.bookingId]);
    if (invoice.kind === 'deposit' && ['new', 'contacted', 'confirmed'].includes(status) && after.rows[0]!.paid >= deposit) {
      await app.db.query("UPDATE bookings SET status = 'deposit_paid', waiting_on = 'me', updated_at = now() WHERE id = $1", [invoice.bookingId]);
      await addEvent(app.db, invoice.bookingId, { type: 'status', fromStatus: status, toStatus: 'deposit_paid', actor: 'e-Boekhouden' });
      const mail = statusChangeMail('deposit_paid', (await getBookingMailData(app.db, invoice.bookingId))!, { publicUrl: app.config.PUBLIC_URL });
      if (mail) await sendAndLog(app, { bookingId: invoice.bookingId }, mail, 'e-Boekhouden');
      await app.db.query("UPDATE bookings SET waiting_on = 'me' WHERE id = $1", [invoice.bookingId]);
    }
  }
  return registered;
}
