import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';
import { personalise } from '../src/routes/admin/mailings.js';

describe('mailings', () => {
  let ctx: TestContext;
  let token: string;
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${token}` }, payload });

  beforeEach(async () => {
    ctx = await setupApp();
    token = await loginAdmin(ctx);
  });
  afterEach(() => teardown(ctx));

  it('keeps a list of people without doubles, also from the bookings of a year', async () => {
    const added = (await call('POST', '/mailing/contacts', { contacts: [
      { email: 'jan@example.com', name: 'Jan Jansen' }, { email: 'JAN@example.com', name: 'Dubbel' }, { email: 'geen adres' }, { email: 'piet@example.com' },
    ] })).json();
    expect(added).toEqual({ added: 2, known: 1, invalid: ['geen adres'] });

    const body = bookingBody(ctx);
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: body });
    const year = Number(body.partyDate.slice(0, 4));
    expect((await call('POST', '/mailing/contacts/from-bookings', { year })).json()).toEqual({ added: 1, known: 0 });
    expect((await call('POST', '/mailing/contacts/from-bookings', { year })).json()).toEqual({ added: 0, known: 1 });
    const list = (await call('GET', '/mailing/contacts')).json();
    expect(list).toHaveLength(3);
    expect(list.find((c: { email: string }) => c.email === body.email)).toMatchObject({ name: body.parentName, bookings: 1, note: `Boeking ${year}` });
  });

  it('sends everyone their own mail with first name and a way out, and skips who unsubscribed', async () => {
    await call('POST', '/mailing/contacts', { contacts: [{ email: 'jan@example.com', name: 'Jan Jansen' }, { email: 'piet@example.com' }, { email: 'weg@example.com', name: 'Weg' }] });
    // The link in an earlier mail: one visit takes this person off the list.
    const { rows } = await ctx.db.query<{ token: string }>("SELECT token FROM mail_contacts WHERE email = 'weg@example.com'");
    const out = await ctx.app.inject({ method: 'POST', url: '/api/unsubscribe', payload: { token: rows[0]!.token } });
    expect(out.json()).toEqual({ email: 'w…@example.com' });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/unsubscribe', payload: { token: 'bestaat-niet-123' } })).statusCode).toBe(404);

    ctx.sent.length = 0;
    const message = { subject: 'Bedankt voor 2026', body: 'Hoi {voornaam},\n\nDank je wel!' };
    expect((await call('POST', '/mailings/test', message)).statusCode).toBe(200);
    expect(ctx.sent[0]).toMatchObject({ subject: '[Test] Bedankt voor 2026' });

    ctx.sent.length = 0;
    const sent = await call('POST', '/mailings', message);
    expect(sent.statusCode).toBe(202);
    expect(sent.json().recipients).toBe(2);
    expect(ctx.sent.map((m) => m.to).sort()).toEqual(['jan@example.com', 'piet@example.com']);
    const jan = ctx.sent.find((m) => m.to === 'jan@example.com')!;
    expect(jan.text).toContain('Hoi Jan,');
    expect(jan.text).toMatch(/Meld je af: http.*\/afmelden\?t=\S+/);
    expect(ctx.sent.find((m) => m.to === 'piet@example.com')!.text).toContain('Hoi daar,');

    const [mailing] = (await call('GET', '/mailings')).json();
    expect(mailing).toMatchObject({ subject: 'Bedankt voor 2026', sent: 2, failed: 0, queued: 0 });
    expect(mailing.finishedAt).not.toBeNull();
  });

  it('refuses an empty list, and is for the owner only', async () => {
    expect((await call('POST', '/mailings', { subject: 'x', body: 'y' })).json().code).toBe('no_recipients');
    expect((await ctx.app.inject({ url: '/api/admin/mailing/contacts' })).statusCode).toBe(401);
    expect(personalise('Hoi {voornaam}', '', 'https://x/afmelden?t=1')).toContain('Hoi daar');
  });
});
