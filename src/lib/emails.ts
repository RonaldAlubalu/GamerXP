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
}

const signature = '\n\nGame on!\nTeam GamerXP\nhttps://gamerxp.nl';

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

export function bookingReceivedMail(b: BookingMailData): Mail {
  return {
    to: b.email,
    subject: `We hebben je aanvraag ontvangen (${b.reference})`,
    text:
      `Hoi ${b.parentName},\n\n` +
      `Bedankt voor je aanvraag voor een GamerXP LAN-party! We bekijken hem zo snel mogelijk ` +
      `en sturen je een bevestiging zodra alles rond is.\n\n${summary(b)}` +
      (b.notes ? `\nOpmerkingen: ${b.notes}` : '') +
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

export function bookingConfirmedMail(b: BookingMailData): Mail {
  return {
    to: b.email,
    subject: `Je GamerXP LAN-party is bevestigd! (${b.reference})`,
    text:
      `Hoi ${b.parentName},\n\nGoed nieuws: je LAN-party is bevestigd! ` +
      `We nemen vooraf nog contact met je op over de laatste details.\n\n${summary(b)}${signature}`,
  };
}

export function bookingCancelledMail(b: BookingMailData): Mail {
  return {
    to: b.email,
    subject: `Je GamerXP boeking is geannuleerd (${b.reference})`,
    text:
      `Hoi ${b.parentName},\n\nJe boeking hieronder is geannuleerd. ` +
      `Heb je hier vragen over of wil je een andere datum? Beantwoord dan deze e-mail.\n\n${summary(b)}${signature}`,
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
