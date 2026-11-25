import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { today } from '../../lib/dates.js';
import { currentSignature, DEFAULT_SIGNATURE, greetName, setSignature, withSignature } from '../../lib/emails.js';
import { HttpError } from '../../lib/errors.js';
import { upcomingBirthdays } from '../../services/birthdays.js';
import { sendAndLog } from '../../services/communications.js';
import { contactFor, personalLinkToken } from '../../services/discounts.js';
import { addEvent } from '../../services/pipeline.js';
import { actorOf } from './bookings.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const template = z.object({
  // The built-in template this one replaces; without it, it is a template of the owner's own.
  key: z.string().trim().max(200).optional(),
  kind: z.enum(['booking', 'contact', 'birthday']),
  group: z.string().trim().max(60).default(''),
  label: z.string().trim().min(1, 'Geef het sjabloon een naam.').max(100),
  subject: z.string().trim().max(200).default(''),
  body: z.string().trim().min(1, 'Schrijf de tekst van het sjabloon.').max(5000),
  hidden: z.boolean().default(false),
});
const COLUMNS = 'id, key, kind, grp AS "group", label, subject, body, hidden';

function requireOwner(req: FastifyRequest) {
  if (req.admin?.role !== 'owner') throw new HttpError(403, 'Je hebt geen rechten voor deze actie.', 'forbidden');
}

// Reads the sign-off the owner saved; called when the site starts.
export async function loadSignature(db: { query: (sql: string) => Promise<{ rows: { value: string }[] }> }): Promise<void> {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = 'signature'");
  setSignature(rows[0]?.value ?? '');
}

export const templateRoutes: FastifyPluginAsync = async (app) => {
  // What the owner changed or added, and the sign-off. The built-in templates live in the admin page.
  app.get('/templates', async () => {
    const { rows } = await app.db.query(`SELECT ${COLUMNS} FROM message_templates ORDER BY id`);
    return { templates: rows, signature: currentSignature(), defaultSignature: DEFAULT_SIGNATURE };
  });

  // Saves a template: a changed built-in one (by its key) or a new one of your own.
  app.post('/templates', async (req, reply) => {
    requireOwner(req);
    const t = template.parse(req.body);
    const { rows } = await app.db.query(
      `INSERT INTO message_templates (key, kind, grp, label, subject, body, hidden) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET grp = EXCLUDED.grp, label = EXCLUDED.label, subject = EXCLUDED.subject, body = EXCLUDED.body, hidden = EXCLUDED.hidden, updated_at = now()
       RETURNING ${COLUMNS}`,
      [t.key || null, t.kind, t.group, t.label, t.subject, t.body, t.hidden],
    );
    return reply.status(201).send(rows[0]);
  });

  app.patch('/templates/:id', async (req) => {
    requireOwner(req);
    const { id } = idParam.parse(req.params);
    const t = template.omit({ key: true, kind: true }).parse(req.body);
    const { rows } = await app.db.query(
      `UPDATE message_templates SET grp = $2, label = $3, subject = $4, body = $5, hidden = $6, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, t.group, t.label, t.subject, t.body, t.hidden],
    );
    if (!rows[0]) throw new HttpError(404, 'Dit sjabloon bestaat niet (meer).', 'not_found');
    return rows[0];
  });

  // Removes a template of your own, or puts a built-in one back as it was.
  app.delete('/templates/:id', async (req, reply) => {
    requireOwner(req);
    const { id } = idParam.parse(req.params);
    await app.db.query('DELETE FROM message_templates WHERE id = $1', [id]);
    return reply.status(204).send();
  });

  // The sign-off under every mail to a customer. Empty puts the standard one back.
  app.put('/settings/signature', async (req) => {
    requireOwner(req);
    const { text } = z.object({ text: z.string().trim().max(600).refine((v) => v.split('\n').length <= 12, 'De ondertekening mag hooguit 12 regels zijn.') }).parse(req.body);
    if (text) await app.db.query("INSERT INTO app_settings (key, value) VALUES ('signature', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [text]);
    else await app.db.query("DELETE FROM app_settings WHERE key = 'signature'");
    setSignature(text);
    return { signature: currentSignature() };
  });

  // Children who have a birthday again soon, a year or more after their party.
  app.get('/birthdays', async (req) => {
    requireOwner(req);
    return upcomingBirthdays(app.db, today(app.config.TIMEZONE));
  });

  // Mails the customer about the coming birthday and ticks the reminder off. {kortingslink} in the
  // text becomes a personal link that works once.
  app.post('/birthdays/:id/mail', async (req) => {
    requireOwner(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const m = z.object({ subject: z.string().trim().min(1, 'Vul een onderwerp in.').max(200), body: z.string().trim().min(1, 'Schrijf een bericht.').max(5000) }).parse(req.body);
    const b = (await app.db.query<{ email: string; parentName: string; firstName: string }>(
      'SELECT email, parent_name AS "parentName", first_name AS "firstName" FROM bookings WHERE id = $1', [id],
    )).rows[0];
    if (!b) throw new HttpError(404, 'Boeking niet gevonden.', 'not_found');
    if (!b.email) throw new HttpError(422, 'Bij deze boeking staat geen e-mailadres.', 'no_email');
    let text = m.body;
    if (/\{kortingslink\}/i.test(text)) {
      const code = (await app.db.query<{ id: number }>('SELECT id FROM discount_codes WHERE active AND personal ORDER BY id DESC LIMIT 1')).rows[0];
      if (!code) throw new HttpError(422, 'In de tekst staat {kortingslink}, maar er is geen actieve korting die "alleen via link" werkt. Maak die aan onder Pakketten, of haal de link uit de tekst.', 'no_code');
      const contact = await contactFor(app.db, b.email, b.parentName, 'Verjaardag');
      text = text.replace(/\{kortingslink\}/gi, `${app.config.PUBLIC_URL}/reserveer?korting=${await personalLinkToken(app.db, code.id, contact.id, 'Verjaardag')}`);
    }
    const sent = await sendAndLog(app, { bookingId: id }, { to: b.email, subject: m.subject, text: withSignature(text) }, actorOf(req), { keepTurn: true });
    if (!sent) throw new HttpError(502, 'De e-mail kon niet worden verstuurd. Hij staat wel in het logboek.', 'send_failed');
    await app.db.query('UPDATE bookings SET birthday_handled_on = $2 WHERE id = $1', [id, today(app.config.TIMEZONE)]);
    await addEvent(app.db, id, { type: 'message', message: `Verjaardagsmail verstuurd aan ${greetName(b)}: ${m.subject}`, actor: actorOf(req) });
    return { ok: true };
  });

  // Not this year: the reminder goes away until next year.
  app.post('/birthdays/:id/skip', async (req) => {
    requireOwner(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await app.db.query('UPDATE bookings SET birthday_handled_on = $2 WHERE id = $1', [id, today(app.config.TIMEZONE)]);
    return { ok: true };
  });
};
