import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';
import { renderEmailHtml } from './email-html.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  // Files to send along, fetched from their link (the invoice PDF).
  attachments?: { filename: string; path: string }[];
  // Notifications to the owner stay plain; emails to customers get the look of the website.
  plain?: boolean;
  // Link of a picture to show at the top (a special mailing).
  headerImage?: string;
  // The same picture as a file, so it can travel inside the mail.
  headerImageData?: { content: Buffer; mime: string };
}

export const LOGO = fileURLToPath(new URL('../../public/assets/img/logo-email.png', import.meta.url));

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
    async send({ plain, headerImage, headerImageData, ...mail }) {
      if (plain) {
        await transport.sendMail({ from: config.MAIL_FROM, ...mail });
        return;
      }
      // The logo and the picture travel inside the mail. Outlook and others block pictures that
      // have to be fetched from a website until the reader allows it; these show at once.
      const inline: { filename: string; cid: string; path?: string; content?: Buffer; contentType?: string }[] = [{ filename: 'logo.png', path: LOGO, cid: 'logo@gamerxp' }];
      if (headerImageData) inline.push({ filename: headerImageData.mime === 'image/png' ? 'header.png' : 'header.jpg', content: headerImageData.content, contentType: headerImageData.mime, cid: 'header@gamerxp' });
      const html = renderEmailHtml(mail.text, {
        publicUrl: config.PUBLIC_URL,
        reviewUrl: config.GOOGLE_REVIEW_URL || undefined,
        logoUrl: 'cid:logo@gamerxp',
        headerImage: headerImageData ? 'cid:header@gamerxp' : headerImage,
      });
      await transport.sendMail({ from: config.MAIL_FROM, ...mail, html, attachments: [...inline, ...(mail.attachments ?? [])] });
    },
    async verify() {
      await transport.verify();
    },
  };
}
