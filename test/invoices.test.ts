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

  it('sends the invoice to the customer\'s own address when the party is somewhere else', async () => {
    await call('PATCH', `/bookings/${id}/contact`, { locationName: 'Zaal De Hoek', billingStreet: 'Thuisstraat 9', billingPostalCode: '5611 AA', billingCity: 'Eindhoven' });
    await call('POST', `/bookings/${id}/invoices`, { kind: 'deposit' });
    expect(ctx.invoiced[0]!.customer).toMatchObject({ street: 'Thuisstraat 9', postalCode: '5611 AA', city: 'Eindhoven' });
    const detail = (await call('GET', `/bookings/${id}`)).json();
    expect(detail).toMatchObject({ locationName: 'Zaal De Hoek', billingCity: 'Eindhoven' });
    expect(detail.city).not.toBe('');
  });

  it('shows the customer the invoices on the status page, with the PDF behind the status link', async () => {
    await call('POST', `/bookings/${id}/invoices`, { kind: 'deposit' });
    await call('PATCH', `/bookings/${id}`, { status: 'confirmed', notifyCustomer: false });
    const token = (await call('GET', `/bookings/${id}`)).json().statusToken;
    const status = (await ctx.app.inject({ url: `/api/status/${token}` })).json();
    expect(status.pay).toEqual({ deposit: null, payment: null });
    expect(status.invoices).toEqual([{ kind: 'deposit', number: 'F00015-1', amountCents: 10000, paidCents: 0, url: `/api/status/${token}/invoice/deposit` }]);

    // The PDF comes from the bookkeeping through this site; only with the right link.
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => { asked.push(String(url)); return new Response('%PDF-1.4 test', { status: 200 }); }) as typeof fetch;
    try {
      const pdf = await ctx.app.inject({ url: status.invoices[0].url });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(pdf.headers['content-disposition']).toContain('Factuur F00015-1.pdf');
      expect(pdf.body).toContain('%PDF');
      expect(asked).toEqual(['https://boekhouding.example/1.pdf']);
      expect((await ctx.app.inject({ url: `/api/status/${token}/invoice/final` })).statusCode).toBe(404);
      expect((await ctx.app.inject({ url: `/api/status/${'x'.repeat(30)}/invoice/deposit` })).statusCode).toBe(404);
    } finally {
      globalThis.fetch = realFetch;
    }
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

  it('registers a payment the bookkeeping reports, once, and makes the party definite', async () => {
    await call('POST', `/bookings/${id}/invoices`, { kind: 'deposit' });
    await call('PATCH', `/bookings/${id}`, { status: 'confirmed' });
    ctx.sent.length = 0;
    expect((await call('POST', `/bookings/${id}/invoices/sync`)).json()).toEqual({ registered: 0 });

    ctx.received.set('F00015-1', 10000);
    expect((await call('POST', `/bookings/${id}/invoices/sync`)).json()).toEqual({ registered: 1 });
    expect((await call('POST', `/bookings/${id}/invoices/sync`)).json()).toEqual({ registered: 0 });
    const detail = (await call('GET', `/bookings/${id}`)).json();
    expect(detail).toMatchObject({ status: 'deposit_paid', paidCents: 10000 });
    expect(detail.invoices[0]).toMatchObject({ paidCents: 10000 });
    expect(detail.payments).toHaveLength(1);
    expect(ctx.sent.map((m) => m.subject).join()).toContain('Aanbetaling ontvangen');
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.pushed).toEqual([]); // no device subscribed, so nothing was sent
  });

  it('does not count a payment twice when it was already noted by hand', async () => {
    await call('POST', `/bookings/${id}/invoices`, { kind: 'deposit' });
    await call('POST', `/bookings/${id}/payments`, { kind: 'deposit', amountCents: 10000, method: 'bank', paidOn: '2026-11-01' });
    ctx.received.set('F00015-1', 10000);
    expect((await call('POST', `/bookings/${id}/invoices/sync`)).json()).toEqual({ registered: 0 });
    const detail = (await call('GET', `/bookings/${id}`)).json();
    expect(detail.paidCents).toBe(10000);
    expect(detail.invoices[0].paidCents).toBe(10000);
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

describe('linking an invoice that already exists in the bookkeeping', () => {
  let ctx: TestContext;
  let token: string;
  let bookingId: string;
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${token}` }, payload });

  beforeEach(async () => {
    ctx = await setupApp();
    token = await loginAdmin(ctx);
    const { termsAccepted: _t, ...body } = bookingBody(ctx);
    bookingId = (await call('POST', '/bookings', body)).json().id;
  });
  afterEach(() => teardown(ctx));

  it('lists the free invoices, links one with its amount and picks up a payment', async () => {
    expect((await call('GET', '/invoices/unlinked')).json().map((i: { number: string }) => i.number)).toEqual(['F00013-2', 'F00013-1']);

    const linked = await call('POST', `/bookings/${bookingId}/invoices/link`, { kind: 'deposit', number: 'f00013-1' });
    expect(linked.statusCode).toBe(201);
    expect(linked.json()[0]).toMatchObject({ kind: 'deposit', number: 'F00013-1', amountCents: 10000 });
    expect(ctx.invoiced).toHaveLength(0);
    expect((await call('GET', '/invoices/unlinked')).json()).toHaveLength(1);

    // The same invoice can't belong to two bookings, and a number that doesn't exist is refused.
    expect((await call('POST', `/bookings/${bookingId}/invoices/link`, { kind: 'final', number: 'F00013-1' })).json().code).toBe('linked_elsewhere');
    expect((await call('POST', `/bookings/${bookingId}/invoices/link`, { kind: 'final', number: 'F99999-9' })).json().code).toBe('invoice_not_found');

    // Without a total in the bookkeeping, a typed amount is used.
    const rest = await call('POST', `/bookings/${bookingId}/invoices/link`, { kind: 'final', number: 'F00013-2', amountCents: 27500 });
    expect(rest.json().find((i: { kind: string }) => i.kind === 'final').amountCents).toBe(27500);

    ctx.received.set('F00013-1', 10000);
    expect((await call('POST', `/bookings/${bookingId}/invoices/sync`)).json().registered).toBe(1);
  });

  it('registers a part of an invoice that was paid, and the rest later', async () => {
    const price = (await call('GET', `/bookings/${bookingId}`)).json().priceCents;
    await call('POST', `/bookings/${bookingId}/invoices/link`, { kind: 'final', number: 'F00013-2', amountCents: price });
    ctx.received.set('F00013-2', 10000);
    expect((await call('POST', `/bookings/${bookingId}/invoices/sync`)).json()).toEqual({ registered: 1 });
    let detail = (await call('GET', `/bookings/${bookingId}`)).json();
    expect(detail).toMatchObject({ paidCents: 10000, outstandingCents: price - 10000 });
    expect(detail.payments).toHaveLength(1);

    ctx.received.set('F00013-2', price);
    expect((await call('POST', `/bookings/${bookingId}/invoices/sync`)).json()).toEqual({ registered: 1 });
    detail = (await call('GET', `/bookings/${bookingId}`)).json();
    expect(detail).toMatchObject({ paidCents: price, outstandingCents: 0 });
    expect(detail.payments.map((p: { amountCents: number }) => p.amountCents).sort((a: number, b: number) => a - b)).toEqual([10000, price - 10000]);
  });

  it('still registers the other invoices when the bookkeeping fails on one', async () => {
    const { syncInvoicePayments } = await import('../src/services/invoices.js');
    const price = (await call('GET', `/bookings/${bookingId}`)).json().priceCents;
    await call('POST', `/bookings/${bookingId}/invoices/link`, { kind: 'deposit', number: 'F00013-1' });
    await call('POST', `/bookings/${bookingId}/invoices/link`, { kind: 'final', number: 'F00013-2', amountCents: price - 10000 });
    ctx.received.set('F00013-2', 5000);
    const ask = ctx.app.bookkeeping!.paidCents;
    ctx.app.bookkeeping!.paidCents = async (number) => {
      if (number === 'F00013-1') throw new Error('e-Boekhouden is even niet bereikbaar');
      return ask(number);
    };
    // The round every ten minutes goes on with the rest; a look at one booking reports the problem.
    expect(await syncInvoicePayments(ctx.app)).toBe(1);
    expect((await call('GET', `/bookings/${bookingId}`)).json().paidCents).toBe(5000);
    expect((await call('POST', `/bookings/${bookingId}/invoices/sync`)).statusCode).toBe(502);
    ctx.app.bookkeeping!.paidCents = ask;
  });

  it('counts every paid invoice once, also after unlinking and linking again', async () => {
    const rest = (await call('GET', `/bookings/${bookingId}`)).json().priceCents - 10000;
    // The rest was linked and paid first, then unlinked; its payment stays.
    await call('POST', `/bookings/${bookingId}/invoices/link`, { kind: 'final', number: 'F00013-2', amountCents: rest });
    ctx.received.set('F00013-2', rest);
    ctx.received.set('F00013-1', 10000);
    await call('POST', `/bookings/${bookingId}/invoices/sync`);
    await call('DELETE', `/bookings/${bookingId}/invoices/final`);

    // The deposit invoice is linked while the booking already holds more than that.
    await call('POST', `/bookings/${bookingId}/invoices/link`, { kind: 'deposit', number: 'F00013-1' });
    await call('POST', `/bookings/${bookingId}/invoices/sync`);
    await call('POST', `/bookings/${bookingId}/invoices/link`, { kind: 'final', number: 'F00013-2', amountCents: rest });
    await call('POST', `/bookings/${bookingId}/invoices/sync`);

    const detail = (await call('GET', `/bookings/${bookingId}`)).json();
    expect(detail.invoices.map((i: { paidCents: number }) => i.paidCents).sort((a: number, b: number) => a - b)).toEqual([10000, rest]);
    expect(detail.paidCents).toBe(rest + 10000);
    expect(detail.payments.map((p: { amountCents: number; note: string }) => `${p.amountCents} ${p.note}`).sort()).toEqual(['10000 Factuur F00013-1 betaald', `${rest} Factuur F00013-2 betaald`]);
    // And nothing more on a later look.
    expect((await call('POST', `/bookings/${bookingId}/invoices/sync`)).json()).toEqual({ registered: 0 });
    expect((await call('GET', `/bookings/${bookingId}`)).json().paidCents).toBe(rest + 10000);
  });
});
