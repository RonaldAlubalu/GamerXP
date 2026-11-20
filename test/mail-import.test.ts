import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripQuotedReply, type IncomingMail } from '../src/services/mail-import.js';
import { bookingBody, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';

let ctx: TestContext;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });
let n = 0;
const mail = (overrides: Partial<IncomingMail> = {}): IncomingMail => ({
  messageId: `<m${++n}@example.nl>`,
  fromName: 'Sanne de Vries',
  fromEmail: 'Sanne@Example.nl',
  subject: 'Re: je aanvraag',
  text: 'Kunnen we om 14:00 beginnen?',
  date: new Date(),
  ...overrides,
});
const runImport = async () => (await ctx.app.inject({ method: 'POST', url: '/api/admin/mail-import', headers: auth() })).json();

beforeEach(async () => {
  ctx = await setupApp();
  token = await loginAdmin(ctx);
});
afterEach(() => teardown(ctx));

async function createBooking(overrides: Record<string, unknown> = {}) {
  await ctx.app.inject({ method: 'POST', url: '/api/bookings', payload: bookingBody(ctx, overrides) });
  const bookings = (await ctx.app.inject({ url: '/api/admin/bookings', headers: auth() })).json();
  return bookings.find((b: { email: string }) => b.email === (overrides.email ?? 'sanne@example.nl'));
}
const detail = async (id: string) => (await ctx.app.inject({ url: `/api/admin/bookings/${id}`, headers: auth() })).json();

describe('email import', () => {
  it('adds a customer email to their booking and makes it your turn', async () => {
    const booking = await createBooking();
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/bookings/${booking.id}`, headers: auth(), payload: { waitingOn: 'customer' } });
    ctx.inbox.push(mail());
    expect(await runImport()).toEqual({ imported: 1, newConversations: 0, skipped: 0 });

    const after = await detail(booking.id);
    expect(after.waitingOn).toBe('me');
    expect(after.communications[0]).toMatchObject({ direction: 'in', channel: 'email', body: 'Kunnen we om 14:00 beginnen?', actor: 'Sanne de Vries' });
  });

  it('imports each email only once', async () => {
    await createBooking();
    ctx.inbox.push(mail());
    await runImport();
    expect(await runImport()).toEqual({ imported: 0, newConversations: 0, skipped: 1 });
  });

  it('follows the booking reference when the email comes from another address', async () => {
    const booking = await createBooking();
    ctx.inbox.push(mail({ fromName: 'Peter', fromEmail: 'peter@werk.nl', subject: `Vraag over ${booking.reference.toLowerCase()}` }));
    await runImport();
    expect((await detail(booking.id)).communications[0]).toMatchObject({ actor: 'Peter', channel: 'email' });
  });

  it('starts a conversation under Berichten for an unknown sender and continues it', async () => {
    ctx.inbox.push(mail({ fromName: 'Nieuwe Klant', fromEmail: 'nieuw@example.nl', subject: 'Vraag', text: 'Komen jullie ook in Breda?' }));
    expect(await runImport()).toMatchObject({ imported: 1, newConversations: 1 });
    ctx.inbox.push(mail({ fromName: 'Nieuwe Klant', fromEmail: 'nieuw@example.nl', text: 'Nog een vraag.' }));
    expect(await runImport()).toMatchObject({ imported: 1, newConversations: 0 });

    const messages = (await ctx.app.inject({ url: '/api/admin/messages', headers: auth() })).json();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ name: 'Nieuwe Klant', email: 'nieuw@example.nl', message: 'Komen jullie ook in Breda?', waitingOn: 'me' });
    const thread = (await ctx.app.inject({ url: `/api/admin/messages/${messages[0].id}`, headers: auth() })).json();
    expect(thread.communications).toHaveLength(2);
  });

  it('skips our own emails and bounces', async () => {
    ctx.inbox.push(mail({ fromEmail: 'owner@gamerxp.nl' }), mail({ fromEmail: 'MAILER-DAEMON@mail.example.nl' }));
    expect(await runImport()).toEqual({ imported: 0, newConversations: 0, skipped: 2 });
  });

  it('keeps only what the customer wrote in a reply', () => {
    expect(stripQuotedReply('Prima, tot dan!\n\nOp di 3 nov 2026 om 10:12 schreef Gamer Xperience <contact@gamerxp.nl>:\n> Hoi Sanne,\n> ...')).toBe('Prima, tot dan!');
    expect(stripQuotedReply('Top.\r\n\r\n-----Oorspronkelijk bericht-----\r\nVan: Gamer Xperience')).toBe('Top.');
    expect(stripQuotedReply('> alleen een citaat')).toBe('> alleen een citaat');
  });

  it('tells the admin page whether the import is set up', async () => {
    expect((await ctx.app.inject({ url: '/api/admin/me', headers: auth() })).json().mailImportConfigured).toBe(true);
  });
});
