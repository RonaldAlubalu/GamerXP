import type { FastifyInstance } from 'fastify';
import { addDays, formatDutchDate, today } from '../lib/dates.js';
import { notify } from './push.js';

// Tells the owner when a subscription or a Game Pass is about to run out: once two weeks ahead
// and once three days ahead (or straight away when it has less time than that left).
export async function sendExpiryNotices(app: FastifyInstance): Promise<number> {
  const t = today(app.config.TIMEZONE);
  const { rows } = await app.db.query<{ id: string; name: string; kind: string; expiresOn: string; level: number }>(
    `SELECT id, name, kind, expires_on::text AS "expiresOn",
            CASE WHEN expires_on <= $2::date THEN 2 ELSE 1 END AS level
       FROM inventory_items
      WHERE expires_on IS NOT NULL AND expires_on <= $1::date AND status IN ('in_use', 'spare')
        AND expiry_notice < CASE WHEN expires_on <= $2::date THEN 2 ELSE 1 END
      ORDER BY expires_on`,
    [addDays(t, 14), addDays(t, 3)],
  );
  let sent = 0;
  for (const item of rows) {
    // Claim it first, so two rounds at the same moment don't both send.
    const claimed = await app.db.query('UPDATE inventory_items SET expiry_notice = $2 WHERE id = $1 AND expiry_notice < $2', [item.id, item.level]);
    if (!claimed.rowCount) continue;
    const what = item.kind === 'station' ? `Game Pass van ${item.name}` : item.name;
    const when = item.expiresOn < t ? `is verlopen op ${formatDutchDate(item.expiresOn)}` : item.expiresOn === t ? 'verloopt vandaag' : `verloopt op ${formatDutchDate(item.expiresOn)}`;
    await notify(app, { title: 'Abonnement verloopt', body: `${what} ${when}.`, url: '#/inventory' });
    if (app.config.OWNER_EMAIL) {
      await app.mailer
        .send({
          to: app.config.OWNER_EMAIL,
          subject: `${what} ${when}`,
          text: `${what} ${when}.\n\nBekijk en verleng het in de inventaris:\n${app.config.PUBLIC_URL}/admin/#/inventory\n\nDit is een automatische melding van je eigen site.`,
          plain: true,
        })
        .catch((err) => app.log.error({ err }, 'Expiry notice could not be mailed'));
    }
    sent++;
  }
  return sent;
}
