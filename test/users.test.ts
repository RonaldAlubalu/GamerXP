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
      ['GET', '/status'],
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

  it('shows the owner which connections work', async () => {
    const status = (await call(owner, 'GET', '/status')).json();
    const state = Object.fromEntries(status.checks.map((c: { key: string; state: string }) => [c.key, c.state]));
    expect(state).toMatchObject({ database: 'ok', 'mail-send': 'off', 'mail-read': 'off', mollie: 'off', whatsapp: 'ok' });
    expect((await call(owner, 'GET', '/overview')).json().systemProblems).toBe(0);
  });

  it('explains mailbox login problems in plain words', async () => {
    const { explain } = await import('../src/services/status.js');
    expect(explain(Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: '[AUTHENTICATIONFAILED] Invalid credentials (Failure)' }))).toContain('app-wachtwoord (16 letters)');
    expect(explain(new Error('Invalid login: 534-5.7.9 Application-specific password required'))).toContain('Google vraagt om een app-wachtwoord');
    expect(explain(new Error('connect ETIMEDOUT 142.250.0.1:993'))).toContain('geen antwoord');
    expect(explain(new Error('iets anders'))).toBe('iets anders');
  });

  it('always keeps an owner', async () => {
    const [me] = (await call(owner, 'GET', '/users')).json();
    expect((await call(owner, 'DELETE', `/users/${me.id}`)).statusCode).toBe(409);
    expect((await call(owner, 'PATCH', `/users/${me.id}`, { role: 'assistant' })).statusCode).toBe(409);
  });
});

describe('two-step login', () => {
  const login = (payload: object) => ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { email: 'admin@gamerxp.nl', password: 'correct-horse-battery', ...payload } });

  it('asks for a code once it is switched on, accepts each code once, and takes backup codes', async () => {
    const { codeAt, currentStep } = await import('../src/lib/totp.js');
    expect((await call(owner, 'GET', '/me')).json().twoFactor).toBe(false);
    const { secret, qrSvg } = (await call(owner, 'POST', '/me/2fa/setup')).json();
    expect(qrSvg).toContain('<svg');
    // Not active until a code proves the app works.
    expect((await login({})).statusCode).toBe(200);
    expect((await call(owner, 'POST', '/me/2fa/enable', { code: '000000' })).statusCode).toBe(400);
    const step = currentStep();
    const enabled = await call(owner, 'POST', '/me/2fa/enable', { code: codeAt(secret, step) });
    expect(enabled.json().recoveryCodes).toHaveLength(8);

    const needs = await login({});
    expect(needs.statusCode).toBe(401);
    expect(needs.json().code).toBe('two_factor_required');
    expect((await login({ code: '123456' })).json().code).toBe('invalid_code');
    // The code used to switch it on can't be used again; the next one works, once.
    expect((await login({ code: codeAt(secret, step) })).statusCode).toBe(401);
    expect((await login({ code: codeAt(secret, step + 1) })).statusCode).toBe(200);
    expect((await login({ code: codeAt(secret, step + 1) })).statusCode).toBe(401);

    const backup = enabled.json().recoveryCodes[0];
    expect((await login({ code: backup.toUpperCase() })).statusCode).toBe(200);
    expect((await login({ code: backup })).statusCode).toBe(401);
    // A wrong password never reveals whether a second step exists.
    const wrong = await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { email: 'admin@gamerxp.nl', password: 'fout' } });
    expect(wrong.json().code).toBe('invalid_credentials');
  });

  it('can be switched off with the password, or reset by an owner', async () => {
    const { codeAt, currentStep } = await import('../src/lib/totp.js');
    const { secret } = (await call(owner, 'POST', '/me/2fa/setup')).json();
    await call(owner, 'POST', '/me/2fa/enable', { code: codeAt(secret, currentStep()) });
    expect((await call(owner, 'POST', '/me/2fa/disable', { password: 'fout' })).statusCode).toBe(400);
    expect((await call(owner, 'POST', '/me/2fa/disable', { password: 'correct-horse-battery' })).statusCode).toBe(204);
    expect((await login({})).statusCode).toBe(200);

    const { user, token } = await addAssistant();
    const lisa = (await call(token, 'POST', '/me/2fa/setup')).json();
    await call(token, 'POST', '/me/2fa/enable', { code: codeAt(lisa.secret, currentStep()) });
    expect((await call(owner, 'GET', '/users')).json().find((u: { id: number }) => u.id === user.id).twoFactor).toBe(true);
    expect((await call(token, 'POST', `/users/${user.id}/2fa-reset`)).statusCode).toBe(403);
    expect((await call(owner, 'POST', `/users/${user.id}/2fa-reset`)).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/admin/login', payload: { email: 'lisa@gamerxp.nl', password: 'lisa-wachtwoord-1' } })).statusCode).toBe(200);
  });
});

describe('login link by email', () => {
  const loginUrl = '/api/admin/login';
  const creds = { email: 'admin@gamerxp.nl', password: 'correct-horse-battery' };
  const finish = (payload: object) => ctx.app.inject({ method: 'POST', url: '/api/admin/login/link', payload });
  const start = async () => {
    const res = await ctx.app.inject({ method: 'POST', url: loginUrl, payload: creds });
    const mail = ctx.sent.at(-1)!;
    return { res, mail, token: /inloggen\?t=([\w-]+)/.exec(mail.text)![1]!, code: /code over in het inlogscherm: (\d{6})/.exec(mail.text)![1]! };
  };

  beforeEach(() => {
    ctx.app.config.SMTP_HOST = 'smtp.example.test';
  });

  it('sends a link and a code instead of a session when there is no authenticator app', async () => {
    const { res, mail, token } = await start();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ step: 'email', minutes: 10 });
    expect(res.json().token).toBeUndefined();
    expect(mail.to).toBe('admin@gamerxp.nl');

    const done = await finish({ pending: res.json().pending, token });
    expect(done.statusCode).toBe(200);
    expect((await call(done.json().token, 'GET', '/me')).statusCode).toBe(200);
    // One use only.
    expect((await finish({ pending: res.json().pending, token })).json().code).toBe('link_expired');
  });

  it('accepts the code typed over, and the link alone opens nothing', async () => {
    const { res, token, code } = await start();
    // The mail without the browser that typed the password is useless.
    expect((await finish({ pending: 'x'.repeat(43), token })).statusCode).toBe(401);
    const done = await finish({ pending: res.json().pending, code });
    expect(done.statusCode).toBe(200);
    expect(done.json().token).toBeTruthy();
  });

  it('stops after five wrong codes and expires', async () => {
    const { res, code } = await start();
    const pending = res.json().pending;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await finish({ pending, code: wrong })).json().code).toBe('invalid_code');
    expect((await finish({ pending, code })).json().code).toBe('link_expired');

    const again = await start();
    await ctx.db.query(`UPDATE login_links SET expires_at = now() - interval '1 minute'`);
    expect((await finish({ pending: again.res.json().pending, code: again.code })).json().code).toBe('link_expired');
  });

  it('does not mail when the password is wrong or an authenticator app is set up', async () => {
    const before = ctx.sent.length;
    const bad = await ctx.app.inject({ method: 'POST', url: loginUrl, payload: { ...creds, password: 'fout' } });
    expect(bad.statusCode).toBe(401);
    await ctx.db.query(`UPDATE admin_users SET totp_enabled = true, totp_secret = 'JBSWY3DPEHPK3PXP'`);
    const totp = await ctx.app.inject({ method: 'POST', url: loginUrl, payload: creds });
    expect(totp.json().code).toBe('two_factor_required');
    expect(ctx.sent.length).toBe(before);
  });
});

describe('remember this device for 30 days', () => {
  const loginUrl = '/api/admin/login';
  const creds = { email: 'admin@gamerxp.nl', password: 'correct-horse-battery' };
  const post = (url: string, payload: object) => ctx.app.inject({ method: 'POST', url, payload });

  beforeEach(() => {
    ctx.app.config.SMTP_HOST = 'smtp.example.test';
  });

  async function rememberedDevice() {
    const first = await post(loginUrl, { ...creds, remember: true });
    const code = /inlogscherm: (\d{6})/.exec(ctx.sent.at(-1)!.text)![1]!;
    const done = await post('/api/admin/login/link', { pending: first.json().pending, code });
    expect(done.json().deviceToken).toBeTruthy();
    return done.json() as { token: string; deviceToken: string };
  }

  it('skips the second step on that device only, and not without the password', async () => {
    const { deviceToken } = await rememberedDevice();
    const mails = ctx.sent.length;

    const again = await post(loginUrl, { ...creds, device: deviceToken });
    expect(again.json().token).toBeTruthy();
    expect(ctx.sent.length).toBe(mails);

    expect((await post(loginUrl, { ...creds, password: 'fout', device: deviceToken })).statusCode).toBe(401);
    expect((await post(loginUrl, { ...creds, device: 'een-ander-apparaat' })).json().step).toBe('email');
  });

  it('gives no device token without the tick, and expires after 30 days', async () => {
    const first = await post(loginUrl, creds);
    const code = /inlogscherm: (\d{6})/.exec(ctx.sent.at(-1)!.text)![1]!;
    expect((await post('/api/admin/login/link', { pending: first.json().pending, code })).json().deviceToken).toBeUndefined();

    const { deviceToken } = await rememberedDevice();
    await ctx.db.query(`UPDATE trusted_devices SET expires_at = now() - interval '1 minute'`);
    expect((await post(loginUrl, { ...creds, device: deviceToken })).json().step).toBe('email');
  });

  it('forgets devices on request and when the password changes', async () => {
    const a = await rememberedDevice();
    expect((await call(a.token, 'GET', '/me')).json().trustedDevices).toBe(1);
    expect((await call(a.token, 'POST', '/me/devices/forget')).statusCode).toBe(204);
    expect((await post(loginUrl, { ...creds, device: a.deviceToken })).json().step).toBe('email');

    const b = await rememberedDevice();
    const changed = await call(b.token, 'POST', '/me/password', { current: creds.password, password: 'een-heel-nieuw-wachtwoord' });
    expect(changed.statusCode).toBeLessThan(300);
    const after = await post(loginUrl, { email: creds.email, password: 'een-heel-nieuw-wachtwoord', device: b.deviceToken });
    expect(after.json().step).toBe('email');
  });
});

describe('profile', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await setupApp(); });
  afterEach(() => teardown(ctx));

  it('sends a test mail to every login and a test notification to the owners\' devices', async () => {
    const token = await loginAdmin(ctx);
    const headers = { authorization: `Bearer ${token}` };
    await ctx.app.inject({ method: 'POST', url: '/api/admin/push/subscribe', headers, payload: { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' }, device: 'test' } });
    ctx.sent.length = 0;
    const res = (await ctx.app.inject({ method: 'POST', url: '/api/admin/system/test', headers })).json();
    expect(res).toMatchObject({ failed: [], devices: 1, pushed: 1 });
    expect(res.mailed).toHaveLength(1);
    expect(ctx.sent.map((m) => m.subject)).toEqual(['Testbericht van de Gamer Xperience admin']);
    expect(ctx.pushed[0]).toMatchObject({ title: 'Testmelding', url: '#/system' });
  });

  it('lets a user set a name and a small photo, and lists who works here by address', async () => {
    const token = await loginAdmin(ctx);
    const headers = { authorization: `Bearer ${token}` };
    const photo = `data:image/jpeg;base64,${Buffer.from('foto').toString('base64')}`;
    const saved = await ctx.app.inject({ method: 'POST', url: '/api/admin/me/profile', headers, payload: { name: 'Ronald', avatar: photo } });
    expect(saved.json()).toMatchObject({ name: 'Ronald', avatar: photo });
    // A name alone keeps the photo; an empty one removes it; anything that is not an image is refused.
    expect((await ctx.app.inject({ method: 'POST', url: '/api/admin/me/profile', headers, payload: { name: 'Ronald Kers' } })).json().avatar).toBe(photo);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/admin/me/profile', headers, payload: { name: 'Ronald Kers', avatar: 'javascript:alert(1)' } })).statusCode).toBe(400);
    const me = (await ctx.app.inject({ url: '/api/admin/me', headers })).json();
    expect(me).toMatchObject({ name: 'Ronald Kers', avatar: photo });
    const staff = (await ctx.app.inject({ url: '/api/admin/staff', headers })).json();
    expect(staff).toEqual([{ email: me.email, name: 'Ronald Kers', avatar: photo }]);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/admin/me/profile', headers, payload: { name: 'Ronald Kers', avatar: '' } })).json().avatar).toBe('');
  });
});
