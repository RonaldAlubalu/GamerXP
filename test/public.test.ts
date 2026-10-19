import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, futureDate, setupApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupApp();
});
afterEach(() => teardown(ctx));

describe('public API', () => {
  it('reports health', async () => {
    const res = await ctx.app.inject('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('lists only active packages', async () => {
    await ctx.db.query(
      "INSERT INTO packages (slug, name, max_players, duration_hours, price_cents, active) VALUES ('old', 'Oud', 4, 2, 100, false)",
    );
    const res = await ctx.app.inject('/api/packages');
    expect(res.json()).toEqual([
      expect.objectContaining({ slug: 'basis', maxPlayers: 8, durationHours: 3, priceCents: 19900 }),
    ]);
  });

  it('creates a booking and sends emails to parent and owner', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(res.statusCode).toBe(201);
    const { reference, status } = res.json();
    expect(reference).toMatch(/^GXP-[2-9A-Z]{6}$/);
    expect(status).toBe('pending');

    const { rows } = await ctx.db.query('SELECT postal_code, party_date FROM bookings');
    expect(rows).toEqual([{ postal_code: '1234 AB', party_date: futureDate(ctx) }]);

    expect(ctx.sent.map((m) => m.to)).toEqual(['sanne@example.nl', 'owner@gamerxp.nl']);
    expect(ctx.sent[0]!.text).toContain(reference);
    expect(ctx.sent[1]!.replyTo).toBe('sanne@example.nl');
  });

  it('still accepts the booking when email sending fails', async () => {
    ctx.app.mailer.send = async () => {
      throw new Error('SMTP down');
    };
    const res = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a second booking on a full date', async () => {
    const first = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(first.statusCode).toBe(201);
    const second = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('date_unavailable');
  });

  it('never overbooks under concurrent requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/bookings',
          payload: bookingBody(ctx, { email: `p${i}@example.nl` }),
          remoteAddress: `10.0.0.${i}`,
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409]);
  });

  it('frees the date again when a booking is cancelled', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    await ctx.db.query("UPDATE bookings SET status = 'cancelled'");
    const res = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(res.statusCode).toBe(201);
  });

  it('respects DAILY_CAPACITY', async () => {
    await teardown(ctx);
    ctx = await setupApp({ DAILY_CAPACITY: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) })).statusCode);
    }
    expect(codes).toEqual([201, 201, 409]);
  });

  it('rejects blocked dates and dates outside the booking window', async () => {
    await ctx.db.query('INSERT INTO blocked_dates (date) VALUES ($1)', [futureDate(ctx)]);
    const blocked = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(blocked.statusCode).toBe(409);

    const tooSoon = await ctx.app.inject({
      method: 'POST',
      url: '/api/bookings',
      payload: bookingBody(ctx, { partyDate: futureDate(ctx, 1) }),
    });
    expect(tooSoon.statusCode).toBe(422);
    expect(tooSoon.json().code).toBe('date_out_of_range');
  });

  it('validates input with Dutch error messages', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/bookings',
      payload: bookingBody(ctx, { postalCode: 'abc', privacyConsent: false }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { path: string }) => i.path).sort()).toEqual(['postalCode', 'privacyConsent']);
    expect(res.json().error).toMatch(/postcode|privacyverklaring/);
  });

  it('rejects submissions that fill in the honeypot field', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/bookings',
      payload: bookingBody(ctx, { website: 'http://spam.example' }),
    });
    expect(res.statusCode).toBe(400);
    expect((await ctx.db.query('SELECT 1 FROM bookings')).rowCount).toBe(0);
  });

  it('rate limits booking submissions per IP', async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: { invalid: true } });
      codes.push(res.statusCode);
    }
    expect(codes.at(-1)).toBe(429);
  });

  it('reports unavailable dates', async () => {
    const blocked = futureDate(ctx, 20);
    await ctx.db.query('INSERT INTO blocked_dates (date) VALUES ($1)', [blocked]);
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });

    const res = await ctx.app.inject(`/api/availability?to=${futureDate(ctx, 30)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.minDate).toBe(futureDate(ctx, ctx.config.MIN_LEAD_DAYS));
    expect(body.unavailable).toEqual([futureDate(ctx), blocked]);
  });

  it('stores contact messages and notifies the owner', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/contact',
      payload: { name: 'Piet', email: 'piet@example.nl', message: 'Kan het ook op zondag?' },
    });
    expect(res.statusCode).toBe(201);
    expect((await ctx.db.query('SELECT message FROM contact_messages')).rows).toEqual([
      { message: 'Kan het ook op zondag?' },
    ]);
    expect(ctx.sent[0]).toMatchObject({ to: 'owner@gamerxp.nl', replyTo: 'piet@example.nl' });
  });

  it('serves the website and a 404 page', async () => {
    expect((await ctx.app.inject('/')).statusCode).toBe(200);
    const missing = await ctx.app.inject('/bestaat-niet');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('text/html');
    expect((await ctx.app.inject('/api/bestaat-niet')).json().code).toBe('not_found');
  });
});
