import type { FastifyInstance } from 'fastify';
import type { Mail } from '../lib/mailer.js';

export type Direction = 'in' | 'out';
export type Channel = 'website' | 'email' | 'whatsapp' | 'phone' | 'in_person' | 'other';

export const CHANNEL_LABELS: Record<Channel, string> = {
  website: 'Website',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
  phone: 'Telefoon',
  in_person: 'Persoonlijk',
  other: 'Anders',
};

export interface MessageTarget {
  bookingId?: string;
  contactMessageId?: number;
}

export interface NewCommunication extends MessageTarget {
  direction: Direction;
  channel: Channel;
  subject?: string;
  body: string;
  delivery?: 'sent' | 'failed';
  actor: string;
}

// Logs a message and updates whose turn it is: after a message from the customer
// it's your turn, after your message it's the customer's. Finished or cancelled
// bookings stay on 'nobody'.
export async function logCommunication(app: FastifyInstance, c: NewCommunication): Promise<number> {
  const { rows } = await app.db.query<{ id: number }>(
    `INSERT INTO communications (booking_id, contact_message_id, direction, channel, subject, body, delivery, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [c.bookingId ?? null, c.contactMessageId ?? null, c.direction, c.channel, c.subject ?? '', c.body, c.delivery ?? null, c.actor],
  );
  if (c.delivery !== 'failed') {
    const waitingOn = c.direction === 'in' ? 'me' : 'customer';
    if (c.bookingId) {
      await app.db.query(
        `UPDATE bookings SET waiting_on = $2, updated_at = now()
          WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`,
        [c.bookingId, waitingOn],
      );
    } else {
      await app.db.query('UPDATE contact_messages SET waiting_on = $2, handled = false WHERE id = $1', [
        c.contactMessageId,
        waitingOn,
      ]);
    }
  }
  return rows[0]!.id;
}

// Sends an email and logs it, also when sending fails (so it's visible in the log).
export async function sendAndLog(
  app: FastifyInstance,
  target: MessageTarget,
  mail: Mail,
  actor: string,
): Promise<boolean> {
  let delivery: 'sent' | 'failed' = 'sent';
  try {
    await app.mailer.send(mail);
  } catch (err) {
    app.log.error({ err, subject: mail.subject }, 'Failed to send email');
    delivery = 'failed';
  }
  await logCommunication(app, {
    ...target,
    direction: 'out',
    channel: 'email',
    subject: mail.subject,
    body: mail.text,
    delivery,
    actor,
  });
  return delivery === 'sent';
}
