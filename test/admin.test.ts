import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, futureDate, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

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

  it('lets the customer details be corrected and completed, with a second phone and e-mail', async () => {
    const booking = await createBooking();
    const change = (payload: object) => ctx.app.inject({ method: 'PATCH', url: `/api/admin/bookings/${booking.id}/contact`, headers: auth(), payload });
    const res = await change({ email2: 'andere.ouder@example.com', phone2: '06 87654321', parentName: 'Nieuwe Naam', city: 'Helmond', postalCode: '5701 AB', childAge: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email2: 'andere.ouder@example.com', phone2: '06 87654321', parentName: 'Nieuwe Naam', city: 'Helmond', postalCode: '5701 AB', childAge: 10, email: booking.email });
    // The distance is looked up again for the new address.
    expect(res.json().travelKm).toBe(30);
    expect((await change({ email2: 'geen-adres' })).statusCode).toBe(400);
    const cleared = (await change({ email: '' })).json();
    expect(cleared).toMatchObject({ email: '', phone: booking.phone, phone2: '06 87654321' });
    const detail = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(detail.events.map((e: { message: string }) => e.message).join(' | ')).toContain('Gegevens gewijzigd: Naam, Tweede e-mail, Tweede telefoon, Postcode, Plaats, Leeftijd');
  });

  it('takes an agreed end time: the party then lasts from start to end, not the package hours', async () => {
    const booking = await createBooking();
    expect((await patch(booking.id, { endTime: '19:00' })).json().code).toBe('end_without_start');
    expect((await patch(booking.id, { startTime: '16:00', endTime: '15:00' })).json().code).toBe('end_before_start');
    const changed = (await patch(booking.id, { startTime: '16:00', endTime: '19:00' })).json();
    expect(changed).toMatchObject({ startTime: '16:00', endTime: '19:00', durationHours: 3 });
    const detail = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(detail.schedule).toMatchObject({ start: '16:00', end: '19:00' });
    const cleared = (await patch(booking.id, { endTime: null })).json();
    expect(cleared.endTime).toBeNull();
    expect(cleared.durationHours).toBe(cleared.packageHours);
  });

  it('keeps the location name and the own address of a customer whose party is somewhere else', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { locationName: 'Zaal De Hoek', billingStreet: 'Thuisstraat 9', billingPostalCode: '5611 AA', billingCity: 'Eindhoven' }) });
    expect(res.statusCode).toBe(201);
    const [booking] = (await ctx.app.inject({ url: '/api/admin/bookings', headers: auth() })).json();
    expect(booking).toMatchObject({ locationName: 'Zaal De Hoek', billingStreet: 'Thuisstraat 9', billingPostalCode: '5611 AA', billingCity: 'Eindhoven' });
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { billingPostalCode: 'nee' }) });
    expect(bad.statusCode).toBe(400);
  });

  it('switches a booking to another package: price and duration follow, and it is logged', async () => {
    const booking = await createBooking();
    const packages = (await ctx.app.inject({ url: '/api/admin/packages', headers: auth() })).json() as { id: number; slug: string; name: string; priceCents: number; durationHours: number }[];
    const from = packages.find((p) => p.id === booking.packageId)!;
    const to = packages.find((p) => p.id !== booking.packageId)!;
    const changed = (await patch(booking.id, { packageId: to.id })).json();
    expect(changed).toMatchObject({ packageId: to.id, packageName: to.name, packagePriceCents: to.priceCents, durationHours: to.durationHours });
    expect(changed.priceCents - booking.priceCents).toBe(to.priceCents - from.priceCents);
    expect((await patch(booking.id, { packageId: 99999 })).json().code).toBe('unknown_package');
    const detail = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(detail.events.map((e: { message: string }) => e.message).join(' | ')).toContain(`Pakket: ${from.name} → ${to.name}`);
  });

  it('removes a booking with everything under it, for the owner only', async () => {
    const booking = await createBooking();
    await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${booking.id}/payments`, headers: { authorization: `Bearer ${token}` }, payload: { kind: 'deposit', amountCents: 10000, method: 'bank', paidOn: '2026-11-01' } });
    const remove = () => ctx.app.inject({ method: 'DELETE', url: `/api/admin/bookings/${booking.id}`, headers: { authorization: `Bearer ${token}` } });
    expect((await remove()).statusCode).toBe(204);
    expect((await remove()).statusCode).toBe(404);
    const left = await ctx.db.query('SELECT (SELECT count(*) FROM payments)::int AS payments, (SELECT count(*) FROM booking_tasks)::int AS tasks, (SELECT count(*) FROM bookings)::int AS bookings');
    expect(left.rows[0]).toEqual({ payments: 0, tasks: 0, bookings: 0 });
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

  it('moves a new request to "contact made" at your first reply, also on the customer page', async () => {
    const booking = await createBooking();
    const { rows } = await ctx.db.query('SELECT status_token FROM bookings WHERE id = $1', [booking.id]);
    const customerPage = async () => (await ctx.app.inject(`/api/status/${rows[0].status_token}`)).json();
    expect((await customerPage()).status).toBe('new');
    // A message from the customer changes nothing.
    await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${booking.id}/messages`, headers: auth(), payload: { direction: 'in', channel: 'whatsapp', body: 'Hoi!' } });
    expect((await customerPage()).status).toBe('new');
    await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${booking.id}/messages`, headers: auth(), payload: { direction: 'out', channel: 'email', body: 'Bedankt voor je aanvraag!', send: true } });
    const page = await customerPage();
    expect(page.status).toBe('contacted');
    expect(page.steps.filter((s: { state: string }) => s.state === 'done')).toHaveLength(1);
    // A later reply does not move a booking that is already further along.
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/bookings/${booking.id}`, headers: auth(), payload: { status: 'confirmed' } });
    await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${booking.id}/messages`, headers: auth(), payload: { direction: 'out', channel: 'whatsapp', body: 'Tot dan!' } });
    expect((await customerPage()).status).toBe('confirmed');
  });

  it('plans the whole day around a party, with the drive there and back', async () => {
    const booking = await createBooking();
    // 30 km in the tests: estimated at 30 minutes. Standaard lasts 3 hours; the middag slot starts at 13:00.
    const first = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(first.travelMinutes).toBe(30);
    expect(first.schedule).toEqual({ leave: '11:30', setupStart: '12:00', start: '13:00', end: '16:00', teardownEnd: '16:45', home: '17:15', travelKnown: true, startAssumed: true });

    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/bookings/${booking.id}`, headers: auth(), payload: { startTime: '14:30', travelMinutes: 50 } });
    const planned = (await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json();
    expect(planned.schedule).toMatchObject({ leave: '12:40', start: '14:30', end: '17:30', home: '19:05', startAssumed: false });
    // Saving the price again with the same distance keeps the driving time you set.
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/bookings/${booking.id}`, headers: auth(), payload: { travelKm: 30, depositCents: 10000 } });
    expect((await ctx.app.inject({ url: `/api/admin/bookings/${booking.id}`, headers: auth() })).json().travelMinutes).toBe(50);

    const month = planned.partyDate.slice(0, 7);
    const calendar = (await ctx.app.inject({ url: `/api/admin/calendar?month=${month}`, headers: auth() })).json();
    const day = calendar.days.find((d: { date: string }) => d.date === planned.partyDate);
    expect(day.bookings[0].schedule).toMatchObject({ leave: '12:40', home: '19:05' });
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

describe('adding a booking by hand', () => {
  let ctx: TestContext;
  let token: string;
  const add = (payload: object) =>
    ctx.app.inject({ method: 'POST', url: '/api/admin/bookings', headers: { authorization: `Bearer ${token}` }, payload });

  beforeEach(async () => {
    ctx = await setupApp();
    token = await loginAdmin(ctx);
  });
  afterEach(() => teardown(ctx));

  it('adds it without emailing anyone, even outside the booking period, and guards a taken slot', async () => {
    const { termsAccepted: _t, ...body } = bookingBody(ctx, { partyDate: futureDate(ctx, 1), notes: 'Via WhatsApp afgesproken' });
    const res = await add(body);
    expect(res.statusCode).toBe(201);
    expect(res.json().reference).toMatch(/^GXP-/);
    expect(ctx.sent).toHaveLength(0);

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/admin/bookings/${res.json().id}`, headers: { authorization: `Bearer ${token}` } });
    expect(detail.json().status).toBe('new');

    const again = await add(body);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('slot_unavailable');
  });
});

describe('inventory', () => {
  let ctx: TestContext;
  let token: string;
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${token}` }, payload });

  beforeEach(async () => {
    ctx = await setupApp();
    token = await loginAdmin(ctx);
  });
  afterEach(() => teardown(ctx));

  it('keeps stations, imports a list without doubles and refuses passwords', async () => {
    const added = await call('POST', '/inventory', { kind: 'station', name: 'Station 1', details: { consoleSerial: 'X1', gamePass: true } });
    expect(added.statusCode).toBe(201);
    const imported = await call('POST', '/inventory/import', {
      items: [
        { kind: 'station', name: 'station 1', details: { consoleSerial: 'X1-new', gamePass: true, gamePassNote: 'Per 22-10' } },
        { kind: 'game', name: 'Minecraft', priceCents: 1000, details: { source: 'gamepass_or_bought' } },
      ],
    });
    expect(imported.json()).toEqual({ added: 1, updated: 1 });
    const list = (await call('GET', '/inventory')).json();
    expect(list).toHaveLength(2);
    expect(list.find((i: { kind: string }) => i.kind === 'station').details.consoleSerial).toBe('X1-new');

    const secret = await call('POST', '/inventory/import', { items: [{ kind: 'station', name: 'S2', details: { epicPassword: 'x' } }] });
    expect(secret.statusCode).toBe(400);
    expect(secret.json().code).toBe('secrets_in_import');
  });

  it('changes a whole selection at once: status, Game Pass, the party it went to, removal', async () => {
    const ids: number[] = [];
    for (const name of ['Station 1', 'Station 2', 'Station 3']) ids.push((await call('POST', '/inventory', { kind: 'station', name, details: { gamertag: name } })).json().id);
    const game = (await call('POST', '/inventory', { kind: 'game', name: 'Minecraft' })).json();
    const bulk = (payload: object) => call('POST', '/inventory/bulk', payload);
    const list = async () => (await call('GET', '/inventory')).json() as { id: number; name: string; status: string; expiresOn: string | null; details: Record<string, unknown> }[];

    expect((await bulk({ action: 'status', ids: [] })).statusCode).toBe(400);
    expect((await bulk({ action: 'status', ids: [ids[0], ids[1]], status: 'broken' })).json()).toEqual({ changed: 2 });
    expect((await list()).filter((i) => i.status === 'broken').map((i) => i.name)).toEqual(['Station 1', 'Station 2']);

    // Renewed: only stations get it, and their other details stay.
    expect((await bulk({ action: 'gamepass', ids: [ids[0], ids[2], game.id], gamePass: true, expiresOn: '2027-03-01', note: 'Verlengd' })).json()).toEqual({ changed: 2 });
    const renewed = (await list()).find((i) => i.id === ids[2])!;
    expect(renewed).toMatchObject({ expiresOn: '2027-03-01', details: { gamePass: true, gamePassNote: 'Verlengd', gamertag: 'Station 3' } });
    expect((await bulk({ action: 'gamepass', ids: [ids[2]], gamePass: false, expiresOn: '2027-03-01' })).json()).toEqual({ changed: 1 });
    expect((await list()).find((i) => i.id === ids[2])).toMatchObject({ expiresOn: null, details: { gamePass: false } });

    // Went to a party: added to what the party already had; a game does not travel.
    const { termsAccepted: _t, ...body } = bookingBody(ctx, { partyDate: futureDate(ctx, 20) });
    const booking = (await call('POST', '/bookings', body)).json();
    await call('PUT', `/bookings/${booking.id}/inventory`, { itemIds: [ids[0]] });
    expect((await bulk({ action: 'party', ids: [ids[0], ids[1], game.id], bookingId: booking.id })).json()).toEqual({ changed: 1 });
    expect((await call('GET', `/inventory/${ids[1]}/history`)).json()).toHaveLength(1);
    expect((await bulk({ action: 'party', ids: [ids[1]], bookingId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);

    expect((await bulk({ action: 'delete', ids: [ids[0], game.id] })).json()).toEqual({ changed: 2 });
    expect((await list()).map((i) => i.name)).toEqual(['Station 2', 'Station 3']);
  });

  it('takes a booking noted by hand without e-mail or address, and mails nothing to it', async () => {
    const { termsAccepted: _t, email: _e, street: _s, postalCode: _p, ...body } = bookingBody(ctx, { partyDate: futureDate(ctx, 25) });
    const created = await call('POST', '/bookings', body);
    expect(created.statusCode).toBe(201);
    ctx.sent.length = 0;
    expect((await call('PATCH', `/bookings/${created.json().id}`, { status: 'confirmed' })).statusCode).toBe(200);
    expect(ctx.sent).toHaveLength(0);
    expect((await call('GET', `/bookings/${created.json().id}`)).json()).toMatchObject({ email: '', street: '', postalCode: '', status: 'confirmed' });
  });

  it('remembers which gear went to which party and flags a station used twice on one day', async () => {
    const station = (await call('POST', '/inventory', { kind: 'station', name: 'Station 1' })).json();
    const { termsAccepted: _t, ...body } = bookingBody(ctx, { partyDate: futureDate(ctx, 20) });
    const a = (await call('POST', '/bookings', body)).json();
    const b = (await call('POST', '/bookings', { ...body, timeSlot: 'avond', email: 'ander@example.com' })).json();

    expect((await call('PUT', `/bookings/${a.id}/inventory`, { itemIds: [station.id] })).statusCode).toBe(200);
    const forB = (await call('GET', `/bookings/${b.id}/inventory`)).json();
    expect(forB[0]).toMatchObject({ name: 'Station 1', assigned: false });
    expect(forB[0].alsoAt).toContain(a.reference);

    const history = (await call('GET', `/inventory/${station.id}/history`)).json();
    expect(history).toHaveLength(1);
    expect(history[0].reference).toBe(a.reference);
  });

  it('warns the owner once, two weeks and three days before a subscription runs out', async () => {
    const { sendExpiryNotices } = await import('../src/services/inventory.js');
    await call('POST', '/inventory', { kind: 'subscription', name: 'Game Pass', expiresOn: futureDate(ctx, 10) });
    await call('POST', '/inventory', { kind: 'subscription', name: 'Domein', expiresOn: futureDate(ctx, 60) });
    expect(await sendExpiryNotices(ctx.app)).toBe(1);
    expect(ctx.sent.at(-1)!.subject).toContain('Game Pass verloopt op');
    expect(await sendExpiryNotices(ctx.app)).toBe(0);

    await ctx.db.query(`UPDATE inventory_items SET expires_on = current_date + 2 WHERE name = 'Game Pass'`);
    expect(await sendExpiryNotices(ctx.app)).toBe(1);
    expect(await sendExpiryNotices(ctx.app)).toBe(0);
  });
});

describe('inventory that comes with the site', () => {
  it('holds the stations, games and subscriptions, and no account names or passwords', async () => {
    const sql = (await import('node:fs')).readFileSync('migrations/020_inventory_seed.sql', 'utf8');
    expect(sql.match(/\('station'/g)).toHaveLength(10);
    expect(sql.match(/\('game'/g)).toHaveLength(12);
    expect(sql.match(/\('subscription'/g)).toHaveLength(2);
    expect(sql).not.toMatch(/password|passwd|wachtwoord|@|gamertag|consoleSerial/i);
  });
});
