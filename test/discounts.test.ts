import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

describe('discount codes', () => {
  let ctx: TestContext;
  let token: string;
  const admin = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${token}` }, payload });
  const book = (extra: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, extra) });

  beforeEach(async () => {
    ctx = await setupApp();
    token = await loginAdmin(ctx);
    // A code for every date, so the tests do not depend on today.
    await admin('POST', '/discount-codes', { code: 'test10', percent: 10, note: 'Test' });
  });
  afterEach(() => teardown(ctx));

  it('takes its percentage off the package price only, and remembers the code', async () => {
    await book({});
    const plainPrice = (await admin('GET', '/bookings')).json()[0].priceCents;
    await ctx.db.query('DELETE FROM bookings');
    const res = await book({ discountCode: ' test10 ' });
    expect(res.statusCode).toBe(201);
    const [booking] = (await admin('GET', '/bookings')).json();
    expect(booking.discountCode).toBe('TEST10');
    const detail = (await admin('GET', `/bookings/${booking.id}`)).json();
    const line = detail.priceExtras.find((x: { label: string }) => x.label.startsWith('Kortingscode'));
    expect(line).toEqual({ label: 'Kortingscode TEST10 (10% op het pakket)', amountCents: -Math.round(detail.packagePriceCents / 10) });
    // Travel costs and surcharges are not discounted: the total is exactly that line lower.
    expect(detail.priceCents).toBe(plainPrice + line.amountCents);

    // Another package: the discount follows the new package price.
    const other = (await admin('GET', '/packages')).json().find((p: { id: number }) => p.id !== booking.packageId);
    const switched = (await admin('PATCH', `/bookings/${booking.id}`, { packageId: other.id })).json();
    expect(switched.priceExtras.find((x: { label: string }) => x.label.startsWith('Kortingscode')).amountCents).toBe(-Math.round(other.priceCents / 10));
    expect((await admin('GET', '/discount-codes')).json().find((c: { code: string }) => c.code === 'TEST10').used).toBe(1);
  });

  it('refuses an unknown or switched-off code and one outside its period, and says why', async () => {
    expect((await book({ discountCode: 'BESTAATNIET' })).json()).toMatchObject({ code: 'invalid_discount', error: 'Deze kortingscode kennen we niet.' });
    const partyDate = bookingBody(ctx).partyDate;
    const [code] = (await admin('GET', '/discount-codes')).json().filter((c: { code: string }) => c.code === 'TEST10');
    await admin('PATCH', `/discount-codes/${code.id}`, { percent: 10, validFrom: '2099-01-01', validUntil: null, active: true });
    const early = (await ctx.app.inject({ url: `/api/discount?code=test10&partyDate=${partyDate}` })).json();
    expect(early).toEqual({ valid: false, reason: 'Deze code geldt voor feestjes vanaf 1-1-2099.' });
    expect((await book({ discountCode: 'TEST10' })).statusCode).toBe(422);
    await admin('PATCH', `/discount-codes/${code.id}`, { percent: 10, validFrom: null, validUntil: null, active: false });
    expect((await ctx.app.inject({ url: `/api/discount?code=TEST10&partyDate=${partyDate}` })).json().valid).toBe(false);
    await admin('PATCH', `/discount-codes/${code.id}`, { percent: 15, validFrom: null, validUntil: null, active: true });
    expect((await ctx.app.inject({ url: `/api/discount?code=TEST10&partyDate=${partyDate}` })).json()).toEqual({ valid: true, code: 'TEST10', percent: 15 });
  });

  it('comes with the New Year code for parties in 2027, and keeps codes unique', async () => {
    const codes = (await admin('GET', '/discount-codes')).json();
    expect(codes.find((c: { code: string }) => c.code === 'NIEUWJAAR10')).toMatchObject({ percent: 10, validFrom: '2027-01-01', validUntil: '2027-12-31', active: true });
    expect((await ctx.app.inject({ url: '/api/discount?code=nieuwjaar10&partyDate=2027-03-14' })).json()).toEqual({ valid: true, code: 'NIEUWJAAR10', percent: 10 });
    expect((await ctx.app.inject({ url: '/api/discount?code=NIEUWJAAR10&partyDate=2026-12-20' })).json().valid).toBe(false);
    expect((await admin('POST', '/discount-codes', { code: 'Test10', percent: 5 })).json().code).toBe('exists');
    expect((await admin('POST', '/discount-codes', { code: 'met spatie', percent: 5 })).statusCode).toBe(400);
  });
});
