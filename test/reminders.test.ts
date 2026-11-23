import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays, today } from '../src/lib/dates.js';
import { whatsappUrl } from '../src/lib/emails.js';
import { bookingBody, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });
const get = async (url: string) => (await ctx.app.inject({ url: `/api/admin${url}`, headers: auth() })).json();

beforeEach(async () => {
  ctx = await setupApp();
  token = await loginAdmin(ctx);
});
afterEach(() => teardown(ctx));

// A booking for tomorrow in the given stage (the website itself needs more notice).
async function partyTomorrow(status: string, overrides: Record<string, unknown> = {}) {
  const email = `${status}@example.nl`;
  await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, { email, ...overrides }) });
  const tomorrow = addDays(today(ctx.config.TIMEZONE), 1);
  const { rows } = await ctx.db.query("UPDATE bookings SET status = $1, party_date = $2, start_time = '14:00' WHERE email = $3 RETURNING id", [status, tomorrow, email]);
  ctx.sent.length = 0;
  return rows[0].id as string;
}

describe('day-before reminders', () => {
  it('lists only definite parties that are tomorrow', async () => {
    const paid = await partyTomorrow('deposit_paid');
    await partyTomorrow('new');
    await partyTomorrow('confirmed');
    const reminders = await get('/reminders');
    expect(reminders.map((r: { id: string }) => r.id)).toEqual([paid]);
    expect(reminders[0].text).toContain('Hoi Sanne! Morgen is het zover: het feest van Daan');
    expect(reminders[0].text).toContain('begint om 14:00');
    expect(reminders[0].whatsappUrl).toMatch(/^https:\/\/wa\.me\/31612345678\?text=Hoi%20Sanne/);
    expect((await get('/overview')).remindersDue).toBe(1);
  });

  it('logs a WhatsApp reminder once and keeps whose turn it is', async () => {
    const id = await partyTomorrow('scheduled');
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/bookings/${id}`, headers: auth(), payload: { waitingOn: 'nobody' } });
    const res = await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${id}/reminder`, headers: auth(), payload: { channel: 'whatsapp' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().waitingOn).toBe('nobody');
    expect((await get(`/bookings/${id}`)).communications[0]).toMatchObject({ direction: 'out', channel: 'whatsapp' });
    expect(ctx.sent).toHaveLength(0);
    expect(await get('/reminders')).toEqual([]);
  });

  it('can send the reminder by email instead', async () => {
    const id = await partyTomorrow('deposit_paid', { phone: '' });
    expect((await get('/reminders'))[0].whatsappUrl).toBeNull();
    await ctx.app.inject({ method: 'POST', url: `/api/admin/bookings/${id}/reminder`, headers: auth(), payload: { channel: 'email' } });
    expect(ctx.sent[0]).toMatchObject({ to: 'deposit_paid@example.nl', subject: expect.stringContaining('Morgen is het zover') });
    expect((await get('/overview')).remindersDue).toBe(0);
  });

  it('builds WhatsApp links from Dutch and international numbers', () => {
    expect(whatsappUrl('06 12345678', 'Hoi')).toBe('https://wa.me/31612345678?text=Hoi');
    expect(whatsappUrl('+31 6 12345678', 'Hoi')).toBe('https://wa.me/31612345678?text=Hoi');
    expect(whatsappUrl('0031612345678', 'Hoi')).toBe('https://wa.me/31612345678?text=Hoi');
    expect(whatsappUrl('', 'Hoi')).toBeNull();
  });
});
