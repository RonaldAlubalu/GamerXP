import type { Config } from '../config.js';

// The small part of the Mollie Payments API we use.
// https://docs.mollie.com/reference/create-payment

export interface MolliePayment {
  id: string;
  status: 'open' | 'pending' | 'authorized' | 'paid' | 'canceled' | 'expired' | 'failed';
  amount: { currency: string; value: string };
  metadata?: { bookingId?: string; kind?: string } | null;
  checkoutUrl: string | null;
}

export interface CreatePaymentInput {
  amountCents: number;
  description: string;
  redirectUrl: string;
  webhookUrl?: string;
  metadata: { bookingId: string; kind: string };
}

export interface MollieClient {
  createPayment(input: CreatePaymentInput): Promise<MolliePayment>;
  getPayment(id: string): Promise<MolliePayment>;
}

export const centsToValue = (cents: number) => (cents / 100).toFixed(2);
export const valueToCents = (value: string) => Math.round(Number(value) * 100);

interface RawPayment {
  id: string;
  status: MolliePayment['status'];
  amount: { currency: string; value: string };
  metadata?: MolliePayment['metadata'];
  _links?: { checkout?: { href: string } };
}

const fromRaw = (p: RawPayment): MolliePayment => ({
  id: p.id,
  status: p.status,
  amount: p.amount,
  metadata: p.metadata,
  checkoutUrl: p._links?.checkout?.href ?? null,
});

// Returns null when no API key is configured: online payment is then switched off.
export function createMollieClient(config: Config): MollieClient | null {
  if (!config.MOLLIE_API_KEY) return null;

  async function request(path: string, init: RequestInit = {}): Promise<RawPayment> {
    const res = await fetch(`${config.MOLLIE_API_URL}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${config.MOLLIE_API_KEY}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as RawPayment & { detail?: string };
    if (!res.ok) throw new Error(`Mollie ${res.status}: ${body.detail ?? 'unknown error'}`);
    return body;
  }

  return {
    async createPayment(input) {
      return fromRaw(
        await request('/payments', {
          method: 'POST',
          body: JSON.stringify({
            amount: { currency: 'EUR', value: centsToValue(input.amountCents) },
            description: input.description,
            redirectUrl: input.redirectUrl,
            ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
            metadata: input.metadata,
            locale: 'nl_NL',
          }),
        }),
      );
    },
    async getPayment(id) {
      return fromRaw(await request(`/payments/${encodeURIComponent(id)}`));
    },
  };
}
