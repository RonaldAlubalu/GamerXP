import type { FastifyInstance } from 'fastify';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Config } from '../config.js';
import { logCommunication } from './communications.js';

// An email as read from the mailbox.
export interface IncomingMail {
  messageId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  text: string;
  date: Date;
}

export interface MailSource {
  // Emails received since the given date (the import skips ones it already has).
  fetchSince(since: Date): Promise<IncomingMail[]>;
}

export interface ImportResult {
  imported: number;
  // Emails that started a new conversation under Berichten.
  newConversations: number;
  skipped: number;
}

// Returns null when no mailbox is configured: the import is then switched off.
export function createImapSource(config: Config): MailSource | null {
  if (!config.IMAP_HOST) return null;
  return {
    async fetchSince(since) {
      const client = new ImapFlow({
        host: config.IMAP_HOST,
        port: config.IMAP_PORT,
        secure: config.IMAP_SECURE,
        auth: { user: config.IMAP_USER, pass: config.IMAP_PASS },
        logger: false,
      });
      const mails: IncomingMail[] = [];
      await client.connect();
      try {
        // Read-only: importing never marks emails as read or moves them.
        const lock = await client.getMailboxLock(config.IMAP_MAILBOX, { readOnly: true });
        try {
          const uids = (await client.search({ since }, { uid: true })) || [];
          if (uids.length) {
            for await (const message of client.fetch(uids, { source: true }, { uid: true })) {
              if (!message.source) continue;
              const parsed = await simpleParser(message.source);
              const from = parsed.from?.value[0];
              if (!from?.address) continue;
              mails.push({
                messageId: parsed.messageId ?? `uid-${config.IMAP_MAILBOX}-${message.uid}`,
                fromName: from.name || from.address,
                fromEmail: from.address,
                subject: parsed.subject ?? '',
                text: parsed.text ?? '',
                date: parsed.date ?? new Date(),
              });
            }
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => {});
      }
      return mails;
    },
  };
}

const REFERENCE = /\bGXP-[A-Z0-9]{4,}\b/i;
const emailOf = (address: string) => (/<([^>]+)>/.exec(address)?.[1] ?? address).trim().toLowerCase();

// Drops the quoted earlier messages from a reply, so the log shows only what the customer wrote.
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex(
    (line) =>
      /^(Op|On) .+(schreef|wrote).*:\s*$/i.test(line.trim()) ||
      /^-{2,}\s*(Oorspronkelijk bericht|Original Message)/i.test(line.trim()) ||
      /^(Van|From): .+/i.test(line.trim()) ||
      /^_{10,}$/.test(line.trim()),
  );
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).filter((line) => !line.startsWith('>'));
  return kept.join('\n').trim() || text.trim();
}

// Files each email under the right booking (by reference, else by the sender's
// email address), under an open contact conversation, or as a new conversation.
export async function importMails(app: FastifyInstance, mails: IncomingMail[]): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, newConversations: 0, skipped: 0 };
  const own = new Set(
    [app.config.MAIL_FROM, app.config.OWNER_EMAIL, app.config.IMAP_USER, app.config.SMTP_USER].filter(Boolean).map(emailOf),
  );

  for (const mail of [...mails].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    const from = mail.fromEmail.trim().toLowerCase();
    const seen = await app.db.query('SELECT 1 FROM communications WHERE external_id = $1', [mail.messageId]);
    // Our own emails and automatic ones (bounces, no-reply) are not customer messages.
    if (seen.rowCount || own.has(from) || /^(mailer-daemon|postmaster|no-?reply)@/.test(from)) {
      result.skipped++;
      continue;
    }

    const reference = REFERENCE.exec(`${mail.subject}\n${mail.text}`)?.[0].toUpperCase();
    let booking = reference
      ? (await app.db.query<{ id: string }>('SELECT id FROM bookings WHERE reference = $1', [reference])).rows[0]
      : undefined;
    // Without a reference: the sender's booking that is still running, else their latest one.
    booking ??= (
      await app.db.query<{ id: string }>(
        `SELECT id FROM bookings WHERE lower(email) = $1
          ORDER BY (status IN ('completed', 'cancelled')), created_at DESC LIMIT 1`,
        [from],
      )
    ).rows[0];

    let contactMessageId: number | undefined;
    if (!booking) {
      const open = await app.db.query<{ id: number }>(
        'SELECT id FROM contact_messages WHERE lower(email) = $1 AND NOT handled ORDER BY created_at DESC LIMIT 1',
        [from],
      );
      contactMessageId = open.rows[0]?.id;
    }

    const body = stripQuotedReply(mail.text) || '(leeg bericht)';
    if (!booking && !contactMessageId) {
      const created = await app.db.query<{ id: number }>(
        'INSERT INTO contact_messages (name, email, message, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [mail.fromName, from, body, mail.date],
      );
      contactMessageId = created.rows[0]!.id;
      result.newConversations++;
    }

    const id = await logCommunication(app, {
      bookingId: booking?.id,
      contactMessageId,
      direction: 'in',
      channel: 'email',
      subject: mail.subject,
      body,
      actor: mail.fromName,
    });
    await app.db.query('UPDATE communications SET external_id = $2, created_at = $3 WHERE id = $1', [id, mail.messageId, mail.date]);
    result.imported++;
  }
  return result;
}

// Checks the mailbox. The first check looks back IMAP_LOOKBACK_DAYS; later ones from the last import.
export async function runMailImport(app: FastifyInstance): Promise<ImportResult> {
  if (!app.mailSource) return { imported: 0, newConversations: 0, skipped: 0 };
  const last = await app.db.query<{ at: Date | null }>('SELECT max(created_at) AS at FROM communications WHERE external_id IS NOT NULL');
  const lookback = new Date(Date.now() - app.config.IMAP_LOOKBACK_DAYS * 86_400_000);
  // IMAP searches by whole days, so go back one extra day; duplicates are skipped anyway.
  const since = last.rows[0]?.at ? new Date(last.rows[0].at.getTime() - 86_400_000) : lookback;
  return importMails(app, await app.mailSource.fetchSince(since));
}
