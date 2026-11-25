import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { withSignature } from '../../lib/emails.js';
import { personalLinkToken } from '../../services/discounts.js';
import { referralToken } from '../../services/referrals.js';
import { actorOf } from './bookings.js';

const email = z.email('Vul een geldig e-mailadres in.').trim().max(200);
const idParam = z.object({ id: z.coerce.number().int().positive() });
const message = z.object({
  subject: z.string().trim().min(1, 'Vul een onderwerp in.').max(200),
  body: z.string().trim().min(1, 'Schrijf een bericht.').max(10_000),
  // The discount the personal link in the mail ({kortingslink}) is for.
  discountCodeId: z.number().int().positive().nullable().default(null),
  // The picture at the top, when there is one (see /mailing/images).
  headerImage: z.string().regex(/^[A-Za-z0-9_-]{10,40}$/).or(z.literal('')).default(''),
});
const LINK = /\{kortingslink\}/gi;

// "Jan Jansen" -> "Jan". Without a name the greeting stays neutral.
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

// The mail as one person gets it: their first name filled in, and the way out at the bottom.
export function personalise(body: string, name: string, unsubscribeUrl: string, discountUrl = '', referralUrl = '', given = ''): string {
  const first = given.trim() || firstName(name);
  const text = body
    .replace(/\{voornaam\}/gi, first || 'daar')
    .replace(/\{naam\}/gi, name.trim() || 'daar')
    .replace(LINK, discountUrl)
    .replace(/\{aanbeveellink\}/gi, referralUrl);
  return `${withSignature(text)}\n\n--\nJe krijgt deze mail omdat we een gamefeestje bij jullie hebben verzorgd. Geen mails meer ontvangen? Meld je af: ${unsubscribeUrl}`;
}

const imageUrl = (app: FastifyInstance, token: string) => (token ? `${app.config.PUBLIC_URL}/api/mail-image/${token}` : undefined);
const unsubscribeUrl = (app: FastifyInstance, token: string) => `${app.config.PUBLIC_URL}/afmelden?t=${token}`;

// Sends a mailing one mail at a time, so every customer gets their own mail and a slow mail
// server is not flooded. Runs on after the request that started it has answered.
async function deliver(app: FastifyInstance, mailingId: number): Promise<void> {
  const mailing = (await app.db.query<{ subject: string; body: string; codeId: number | null; image: string }>('SELECT subject, body, discount_code_id AS "codeId", header_image AS image FROM mailings WHERE id = $1', [mailingId])).rows[0];
  if (!mailing) return;
  for (;;) {
    const { rows } = await app.db.query<{ id: number; email: string; name: string; first: string; token: string }>(
      `SELECT c.id, c.email, c.name, c.first_name AS first, c.token FROM mailing_recipients r JOIN mail_contacts c ON c.id = r.contact_id
        WHERE r.mailing_id = $1 AND r.status = 'queued' AND c.unsubscribed_at IS NULL ORDER BY c.id LIMIT 1`,
      [mailingId],
    );
    const to = rows[0];
    if (!to) break;
    let status: 'sent' | 'failed' = 'sent';
    try {
      // Everyone gets a link of their own, good for one booking.
      const link = mailing.codeId ? `${app.config.PUBLIC_URL}/reserveer?korting=${await personalLinkToken(app.db, mailing.codeId, to.id)}` : '';
      // And a recommending link of their own, when the text asks for it.
      const via = /\{aanbeveellink\}/i.test(mailing.body) ? `${app.config.PUBLIC_URL}/reserveer?via=${await referralToken(app.db, to.id)}` : '';
      await app.mailer.send({ to: to.email, subject: mailing.subject, headerImage: imageUrl(app, mailing.image), text: personalise(mailing.body, to.name, unsubscribeUrl(app, to.token), link, via, to.first) });
    } catch (err) {
      app.log.warn({ err, mailing: mailingId }, 'A mail of a mailing failed');
      status = 'failed';
    }
    await app.db.query('UPDATE mailing_recipients SET status = $3, sent_at = now() WHERE mailing_id = $1 AND contact_id = $2', [mailingId, to.id, status]);
    await new Promise((r) => setTimeout(r, app.config.NODE_ENV === 'test' ? 0 : 1500));
  }
  await app.db.query('UPDATE mailings SET finished_at = now() WHERE id = $1', [mailingId]);
}

// A mail with {kortingslink} needs a discount to make the links for, and the other way round.
function checkLink(body: { body: string; discountCodeId: number | null }) {
  const has = /\{kortingslink\}/i.test(body.body);
  if (has && !body.discountCodeId) throw new HttpError(422, 'In de tekst staat {kortingslink}, maar er is geen korting gekozen voor die link.', 'no_discount');
  if (!has && body.discountCodeId) throw new HttpError(422, 'Je hebt een korting gekozen, maar in de tekst staat nergens {kortingslink}.', 'no_link');
}

export const mailingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    if (req.admin?.role !== 'owner') throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
  });

  // Everyone a mailing can go to, with how many parties this address had here.
  app.get('/mailing/contacts', async () => {
    const { rows } = await app.db.query(
      `SELECT c.id, c.email, c.name, c.first_name AS "firstName", c.note, c.unsubscribed_at AS "unsubscribedAt", c.unsubscribe_reason AS "unsubscribeReason", c.created_at AS "createdAt",
              (SELECT count(*)::int FROM bookings b WHERE lower(b.email) = lower(c.email) AND b.status <> 'cancelled') AS bookings,
              -- Whether a personal discount link of this person was used for a booking.
              EXISTS (SELECT 1 FROM discount_links l JOIN bookings b ON b.discount_link = l.token AND b.status <> 'cancelled' WHERE l.contact_id = c.id) AS "linkUsed",
              -- Recommending: parties that came in through this person, and how many of them have taken place and still count.
              (SELECT count(*)::int FROM bookings b WHERE b.referred_by = c.id AND b.status <> 'cancelled') AS referrals,
              (SELECT count(*)::int FROM bookings b WHERE b.referred_by = c.id AND b.status IN ('party_held', 'completed') AND b.referral_redeemed_on IS NULL) AS "referralsHeld"
         FROM mail_contacts c ORDER BY lower(c.name), lower(c.email)`,
    );
    return rows;
  });

  // Adds people: typed, pasted or read from a file. An address that is already there keeps its
  // place (and stays unsubscribed if it was); a missing name is filled in.
  app.post('/mailing/contacts', async (req) => {
    const body = z
      .object({ contacts: z.array(z.object({ email: z.string().trim().max(200), name: z.string().trim().max(100).default(''), firstName: z.string().trim().max(50).default(''), note: z.string().trim().max(200).default('') })).min(1).max(2000) })
      .parse(req.body);
    let added = 0;
    let known = 0;
    const invalid: string[] = [];
    for (const c of body.contacts) {
      const parsed = email.safeParse(c.email);
      if (!parsed.success) {
        if (c.email) invalid.push(c.email);
        continue;
      }
      const res = await app.db.query(
        `INSERT INTO mail_contacts (email, name, note, token, first_name) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lower(email)) DO UPDATE SET name = CASE WHEN mail_contacts.name = '' THEN EXCLUDED.name ELSE mail_contacts.name END,
           first_name = CASE WHEN mail_contacts.first_name = '' THEN EXCLUDED.first_name ELSE mail_contacts.first_name END
         RETURNING (xmax = 0) AS inserted`,
        [parsed.data, c.name, c.note, randomBytes(18).toString('base64url'), c.firstName || firstName(c.name)],
      );
      if (res.rows[0].inserted) added++;
      else known++;
    }
    return { added, known, invalid };
  });

  // Every customer in the admin with an e-mail address, from any year. Someone who unsubscribed
  // earlier stays unsubscribed.
  app.post('/mailing/contacts/from-bookings', async () => {
    const { rows } = await app.db.query<{ email: string; name: string; first: string; year: number }>(
      `SELECT DISTINCT ON (lower(email)) email, parent_name AS name, first_name AS first, extract(year FROM party_date)::int AS year FROM bookings
        WHERE email <> '' AND status <> 'cancelled' ORDER BY lower(email), party_date DESC`,
    );
    let added = 0;
    for (const c of rows) {
      const res = await app.db.query(
        `INSERT INTO mail_contacts (email, name, note, token, first_name) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (lower(email)) DO NOTHING`,
        [c.email, c.name, `Boeking ${c.year}`, randomBytes(18).toString('base64url'), c.first || firstName(c.name)],
      );
      added += res.rowCount ?? 0;
    }
    return { added, known: rows.length - added };
  });

  app.patch('/mailing/contacts/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ name: z.string().trim().max(100).optional(), firstName: z.string().trim().max(50).optional(), subscribed: z.boolean().optional() }).parse(req.body);
    const { rows } = await app.db.query(
      `UPDATE mail_contacts SET name = COALESCE($2, name), first_name = COALESCE($4, first_name),
              unsubscribed_at = CASE WHEN $3::boolean IS NULL THEN unsubscribed_at WHEN $3 THEN NULL ELSE COALESCE(unsubscribed_at, now()) END,
              unsubscribe_reason = CASE WHEN $3 THEN '' ELSE unsubscribe_reason END
        WHERE id = $1 RETURNING id`,
      [id, body.name ?? null, body.subscribed ?? null, body.firstName ?? null],
    );
    if (!rows[0]) throw new HttpError(404, 'Dit adres staat niet (meer) in de lijst.', 'not_found');
    return { ok: true };
  });

  app.delete('/mailing/contacts/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await app.db.query('DELETE FROM mail_contacts WHERE id = $1', [id]);
    return reply.status(204).send();
  });

  // Pictures for the top of a mailing. The page makes them small enough before sending.
  app.get('/mailing/images', async () => {
    const { rows } = await app.db.query<{ token: string }>('SELECT token FROM mailing_images ORDER BY id DESC LIMIT 12');
    return rows.map((r) => ({ token: r.token, url: imageUrl(app, r.token) }));
  });

  app.post('/mailing/images', { bodyLimit: 900 * 1024 }, async (req) => {
    const { image } = z.object({ image: z.string().max(800_000).regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/, 'Dit plaatje kan niet worden gebruikt.') }).parse(req.body);
    const [head, data] = image.split(',') as [string, string];
    const token = randomBytes(15).toString('base64url');
    await app.db.query('INSERT INTO mailing_images (token, mime, data) VALUES ($1, $2, $3)', [token, head.includes('png') ? 'image/png' : 'image/jpeg', Buffer.from(data, 'base64')]);
    return { token, url: imageUrl(app, token) };
  });

  app.delete('/mailing/images/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().max(40) }).parse(req.params);
    await app.db.query('DELETE FROM mailing_images WHERE token = $1', [token]);
    return reply.status(204).send();
  });

  // Earlier mailings with how far each one got.
  app.get('/mailings', async () => {
    const { rows } = await app.db.query(
      `SELECT m.id, m.subject, m.body, m.actor, m.created_at AS "createdAt", m.finished_at AS "finishedAt",
              count(r.*) FILTER (WHERE r.status = 'sent')::int AS sent,
              count(r.*) FILTER (WHERE r.status = 'failed')::int AS failed,
              count(r.*) FILTER (WHERE r.status = 'queued')::int AS queued
         FROM mailings m LEFT JOIN mailing_recipients r ON r.mailing_id = m.id GROUP BY m.id ORDER BY m.id DESC`,
    );
    return rows;
  });

  // One mail to yourself, exactly as a customer would get it.
  app.post('/mailings/test', async (req) => {
    const body = message.parse(req.body);
    checkLink(body);
    await app.mailer.send({ to: req.admin!.email, subject: `[Test] ${body.subject}`, headerImage: imageUrl(app, body.headerImage), text: personalise(body.body, req.admin!.name || 'Voornaam', `${app.config.PUBLIC_URL}/afmelden?t=voorbeeld`, `${app.config.PUBLIC_URL}/reserveer?korting=voorbeeld`, `${app.config.PUBLIC_URL}/reserveer?via=voorbeeld`) });
    return { to: req.admin!.email };
  });

  // Sends to everyone on the list who has not unsubscribed. Answers at once; the mails go out
  // one by one after that.
  app.post('/mailings', async (req, reply) => {
    // Without contactIds everyone on the list gets it; with them only the people ticked.
    const body = message.extend({ contactIds: z.array(z.coerce.number().int().positive()).min(1).max(5000).optional() }).parse(req.body);
    checkLink(body);
    const busy = await app.db.query('SELECT 1 FROM mailings WHERE finished_at IS NULL');
    if (busy.rowCount) throw new HttpError(409, 'Er wordt nog een mailing verstuurd. Wacht tot die klaar is.', 'busy');
    const { rows } = await app.db.query<{ id: number }>('INSERT INTO mailings (subject, body, actor, discount_code_id, header_image) VALUES ($1, $2, $3, $4, $5) RETURNING id', [body.subject, body.body, actorOf(req), body.discountCodeId, body.headerImage]);
    const id = rows[0]!.id;
    const queued = await app.db.query(
      'INSERT INTO mailing_recipients (mailing_id, contact_id) SELECT $1, id FROM mail_contacts WHERE unsubscribed_at IS NULL AND ($2::bigint[] IS NULL OR id = ANY($2))',
      [id, body.contactIds ?? null],
    );
    if (!queued.rowCount) {
      await app.db.query('DELETE FROM mailings WHERE id = $1', [id]);
      throw new HttpError(422, 'Er staat niemand op de lijst om naar te versturen.', 'no_recipients');
    }
    const run = deliver(app, id).catch((err) => app.log.error({ err, mailing: id }, 'Mailing stopped'));
    if (app.config.NODE_ENV === 'test') await run;
    return reply.status(202).send({ id, recipients: queued.rowCount });
  });
};

// After a restart: a mailing that was cut off goes on where it stopped.
export async function resumeMailings(app: FastifyInstance): Promise<void> {
  const { rows } = await app.db.query<{ id: number }>('SELECT id FROM mailings WHERE finished_at IS NULL ORDER BY id');
  for (const m of rows) await deliver(app, m.id);
}
