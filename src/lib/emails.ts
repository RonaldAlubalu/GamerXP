import type { Status } from '../services/pipeline.js';
import { formatDutchDate } from './dates.js';
import type { Mail } from './mailer.js';

export interface BookingMailData {
  reference: string;
  packageName: string;
  partyDate: string;
  startTime: string;
  parentName: string;
  email: string;
  phone: string;
  street: string;
  postalCode: string;
  city: string;
  childName: string;
  childAge: number;
  guestCount: number;
  notes: string;
  statusToken: string;
  priceCents?: number;
  depositCents?: number;
  paidCents?: number;
}

const signature = '\n\nGame on!\nTeam GamerXP\nhttps://gamerxp.nl';
const euro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

export const formatEuro = (cents: number) => euro.format(cents / 100);

export function statusUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/status?t=${encodeURIComponent(token)}`;
}

function summary(b: BookingMailData): string {
  return [
    `Referentie: ${b.reference}`,
    `Pakket: ${b.packageName}`,
    `Datum: ${formatDutchDate(b.partyDate)}`,
    `Starttijd: ${b.startTime.slice(0, 5)}`,
    `Jarige: ${b.childName} (${b.childAge} jaar)`,
    `Aantal kinderen: ${b.guestCount}`,
    `Adres: ${b.street}, ${b.postalCode} ${b.city}`,
  ].join('\n');
}

const followLink = (b: BookingMailData, publicUrl: string) =>
  `\n\nVolg de voortgang van je feest: ${statusUrl(publicUrl, b.statusToken)}`;

export function bookingReceivedMail(b: BookingMailData, publicUrl: string): Mail {
  return {
    to: b.email,
    subject: `We hebben je aanvraag ontvangen (${b.reference})`,
    text:
      `Hoi ${b.parentName},\n\n` +
      `Bedankt voor je aanvraag voor een GamerXP LAN-party! We bekijken hem zo snel mogelijk ` +
      `en nemen contact met je op.\n\n${summary(b)}` +
      (b.notes ? `\nOpmerkingen: ${b.notes}` : '') +
      followLink(b, publicUrl) +
      `\n\nKlopt er iets niet? Beantwoord dan gewoon deze e-mail.${signature}`,
  };
}

export function bookingOwnerNotification(b: BookingMailData, to: string, adminUrl: string): Mail {
  return {
    to,
    replyTo: b.email,
    subject: `Nieuwe boeking: ${formatDutchDate(b.partyDate)} – ${b.childName} (${b.reference})`,
    text:
      `Nieuwe aanvraag binnen.\n\n${summary(b)}\n\n` +
      `Ouder: ${b.parentName}\nE-mail: ${b.email}\nTelefoon: ${b.phone}\n` +
      (b.notes ? `Opmerkingen: ${b.notes}\n` : '') +
      `\nBekijken: ${adminUrl}`,
  };
}

// The email a parent gets when their booking moves to a new stage.
// Returns undefined for stages that don't need an email.
export function statusChangeMail(status: Status, b: BookingMailData, publicUrl: string): Mail | undefined {
  const hi = `Hoi ${b.parentName},\n\n`;
  const footer = `\n\n${summary(b)}${followLink(b, publicUrl)}${signature}`;
  const deposit = b.depositCents ?? 0;

  switch (status) {
    case 'confirmed':
      return {
        to: b.email,
        subject: `Je GamerXP LAN-party is bevestigd! (${b.reference})`,
        text:
          hi +
          `Goed nieuws: je LAN-party voor ${b.childName} is bevestigd!` +
          (deposit > 0
            ? ` Om de datum definitief vast te leggen vragen we een aanbetaling van ${formatEuro(deposit)}. ` +
              `Vermeld bij de betaling je referentie ${b.reference}.`
            : '') +
          footer,
      };
    case 'deposit_paid':
      return {
        to: b.email,
        subject: `Aanbetaling ontvangen – je feest staat vast! (${b.reference})`,
        text: hi + `We hebben je aanbetaling ontvangen. Het feest van ${b.childName} staat definitief in onze agenda!` + footer,
      };
    case 'completed':
      return {
        to: b.email,
        subject: `Bedankt voor het feest! (${b.reference})`,
        text:
          hi +
          `Bedankt dat je voor GamerXP hebt gekozen! We hopen dat ${b.childName} en de vrienden een topdag hebben gehad. ` +
          `We zouden het heel leuk vinden als je een review achterlaat of ons aanraadt bij andere ouders.` +
          signature,
      };
    case 'cancelled':
      return {
        to: b.email,
        subject: `Je GamerXP boeking is geannuleerd (${b.reference})`,
        text:
          hi +
          `Je boeking hieronder is geannuleerd. Heb je hier vragen over of wil je een andere datum? ` +
          `Beantwoord dan deze e-mail.` +
          footer,
      };
    default:
      return undefined;
  }
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
