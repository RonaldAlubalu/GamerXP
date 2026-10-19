import { z } from 'zod';
import { isValidDate } from './dates.js';

export const dateString = z.string().refine(isValidDate, 'Ongeldige datum (gebruik JJJJ-MM-DD).');

export const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Ongeldige tijd (gebruik UU:MM).');

const text = (max: number) => z.string().trim().max(max);
const requiredText = (max: number, message: string) => text(max).min(1, message);

// Dutch postal code, normalised to '1234 AB'.
const postalCode = z
  .string()
  .trim()
  .regex(/^[1-9]\d{3}\s?[a-zA-Z]{2}$/, 'Vul een geldige postcode in, bijvoorbeeld 1234 AB.')
  .transform((v) => `${v.slice(0, 4)} ${v.slice(-2).toUpperCase()}`);

const phone = z
  .string()
  .trim()
  .regex(/^\+?[\d\s\-()]{8,20}$/, 'Vul een geldig telefoonnummer in.');

export const bookingRequest = z.object({
  packageId: z.coerce.number().int().positive('Kies een pakket.'),
  partyDate: dateString,
  startTime: timeString,
  parentName: requiredText(100, 'Vul je naam in.'),
  email: z.email('Vul een geldig e-mailadres in.').max(200),
  phone,
  street: requiredText(200, 'Vul je straat en huisnummer in.'),
  postalCode,
  city: requiredText(100, 'Vul je woonplaats in.'),
  childName: requiredText(50, 'Vul de naam van de jarige in.'),
  childAge: z.coerce.number().int().min(3, 'Leeftijd moet tussen 3 en 18 zijn.').max(18, 'Leeftijd moet tussen 3 en 18 zijn.'),
  guestCount: z.coerce.number().int().min(1, 'Minimaal 1 kind.').max(40, 'Maximaal 40 kinderen.'),
  notes: text(2000).default(''),
  privacyConsent: z.literal(true, 'Je moet akkoord gaan met de privacyverklaring.'),
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

export const bookingStatus = z.enum(['pending', 'confirmed', 'cancelled', 'completed']);
