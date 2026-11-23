import type { FastifyInstance } from 'fastify';
import { formatDutchDate, today } from '../lib/dates.js';
import { HttpError } from '../lib/errors.js';
import type { InvoiceLine } from './bookkeeping.js';
import { addEvent } from './pipeline.js';
import { calculatePrice } from './pricing.js';

export type InvoiceKind = 'deposit' | 'final';

// Product codes as they exist in e-Boekhouden, per package.
const PRODUCTS: Record<string, { full: string; deposit: string }> = {
  ultimate: { full: 'GE263', deposit: 'GE262' },
  standaard: { full: 'GE265', deposit: 'GE264' },
};
const EVENING_PRODUCT = 'GE266';
const STATION_PRODUCT = 'GE267';

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
      return { description: l.label, quantity: 1, priceCents: l.amountCents };
    });
  if (depositInvoice) {
    result.push({ description: `Reeds gefactureerde aanbetaling (factuur ${depositInvoice.number})`, quantity: 1, priceCents: -depositInvoice.amountCents });
  }
  return result;
}

export async function listInvoices(app: FastifyInstance, bookingId: string) {
  const { rows } = await app.db.query(
    `SELECT kind, number, amount_cents AS "amountCents", pdf_url AS "pdfUrl", created_at AS "createdAt"
       FROM invoices WHERE booking_id = $1 ORDER BY created_at`,
    [bookingId],
  );
  return rows as { kind: InvoiceKind; number: string; amountCents: number; pdfUrl: string; createdAt: string }[];
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

  const party = `${b.childName ? `Feest van ${b.childName}` : 'Gamer Xperience feest'} op ${formatDutchDate(b.partyDate)}`;
  const created = await app.bookkeeping
    .createInvoice({
      customer: { code: b.reference, name: b.parentName, street: b.street, postalCode: b.postalCode, city: b.city, email: b.email },
      date: today(app.config.TIMEZONE),
      termDays: kind === 'deposit' ? 5 : 14,
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
