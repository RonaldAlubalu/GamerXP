import { z } from 'zod';
import { STATUSES } from '../services/pipeline.js';
import { isValidDate } from './dates.js';

export const dateString = z.string().refine(isValidDate, 'Ongeldige datum (gebruik JJJJ-MM-DD).');

export const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Ongeldige tijd (gebruik UU:MM).');

const text = (max: number) => z.string().trim().max(max);
const requiredText = (max: number, message: string) => text(max).min(1, message);
// Optional number fields arrive from forms as '' when left empty.
const optionalInt = (min: number, max: number, message: string) =>
  z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.coerce.number().int().min(min, message).max(max, message).optional(),
  );

// Dutch postal code (normalised to '1234 AB') or Belgian postal code ('1234').
const postalCode = z
  .string()
  .trim()
  .regex(/^([1-9]\d{3}\s?[a-zA-Z]{2}|[1-9]\d{3})$/, 'Vul een geldige postcode in, bijvoorbeeld 1234 AB.')
  .transform((v) => (v.length <= 4 ? v : `${v.slice(0, 4)} ${v.slice(-2).toUpperCase()}`));

const phone = z
  .string()
  .trim()
  .regex(/^\+?[\d\s\-()]{8,20}$/, 'Vul een geldig telefoonnummer in.');

export const TIME_SLOTS = ['ochtend', 'middag', 'avond'] as const;

export const bookingRequest = z.object({
  packageId: z.coerce.number().int().positive('Kies je Gamer Party.'),
  extraStations: z.coerce.number().int().min(0).max(2, 'Maximaal 2 extra gamestations.').default(0),
  partyDate: dateString,
  timeSlot: z.enum(TIME_SLOTS, 'Kies een tijdslot.'),
  parentName: requiredText(100, 'Vul je naam in.'),
  email: z.email('Vul een geldig e-mailadres in.').max(200),
  phone: z.union([phone, z.literal('')]).default(''),
  street: requiredText(200, 'Vul je straat en huisnummer in.'),
  postalCode,
  city: requiredText(100, 'Vul je woonplaats in.'),
  childName: text(50).default(''),
  childAge: optionalInt(1, 18, 'Leeftijd moet tussen 1 en 18 zijn.'),
  guestCount: optionalInt(1, 40, 'Aantal kinderen moet tussen 1 en 40 zijn.'),
  notes: text(2000).default(''),
  termsAccepted: z.literal(true, 'Je moet akkoord gaan met de algemene voorwaarden.'),
  // Honeypot: hidden in the form, bots tend to fill it in.
  website: z.string().max(0).optional(),
});

export const contactRequest = z.object({
  name: requiredText(100, 'Vul je naam in.'),
  email: z.email('Vul een geldig e-mailadres in.').max(200),
  phone: z.union([phone, z.literal('')]).default(''),
  message: requiredText(5000, 'Vul een bericht in.'),
  website: z.string().max(0).optional(),
});

export const bookingStatus = z.enum(STATUSES);
