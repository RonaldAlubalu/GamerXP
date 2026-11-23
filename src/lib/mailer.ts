import nodemailer from 'nodemailer';
import type { Config } from '../config.js';
import { renderEmailHtml } from './email-html.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  // Notifications to the owner stay plain; emails to customers get the look of the website.
  plain?: boolean;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  // Logs in to the mail server without sending anything. Missing when email is switched off.
  verify?(): Promise<void>;
}

export function createMailer(config: Config, log: (msg: string) => void): Mailer {
  if (!config.SMTP_HOST) {
    return {
      async send(mail) {
        log(`[mail not sent: SMTP_HOST not configured] to=${mail.to} subject="${mail.subject}"`);
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });

  return {
    async send({ plain, ...mail }) {
      const html = plain
        ? undefined
        : renderEmailHtml(mail.text, { publicUrl: config.PUBLIC_URL, reviewUrl: config.GOOGLE_REVIEW_URL || undefined });
      await transport.sendMail({ from: config.MAIL_FROM, ...mail, html });
    },
    async verify() {
      await transport.verify();
    },
  };
}
