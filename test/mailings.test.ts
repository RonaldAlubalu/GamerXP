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
    expect((await call('POST', '/mailing/contacts/from-bookings')).json()).toEqual({ added: 1, known: 0 });
    // Someone who left stays out, also when the customers are added again.
    await ctx.db.query('UPDATE mail_contacts SET unsubscribed_at = now() WHERE email = $1', [body.email]);
    expect((await call('POST', '/mailing/contacts/from-bookings')).json()).toEqual({ added: 0, known: 1 });
    expect((await call('GET', '/mailing/contacts')).json().find((c: { email: string }) => c.email === body.email).unsubscribedAt).not.toBeNull();
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
    // A reason may follow, but only from someone who is already off the list.
    expect((await ctx.app.inject({ method: 'POST', url: '/api/unsubscribe/reason', payload: { token: rows[0]!.token, reason: 'Geen feestje meer gepland' } })).statusCode).toBe(200);
    const other = await ctx.db.query<{ token: string }>("SELECT token FROM mail_contacts WHERE email = 'jan@example.com'");
    expect((await ctx.app.inject({ method: 'POST', url: '/api/unsubscribe/reason', payload: { token: other.rows[0]!.token, reason: 'x' } })).statusCode).toBe(404);
    expect((await call('GET', '/mailing/contacts')).json().find((c: { email: string }) => c.email === 'weg@example.com').unsubscribeReason).toBe('Geen feestje meer gepland');

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

    // A first name given apart goes before the first word of the name.
    await call('POST', '/mailing/contacts', { contacts: [{ email: 'tom@example.com', name: 'Tom (& Mar) Binnendijk', firstName: 'Tom en Mar' }] });
    expect((await call('GET', '/mailing/contacts')).json().find((c: { email: string }) => c.email === 'tom@example.com').firstName).toBe('Tom en Mar');

    const [mailing] = (await call('GET', '/mailings')).json();
    expect(mailing).toMatchObject({ subject: 'Bedankt voor 2026', sent: 2, failed: 0, queued: 0 });
    expect(mailing.finishedAt).not.toBeNull();
  });

  it('sends a picture along at the top, and signs every mail', async () => {
    await call('POST', '/mailing/contacts', { contacts: [{ email: 'jan@example.com', name: 'Jan Jansen' }] });
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    expect((await call('POST', '/mailing/images', { image: 'data:text/html;base64,AAAA' })).statusCode).toBe(400);
    const made = (await call('POST', '/mailing/images', { image: pixel })).json();
    expect((await call('GET', '/mailing/images')).json()).toEqual([made]);
    // Mail programs fetch it without logging in.
    const shown = await ctx.app.inject({ url: `/api/mail-image/${made.token}` });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-type']).toBe('image/png');
    expect((await ctx.app.inject({ url: '/api/mail-image/bestaat-niet' })).statusCode).toBe(404);

    ctx.sent.length = 0;
    await call('POST', '/mailings', { subject: 'Fijne feestdagen', body: 'Hoi {voornaam},\n\nTot in 2027!', headerImage: made.token });
    expect(ctx.sent[0]).toMatchObject({ to: 'jan@example.com', headerImage: made.url });
    expect(ctx.sent[0]!.text).toMatch(/Tot in 2027!\n\nGame on![\s\S]*\n\n--\nJe krijgt/);

    expect((await call('DELETE', `/mailing/images/${made.token}`)).statusCode).toBe(204);
    expect((await ctx.app.inject({ url: `/api/mail-image/${made.token}` })).statusCode).toBe(404);
  });

  it('refuses an empty list, and is for the owner only', async () => {
    expect((await call('POST', '/mailings', { subject: 'x', body: 'y' })).json().code).toBe('no_recipients');
    expect((await ctx.app.inject({ url: '/api/admin/mailing/contacts' })).statusCode).toBe(401);
    expect(personalise('Hoi {voornaam}', '', 'https://x/afmelden?t=1')).toContain('Hoi daar');
  });
});
