import type { FastifyInstance } from 'fastify';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Config } from '../config.js';
import { logCommunication } from './communications.js';
import { STAGE_INFO, STATUSES, type Status } from './pipeline.js';

// An email as read from the mailbox.
export interface IncomingMail {
  messageId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  text: string;
  date: Date;
}

// What is known about an email before it is downloaded.
export interface MailHeader {
  fromEmail: string;
  subject: string;
}

export interface MailSource {
  // Emails received since the given date. Only the sender and subject of each email are
  // looked at; the email itself is downloaded only when `relevant` says so.
  fetchSince(since: Date, relevant: (header: MailHeader) => boolean): Promise<IncomingMail[]>;
  // Puts `label` on the emails with these Message-IDs and takes `others` off (Gmail labels).
  // Mailboxes without labels leave this out.
  setLabel?(messageIds: string[], label: string, others: string[]): Promise<void>;
  // Logs in and opens the mailbox, without reading anything.
  check?(): Promise<void>;
}

// The label a booking's emails carry in the mailbox: the same stage name as in the admin.
export const mailLabel = (status: Status) => `GamerXP/${STAGE_INFO[status].label}`;
const ALL_LABELS = STATUSES.map(mailLabel);

export interface ImportResult {
  imported: number;
  skipped: number;
}

// Returns null when no mailbox is configured: the import is then switched off.
export function createImapSource(config: Config): MailSource | null {
  if (!config.IMAP_HOST) return null;
  return {
    async fetchSince(since, relevant) {
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
          const found = (await client.search({ since }, { uid: true })) || [];
          // First pass: sender and subject only. Everything else in the mailbox is left alone.
          const uids: number[] = [];
          if (found.length) {
            for await (const message of client.fetch(found, { envelope: true }, { uid: true })) {
              const fromEmail = message.envelope?.from?.[0]?.address ?? '';
              if (fromEmail && relevant({ fromEmail, subject: message.envelope?.subject ?? '' })) uids.push(message.uid);
            }
          }
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

    async check() {
      const client = new ImapFlow({
        host: config.IMAP_HOST,
        port: config.IMAP_PORT,
        secure: config.IMAP_SECURE,
        auth: { user: config.IMAP_USER, pass: config.IMAP_PASS },
        logger: false,
      });
      await client.connect();
      try {
        (await client.getMailboxLock(config.IMAP_MAILBOX, { readOnly: true })).release();
      } finally {
        await client.logout().catch(() => {});
      }
    },

    async setLabel(messageIds, label, others) {
      const client = new ImapFlow({
        host: config.IMAP_HOST,
        port: config.IMAP_PORT,
        secure: config.IMAP_SECURE,
        auth: { user: config.IMAP_USER, pass: config.IMAP_PASS },
        logger: false,
      });
      await client.connect();
      try {
        // Labels are a Gmail feature; other mailboxes are left untouched.
        if (!client.capabilities.has('X-GM-EXT-1')) return;
        const lock = await client.getMailboxLock(config.IMAP_MAILBOX);
        try {
          for (const id of messageIds) {
            const uids = (await client.search({ header: { 'message-id': id } }, { uid: true })) || [];
            if (!uids.length) continue;
            // Changing labels does not mark an email as read.
            await client.messageFlagsRemove(uids, others, { uid: true, useLabels: true });
            await client.messageFlagsAdd(uids, [label], { uid: true, useLabels: true });
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => {});
      }
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

// Decides from sender and subject alone whether an email belongs to a customer:
// the subject carries a booking reference, or the sender has a booking or a
// conversation under Berichten. Other email is never downloaded.
export async function relevanceCheck(app: FastifyInstance): Promise<(header: MailHeader) => boolean> {
  const { rows } = await app.db.query<{ email: string }>(
    'SELECT lower(email) AS email FROM bookings UNION SELECT lower(email) FROM contact_messages',
  );
  const known = new Set(rows.map((r) => r.email));
  return ({ fromEmail, subject }) => REFERENCE.test(subject) || known.has(fromEmail.trim().toLowerCase());
}

// Files each email under the right booking (by reference, else by the sender's
// email address) or under the sender's conversation in Berichten.
export async function importMails(app: FastifyInstance, mails: IncomingMail[]): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0 };
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
        'SELECT id FROM contact_messages WHERE lower(email) = $1 ORDER BY handled, created_at DESC LIMIT 1',
        [from],
      );
      contactMessageId = open.rows[0]?.id;
    }

    // Not from a customer we know and no existing booking reference: leave it in the mailbox.
    if (!booking && !contactMessageId) {
      result.skipped++;
      continue;
    }
    const body = stripQuotedReply(mail.text) || '(leeg bericht)';

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
    // The new email still needs its label.
    if (booking) await app.db.query('UPDATE bookings SET mail_label = NULL WHERE id = $1', [booking.id]);
    result.imported++;
  }
  return result;
}

// Gives each booking's emails in the mailbox the label of the booking's current stage.
// Runs with every mailbox check, so a stage change shows up in the mailbox within minutes.
export async function syncMailLabels(app: FastifyInstance): Promise<number> {
  const setLabel = app.mailSource?.setLabel?.bind(app.mailSource);
  if (!setLabel) return 0;
  const { rows } = await app.db.query<{ id: string; status: Status; mailLabel: string | null; ids: string[] }>(
    `SELECT b.id, b.status, b.mail_label AS "mailLabel", array_agg(c.external_id) AS ids
       FROM bookings b JOIN communications c ON c.booking_id = b.id
      WHERE c.external_id LIKE '<%'
      GROUP BY b.id`,
  );
  let changed = 0;
  for (const booking of rows) {
    const label = mailLabel(booking.status);
    if (booking.mailLabel === label) continue;
    await setLabel(booking.ids, label, ALL_LABELS.filter((l) => l !== label));
    // New emails of this booking get labelled on the next check: forget the label when one arrives.
    await app.db.query('UPDATE bookings SET mail_label = $2 WHERE id = $1', [booking.id, label]);
    changed++;
  }
  return changed;
}

// Checks the mailbox. The first check looks back IMAP_LOOKBACK_DAYS; later ones from the last import.
export async function runMailImport(app: FastifyInstance): Promise<ImportResult> {
  if (!app.mailSource) return { imported: 0, skipped: 0 };
  const last = await app.db.query<{ at: Date | null }>('SELECT max(created_at) AS at FROM communications WHERE external_id IS NOT NULL');
  const lookback = new Date(Date.now() - app.config.IMAP_LOOKBACK_DAYS * 86_400_000);
  // IMAP searches by whole days, so go back one extra day; duplicates are skipped anyway.
  const since = last.rows[0]?.at ? new Date(last.rows[0].at.getTime() - 86_400_000) : lookback;
  const result = await importMails(app, await app.mailSource.fetchSince(since, await relevanceCheck(app)));
  // A labelling problem must not make the import itself fail.
  await syncMailLabels(app).catch((err) => app.log.error({ err }, 'Could not update mailbox labels'));
  return result;
}
