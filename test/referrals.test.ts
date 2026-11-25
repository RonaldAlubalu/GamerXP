import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, futureDate, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

describe('recommending', () => {
  let ctx: TestContext;
  let token: string;
  let day = 20;
  const admin = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${token}` }, payload });
  // Every booking on its own day, so they never compete for a slot.
  const book = (extra: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { partyDate: futureDate(ctx, day++), ...extra }) });
  // Through the admin, for a row of bookings: the public form only takes a few in a short time.
  const bookMany = (extra: Record<string, unknown>) => {
    const { termsAccepted: _t, ...body } = bookingBody(ctx, { partyDate: futureDate(ctx, day++), ...extra });
    return admin('POST', '/bookings', body);
  };
  const bookingOf = async (email: string) => (await admin('GET', '/bookings')).json().filter((b: { email: string }) => b.email === email).at(-1);
  const discounts = (b: { priceExtras: { label: string; amountCents: number }[] }) => b.priceExtras.filter((x) => x.amountCents < 0);

  beforeEach(async () => {
    ctx = await setupApp();
    token = await loginAdmin(ctx);
    day = 20;
  });
  afterEach(() => teardown(ctx));

  // The recommending link of a customer, as shown on their status page.
  async function linkOf(email: string) {
    const b = await bookingOf(email);
    const status = (await ctx.app.inject({ url: `/api/status/${(await admin('GET', `/bookings/${b.id}`)).json().statusToken}` })).json();
    return status.referral as { url: string; held: number; upcoming: number; percent: number; maxPercent: number };
  }

  it('gives the new customer 10% and the one who recommended 5% per party that took place, up to 25%', async () => {
    await book({ email: 'anna@example.com', parentName: 'Anna' });
    const anna = await linkOf('anna@example.com');
    expect(anna).toMatchObject({ held: 0, upcoming: 0, percent: 0, maxPercent: 25 });
    const via = anna.url.split('via=')[1]!;
    expect((await ctx.app.inject({ url: `/api/referral?token=${via}` })).json()).toEqual({ valid: true, percent: 10 });
    expect((await ctx.app.inject({ url: '/api/referral?token=bestaatniet' })).json()).toEqual({ valid: false });

    // A friend books through the link.
    expect((await book({ email: 'bas@example.com', parentName: 'Bas', referral: via })).statusCode).toBe(201);
    const bas = (await admin('GET', `/bookings/${(await bookingOf('bas@example.com')).id}`)).json();
    expect(bas.referredByName).toBe('Anna');
    expect(discounts(bas)).toEqual([{ label: 'Aanbevolen door een klant (10% op het pakket)', amountCents: -Math.round(bas.packagePriceCents / 10) }]);

    // Using your own link does nothing: no discount, no credit.
    await book({ email: 'anna@example.com', parentName: 'Anna', referral: via });
    const own = (await admin('GET', `/bookings/${(await bookingOf('anna@example.com')).id}`)).json();
    expect(discounts(own)).toEqual([]);
    expect(own.referredByName).toBeNull();

    // Nothing is earned until the recommended party has taken place.
    expect(await linkOf('anna@example.com')).toMatchObject({ held: 0, upcoming: 1, percent: 0 });
    await admin('PATCH', `/bookings/${bas.id}`, { status: 'party_held', notifyCustomer: false });
    expect(await linkOf('anna@example.com')).toMatchObject({ held: 1, upcoming: 0, percent: 5 });

    // Six more friends: the reward stops at 25%.
    for (let i = 0; i < 6; i++) {
      expect((await bookMany({ email: `vriend${i}@example.com`, referral: via })).statusCode).toBe(201);
      await admin('PATCH', `/bookings/${(await bookingOf(`vriend${i}@example.com`)).id}`, { status: 'party_held', notifyCustomer: false });
    }
    expect(await linkOf('anna@example.com')).toMatchObject({ held: 7, percent: 25 });
    expect((await admin('GET', '/mailing/contacts')).json().find((c: { email: string }) => c.email === 'anna@example.com')).toMatchObject({ referrals: 7, referralsHeld: 7 });
  });

  it('never adds discounts up: the biggest one counts, and the recommendation is still credited', async () => {
    await book({ email: 'anna@example.com', parentName: 'Anna' });
    const via = (await linkOf('anna@example.com')).url.split('via=')[1]!;
    await admin('POST', '/discount-codes', { code: 'KLEIN5', percent: 5 });
    await admin('POST', '/discount-codes', { code: 'GROOT20', percent: 20 });

    await book({ email: 'klein@example.com', referral: via, discountCode: 'KLEIN5' });
    const small = (await admin('GET', `/bookings/${(await bookingOf('klein@example.com')).id}`)).json();
    expect(discounts(small).map((x) => x.label)).toEqual(['Aanbevolen door een klant (10% op het pakket)']);

    await book({ email: 'groot@example.com', referral: via, discountCode: 'GROOT20' });
    const big = (await admin('GET', `/bookings/${(await bookingOf('groot@example.com')).id}`)).json();
    expect(discounts(big).map((x) => x.label)).toEqual(['Kortingscode GROOT20 (20% op het pakket)']);
    expect(big.referredByName).toBe('Anna');
  });

  it('cashes the reward in on a booking of the customer who recommended, once', async () => {
    await book({ email: 'anna@example.com', parentName: 'Anna' });
    const via = (await linkOf('anna@example.com')).url.split('via=')[1]!;
    for (let i = 0; i < 2; i++) {
      expect((await bookMany({ email: `vriend${i}@example.com`, referral: via })).statusCode).toBe(201);
      await admin('PATCH', `/bookings/${(await bookingOf(`vriend${i}@example.com`)).id}`, { status: 'party_held', notifyCustomer: false });
    }
    await admin('POST', '/discount-codes', { code: 'GROOT20', percent: 20 });
    await admin('POST', '/discount-codes', { code: 'KLEIN5', percent: 5 });

    // A bigger discount already on the booking: the reward is kept for later.
    await book({ email: 'anna@example.com', parentName: 'Anna', discountCode: 'GROOT20' });
    const withBig = await bookingOf('anna@example.com');
    expect((await admin('GET', `/bookings/${withBig.id}`)).json().reward).toMatchObject({ held: 2, percent: 10 });
    expect((await admin('POST', `/bookings/${withBig.id}/apply-reward`)).json().code).toBe('bigger_discount');

    // A smaller one makes way for the reward.
    await book({ email: 'anna@example.com', parentName: 'Anna', discountCode: 'KLEIN5' });
    const next = await bookingOf('anna@example.com');
    const applied = (await admin('POST', `/bookings/${next.id}/apply-reward`)).json();
    expect(discounts(applied)).toEqual([{ label: 'Beloning voor aanbevelen (10% op het pakket)', amountCents: -Math.round(applied.packagePriceCents / 10) }]);
    expect(applied.priceCents).toBe(next.priceCents + Math.round(applied.packagePriceCents * 0.05) - Math.round(applied.packagePriceCents * 0.1));

    // Used up: nothing left to cash in, also not on another booking.
    expect((await admin('GET', `/bookings/${next.id}`)).json().reward).toMatchObject({ held: 0, percent: 0 });
    expect((await admin('POST', `/bookings/${withBig.id}/apply-reward`)).json().code).toBe('no_reward');
  });
});
