import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
let token: string;
const call = (method: 'GET' | 'POST', url: string, payload?: object, t = token) =>
  ctx.app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${t}` }, payload });
const device = (name: string) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: 'key', auth: 'auth' }, device: name });
// Notifications are sent without waiting, so give them a moment.
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeEach(async () => {
  ctx = await setupApp();
  token = await loginAdmin(ctx);
});
afterEach(() => teardown(ctx));

describe('push notifications', () => {
  it('hands out one stable public key', async () => {
    const first = (await call('GET', '/push/key')).json().publicKey;
    expect(first).toMatch(/^[\w-]{80,}$/);
    expect((await call('GET', '/push/key')).json().publicKey).toBe(first);
  });

  it('notifies the owner about a new request and a contact message', async () => {
    expect((await call('POST', '/push/subscribe', device('phone'))).statusCode).toBe(204);
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    await ctx.app.inject({ method: 'POST', url: '/api/contact', payload: { name: 'Kees', email: 'kees@example.nl', message: 'Komen jullie ook in Breda?' } });
    await settle();
    expect(ctx.pushed.map((p) => p.title)).toEqual(['Nieuwe aanvraag', 'Bericht van Kees']);
    expect(ctx.pushed[0]).toMatchObject({ endpoint: 'https://push.example/phone', body: expect.stringContaining('Sanne de Vries'), url: expect.stringMatching(/^#\/bookings\//) });
  });

  it('sends a test only to the person who asked, and forgets devices that are gone', async () => {
    await call('POST', '/push/subscribe', device('phone'));
    await call('POST', '/push/subscribe', device('gone-laptop'));
    expect((await call('POST', '/push/test')).json()).toEqual({ sent: 1 });
    expect((await ctx.db.query('SELECT endpoint FROM push_subscriptions')).rows).toEqual([{ endpoint: 'https://push.example/phone' }]);
  });

  it('does not send business notifications to an assistant, and stops after unsubscribing', async () => {
    await call('POST', '/users', { email: 'lisa@gamerxp.nl', role: 'assistant', password: 'lisa-wachtwoord-1' });
    const lisa = (await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { email: 'lisa@gamerxp.nl', password: 'lisa-wachtwoord-1' } })).json().token;
    expect((await call('POST', '/push/subscribe', device('lisa-phone'), lisa)).statusCode).toBe(204);
    await call('POST', '/push/subscribe', device('phone'));
    await call('POST', '/push/unsubscribe', { endpoint: device('phone').endpoint });
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    await settle();
    expect(ctx.pushed).toEqual([]);
  });
});
