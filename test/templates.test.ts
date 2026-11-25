import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookingBody, loginAdmin, setupApp, teardown, type TestContext } from './helpers.js';
import { renderEmailHtml } from '../src/lib/email-html.js';
import { setSignature, withSignature } from '../src/lib/emails.js';
import { addDays, today } from '../src/lib/dates.js';

describe('templates, sign-off and birthdays', () => {
  let ctx: TestContext;
  let token: string;
  const admin = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api/admin${url}`, headers: { authorization: `Bearer ${token}` }, payload });

  beforeEach(async () => {
    ctx = await setupApp();
    token = await loginAdmin(ctx);
  });
  afterEach(async () => {
    setSignature('');
    await teardown(ctx);
  });

  it('keeps changed built-in templates by their key and templates of your own', async () => {
    const changed = { key: 'booking:Prijsopgave', kind: 'booking', group: 'Na de aanvraag', label: 'Prijsopgave', subject: 'Prijs', body: 'Hoi {naam}, nieuwe tekst' };
    expect((await admin('POST', '/templates', changed)).statusCode).toBe(201);
    // Saving the same key again replaces it instead of adding a second one.
    await admin('POST', '/templates', { ...changed, body: 'Hoi {naam}, nog nieuwer', hidden: true });
    const own = (await admin('POST', '/templates', { kind: 'contact', label: 'Eigen antwoord', body: 'Hoi!' })).json();
    let all = (await admin('GET', '/templates')).json().templates;
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ key: 'booking:Prijsopgave', body: 'Hoi {naam}, nog nieuwer', hidden: true });

    expect((await admin('PATCH', `/templates/${own.id}`, { label: 'Eigen antwoord 2', body: 'Hallo!' })).json()).toMatchObject({ label: 'Eigen antwoord 2', key: null });
    expect((await admin('POST', '/templates', { kind: 'booking', label: '', body: 'x' })).statusCode).toBe(400);
    expect((await admin('DELETE', `/templates/${all[0].id}`)).statusCode).toBe(204);
    all = (await admin('GET', '/templates')).json().templates;
    expect(all.map((t: { label: string }) => t.label)).toEqual(['Eigen antwoord 2']);
  });

  it('puts the sign-off the owner wrote under the mails, in the look of the site', async () => {
    const before = (await admin('GET', '/templates')).json();
    expect(before.signature).toBe(before.defaultSignature);
    expect((await admin('PUT', '/settings/signature', { text: 'Tot gauw!\n\nRonald Kers\nGamer Xperience\n06 3420 6753' })).json().signature).toContain('Tot gauw!');
    expect(withSignature('Hoi')).toBe('Hoi\n\nTot gauw!\n\nRonald Kers\nGamer Xperience\n06 3420 6753');
    const html = renderEmailHtml(withSignature('Hoi Jan'), { publicUrl: 'https://gamerxp.nl', signature: 'Tot gauw!\n\nRonald Kers\nGamer Xperience\n06 3420 6753' });
    expect(html).toContain('>Tot gauw!</p>');
    expect(html).toContain('<strong>Ronald Kers</strong><br>Gamer Xperience</p>');
    // Empty puts the standard one back.
    expect((await admin('PUT', '/settings/signature', { text: '' })).json().signature).toBe(before.defaultSignature);
    expect(withSignature('Hoi')).toContain('Game on!');
  });

  it('lists children who have a birthday again soon, and mails or skips them', async () => {
    const t = today(ctx.app.config.TIMEZONE);
    const book = async (email: string, child: string, daysAgo: number, status = 'completed') => {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/bookings', headers: { authorization: `Bearer ${token}` }, payload: bookingBody(ctx, { email, childName: child, firstName: 'Sanne', lastName: 'de Vries' }) });
      const { id } = res.json();
      await ctx.db.query('UPDATE bookings SET party_date = $2, status = $3 WHERE id = $1', [id, addDays(t, -daysAgo), status]);
      return id as string;
    };
    const soon = await book('soon@example.nl', 'Daan', 365 - 21); // birthday in three weeks
    await book('far@example.nl', 'Finn', 365 - 120); // in four months: not yet
    await book('fresh@example.nl', 'Noor', 30); // party was last month
    const again = await book('again@example.nl', 'Sam', 365 - 14);
    await book('again@example.nl', 'Sam', -40, 'scheduled'); // already booked again
    await book('gone@example.nl', 'Mila', 365 - 10);
    await admin('POST', '/mailing/contacts', { contacts: [{ email: 'gone@example.nl' }] });
    await ctx.db.query("UPDATE mail_contacts SET unsubscribed_at = now() WHERE email = 'gone@example.nl'");
    const skip = await book('skip@example.nl', 'Lars', 365 - 30);

    let list = (await admin('GET', '/birthdays')).json();
    expect(list.map((b: { childName: string }) => b.childName)).toEqual(['Daan', 'Lars']);
    expect(list[0]).toMatchObject({ id: soon, turning: 10, around: addDays(t, 21), firstName: 'Sanne' });
    expect(again).toBeTruthy();
    expect((await admin('GET', '/overview')).json().birthdays).toBe(2);

    // Without a discount to make the link for, the mail is refused; with one it goes out once.
    await ctx.db.query('UPDATE discount_codes SET active = false');
    const mail = { subject: 'Daan is bijna jarig', body: 'Hoi Sanne,\n\nKorting: {kortingslink}' };
    expect((await admin('POST', `/birthdays/${soon}/mail`, mail)).json().code).toBe('no_code');
    await admin('POST', '/discount-codes', { code: 'jarig10', percent: 10, personal: true });
    ctx.sent.length = 0;
    expect((await admin('POST', `/birthdays/${soon}/mail`, mail)).statusCode).toBe(200);
    expect(ctx.sent[0]).toMatchObject({ to: 'soon@example.nl', subject: 'Daan is bijna jarig' });
    expect(ctx.sent[0]!.text).toMatch(/Korting: http\S+\/reserveer\?korting=\S+\n\nGame on!/);

    expect((await admin('POST', `/birthdays/${skip}/skip`)).statusCode).toBe(200);
    list = (await admin('GET', '/birthdays')).json();
    expect(list).toHaveLength(0);
  });
});
