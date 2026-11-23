import type { FastifyInstance } from 'fastify';
import { generateVAPIDKeys, sendNotification } from 'web-push';

// A notification on the owner's phone or computer.
export interface PushMessage {
  title: string;
  body: string;
  // Where a tap leads, inside the admin page (e.g. '#/bookings/<id>').
  url: string;
}

export type PushSender = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<void>;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// The keys that identify this site to the push services. Made once and kept in the database.
export async function vapidKeys(app: FastifyInstance): Promise<VapidKeys> {
  const { rows } = await app.db.query<{ value: VapidKeys }>("SELECT value FROM settings WHERE key = 'push_keys'");
  if (rows[0]) return rows[0].value;
  const keys = generateVAPIDKeys();
  await app.db.query("INSERT INTO settings (key, value) VALUES ('push_keys', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(keys)]);
  return (await app.db.query<{ value: VapidKeys }>("SELECT value FROM settings WHERE key = 'push_keys'")).rows[0]!.value;
}

export function createPushSender(app: FastifyInstance): PushSender {
  return async (subscription, payload) => {
    const keys = await vapidKeys(app);
    await sendNotification(subscription, payload, {
      vapidDetails: { subject: `mailto:${app.config.OWNER_EMAIL || 'contact@gamerxp.nl'}`, ...keys },
      TTL: 24 * 3600,
    });
  };
}

// Sends a notification to every device of every owner (or of one user). Never throws:
// a notification that fails must not break the booking or payment that caused it.
export async function notify(app: FastifyInstance, message: PushMessage, onlyUserId?: number): Promise<number> {
  let sent = 0;
  try {
    const { rows } = await app.db.query<{ id: number; endpoint: string; keys: { p256dh: string; auth: string } }>(
      `SELECT s.id, s.endpoint, s.keys FROM push_subscriptions s JOIN admin_users u ON u.id = s.user_id
        WHERE ($1::int IS NULL AND u.role = 'owner') OR s.user_id = $1`,
      [onlyUserId ?? null],
    );
    await Promise.all(
      rows.map(async (sub) => {
        try {
          await app.push({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(message));
          sent++;
        } catch (err) {
          // 404/410: the device unsubscribed or the browser data was cleared.
          const gone = [404, 410].includes((err as { statusCode?: number }).statusCode ?? 0);
          if (gone) await app.db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
          else app.log.warn({ err }, 'Push notification failed');
        }
      }),
    );
  } catch (err) {
    app.log.warn({ err }, 'Push notifications failed');
  }
  return sent;
}
