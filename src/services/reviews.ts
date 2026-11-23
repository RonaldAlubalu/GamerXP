import type { FastifyInstance } from 'fastify';
import { addDays, today } from '../lib/dates.js';
import { reviewRequestMail } from '../lib/emails.js';
import { getBookingMailData } from './bookings.js';
import { sendAndLog } from './communications.js';
import { addEvent } from './pipeline.js';

// Sends the Google review request a few days after the party, to customers who haven't
// been asked yet. Parties longer than two weeks ago are left alone: asking that late is odd.
export async function sendDueReviewRequests(app: FastifyInstance): Promise<number> {
  const { AUTO_REVIEW_DAYS: days, GOOGLE_REVIEW_URL: reviewUrl, TIMEZONE, PUBLIC_URL } = app.config;
  if (!days || !reviewUrl) return 0;
  const t = today(TIMEZONE);
  const { rows } = await app.db.query<{ id: string }>(
    `SELECT id FROM bookings
      WHERE status IN ('party_held', 'completed') AND review_status = 'none'
        AND party_date BETWEEN $1 AND $2
      ORDER BY party_date`,
    [addDays(t, -14), addDays(t, -days)],
  );
  let sent = 0;
  for (const { id } of rows) {
    // Claim it first, so a second run at the same moment can't send it twice.
    const claimed = await app.db.query(
      "UPDATE bookings SET review_status = 'requested', review_requested_at = now() WHERE id = $1 AND review_status = 'none'",
      [id],
    );
    if (!claimed.rowCount) continue;
    const data = (await getBookingMailData(app.db, id))!;
    const ok = await sendAndLog(app, { bookingId: id }, reviewRequestMail(data, { publicUrl: PUBLIC_URL, reviewUrl }), 'Automatisch', { keepTurn: true });
    if (ok) {
      await addEvent(app.db, id, { type: 'review', message: 'Reviewverzoek automatisch verstuurd', actor: 'Automatisch' });
      sent++;
    } else {
      // Sending failed: put it back so it is tried again.
      await app.db.query("UPDATE bookings SET review_status = 'none', review_requested_at = NULL WHERE id = $1", [id]);
    }
  }
  return sent;
}
