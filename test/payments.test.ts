import { afterEach, describe, expect, it } from 'vitest';
import { bookingBody, fakeMollie, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => teardown(ctx));

async function setup(withMollie = true) {
  const mollie = fakeMollie();
  ctx = await setupApp({ PUBLIC_URL: 'https://gamerxp.nl' }, withMollie ? mollie.client : null);
  const token = await loginAdmin(ctx);
  const auth = { authorization: `Bearer ${token}` };
  const created = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
  const statusToken = new URL(created.json().statusUrl).searchParams.get('t')!;
  const [booking] = (await ctx.app.inject({ url: '/api/admin/bookings', headers: auth })).json();
  const patch = (payload: object) => ctx.app.inject({ method: 'PATCH', url: `/api/admin/bookings/${booking.id}`, headers: auth, payload });
  const status = async () => (await ctx.app.inject(`/api/status/${statusToken}`)).json();
  const detail = async () => (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth })).json();
  const webhook = (id: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/mollie/webhook', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `id=${id}` });
  return { mollie, auth, booking, statusToken, patch, status, detail, webhook };
}

describe('online payments with Mollie', () => {
  it('offers the deposit online once the booking is confirmed, with a link in the email', async () => {
    const t = await setup();
    expect((await t.status()).pay).toEqual({ deposit: null, payment: null });

    ctx.sent.length = 0;
    await t.patch({ status: 'confirmed' });
    expect(ctx.sent[0]!.text).toContain(`https://gamerxp.nl/betalen/${t.statusToken}/aanbetaling`);
    expect((await t.status()).pay.deposit).toEqual({ amountCents: 10000, url: `/betalen/${t.statusToken}/aanbetaling` });
  });

  it('sends the customer to Mollie and reuses an open payment', async () => {
    const t = await setup();
    await t.patch({ status: 'confirmed', notifyCustomer: false });

    const first = await ctx.app.inject(`/betalen/${t.statusToken}/aanbetaling`);
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe('https://www.mollie.com/checkout/tr_test1');
    const created = t.mollie.payments.get('tr_test1')!;
    expect(created).toMatchObject({
      amount: { value: '100.00' },
      redirectUrl: `https://gamerxp.nl/status?t=${t.statusToken}&betaling=1`,
      webhookUrl: 'https://gamerxp.nl/api/mollie/webhook',
      metadata: { bookingId: t.booking.id, kind: 'deposit' },
    });
    expect((await ctx.app.inject(`/betalen/${t.statusToken}/aanbetaling`)).headers.location).toBe(first.headers.location);
  });

  it('registers a paid deposit once and moves the booking on', async () => {
    const t = await setup();
    await t.patch({ status: 'confirmed', notifyCustomer: false });
    await ctx.app.inject(`/betalen/${t.statusToken}/aanbetaling`);
    ctx.sent.length = 0;

    // Still open: nothing happens.
    await t.webhook('tr_test1');
    expect((await t.detail()).paidCents).toBe(0);

    t.mollie.pay('tr_test1');
    expect((await t.webhook('tr_test1')).statusCode).toBe(200);
    await t.webhook('tr_test1'); // Mollie may call more than once

    const d = await t.detail();
    expect(d).toMatchObject({ status: 'deposit_paid', paidCents: 10000, depositPaid: true, waitingOn: 'me' });
    expect(d.payments).toEqual([expect.objectContaining({ kind: 'deposit', amountCents: 10000, method: 'mollie' })]);
    expect(d.molliePayments).toEqual([expect.objectContaining({ id: 'tr_test1', status: 'paid' })]);
    expect(ctx.sent.map((m) => m.subject)).toEqual([expect.stringContaining('Aanbetaling ontvangen')]);
  });

  it('checks the payment when the customer returns, without a webhook', async () => {
    const t = await setup();
    await t.patch({ status: 'confirmed', notifyCustomer: false });
    await ctx.app.inject(`/betalen/${t.statusToken}/aanbetaling`);
    t.mollie.pay('tr_test1');
    const synced = await ctx.app.inject({ method: 'POST', url: `/api/status/${t.statusToken}/sync` });
    expect(synced.json()).toEqual({ latest: 'paid' });
    expect((await t.status()).status).toBe('deposit_paid');
  });

  it('lets the customer pay the remaining amount after the deposit', async () => {
    const t = await setup();
    await t.patch({ status: 'confirmed', notifyCustomer: false });
    await ctx.app.inject(`/betalen/${t.statusToken}/aanbetaling`);
    t.mollie.pay('tr_test1');
    await t.webhook('tr_test1');

    expect((await t.status()).pay).toEqual({
      deposit: null,
      payment: { amountCents: 20500, url: `/betalen/${t.statusToken}/restbedrag` },
    });
    await ctx.app.inject(`/betalen/${t.statusToken}/restbedrag`);
    t.mollie.pay('tr_test2');
    await t.webhook('tr_test2');
    expect(await t.detail()).toMatchObject({ status: 'deposit_paid', paidCents: 30500, outstandingCents: 0 });
    expect((await t.status()).pay).toEqual({ deposit: null, payment: null });
  });

  it('ignores webhooks for unknown or invalid payments', async () => {
    const t = await setup();
    expect((await t.webhook('tr_unknown')).statusCode).toBe(200);
    expect((await t.webhook('nonsense')).statusCode).toBe(200);
    expect((await t.detail()).paidCents).toBe(0);
  });

  it('sends the customer back when there is nothing to pay', async () => {
    const t = await setup();
    const res = await ctx.app.inject(`/betalen/${t.statusToken}/aanbetaling`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/status?t=${t.statusToken}&betaalfout=nothing_due`);
    expect((await ctx.app.inject('/betalen/x/aanbetaling')).statusCode).toBe(404);
  });

  it('emails a payment link from the admin', async () => {
    const t = await setup();
    const early = await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${t.booking.id}/payment-link`, headers: t.auth, payload: { kind: 'deposit' } });
    expect(early.statusCode).toBe(409);

    await t.patch({ status: 'confirmed', notifyCustomer: false });
    ctx.sent.length = 0;
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/admin/bookings/${t.booking.id}/payment-link`, headers: t.auth, payload: { kind: 'deposit', send: true },
    });
    expect(res.json()).toEqual({ url: `https://gamerxp.nl/betalen/${t.statusToken}/aanbetaling`, amountCents: 10000 });
    expect(ctx.sent[0]!.subject).toContain('Betaallink');
    expect(ctx.sent[0]!.text).toContain(res.json().url);
  });

  it('is switched off without an API key', async () => {
    const t = await setup(false);
    await t.patch({ status: 'confirmed' });
    expect(ctx.sent.at(-1)!.text).not.toContain('/betalen/');
    expect((await t.status()).pay).toEqual({ deposit: null, payment: null });
    expect((await ctx.app.inject(`/betalen/${t.statusToken}/aanbetaling`)).headers.location).toContain('betaalfout=payments_disabled');
    const link = await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${t.booking.id}/payment-link`, headers: t.auth, payload: { kind: 'deposit' } });
    expect(link.statusCode).toBe(422);
  });
});
