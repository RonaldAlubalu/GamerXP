import type { Status } from '../services/pipeline.js';
import { formatDutchDate } from './dates.js';
import type { Mail } from './mailer.js';

export interface BookingMailData {
  reference: string;
  packageName: string;
  partyDate: string;
  timeSlot: string;
  startTime: string | null;
  extraStations: number;
  parentName: string;
  email: string;
  phone: string;
  street: string;
  postalCode: string;
  city: string;
  childName: string;
  childAge?: number | null;
  guestCount?: number | null;
  notes: string;
  statusToken: string;
  priceCents?: number;
  depositCents?: number;
  paidCents?: number;
  travelKm?: number | null;
}

export interface MailContext {
  publicUrl: string;
  // Optional payment instructions (e.g. IBAN), added to the confirmation email.
  paymentInfo?: string;
  // Link for leaving a Google review.
  reviewUrl?: string;
  // Online payment (Mollie) is switched on: add pay links to emails.
  onlinePayments?: boolean;
}

const signature =
  '\n\nGame on!\n\nRonald\nGamer Xperience\ncontact@gamerxp.nl · +31 (0)6 3420 6753\nhttps://gamerxp.nl';
const euro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

export const formatEuro = (cents: number) => euro.format(cents / 100);

// Adds the standard sign-off to a message written in the admin page.
export const withSignature = (text: string) => `${text.trim()}${signature}`;

export const TIME_SLOT_LABELS: Record<string, string> = { ochtend: 'Ochtend', middag: 'Middag', avond: 'Avond' };

export function statusUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/status?t=${encodeURIComponent(token)}`;
}

function summary(b: BookingMailData): string {
  const when = b.startTime
    ? `${formatDutchDate(b.partyDate)} om ${b.startTime}`
    : `${formatDutchDate(b.partyDate)} (${(TIME_SLOT_LABELS[b.timeSlot] ?? b.timeSlot).toLowerCase()})`;
  return [
    `Referentie: ${b.reference}`,
    `Pakket: ${b.packageName}` + (b.extraStations ? ` + ${b.extraStations} extra gamestation(s)` : ''),
    `Datum: ${when}`,
    b.childName && `Jarige: ${b.childName}${b.childAge ? ` (${b.childAge} jaar)` : ''}`,
    b.guestCount && `Aantal kinderen: ${b.guestCount}`,
    `Adres: ${b.street}, ${b.postalCode} ${b.city}`,
    b.priceCents !== undefined &&
      `Prijs: ${formatEuro(b.priceCents)} (${b.travelKm == null ? 'excl. reiskosten' : 'incl. reiskosten'})`,
  ]
    .filter(Boolean)
    .join('\n');
}

const followLink = (b: BookingMailData, ctx: MailContext) =>
  `\n\nVolg de voortgang van je feest: ${statusUrl(ctx.publicUrl, b.statusToken)}`;

export function bookingReceivedMail(b: BookingMailData, ctx: MailContext): Mail {
  return {
    to: b.email,
    subject: `We hebben je aanvraag ontvangen (${b.reference})`,
    text:
      `Hoi ${b.parentName},\n\n` +
      `Bedankt voor je aanvraag! Wij duiken in onze agenda en laten je binnen 24 uur weten ` +
      `of jouw datum nog vrij is. Je zit nog nergens aan vast.\n\n${summary(b)}` +
      (b.notes ? `\nDetails: ${b.notes}` : '') +
      followLink(b, ctx) +
      `\n\nKlopt er iets niet? Beantwoord dan gewoon deze e-mail.${signature}`,
  };
}

export function bookingOwnerNotification(b: BookingMailData, to: string, adminUrl: string): Mail {
  return {
    to,
    replyTo: b.email,
    subject: `Nieuwe aanvraag: ${formatDutchDate(b.partyDate)} – ${b.packageName} in ${b.city} (${b.reference})`,
    text:
      `Nieuwe aanvraag binnen.\n\n${summary(b)}\n\n` +
      `Naam: ${b.parentName}\nE-mail: ${b.email}\nTelefoon: ${b.phone || '-'}\n` +
      (b.notes ? `Details: ${b.notes}\n` : '') +
      `\nBekijken: ${adminUrl}`,
  };
}

// The email a parent gets when their booking moves to a new stage.
// Returns undefined for stages that don't need an email.
export function statusChangeMail(status: Status, b: BookingMailData, ctx: MailContext): Mail | undefined {
  const hi = `Hoi ${b.parentName},\n\n`;
  const footer = `\n\n${summary(b)}${followLink(b, ctx)}${signature}`;
  const deposit = b.depositCents ?? 0;
  const party = b.childName ? `het feest van ${b.childName}` : 'jullie feest';

  switch (status) {
    case 'confirmed':
      return {
        to: b.email,
        subject: `Je datum is vrij: bevestiging Gamer Xperience (${b.reference})`,
        text:
          hi +
          `Goed nieuws: je datum is vrij en we hebben ${party} voor je vastgezet!` +
          (deposit > 0
            ? `\n\nOm de datum definitief te maken vragen we een aanbetaling van ${formatEuro(deposit)}, ` +
              `te voldoen binnen 5 kalenderdagen. Vermeld bij de betaling je referentie ${b.reference}. ` +
              (ctx.onlinePayments
                ? `Je betaalt de aanbetaling eenvoudig online met iDEAL: ${ctx.publicUrl}/betalen/${encodeURIComponent(b.statusToken)}/aanbetaling\n\n`
                : '') +
              `Ontvangen we de aanbetaling niet op tijd, dan vervalt de reservering. ` +
              `Het restbedrag betaal je vooraf via overboeking of contant op de dag zelf.` +
              (ctx.paymentInfo ? `\n\n${ctx.paymentInfo}` : '')
            : '') +
          `\n\nDoor de aanbetaling ga je akkoord met onze algemene voorwaarden: ${ctx.publicUrl}/algemene-voorwaarden` +
          footer,
      };
    case 'deposit_paid':
      return {
        to: b.email,
        subject: `Aanbetaling ontvangen – je feest staat vast! (${b.reference})`,
        text:
          hi +
          `Bedankt, we hebben je aanbetaling ontvangen. ${party.charAt(0).toUpperCase() + party.slice(1)} ` +
          `staat definitief in onze agenda! Vlak voor het feest nemen we nog contact op over de laatste details, ` +
          `zoals de gewenste games en het precieze tijdstip.` +
          footer,
      };
    case 'completed':
      return {
        to: b.email,
        subject: `Bedankt voor het feest! (${b.reference})`,
        text:
          hi +
          `Bedankt dat je voor Gamer Xperience hebt gekozen! We hopen dat jullie een topdag hebben gehad.\n\n` +
          reviewAsk(ctx) +
          signature,
      };
    case 'cancelled':
      return {
        to: b.email,
        subject: `Je Gamer Xperience boeking is geannuleerd (${b.reference})`,
        text:
          hi +
          `Je boeking hieronder is geannuleerd. Heb je hier vragen over of wil je een andere datum? ` +
          `Beantwoord dan deze e-mail of stuur ons een berichtje via WhatsApp.` +
          footer,
      };
    default:
      return undefined;
  }
}

const reviewAsk = (ctx: MailContext) =>
  `Zou je ons willen helpen met een korte review op Google? Daar helpen we andere ouders enorm mee. ` +
  (ctx.reviewUrl ? `Het kost maar een minuutje: ${ctx.reviewUrl}` : `Zoek op "Gamer Xperience" in Google en klik op "Review schrijven".`);

export function reviewRequestMail(b: BookingMailData, ctx: MailContext): Mail {
  return {
    to: b.email,
    subject: 'Hoe was het feest? ⭐',
    text:
      `Hoi ${b.parentName},\n\n` +
      `Nogmaals bedankt dat we ${b.childName ? `het feest van ${b.childName}` : 'jullie feest'} mochten verzorgen! ` +
      reviewAsk(ctx) +
      signature,
  };
}

export function paymentLinkMail(b: BookingMailData, kind: 'deposit' | 'payment', amountCents: number, ctx: MailContext): Mail {
  const what = kind === 'deposit' ? 'de aanbetaling' : 'het restbedrag';
  const slug = kind === 'deposit' ? 'aanbetaling' : 'restbedrag';
  return {
    to: b.email,
    subject: `Betaallink voor ${what} (${b.reference})`,
    text:
      `Hoi ${b.parentName},\n\n` +
      `Via onderstaande link betaal je ${what} van ${formatEuro(amountCents)} eenvoudig online met iDEAL:\n\n` +
      `${ctx.publicUrl}/betalen/${encodeURIComponent(b.statusToken)}/${slug}` +
      `\n\n${summary(b)}${followLink(b, ctx)}${signature}`,
  };
}

export function contactOwnerNotification(
  m: { name: string; email: string; phone: string; message: string },
  to: string,
): Mail {
  return {
    to,
    replyTo: m.email,
    subject: `Contactformulier: ${m.name}`,
    text: `Naam: ${m.name}\nE-mail: ${m.email}\nTelefoon: ${m.phone || '-'}\n\n${m.message}`,
  };
}
