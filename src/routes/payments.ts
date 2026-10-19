import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { KIND_SLUGS, loadDue, startPayment, syncOpenPayments, syncPayment } from '../services/online-payments.js';

// Online payment with Mollie. Registered without the /api prefix because of the
// customer-facing /betalen links.
export const paymentRoutes: FastifyPluginAsync = async (app) => {
  // Mollie posts the webhook as a form: id=tr_...
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Link in emails and on the status page: creates the payment and sends the customer to Mollie.
  app.get(
    '/betalen/:token/:kind',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const params = z.object({ token: z.string().min(20).max(100), kind: z.enum(['aanbetaling', 'restbedrag']) }).safeParse(req.params);
      if (!params.success) return reply.callNotFound();
      const booking = await loadDue(app, { token: params.data.token });
      if (!booking) return reply.callNotFound();
      const back = `/status?t=${encodeURIComponent(booking.statusToken)}`;
      try {
        return reply.redirect(await startPayment(app, booking, KIND_SLUGS[params.data.kind]!), 303);
      } catch (err) {
        req.log.warn({ err }, 'Could not start payment');
        const code = err instanceof HttpError ? err.code : 'mollie_error';
        return reply.redirect(`${back}&betaalfout=${code}`, 303);
      }
    },
  );

  // Mollie calls this when a payment changes. Always answer 200, or Mollie keeps retrying.
  app.post('/api/mollie/webhook', async (req, reply) => {
    const id = z.object({ id: z.string().regex(/^tr_\w+$/) }).safeParse(req.body);
    if (id.success) {
      await syncPayment(app, id.data.id).catch((err) => req.log.error({ err }, 'Mollie webhook failed'));
    }
    return reply.status(200).send('ok');
  });

  // When the customer comes back from Mollie, check the payment there too
  // (works without a webhook, e.g. when testing on your own computer).
  app.post(
    '/api/status/:token/sync',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (req) => {
      const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.params);
      const booking = await loadDue(app, { token });
      if (!booking) throw new HttpError(404, 'Deze boeking kunnen we niet vinden.', 'not_found');
      await syncOpenPayments(app, booking.id).catch((err) => req.log.warn({ err }, 'Payment sync failed'));
      // The outcome of the most recent payment, so the page can say whether it worked.
      const { rows } = await app.db.query<{ status: string }>(
        'SELECT status FROM mollie_payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1',
        [booking.id],
      );
      return { latest: rows[0]?.status ?? null };
    },
  );
};
