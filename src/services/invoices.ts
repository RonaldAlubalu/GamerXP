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
            b.parent_name AS "parentName", b.email,
            -- The invoice goes to the customer's own address when one is given, else to where the party is.
            CASE WHEN b.billing_street <> '' OR b.billing_city <> '' THEN b.billing_street ELSE b.street END AS street,
            CASE WHEN b.billing_street <> '' OR b.billing_city <> '' THEN b.billing_postal_code ELSE b.postal_code END AS "postalCode",
            CASE WHEN b.billing_street <> '' OR b.billing_city <> '' THEN b.billing_city ELSE b.city END AS city
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

// Invoices in the bookkeeping that are not linked to any booking yet.
export async function unlinkedInvoices(app: FastifyInstance) {
  if (!app.bookkeeping) throw new HttpError(409, 'De koppeling met e-Boekhouden is nog niet ingesteld.', 'not_configured');
  const all = await app.bookkeeping.existingInvoices().catch((err: Error) => {
    throw new HttpError(502, `De facturen konden niet worden opgehaald. ${err.message}`, 'bookkeeping_failed');
  });
  const { rows } = await app.db.query<{ number: string }>('SELECT lower(number) AS number FROM invoices');
  const linked = new Set(rows.map((r) => r.number));
  return all.filter((i) => !linked.has(i.number.toLowerCase())).slice(0, 200);
}

// Links an invoice that was made in the bookkeeping itself (before the site, or by hand) to a
// booking, as its deposit or its final invoice. Nothing changes in the bookkeeping.
export async function linkInvoice(app: FastifyInstance, bookingId: string, kind: InvoiceKind, number: string, amountCents: number | null, actor: string) {
  if (!app.bookkeeping) throw new HttpError(409, 'De koppeling met e-Boekhouden is nog niet ingesteld.', 'not_configured');
  const booking = await app.db.query<{ depositCents: number; priceCents: number }>(
    'SELECT deposit_cents AS "depositCents", price_cents AS "priceCents" FROM bookings WHERE id = $1',
    [bookingId],
  );
  if (!booking.rows[0]) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');
  const existing = await listInvoices(app, bookingId);
  if (existing.some((i) => i.kind === kind)) throw new HttpError(409, 'Deze boeking heeft al zo\'n factuur. Koppel die eerst los.', 'exists');
  const elsewhere = await app.db.query('SELECT 1 FROM invoices WHERE lower(number) = lower($1)', [number.trim()]);
  if (elsewhere.rowCount) throw new HttpError(409, `Factuur ${number.trim()} is al aan een boeking gekoppeld.`, 'linked_elsewhere');

  const found = await app.bookkeeping.findInvoice(number).catch((err: Error) => {
    throw new HttpError(502, `De factuur kon niet worden opgezocht. ${err.message}`, 'bookkeeping_failed');
  });
  if (!found) throw new HttpError(404, `Factuur ${number.trim()} staat niet in e-Boekhouden.`, 'invoice_not_found');

  // The amount: what was typed in, else what the bookkeeping says, else what the booking expects.
  const { depositCents, priceCents } = booking.rows[0];
  const deposit = existing.find((i) => i.kind === 'deposit');
  const expected = kind === 'deposit' ? depositCents : priceCents - (deposit?.amountCents ?? 0);
  const amount = amountCents ?? found.amountCents ?? expected;
  if (amount <= 0) throw new HttpError(422, 'Vul het bedrag van de factuur in.', 'no_amount');

  await app.db.query(
    'INSERT INTO invoices (booking_id, kind, external_id, number, amount_cents, pdf_url) VALUES ($1, $2, $3, $4, $5, $6)',
    [bookingId, kind, found.id, found.number, amount, found.pdfUrl],
  );
  await addEvent(app.db, bookingId, {
    type: 'payment',
    message: `Bestaande factuur ${found.number} gekoppeld (${kind === 'deposit' ? 'aanbetaling' : 'restbedrag'}, ${formatEuro(amount)})`,
    actor,
  });
  return listInvoices(app, bookingId);
}

// Asks the bookkeeping what has been received on the invoices that are still open (for one
// booking, or all of them) and registers new payments, e.g. after the customer paid with the
// QR code on the invoice. Returns how many payments were registered.
export async function syncInvoicePayments(app: FastifyInstance, bookingId?: string): Promise<number> {
  if (!app.bookkeeping) return 0;
  // Open invoices, plus paid ones whose money was never registered here (that happens when the
  // booking already seemed paid at the time, e.g. through a payment that was removed later).
  const { rows } = await app.db.query<{ id: number; bookingId: string; kind: InvoiceKind; number: string; amountCents: number; paidCents: number; registered: number }>(
    `SELECT i.id, i.booking_id AS "bookingId", i.kind, i.number, i.amount_cents AS "amountCents", i.paid_cents AS "paidCents",
            coalesce((SELECT sum(p.amount_cents) FROM payments p WHERE p.booking_id = i.booking_id AND p.invoice_number = i.number), 0)::int AS registered
       FROM invoices i JOIN bookings b ON b.id = i.booking_id
      WHERE b.status <> 'cancelled' AND ($1::uuid IS NULL OR i.booking_id = $1)
        AND (i.paid_cents < i.amount_cents OR b.paid_cents < b.price_cents)
      ORDER BY i.kind = 'deposit' DESC, i.id`,
    [bookingId ?? null],
  );
  // First hear what has come in on every open invoice, then register: that way the order of a
  // booking's invoices does not matter.
  const heard: ((typeof rows)[number] & { paid: number; news: boolean })[] = [];
  for (const invoice of rows) {
    // Only an invoice that is still open needs a question to the bookkeeping.
    const open = invoice.paidCents < invoice.amountCents;
    const paid = open ? Math.min(await app.bookkeeping.paidCents(invoice.number), invoice.amountCents) : invoice.paidCents;
    const news = paid > invoice.paidCents;
    if (news) await app.db.query('UPDATE invoices SET paid_cents = $2 WHERE id = $1', [invoice.id, paid]);
    heard.push({ ...invoice, paid, news });
  }
  let registered = 0;
  for (const invoice of heard) {
    const { paid, news } = invoice;
    if (!news && paid <= invoice.registered) continue;

    // Register only what the admin doesn't know yet: a payment noted by hand or paid
    // through the site must not be counted twice.
    const totals = await app.db.query<{ invoiced: number; known: number; status: string; deposit: number; price: number }>(
      `SELECT (SELECT coalesce(sum(paid_cents), 0)::int FROM invoices WHERE booking_id = b.id) AS invoiced,
              b.paid_cents AS known, b.status, b.deposit_cents AS deposit, b.price_cents AS price FROM bookings b WHERE b.id = $1`,
      [invoice.bookingId],
    );
    const { invoiced, known, status, deposit, price } = totals.rows[0]!;
    const fresh = Math.min(paid - invoice.registered, Math.max(0, invoiced - known), Math.max(0, price - known));
    if (fresh > 0) {
      await app.db.query(
        `INSERT INTO payments (booking_id, kind, amount_cents, method, paid_on, note, actor, invoice_number)
         VALUES ($1, $2, $3, 'bank', $4, $5, 'e-Boekhouden', $6)`,
        [invoice.bookingId, invoice.kind === 'deposit' ? 'deposit' : 'payment', fresh, today(app.config.TIMEZONE), `Factuur ${invoice.number} betaald`, invoice.number],
      );
      await recalculatePaid(app.db, invoice.bookingId);
      registered++;
    }
    if (!news) {
      if (fresh > 0) await addEvent(app.db, invoice.bookingId, { type: 'payment', message: `Factuur ${invoice.number}: ${formatEuro(fresh)} alsnog als betaling geregistreerd`, actor: 'e-Boekhouden' });
      continue;
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
