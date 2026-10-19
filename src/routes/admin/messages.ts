import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { withSignature } from '../../lib/emails.js';
import { HttpError } from '../../lib/errors.js';
import { logCommunication, sendAndLog } from '../../services/communications.js';
import { actorOf, messageInput, waitingOn } from './bookings.js';

const MESSAGE_COLUMNS = `
  m.id, m.name, m.email, m.phone, m.message, m.handled, m.waiting_on AS "waitingOn", m.created_at AS "createdAt",
  (SELECT max(c.created_at) FROM communications c WHERE c.contact_message_id = m.id) AS "lastMessageAt"`;

const idParam = z.object({ id: z.coerce.number().int().positive() });

// Messages from the contact form, each with its own conversation.
export const messageRoutes: FastifyPluginAsync = async (app) => {
  async function load(id: number) {
    const { rows } = await app.db.query(`SELECT ${MESSAGE_COLUMNS} FROM contact_messages m WHERE m.id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, 'Bericht niet gevonden.', 'not_found');
    return rows[0] as { id: number; name: string; email: string; handled: boolean };
  }

  app.get('/messages', async () => {
    const { rows } = await app.db.query(
      `SELECT ${MESSAGE_COLUMNS} FROM contact_messages m
        ORDER BY m.handled, coalesce((SELECT max(c.created_at) FROM communications c WHERE c.contact_message_id = m.id), m.created_at) DESC
        LIMIT 300`,
    );
    return rows;
  });

  app.get('/messages/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const message = await load(id);
    const { rows } = await app.db.query(
      `SELECT id, direction, channel, subject, body, delivery, actor, created_at AS "createdAt"
         FROM communications WHERE contact_message_id = $1 ORDER BY created_at DESC, id DESC`,
      [id],
    );
    return { ...message, communications: rows };
  });

  app.patch('/messages/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ handled: z.boolean().optional(), waitingOn: waitingOn.optional() }).parse(req.body);
    await load(id);
    await app.db.query(
      `UPDATE contact_messages SET
         handled = COALESCE($2, handled),
         waiting_on = CASE WHEN $2 THEN 'nobody' ELSE COALESCE($3, waiting_on) END
       WHERE id = $1`,
      [id, body.handled ?? null, body.waitingOn ?? null],
    );
    return load(id);
  });

  app.post('/messages/:id/replies', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const m = messageInput.parse(req.body);
    const message = await load(id);
    if (m.direction === 'out' && m.channel === 'email' && m.send) {
      const sent = await sendAndLog(
        app,
        { contactMessageId: id },
        { to: message.email, subject: m.subject || 'Re: je bericht aan Gamer Xperience', text: withSignature(m.body) },
        actorOf(req),
      );
      if (!sent) throw new HttpError(502, 'De e-mail kon niet worden verstuurd. Hij staat wel in het logboek.', 'send_failed');
    } else {
      await logCommunication(app, { contactMessageId: id, ...m, actor: m.direction === 'in' ? message.name : actorOf(req) });
    }
    return reply.status(201).send(await load(id));
  });
};
