import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  ctx = await setupApp();
  token = await loginAdmin(ctx);
});
afterEach(() => teardown(ctx));

describe('admin API', () => {
  it('requires a valid session', async () => {
    expect((await ctx.app.inject('/api/admin/bookings')).statusCode).toBe(401);
    const bad = await ctx.app.inject({ url: '/api/admin/bookings', headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
    expect((await ctx.app.inject({ url: '/api/admin/me', headers: auth() })).json().email).toBe('admin@gamerxp.nl');
  });

  it('rejects wrong passwords and unknown users', async () => {
    for (const email of ['admin@gamerxp.nl', 'nobody@gamerxp.nl']) {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { email, password: 'wrong' } });
      expect(res.statusCode).toBe(401);
    }
  });

  it('stores only a hash of the session token and invalidates it on logout', async () => {
    const { rows } = await ctx.db.query('SELECT token_hash FROM admin_sessions');
    expect(rows[0].token_hash).not.toBe(token);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/admin/logout', headers: auth() })).statusCode).toBe(204);
    expect((await ctx.app.inject({ url: '/api/admin/me', headers: auth() })).statusCode).toBe(401);
  });

  it('lists, confirms and cancels bookings, emailing the parent', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    ctx.sent.length = 0;

    const list = await ctx.app.inject({ url: '/api/admin/bookings?status=pending', headers: auth() });
    const [booking] = list.json();
    expect(booking).toMatchObject({ childName: 'Daan', startTime: '14:00', packageName: 'LAN-Party Basis' });

    const confirmed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/bookings/${booking.id}`,
      headers: auth(),
      payload: { status: 'confirmed', adminNotes: 'Aanbetaling ontvangen' },
    });
    expect(confirmed.json()).toMatchObject({ status: 'confirmed', adminNotes: 'Aanbetaling ontvangen' });
    expect(ctx.sent.map((m) => m.subject)).toEqual([expect.stringContaining('bevestigd')]);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/bookings/${booking.id}`,
      headers: auth(),
      payload: { status: 'cancelled', notifyCustomer: false },
    });
    expect(ctx.sent).toHaveLength(1);
  });

  it('returns 404 for unknown bookings and 400 for bad ids', async () => {
    const unknown = await ctx.app.inject({
      url: '/api/admin/bookings/00000000-0000-4000-8000-000000000000',
      headers: auth(),
    });
    expect(unknown.statusCode).toBe(404);
    expect((await ctx.app.inject({ url: '/api/admin/bookings/abc', headers: auth() })).statusCode).toBe(400);
  });

  it('manages packages', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/packages',
      headers: auth(),
      payload: { slug: 'xl', name: 'XL', maxPlayers: 16, durationHours: 4, priceCents: 44900 },
    });
    expect(created.statusCode).toBe(201);
    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/packages/${created.json().id}`,
      headers: auth(),
      payload: { active: false, priceCents: 39900 },
    });
    expect(updated.json()).toMatchObject({ active: false, priceCents: 39900, name: 'XL' });
    expect((await ctx.app.inject('/api/packages')).json()).toHaveLength(1);
  });

  it('blocks and unblocks dates', async () => {
    const date = bookingBody(ctx).partyDate;
    await ctx.app.inject({ method: 'PUT', url: `/api/admin/blocked-dates/${date}`, headers: auth(), payload: { reason: 'Vakantie' } });
    expect((await ctx.app.inject({ url: '/api/admin/blocked-dates', headers: auth() })).json()).toEqual([
      { date, reason: 'Vakantie' },
    ]);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) })).statusCode).toBe(409);

    await ctx.app.inject({ method: 'DELETE', url: `/api/admin/blocked-dates/${date}`, headers: auth() });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) })).statusCode).toBe(201);
  });

  it('marks contact messages as handled', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/contact', payload: { name: 'A', email: 'a@example.nl', message: 'Hoi' } });
    const [msg] = (await ctx.app.inject({ url: '/api/admin/messages', headers: auth() })).json();
    const res = await ctx.app.inject({ method: 'PATCH', url: `/api/admin/messages/${msg.id}`, headers: auth(), payload: { handled: true } });
    expect(res.json()).toEqual({ id: msg.id, handled: true });
  });
});
