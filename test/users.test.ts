import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, futureDate, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
let owner: string;
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const call = (token: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  ctx.app.inject({ method, url: `/api/admin${url}`, headers: as(token), payload });

async function login(email: string, password: string) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { email, password } });
  return res.json().token as string;
}
async function addAssistant() {
  const res = await call(owner, 'POST', '/users', { email: 'Lisa@GamerXP.nl', name: 'Lisa', role: 'assistant', password: 'lisa-wachtwoord-1' });
  expect(res.statusCode).toBe(201);
  return { user: res.json(), token: await login('lisa@gamerxp.nl', 'lisa-wachtwoord-1') };
}

beforeEach(async () => {
  ctx = await setupApp();
  owner = await loginAdmin(ctx);
});
afterEach(() => teardown(ctx));

describe('admin users', () => {
  it('lets an owner add an assistant who can log in', async () => {
    const { user, token } = await addAssistant();
    expect(user).toMatchObject({ email: 'lisa@gamerxp.nl', name: 'Lisa', role: 'assistant' });
    expect((await call(token, 'GET', '/me')).json()).toMatchObject({ email: 'lisa@gamerxp.nl', role: 'assistant' });
    expect((await call(owner, 'GET', '/users')).json()).toHaveLength(2);
    const again = await call(owner, 'POST', '/users', { email: 'lisa@gamerxp.nl', role: 'assistant', password: 'lisa-wachtwoord-2' });
    expect(again.statusCode).toBe(409);
    const short = await call(owner, 'POST', '/users', { email: 'kort@gamerxp.nl', role: 'assistant', password: 'kort' });
    expect(short.statusCode).toBe(400);
  });

  it('lets an assistant see bookings and change availability, and nothing else', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx) });
    const { token } = await addAssistant();
    const [booking] = (await call(token, 'GET', '/bookings')).json();
    expect(booking.status).toBe('new');
    for (const url of ['/overview', '/pipeline', `/bookings/${booking.id}`, `/calendar?month=${futureDate(ctx).slice(0, 7)}`, '/availability', '/blocked-dates']) {
      expect((await call(token, 'GET', url)).statusCode, url).toBe(200);
    }
    const date = futureDate(ctx, 30);
    expect((await call(token, 'PUT', `/blocked-dates/${date}`, { reason: 'Vakantie' })).statusCode).toBe(200);
    expect((await call(token, 'DELETE', `/blocked-dates/${date}`)).statusCode).toBe(204);

    const denied: [Parameters<typeof call>[1], string, object?][] = [
      ['PATCH', `/bookings/${booking.id}`, { status: 'confirmed' }],
      ['POST', `/bookings/${booking.id}/payments`, { kind: 'deposit', amountCents: 10000, method: 'bank', paidOn: date }],
      ['POST', `/bookings/${booking.id}/messages`, { direction: 'out', channel: 'email', body: 'Bericht van assistent', send: true }],
      ['GET', '/messages'],
      ['POST', '/packages', {}],
      ['GET', '/users'],
      ['POST', '/users', { email: 'x@gamerxp.nl', role: 'owner', password: 'heel-lang-wachtwoord' }],
      ['POST', '/mail-import'],
    ];
    for (const [method, url, payload] of denied) {
      expect((await call(token, method, url, payload)).statusCode, `${method} ${url}`).toBe(403);
    }
    expect(ctx.sent.filter((m) => m.text.includes('Bericht van assistent'))).toHaveLength(0);
  });

  it('lets users change their own password', async () => {
    const { token } = await addAssistant();
    const wrong = await call(token, 'POST', '/me/password', { current: 'fout', password: 'nieuw-wachtwoord-12' });
    expect(wrong.statusCode).toBe(400);
    expect((await call(token, 'POST', '/me/password', { current: 'lisa-wachtwoord-1', password: 'nieuw-wachtwoord-12' })).statusCode).toBe(204);
    expect(await login('lisa@gamerxp.nl', 'lisa-wachtwoord-1')).toBeUndefined();
    expect(await login('lisa@gamerxp.nl', 'nieuw-wachtwoord-12')).toBeTruthy();
  });

  it('logs a user out when an owner resets the password, changes the role or deletes them', async () => {
    const { user, token } = await addAssistant();
    expect((await call(owner, 'PATCH', `/users/${user.id}`, { password: 'door-eigenaar-gezet-1' })).statusCode).toBe(200);
    expect((await call(token, 'GET', '/me')).statusCode).toBe(401);
    const fresh = await login('lisa@gamerxp.nl', 'door-eigenaar-gezet-1');
    expect((await call(owner, 'DELETE', `/users/${user.id}`)).statusCode).toBe(204);
    expect((await call(fresh, 'GET', '/me')).statusCode).toBe(401);
  });

  it('always keeps an owner', async () => {
    const [me] = (await call(owner, 'GET', '/users')).json();
    expect((await call(owner, 'DELETE', `/users/${me.id}`)).statusCode).toBe(409);
    expect((await call(owner, 'PATCH', `/users/${me.id}`, { role: 'assistant' })).statusCode).toBe(409);
  });
});
