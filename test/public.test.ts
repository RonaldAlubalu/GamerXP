import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSettings } from '../src/services/availability.js';
import { addDays } from '../src/lib/dates.js';
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

  it('lists only active packages, Ultimate first', async () => {
    await ctx.db.query(
      "INSERT INTO packages (slug, name, max_players, duration_hours, price_cents, active) VALUES ('old', 'Oud', 4, 2, 100, false)",
    );
    const res = await ctx.app.inject('/api/packages');
    expect(res.json()).toEqual([
      expect.objectContaining({ slug: 'ultimate', maxPlayers: 8, durationHours: 4, priceCents: 35000 }),
      expect.objectContaining({ slug: 'standaard', maxPlayers: 8, durationHours: 3, priceCents: 27500 }),
    ]);
  });

  it('prices extra game stations and sets the €100 deposit', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/bookings',
      payload: bookingBody(ctx, { extraStations: '2', childName: '', childAge: '', guestCount: '', phone: '' }),
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await ctx.db.query('SELECT price_cents, deposit_cents, extra_stations, time_slot, start_time, child_age FROM bookings');
    // €275 package + 2 × €25 extra stations + 30 km × 2 × €0,50 travel.
    expect(rows[0]).toEqual({
      price_cents: 35500, deposit_cents: 10000, extra_stations: 2, time_slot: 'middag', start_time: null, child_age: null,
    });
    expect(ctx.sent[0]!.text).toContain('+ 2 extra gamestation(s)');
  });

  it('accepts Belgian postal codes', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { postalCode: '2000' }) });
    expect(res.statusCode).toBe(201);
  });

  it('creates a booking and sends emails to parent and owner', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(res.statusCode).toBe(201);
    const { reference, status, statusUrl } = res.json();
    expect(reference).toMatch(/^GXP-[2-9A-Z]{6}$/);
    expect(status).toBe('new');
    expect(statusUrl).toMatch(/\/status\?t=/);

    const { rows } = await ctx.db.query('SELECT postal_code, party_date FROM bookings');
    expect(rows).toEqual([{ postal_code: '1234 AB', party_date: futureDate(ctx) }]);

    expect(ctx.sent.map((m) => m.to)).toEqual(['sanne@example.nl', 'owner@gamerxp.nl']);
    expect(ctx.sent[0]!.text).toContain(reference);
    expect(ctx.sent[0]!.text).toContain(statusUrl);
    expect(ctx.sent[1]!.replyTo).toBe('sanne@example.nl');
  });

  it('still accepts the booking when email sending fails', async () => {
    ctx.app.mailer.send = async () => {
      throw new Error('SMTP down');
    };
    const res = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a second booking in the same slot but allows another slot that day', async () => {
    const first = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(first.statusCode).toBe(201);
    const second = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('slot_unavailable');
    const evening = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { timeSlot: 'avond' }) });
    expect(evening.statusCode).toBe(201);
    // Default daily capacity is 2, so the morning is now full too.
    const morning = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { timeSlot: 'ochtend' }) });
    expect(morning.statusCode).toBe(409);
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

  it('respects the slot and daily capacity settings', async () => {
    await saveSettings(ctx.db, { slotCapacity: 2, dailyCapacity: 2, minLeadDays: 3, maxAdvanceDays: 365 });
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) })).statusCode);
    }
    expect(codes).toEqual([201, 201, 409]);
  });

  it('only offers slots that are open in the weekly schedule or opened for that date', async () => {
    const date = futureDate(ctx);
    const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    await ctx.db.query("UPDATE weekly_availability SET open = (slot = 'middag') WHERE weekday = $1", [weekday]);
    await ctx.db.query("INSERT INTO slot_overrides (date, slot, open) VALUES ($1, 'avond', true)", [date]);

    const res = await ctx.app.inject(`/api/availability?from=${date}&to=${date}`);
    expect(res.json().days[date]).toEqual(['middag', 'avond']);
    expect(res.json().slots.map((s: { key: string; start: string }) => `${s.key} ${s.start}`)).toEqual([
      'ochtend 09:00', 'middag 13:00', 'avond 17:00',
    ]);

    const closed = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { timeSlot: 'ochtend' }) });
    expect(closed.statusCode).toBe(409);
    const opened = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { timeSlot: 'avond' }) });
    expect(opened.statusCode).toBe(201);
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
      payload: bookingBody(ctx, { postalCode: 'abc', termsAccepted: false }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { path: string }) => i.path).sort()).toEqual(['postalCode', 'termsAccepted']);
    expect(res.json().error).toMatch(/postcode|voorwaarden/);
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

  it('reports bookable dates and slots', async () => {
    const blocked = futureDate(ctx, 20);
    await ctx.db.query('INSERT INTO blocked_dates (date) VALUES ($1)', [blocked]);
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });

    const res = await ctx.app.inject(`/api/availability?to=${futureDate(ctx, 30)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.minDate).toBe(futureDate(ctx, 3));
    expect(body.days[futureDate(ctx)]).toEqual(['ochtend', 'avond']);
    expect(body.days[blocked]).toBeUndefined();
    expect(body.days[addDays(blocked, 1)]).toEqual(['ochtend', 'middag', 'avond']);
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


  it('shows parents the progress of their booking without personal details', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    const token = new URL(created.json().statusUrl).searchParams.get('t');

    const res = await ctx.app.inject(`/api/status/${token}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ reference: created.json().reference, status: 'new', childName: 'Daan', priceCents: 30500, timeSlot: 'middag', startTime: null });
    expect(body.steps[0]).toMatchObject({ key: 'new', state: 'current' });
    expect(body.steps[1]).toMatchObject({ key: 'contacted', state: 'todo' });
    expect(JSON.stringify(body)).not.toMatch(/Dorpsstraat|sanne@example|0612345678/);

    expect((await ctx.app.inject(`/api/status/${'x'.repeat(40)}`)).statusCode).toBe(404);
  });

  it('lets parents find their status page with reference and email', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    const { reference, statusUrl } = created.json();
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/status/lookup',
      payload: { reference: reference.toLowerCase(), email: 'SANNE@example.nl' },
    });
    expect(statusUrl).toContain(ok.json().token);
    const wrong = await ctx.app.inject({ method: 'POST', url: '/api/status/lookup', payload: { reference, email: 'x@example.nl' } });
    expect(wrong.statusCode).toBe(404);
  });

  it('adds the evening surcharge for the evening slot', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { timeSlot: 'avond' }) });
    const { rows } = await ctx.db.query('SELECT price_cents, evening_surcharge, travel_km::float AS km FROM bookings');
    expect(rows[0]).toEqual({ price_cents: 27500 + 3000 + 5000, evening_surcharge: true, km: 30 });
  });

  it('still books when the distance lookup fails', async () => {
    ctx.app.distance.drivingKm = async () => {
      throw new Error('offline');
    };
    const res = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    expect(res.statusCode).toBe(201);
    expect((await ctx.db.query('SELECT price_cents, travel_km FROM bookings')).rows[0]).toEqual({ price_cents: 27500, travel_km: null });
  });

  it('quotes travel costs, capped at €100', async () => {
    expect((await ctx.app.inject('/api/quote?postalCode=1234AB&city=Utrecht')).json()).toMatchObject({ km: 30, travelCents: 3000 });
    ctx.app.distance.drivingKm = async () => 180;
    expect((await ctx.app.inject('/api/quote?postalCode=1234AB&city=Groningen')).json()).toMatchObject({ km: 180, travelCents: 10000 });
  });

  it('logs the website request as the first message', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { notes: 'Graag Minecraft' }) });
    const { rows } = await ctx.db.query('SELECT direction, channel, body FROM communications');
    expect(rows).toEqual([{ direction: 'in', channel: 'website', body: 'Graag Minecraft' }]);
  });
});
