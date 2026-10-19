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
    expect((await ctx.app.inject({ url: '/api/admin/me', headers: auth() })).json()).toMatchObject({ email: 'admin@gamerxp.nl', reviewUrlConfigured: false, emailConfigured: false });
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

  async function createBooking() {
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    ctx.sent.length = 0;
    const [booking] = (await ctx.app.inject({ url: '/api/admin/bookings', headers: auth() })).json();
    return booking;
  }

  const patch = (id: string, payload: object) =>
    ctx.app.inject({ method: 'PATCH', url: `/api/admin/bookings/${id}`, headers: auth(), payload });

  it('gives every new booking a checklist and a timeline', async () => {
    const booking = await createBooking();
    expect(booking).toMatchObject({
      status: 'new', childName: 'Daan', timeSlot: 'middag', startTime: null, priceCents: 30500, depositCents: 10000,
      tasksDone: 0, waitingOn: 'me', depositPaid: false, outstandingCents: 30500, travelKm: 30,
    });
    expect(booking.tasksTotal).toBeGreaterThan(10);

    const detail = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(detail.tasks[0]).toMatchObject({ stage: 'new', done: false });
    expect(detail.events).toEqual([expect.objectContaining({ type: 'created', toStatus: 'new', actor: 'Sanne de Vries' })]);
  });

  it('moves bookings through the pipeline, logging and emailing the parent', async () => {
    const booking = await createBooking();

    await patch(booking.id, { status: 'contacted' });
    expect(ctx.sent).toHaveLength(0); // no email for this stage

    const confirmed = await patch(booking.id, { status: 'confirmed', depositCents: 5000, startTime: '14:30' });
    expect(confirmed.json()).toMatchObject({ status: 'confirmed', depositCents: 5000, startTime: '14:30' });
    expect(ctx.sent[0]!.subject).toContain('bevestiging');
    expect(ctx.sent[0]!.text).toMatch(/aanbetaling van €\s50,00, te voldoen binnen 5 kalenderdagen/);
    expect(ctx.sent[0]!.text).toContain('om 14:30');
    expect(ctx.sent[0]!.text).toContain('/status?t=');

    await patch(booking.id, { status: 'deposit_paid', paidCents: 5000 });
    expect(ctx.sent[1]!.subject).toContain('Aanbetaling ontvangen');

    await patch(booking.id, { status: 'cancelled', notifyCustomer: false });
    expect(ctx.sent).toHaveLength(2);

    const { events } = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    const statusMoves = events.filter((e: { type: string }) => e.type === 'status').map((e: { toStatus: string }) => e.toStatus);
    expect(statusMoves).toEqual(['cancelled', 'deposit_paid', 'confirmed', 'contacted']);
    const updates = events.filter((e: { type: string }) => e.type === 'update').map((e: { message: string }) => e.message);
    expect(updates.join('\n')).toMatch(/Aanbetaling: €\s100,00 → €\s50,00/);
    expect(events.filter((e: { type: string }) => e.type === 'email')).toHaveLength(2);
    expect(events[0].actor).toBe('admin@gamerxp.nl');
  });

  it('logs a failed status email on the timeline', async () => {
    const booking = await createBooking();
    ctx.app.mailer.send = async () => {
      throw new Error('SMTP down');
    };
    expect((await patch(booking.id, { status: 'confirmed' })).statusCode).toBe(200);
    const { events } = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(events[0].message).toContain('MISLUKT');
  });

  it('ticks off, adds and removes checklist tasks', async () => {
    const booking = await createBooking();
    const { tasks } = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();

    const ticked = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/bookings/${booking.id}/tasks/${tasks[0].id}`,
      headers: auth(),
      payload: { done: true },
    });
    expect(ticked.json()).toMatchObject({ done: true, doneAt: expect.any(String) });

    const added = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/bookings/${booking.id}/tasks`,
      headers: auth(),
      payload: { stage: 'scheduled', label: 'Extra beamer meenemen' },
    });
    expect(added.statusCode).toBe(201);
    await ctx.app.inject({ method: 'DELETE', url: `/api/admin/bookings/${booking.id}/tasks/${added.json().id}`, headers: auth() });

    const after = (await ctx.app.inject({ url: '/api/admin/bookings', headers: auth() })).json()[0];
    expect(after).toMatchObject({ tasksDone: 1, tasksTotal: tasks.length });

    // A task id that belongs to another booking is not found.
    const other = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/bookings/00000000-0000-4000-8000-000000000000/tasks/${tasks[0].id}`,
      headers: auth(),
      payload: { done: true },
    });
    expect(other.statusCode).toBe(404);
  });

  it('adds notes to the timeline', async () => {
    const booking = await createBooking();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/bookings/${booking.id}/notes`,
      headers: auth(),
      payload: { message: 'Gebeld, ruimte is de garage' },
    });
    const { events } = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(events[0]).toMatchObject({ type: 'note', message: 'Gebeld, ruimte is de garage' });
  });

  it('groups bookings per stage on the pipeline board', async () => {
    const booking = await createBooking();
    await patch(booking.id, { status: 'scheduled', notifyCustomer: false });
    const board = (await ctx.app.inject({ url: '/api/admin/pipeline', headers: auth() })).json();
    expect(board.map((c: { key: string }) => c.key)).toEqual([
      'new', 'contacted', 'confirmed', 'deposit_paid', 'scheduled', 'party_held', 'completed', 'cancelled',
    ]);
    expect(board.find((c: { key: string }) => c.key === 'scheduled').bookings).toHaveLength(1);
    expect(board.find((c: { key: string }) => c.key === 'new').bookings).toHaveLength(0);
  });

  it('searches bookings', async () => {
    await createBooking();
    const hit = await ctx.app.inject({ url: '/api/admin/bookings?q=daan', headers: auth() });
    const miss = await ctx.app.inject({ url: '/api/admin/bookings?q=nobody', headers: auth() });
    expect([hit.json().length, miss.json().length]).toEqual([1, 0]);
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
    expect((await ctx.app.inject('/api/packages')).json()).toHaveLength(2);
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

  it('replies to contact messages and tracks whose turn it is', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/contact', payload: { name: 'A', email: 'a@example.nl', message: 'Hoi' } });
    ctx.sent.length = 0;
    const [msg] = (await ctx.app.inject({ url: '/api/admin/messages', headers: auth() })).json();
    expect(msg.waitingOn).toBe('me');

    const replied = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/messages/${msg.id}/replies`,
      headers: auth(),
      payload: { direction: 'out', channel: 'email', body: 'Hoi! Zaterdag kan.', send: true },
    });
    expect(replied.json().waitingOn).toBe('customer');
    expect(ctx.sent[0]).toMatchObject({ to: 'a@example.nl', subject: 'Re: je bericht aan Gamer Xperience' });
    expect(ctx.sent[0]!.text).toMatch(/^Hoi! Zaterdag kan\.[\s\S]*Game on!/);

    const thread = (await ctx.app.inject({ url: `/api/admin/messages/${msg.id}`, headers: auth() })).json();
    expect(thread.communications.map((c: { direction: string; channel: string }) => `${c.direction}:${c.channel}`)).toEqual([
      'out:email', 'in:website',
    ]);

    const handled = await ctx.app.inject({ method: 'PATCH', url: `/api/admin/messages/${msg.id}`, headers: auth(), payload: { handled: true } });
    expect(handled.json()).toMatchObject({ handled: true, waitingOn: 'nobody' });
  });

  it('sends and logs messages on a booking and flips whose turn it is', async () => {
    const booking = await createBooking();
    const sent = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/bookings/${booking.id}/messages`,
      headers: auth(),
      payload: { direction: 'out', channel: 'email', subject: 'Je datum', body: 'Zaterdag is vrij!', send: true },
    });
    expect(sent.json().waitingOn).toBe('customer');
    expect(ctx.sent[0]).toMatchObject({ to: 'sanne@example.nl', subject: 'Je datum' });

    const logged = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/bookings/${booking.id}/messages`,
      headers: auth(),
      payload: { direction: 'in', channel: 'whatsapp', body: 'Top, we doen het!' },
    });
    expect(logged.json().waitingOn).toBe('me');
    expect(ctx.sent).toHaveLength(1);

    const detail = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(detail.communications.map((c: { channel: string; actor: string }) => `${c.channel}:${c.actor}`)).toEqual([
      'whatsapp:Sanne de Vries', 'email:admin@gamerxp.nl', 'email:Website', 'website:Sanne de Vries',
    ]);
  });

  it('keeps a list of agreements', async () => {
    const booking = await createBooking();
    const added = await ctx.app.inject({
      method: 'POST', url: `/api/admin/bookings/${booking.id}/agreements`, headers: auth(), payload: { text: 'Starttijd 14:00' },
    });
    expect(added.statusCode).toBe(201);
    let detail = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(detail.agreements.map((a: { text: string }) => a.text)).toEqual(['Starttijd 14:00']);
    await ctx.app.inject({ method: 'DELETE', url: `/api/admin/bookings/${booking.id}/agreements/${added.json().id}`, headers: auth() });
    detail = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(detail.agreements).toEqual([]);
  });

  it('calculates the price from package, extras, distance and surcharges', async () => {
    const booking = await createBooking();
    const res = await patch(booking.id, {
      extraStations: 1,
      travelKm: 120,
      eveningSurcharge: true,
      priceExtras: [{ label: 'Extra uur', amountCents: 5000 }, { label: 'Korting vriendjes', amountCents: -2500 }],
    });
    // 275 + 25 + min(120 × 2 × 0,50, 100) + 50 + 50 - 25
    expect(res.json().priceCents).toBe(47500);
    const detail = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(detail.priceLines.map((l: { key: string; amountCents: number }) => [l.key, l.amountCents])).toEqual([
      ['package', 27500], ['extra_stations', 2500], ['travel', 10000], ['evening', 5000], ['extra_0', 5000], ['extra_1', -2500],
    ]);
    expect(detail.priceLines[2].label).toContain('maximum');

    // A package price change later does not change this booking.
    await ctx.db.query("UPDATE packages SET price_cents = 30000 WHERE slug = 'standaard'");
    expect((await patch(booking.id, { travelKm: 10 })).json().priceCents).toBe(27500 + 2500 + 1000 + 5000 + 2500);
  });

  it('recalculates the distance on request', async () => {
    const booking = await createBooking();
    ctx.app.distance.drivingKm = async () => 55.5;
    const res = await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${booking.id}/distance`, headers: auth() });
    expect(res.json()).toMatchObject({ travelKm: 55.5, priceCents: 27500 + 5550 });
    ctx.app.distance.drivingKm = async () => null;
    const failed = await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${booking.id}/distance`, headers: auth() });
    expect(failed.statusCode).toBe(422);
  });

  it('tracks payments, deposit and what is still outstanding', async () => {
    const booking = await createBooking();
    const pay = (payload: object) =>
      ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${booking.id}/payments`, headers: auth(), payload });
    const today = new Date().toISOString().slice(0, 10);

    let b = (await pay({ kind: 'deposit', amountCents: 10000, method: 'bank', paidOn: today })).json();
    expect(b).toMatchObject({ paidCents: 10000, depositPaid: true, outstandingCents: 20500 });

    b = (await pay({ kind: 'security_deposit', amountCents: 10000, method: 'cash', paidOn: today })).json();
    expect(b).toMatchObject({ paidCents: 10000, securityDepositHeldCents: 10000 });

    b = (await pay({ kind: 'payment', amountCents: 20500, method: 'cash', paidOn: today })).json();
    expect(b).toMatchObject({ paidCents: 30500, outstandingCents: 0 });

    b = (await pay({ kind: 'security_deposit_returned', amountCents: 10000, method: 'cash', paidOn: today })).json();
    expect(b.securityDepositHeldCents).toBe(0);

    const detail = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(detail.payments).toHaveLength(4);
    const removed = await ctx.app.inject({
      method: 'DELETE', url: `/api/admin/bookings/${booking.id}/payments/${detail.payments[0].id}`, headers: auth(),
    });
    expect(removed.json()).toMatchObject({ paidCents: 20500, depositPaid: true });
    expect((await pay({ kind: 'payment', amountCents: 0, method: 'cash', paidOn: today })).statusCode).toBe(400);

    // Without a deposit set, nothing counts as "deposit paid".
    expect((await patch(booking.id, { depositCents: 0 })).json().depositPaid).toBe(false);
  });

  it('shows an overview of what needs attention', async () => {
    const booking = await createBooking();
    await patch(booking.id, { status: 'confirmed', notifyCustomer: false });
    const overview = (await ctx.app.inject({ url: '/api/admin/overview', headers: auth() })).json();
    expect(overview).toMatchObject({ waitingOnMe: 1, depositOpen: 1, outstandingCents: 30500, reviewsToRequest: 0 });
    const filtered = (await ctx.app.inject({ url: '/api/admin/bookings?payment=deposit_open', headers: auth() })).json();
    expect(filtered).toHaveLength(1);
  });

  it('requests Google reviews when a review link is configured', async () => {
    const booking = await createBooking();
    const noUrl = await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${booking.id}/review-request`, headers: auth() });
    expect(noUrl.statusCode).toBe(422);

    ctx.app.config.GOOGLE_REVIEW_URL = 'https://g.page/r/gamerxp/review';
    const res = await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${booking.id}/review-request`, headers: auth() });
    expect(res.json()).toMatchObject({ reviewStatus: 'requested', reviewRequestedAt: expect.any(String) });
    expect(ctx.sent[0]!.text).toContain('https://g.page/r/gamerxp/review');

    await patch(booking.id, { reviewStatus: 'received' });
    expect((await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json().reviewStatus).toBe('received');
  });

  it('marks the review as requested when the completed email includes the review link', async () => {
    ctx.app.config.GOOGLE_REVIEW_URL = 'https://g.page/r/gamerxp/review';
    const booking = await createBooking();
    const res = await patch(booking.id, { status: 'completed' });
    expect(res.json()).toMatchObject({ reviewStatus: 'requested', waitingOn: 'nobody' });
  });

  it('edits the weekly schedule, slot hours and capacity', async () => {
    const current = (await ctx.app.inject({ url: '/api/admin/availability', headers: auth() })).json();
    expect(current.settings).toEqual({ slotCapacity: 1, dailyCapacity: 2, minLeadDays: 3, maxAdvanceDays: 365 });

    const weekly = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, { ochtend: false, middag: d === 6, avond: false }]));
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/availability',
      headers: auth(),
      payload: {
        settings: { slotCapacity: 1, dailyCapacity: 1, minLeadDays: 7, maxAdvanceDays: 180 },
        slots: [{ key: 'middag', start: '12:30', end: '16:30' }],
        weekly,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.minLeadDays).toBe(7);
    expect(res.json().slots[1]).toMatchObject({ key: 'middag', start: '12:30', end: '16:30' });
    expect(res.json().weekly['6']).toEqual({ ochtend: false, middag: true, avond: false });

    // Only Saturday afternoons are bookable now.
    const days = (await ctx.app.inject('/api/availability')).json().days as Record<string, string[]>;
    for (const [date, slots] of Object.entries(days)) {
      expect(new Date(`${date}T00:00:00Z`).getUTCDay()).toBe(6);
      expect(slots).toEqual(['middag']);
    }

    const invalid = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/availability',
      headers: auth(),
      payload: { ...current, slots: [{ key: 'avond', start: '21:00', end: '17:00' }] },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('manages date exceptions and shows a month calendar', async () => {
    const booking = await createBooking();
    const date = booking.partyDate;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/availability/overrides/${date}/ochtend`,
      headers: auth(),
      payload: { open: false, reason: 'Tandarts' },
    });
    expect((await ctx.app.inject({ url: '/api/admin/availability/overrides', headers: auth() })).json()).toEqual([
      { date, slot: 'ochtend', open: false, reason: 'Tandarts' },
    ]);

    const cal = (await ctx.app.inject({ url: `/api/admin/calendar?month=${date.slice(0, 7)}`, headers: auth() })).json();
    const day = cal.days.find((d: { date: string }) => d.date === date);
    expect(day.slots).toEqual([
      { key: 'ochtend', open: false, booked: 0, available: false },
      { key: 'middag', open: true, booked: 1, available: false },
      { key: 'avond', open: true, booked: 0, available: true },
    ]);
    expect(day.bookings).toEqual([expect.objectContaining({ id: booking.id, timeSlot: 'middag', childName: 'Daan' })]);

    await ctx.app.inject({ method: 'DELETE', url: `/api/admin/availability/overrides/${date}/ochtend`, headers: auth() });
    expect((await ctx.app.inject({ url: '/api/admin/availability/overrides', headers: auth() })).json()).toEqual([]);
  });
});
