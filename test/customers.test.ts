import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

describe('customer card', () => {
  let ctx: TestContext;
  let token: string;
  const admin = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${token}` }, payload });

  beforeEach(async () => {
    ctx = await setupApp();
    token = await loginAdmin(ctx);
  });
  afterEach(() => teardown(ctx));

  it('brings everything under one e-mail address together', async () => {
    const first = (await admin('POST', '/bookings', bookingBody(ctx, { email: 'Sanne@Example.nl', childName: 'Daan' }))).json();
    await ctx.db.query("UPDATE bookings SET party_date = current_date - 300, status = 'completed', paid_cents = price_cents, review_status = 'received' WHERE id = $1", [first.id]);
    await admin('POST', '/bookings', bookingBody(ctx, { email: 'sanne@example.nl', childName: 'Noor', phone: '06 87654321' }));
    await admin('POST', '/bookings', bookingBody(ctx, { email: '', parentName: 'Zonder Mail', timeSlot: 'ochtend' }));
    await ctx.app.inject({ method: 'POST', url: '/api/contact', payload: { name: 'Sanne de Vries', email: 'sanne@example.nl', message: 'Kan het ook op zondag? Graag hoor ik van jullie.' } });
    await admin('POST', '/mailing/contacts', { contacts: [{ email: 'sanne@example.nl', name: 'Sanne de Vries' }, { email: 'alleen@lijst.nl', name: 'Alleen Lijst' }] });

    const list = (await admin('GET', '/customers')).json();
    expect(list.map((c: { name: string }) => c.name)).toEqual(['Alleen Lijst', 'Sanne de Vries', 'Zonder Mail']);
    expect(list[1]).toMatchObject({ email: 'sanne@example.nl', parties: 2, reviews: 1, mailing: 'on', paidCents: 30500 });
    expect(list[1].lastParty).not.toBeNull();
    expect(list[1].nextParty).not.toBeNull();
    expect(list[2]).toMatchObject({ email: '', mailing: 'none', parties: 1 });

    const card = (await admin('GET', '/customers/card?email=SANNE@example.nl')).json();
    expect(card.bookings).toHaveLength(2);
    expect(card.messages).toHaveLength(1);
    expect(card.timeline.some((t: { channel: string; messageId: number | null }) => t.channel === 'website' && t.messageId)).toBe(true);
    expect(card.mailing).toMatchObject({ subscribed: true, links: [], referred: [] });
    expect(card.mailing.referralUrl).toMatch(/\/reserveer\?via=/);

    // A note stays with the person; an empty one removes it.
    await admin('PUT', '/customers/note', { email: 'Sanne@example.nl', note: 'Heeft een hond' });
    expect((await admin('GET', '/customers/card?email=sanne@example.nl')).json().note).toBe('Heeft een hond');
    await admin('PUT', '/customers/note', { email: 'sanne@example.nl', note: '' });
    expect((await admin('GET', '/customers/card?email=sanne@example.nl')).json().note).toBe('');

    const alone = (await admin('GET', `/customers/card?booking=${list[2].bookingId}`)).json();
    expect(alone).toMatchObject({ email: '', name: 'Zonder Mail', mailing: null });
    expect((await admin('GET', '/customers/card?email=niemand@example.nl')).statusCode).toBe(404);
  });
});
