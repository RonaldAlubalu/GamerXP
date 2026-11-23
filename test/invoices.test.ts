import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
let token: string;
let id: string;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  ctx.app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${token}` }, payload });

beforeEach(async () => {
  ctx = await setupApp();
  token = await loginAdmin(ctx);
  // Ultimate (€350) with one extra station (€25), evening (€50) and 30 km (€30 travel).
  const { rows } = await ctx.db.query("SELECT id FROM packages WHERE slug = 'ultimate'");
  await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { packageId: rows[0].id, extraStations: 1, timeSlot: 'avond' }) });
  id = (await call('GET', '/bookings')).json()[0].id;
});
afterEach(() => teardown(ctx));

describe('invoices in the bookkeeping', () => {
  it('makes a deposit invoice with the deposit product', async () => {
    const res = await call('POST', `/bookings/${id}/invoices`, { kind: 'deposit' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject([{ kind: 'deposit', number: 'F00015-1', amountCents: 10000, pdfUrl: expect.stringContaining('.pdf') }]);
    const [sent] = ctx.invoiced;
    expect(sent!.customer).toMatchObject({ name: 'Sanne de Vries', email: 'sanne@example.nl', city: 'Utrecht' });
    expect(sent!.customer.code).toMatch(/^GXP-/);
    expect(sent!.termDays).toBe(5);
    expect(sent!.lines).toEqual([{ description: 'Ultimate Xperience - Aanbetaling', quantity: 1, priceCents: 10000, productCode: 'GE262' }]);
  });

  it('makes the final invoice with every price line minus the invoiced deposit', async () => {
    await call('POST', `/bookings/${id}/invoices`, { kind: 'deposit' });
    await call('PATCH', `/bookings/${id}`, { priceExtras: [{ label: 'Parkeerkosten', amountCents: 1500 }] });
    const res = await call('POST', `/bookings/${id}/invoices`, { kind: 'final' });
    expect(res.statusCode).toBe(201);
    const lines = ctx.invoiced[1]!.lines;
    expect(lines.map((l) => [l.productCode ?? '-', l.quantity, l.priceCents])).toEqual([
      ['GE263', 1, 35000], ['GE267', 1, 2500], ['-', 1, 3000], ['GE266', 1, 5000], ['-', 1, 1500], ['-', 1, -10000],
    ]);
    // Due on the day of the party (the test booking is 14 days ahead).
    expect(ctx.invoiced[1]!.termDays).toBe(14);
    expect(lines.at(-1)!.description).toBe('Reeds gefactureerde aanbetaling (factuur F00015-1)');
    const detail = (await call('GET', `/bookings/${id}`)).json();
    expect(detail.invoices.map((i: { kind: string; amountCents: number }) => [i.kind, i.amountCents])).toEqual([['deposit', 10000], ['final', 37000]]);
    expect(detail.priceCents).toBe(47000);
    expect(detail.invoices.map((i: { number: string }) => i.number)).toEqual(['F00015-1', 'F00015-2']);
  });

  it('sends the invoice along with an email, making it first when needed', async () => {
    ctx.sent.length = 0;
    const msg = { direction: 'out', channel: 'email', subject: 'Je datum is vrij', body: 'Hoi Sanne, de factuur zit in de bijlage.', send: true, attachInvoice: 'deposit' };
    expect((await call('POST', `/bookings/${id}/messages`, msg)).statusCode).toBe(201);
    expect(ctx.invoiced).toHaveLength(1);
    expect(ctx.sent[0]!.attachments).toEqual([{ filename: 'Factuur F00015-1.pdf', path: 'https://boekhouding.example/1.pdf' }]);
    // A second email reuses the invoice.
    await call('POST', `/bookings/${id}/messages`, msg);
    expect(ctx.invoiced).toHaveLength(1);
    const detail = (await call('GET', `/bookings/${id}`)).json();
    expect(detail.communications[0].body).toContain('[Bijlage: Factuur F00015-1.pdf]');
  });

  it('makes each invoice only once and refuses cancelled bookings', async () => {
    await call('POST', `/bookings/${id}/invoices`, { kind: 'deposit' });
    expect((await call('POST', `/bookings/${id}/invoices`, { kind: 'deposit' })).statusCode).toBe(409);
    await call('PATCH', `/bookings/${id}`, { status: 'cancelled' });
    expect((await call('POST', `/bookings/${id}/invoices`, { kind: 'final' })).statusCode).toBe(409);
    expect(ctx.invoiced).toHaveLength(1);
  });

  it('tells the admin when the bookkeeping refuses', async () => {
    ctx.app.bookkeeping!.createInvoice = async () => { throw new Error('e-Boekhouden: Invoice date is missing. (FACT_011)'); };
    const res = await call('POST', `/bookings/${id}/invoices`, { kind: 'deposit' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('FACT_011');
    expect((await call('GET', `/bookings/${id}`)).json().invoices).toEqual([]);
  });
});
