import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { referralToken, rewardOf } from '../../services/referrals.js';

// Customers are not kept apart from their bookings: a customer is everything that came in under
// one e-mail address (bookings, messages through the site, the mailing list). A booking without
// an address stands on its own.
const emailParam = z.string().trim().toLowerCase().min(3).max(200);

export const customerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    if (req.admin?.role !== 'owner') throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
  });

  // Everyone, with the numbers that tell who they are: how many parties, when, how much paid.
  app.get('/customers', async () => {
    const { rows } = await app.db.query(
      `WITH people AS (
         SELECT lower(email) AS email FROM bookings WHERE email <> ''
         UNION SELECT lower(email) FROM mail_contacts
         UNION SELECT lower(email) FROM contact_messages WHERE email <> ''
       )
       SELECT p.email, NULL::uuid AS "bookingId",
              coalesce(nullif(lb.parent_name, ''), nullif(mc.name, ''), lm.name, '') AS name,
              coalesce(lb.phone, lm.phone, '') AS phone, coalesce(lb.city, '') AS city,
              coalesce(st.parties, 0) AS parties, st.last_party::text AS "lastParty", st.next_party::text AS "nextParty",
              coalesce(st.paid, 0) AS "paidCents", coalesce(st.reviews, 0) AS reviews,
              CASE WHEN mc.id IS NULL THEN 'none' WHEN mc.unsubscribed_at IS NULL THEN 'on' ELSE 'off' END AS mailing
         FROM people p
         LEFT JOIN LATERAL (SELECT parent_name, phone, city FROM bookings b WHERE lower(b.email) = p.email ORDER BY b.party_date DESC LIMIT 1) lb ON true
         LEFT JOIN LATERAL (SELECT name, phone FROM contact_messages m WHERE lower(m.email) = p.email ORDER BY m.created_at DESC LIMIT 1) lm ON true
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE status <> 'cancelled')::int AS parties,
                  max(party_date) FILTER (WHERE status <> 'cancelled' AND party_date < current_date) AS last_party,
                  min(party_date) FILTER (WHERE status <> 'cancelled' AND party_date >= current_date) AS next_party,
                  coalesce(sum(paid_cents), 0)::int AS paid,
                  count(*) FILTER (WHERE review_status = 'received')::int AS reviews
             FROM bookings b WHERE lower(b.email) = p.email) st ON true
         LEFT JOIN mail_contacts mc ON lower(mc.email) = p.email
       UNION ALL
       SELECT '' AS email, b.id, b.parent_name, b.phone, b.city,
              (b.status <> 'cancelled')::int, CASE WHEN b.party_date < current_date THEN b.party_date::text END, CASE WHEN b.party_date >= current_date THEN b.party_date::text END,
              b.paid_cents, (b.review_status = 'received')::int, 'none'
         FROM bookings b WHERE b.email = ''
       ORDER BY name, email`,
    );
    return rows;
  });

  // The card of one customer: by e-mail address, or by booking when there is no address.
  app.get('/customers/card', async (req) => {
    const q = z.object({ email: emailParam.optional(), booking: z.uuid().optional() }).parse(req.query);
    if (!q.email && !q.booking) throw new HttpError(400, 'Geef een e-mailadres of een boeking op.', 'bad_request');
    const where = q.email ? 'lower(b.email) = $1' : 'b.id = $1';
    const key = q.email ?? q.booking!;
    const bookings = (await app.db.query(
      `SELECT b.id, b.reference, b.party_date::text AS "partyDate", b.time_slot AS "timeSlot", b.status, p.name AS "packageName",
              b.parent_name AS "parentName", b.first_name AS "firstName", b.email, b.email2, b.phone, b.phone2,
              b.street, b.postal_code AS "postalCode", b.city, b.location_name AS "locationName",
              b.child_name AS "childName", b.child_age AS "childAge", b.price_cents AS "priceCents", b.paid_cents AS "paidCents",
              b.review_status AS "reviewStatus", b.discount_code AS "discountCode", b.created_at AS "createdAt"
         FROM bookings b JOIN packages p ON p.id = b.package_id WHERE ${where} ORDER BY b.party_date DESC`,
      [key],
    )).rows;
    const messages = q.email
      ? (await app.db.query('SELECT id, name, phone, handled, created_at AS "createdAt" FROM contact_messages WHERE lower(email) = $1 ORDER BY created_at DESC', [q.email])).rows
      : [];
    const contact = q.email
      ? (await app.db.query<{ id: number; name: string; firstName: string; note: string; unsubscribedAt: string | null; unsubscribeReason: string }>(
          `SELECT id, name, first_name AS "firstName", note, unsubscribed_at AS "unsubscribedAt", unsubscribe_reason AS "unsubscribeReason" FROM mail_contacts WHERE lower(email) = $1`,
          [q.email],
        )).rows[0]
      : undefined;
    if (!bookings.length && !messages.length && !contact) throw new HttpError(404, 'Deze klant ken ik niet.', 'not_found');

    // Everything said back and forth, across all bookings and messages through the site.
    const timeline = (await app.db.query(
      `SELECT c.id, c.direction, c.channel, c.subject, c.body, c.delivery, c.actor, c.created_at AS "createdAt",
              c.booking_id AS "bookingId", b.reference, c.contact_message_id AS "messageId"
         FROM communications c LEFT JOIN bookings b ON b.id = c.booking_id
        WHERE c.booking_id = ANY($1::uuid[]) OR c.contact_message_id = ANY($2::int[])
        ORDER BY c.created_at DESC, c.id DESC LIMIT 200`,
      [bookings.map((b) => b.id), messages.map((m) => m.id)],
    )).rows;

    const mailing = contact
      ? {
          subscribed: !contact.unsubscribedAt,
          unsubscribedAt: contact.unsubscribedAt,
          unsubscribeReason: contact.unsubscribeReason,
          source: contact.note,
          mailings: (await app.db.query(
            `SELECT m.subject, r.status, r.sent_at AS "sentAt" FROM mailing_recipients r JOIN mailings m ON m.id = r.mailing_id WHERE r.contact_id = $1 ORDER BY m.id DESC`,
            [contact.id],
          )).rows,
          links: (await app.db.query(
            `SELECT d.code, d.percent, l.note, l.created_at AS "createdAt", $2 || '/reserveer?korting=' || l.token AS url,
                    (SELECT b.reference FROM bookings b WHERE b.discount_link = l.token AND b.status <> 'cancelled' LIMIT 1) AS "usedFor"
               FROM discount_links l JOIN discount_codes d ON d.id = l.code_id WHERE l.contact_id = $1 ORDER BY l.created_at DESC`,
            [contact.id, app.config.PUBLIC_URL],
          )).rows,
          referralUrl: `${app.config.PUBLIC_URL}/reserveer?via=${await referralToken(app.db, contact.id)}`,
          reward: await rewardOf(app.db, contact.id),
          referred: (await app.db.query(
            `SELECT id, reference, parent_name AS "parentName", party_date::text AS "partyDate", status FROM bookings WHERE referred_by = $1 ORDER BY party_date DESC`,
            [contact.id],
          )).rows,
        }
      : null;
    const note = q.email ? ((await app.db.query<{ note: string }>('SELECT note FROM customer_notes WHERE email = $1', [q.email])).rows[0]?.note ?? '') : '';
    const latest = bookings[0];
    return {
      email: q.email ?? '',
      name: latest?.parentName || contact?.name || messages[0]?.name || '',
      firstName: latest?.firstName || contact?.firstName || '',
      note,
      bookings,
      messages,
      timeline,
      mailing,
    };
  });

  app.put('/customers/note', async (req) => {
    const { email, note } = z.object({ email: emailParam, note: z.string().trim().max(2000) }).parse(req.body);
    if (note) await app.db.query('INSERT INTO customer_notes (email, note) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET note = EXCLUDED.note, updated_at = now()', [email, note]);
    else await app.db.query('DELETE FROM customer_notes WHERE email = $1', [email]);
    return { ok: true };
  });
};
