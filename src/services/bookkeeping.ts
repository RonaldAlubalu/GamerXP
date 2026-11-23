import type { Config } from '../config.js';

// The part of the bookkeeping (e-Boekhouden.nl) the site uses: customers and sales invoices.
// https://api.e-boekhouden.nl/openapi/v1.json

export interface InvoiceLine {
  description: string;
  quantity: number;
  // Per unit, in cents. Negative for the deposit that was invoiced before.
  priceCents: number;
  // Product code in the bookkeeping (like GE263), when there is one.
  productCode?: string;
}

export interface NewInvoice {
  customer: { code: string; name: string; street: string; postalCode: string; city: string; email: string };
  date: string;
  // Days the customer has to pay.
  termDays: number;
  // The invoice number, in the business's own numbering (like F00015-1).
  number: string;
  reference: string;
  text: string;
  lines: InvoiceLine[];
}

export interface CreatedInvoice {
  id: string;
  number: string;
  pdfUrl: string;
}

export interface Bookkeeping {
  createInvoice(invoice: NewInvoice): Promise<CreatedInvoice>;
  // What the bookkeeping has booked as received on this invoice, in cents.
  paidCents(invoiceNumber: string): Promise<number>;
  // The next free base number, like F00015. A party's invoices are F00015-1 (deposit) and F00015-2 (rest).
  nextNumberBase(): Promise<string>;
  // Asks the bookkeeping whether the token is accepted, and says what it sees there.
  ping(): Promise<string>;
}

// How the business is set up in e-Boekhouden: no VAT (kleineondernemersregeling), revenue
// on ledger 8000, and the invoice template by name.
const VAT_CODE = 'GEEN';
const LEDGER_CODE = '8000';
const TEMPLATE_NAME = 'Factuur Gamer Xperience';
const API = 'https://api.e-boekhouden.nl/v1';

type Json = Record<string, unknown>;
const list = (body: unknown): Json[] => (Array.isArray(body) ? body : (((body as Json)?.items as Json[]) ?? []));

// Returns null when no token is configured: invoicing is then switched off.
export function createBookkeeping(config: Config): Bookkeeping | null {
  if (!config.EBOEKHOUDEN_TOKEN) return null;
  let session: { token: string; expires: number } | null = null;
  const ids: { ledger?: number; template?: number } = {};

  async function call(method: string, path: string, body?: Json, retry = true): Promise<unknown> {
    if (!session || Date.now() > session.expires) {
      const res = await fetch(`${API}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: config.EBOEKHOUDEN_TOKEN, source: 'GamerXP' }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => ({}))) as { token?: string; expiresIn?: number; title?: string; message?: string };
      if (!res.ok || !data.token) throw new Error(`e-Boekhouden weigert het API-token (${res.status}${data.title || data.message ? `: ${data.title ?? data.message}` : ''}).`);
      // Renew a minute early.
      session = { token: data.token, expires: Date.now() + Math.max((data.expiresIn ?? 600) - 60, 30) * 1000 };
    }
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${session.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 && retry) {
      session = null;
      return call(method, path, body, false);
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const d = (data ?? {}) as { title?: string; message?: string; code?: string; detail?: string };
      throw new Error(`e-Boekhouden: ${d.title ?? d.message ?? d.detail ?? `fout ${res.status}`}${d.code ? ` (${d.code})` : ''}`);
    }
    return data;
  }

  async function ledgerId(): Promise<number> {
    if (ids.ledger) return ids.ledger;
    const found = list(await call('GET', `/ledger?code=${LEDGER_CODE}&limit=5`)).find((l) => String(l.code) === LEDGER_CODE);
    if (!found) throw new Error(`Grootboekrekening ${LEDGER_CODE} is niet gevonden in e-Boekhouden.`);
    return (ids.ledger = Number(found.id));
  }

  async function templateId(): Promise<number> {
    if (ids.template) return ids.template;
    const templates = list(await call('GET', '/invoicetemplate?limit=100'));
    const found = templates.find((t) => t.name === TEMPLATE_NAME) ?? templates.find((t) => t.active !== false);
    if (!found) throw new Error('Er is geen factuursjabloon gevonden in e-Boekhouden.');
    return (ids.template = Number(found.id));
  }

  // One customer record per booking, found again by its code (the booking reference).
  async function relationId(c: NewInvoice['customer']): Promise<number> {
    const existing = list(await call('GET', `/relation?code=${encodeURIComponent(c.code)}&limit=5`)).find((r) => String(r.code) === c.code);
    if (existing) return Number(existing.id);
    const created = (await call('POST', '/relation', {
      type: 'P',
      code: c.code,
      name: c.name,
      address: c.street,
      postalCode: c.postalCode,
      city: c.city,
      emailAddress: c.email,
    })) as { id: number };
    return Number(created.id);
  }

  // Every invoice number in the bookkeeping.
  async function invoiceNumbers(): Promise<string[]> {
    const numbers: string[] = [];
    for (let offset = 0; offset < 20_000; offset += 2000) {
      const page = list(await call('GET', `/invoice?limit=2000&offset=${offset}`));
      numbers.push(...page.map((i) => String(i.invoiceNumber ?? '')));
      if (page.length < 2000) break;
    }
    return numbers;
  }

  return {
    async ping() {
      await call('GET', '/ledger?limit=1');
      // Extra detail for the status page; a failure here does not mean the connection is broken.
      try {
        const administrations = list(await call('GET', '/administration?limit=5')).map((a) => String(a.name ?? a.description ?? a.id));
        const numbers = (await invoiceNumbers()).filter(Boolean);
        return `Administratie: ${administrations.join(', ') || 'onbekend'}. ${numbers.length} facturen gevonden${numbers.length ? `, waaronder ${numbers.slice(-3).join(', ')}` : ''}.`;
      } catch (err) {
        return `Verbonden, maar het overzicht kon niet worden opgehaald: ${(err as Error).message}`;
      }
    },

    async paidCents(invoiceNumber) {
      // Mutation type 3 is "invoice payment received". Counting those is positive proof of a payment.
      const payments = list(await call('GET', `/mutation?type=3&invoiceNumber=${encodeURIComponent(invoiceNumber)}&limit=200`));
      return payments
        .filter((m) => String(m.invoiceNumber) === invoiceNumber && String(m.type) === '3')
        .reduce((sum, m) => sum + Math.round(Math.abs(Number(m.amount) || 0) * 100), 0);
    },

    async nextNumberBase() {
      const highest = Math.max(0, ...(await invoiceNumbers()).map((n) => Number(/^F(\d+)/i.exec(n)?.[1] ?? 0)));
      return `F${String(highest + 1).padStart(5, '0')}`;
    },

    async createInvoice(invoice) {
      const [relation, ledger, template] = [await relationId(invoice.customer), await ledgerId(), await templateId()];
      const created = (await call('POST', '/invoice', {
        relationId: relation,
        date: invoice.date,
        invoiceNumber: invoice.number,
        termOfPayment: invoice.termDays,
        templateId: template,
        // Prices are final amounts; with no VAT there is no difference.
        inExVat: 'IN',
        reference: invoice.reference,
        text: invoice.text,
        items: invoice.lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          pricePerUnit: line.priceCents / 100,
          vatCode: VAT_CODE,
          ledgerId: ledger,
          ...(line.productCode ? { code: line.productCode } : {}),
        })),
      })) as { id?: number; invoiceNumber?: string } | null;
      if (!created?.id) {
        throw new Error(`e-Boekhouden gaf geen factuur terug (antwoord: ${JSON.stringify(created).slice(0, 200)}).`);
      }
      // Read it back: proof that it exists, and the link to the PDF comes with it.
      const full = (await call('GET', `/invoice/${created.id}`)) as { invoiceNumber?: string; urlPdfFile?: string };
      return { id: String(created.id), number: String(full.invoiceNumber ?? created.invoiceNumber ?? invoice.number), pdfUrl: full.urlPdfFile ?? '' };
    },
  };
}
