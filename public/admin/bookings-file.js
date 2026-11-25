// Turns the rows of a spreadsheet into bookings to add: one row per party, with a heading row above.
import { date } from './inventory-file.js';

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/[:.]+$/, '').replace(/\s+/g, ' ');

// [heading in the file, field] and other names for the same column.
export const BOOKING_COLUMNS = [
  ['Datum', 'partyDate'], ['Tijdslot', 'timeSlot'], ['Pakket', 'package'], ['Fase', 'status'], ['Naam', 'parentName'],
  ['E-mail', 'email'], ['Telefoon', 'phone'], ['Straat', 'street'], ['Postcode', 'postalCode'], ['Plaats', 'city'],
  ['Jarige', 'childName'], ['Leeftijd', 'childAge'], ['Aantal kinderen', 'guestCount'], ['Extra stations', 'extraStations'], ['Afspraken', 'notes'],
];
// Optional columns, for a list of parties that are already over: the name in two parts, whether a
// review came in, and whether everything was paid.
const EXTRA = { voornaam: 'firstName', achternaam: 'lastName', review: 'review', betaald: 'paid' };
const REVIEW = { ontvangen: 'received', ja: 'received', gevraagd: 'requested', nee: 'declined', geen: 'declined' };
const ALIASES = { email: 'email', klant: 'parentName', contactpersoon: 'parentName', adres: 'street', 'straat en huisnummer': 'street', woonplaats: 'city',
  kinderen: 'guestCount', 'naam jarige': 'childName', notities: 'notes', opmerkingen: 'notes', bijzonderheden: 'notes', status: 'status', slot: 'timeSlot' };
const FIELD = { ...Object.fromEntries(BOOKING_COLUMNS.map(([label, field]) => [norm(label), field])), ...ALIASES, ...EXTRA };
const STATUS = { nieuw: 'new', optie: 'contacted', 'contact opgenomen': 'contacted', 'in overleg': 'contacted', bevestigd: 'confirmed', definitief: 'confirmed',
  'aanbetaling ontvangen': 'deposit_paid', ingepland: 'scheduled', 'feest geweest': 'party_held', afgerond: 'completed' };
const SLOT = { ochtend: 'ochtend', middag: 'middag', avond: 'avond' };

// Returns the bookings that can be added, and per row that cannot what is wrong with it.
export function bookingsFromRows(rows, packages) {
  const bookings = [];
  const problems = [];
  let fields = null;
  rows.forEach((row, index) => {
    const labels = row.map(norm);
    if (!labels.some(Boolean)) return;
    if (!fields) {
      const found = labels.map((l) => FIELD[l] ?? null);
      if (found.includes('partyDate') && (found.includes('parentName') || found.includes('firstName'))) fields = found;
      return;
    }
    const raw = {};
    fields.forEach((field, i) => { if (field && (row[i] ?? '').trim() !== '') raw[field] = row[i].trim(); });
    if (!Object.keys(raw).length) return;
    const line = index + 1;
    // The name in one column, or first and last name apart.
    if (!raw.parentName) raw.parentName = `${raw.firstName ?? ''} ${raw.lastName ?? ''}`.trim();
    const fail = (why) => problems.push(`Rij ${line}${raw.parentName ? ` (${raw.parentName})` : ''}: ${why}`);
    const partyDate = date(raw.partyDate ?? '');
    if (!partyDate) return fail('de datum ontbreekt of is niet te lezen (gebruik 28-11-2026).');
    if (!raw.parentName) return fail('de naam ontbreekt.');
    if (!raw.city) return fail('de plaats ontbreekt.');
    const wanted = norm(raw.package);
    const pack = packages.find((p) => norm(p.name) === wanted) ?? packages.find((p) => wanted && (norm(p.name).includes(wanted) || wanted.includes(norm(p.name).split(' ')[0])));
    if (!pack) return fail(`het pakket "${raw.package ?? ''}" ken ik niet (kies uit: ${packages.map((p) => p.name).join(', ')}).`);
    const timeSlot = SLOT[norm(raw.timeSlot)];
    if (!timeSlot) return fail('het tijdslot moet ochtend, middag of avond zijn.');
    const status = raw.status ? STATUS[norm(raw.status)] : 'new';
    if (!status) return fail(`de fase "${raw.status}" ken ik niet.`);
    const notes = [raw.notes];
    // A phone number or postal code the site would refuse goes to the notes instead of blocking the row.
    let phone = (raw.phone ?? '').replace(/[^\d+\s\-()]/g, '').trim();
    if (phone && !/^\+?[\d\s\-()]{8,20}$/.test(phone)) { notes.push(`Telefoon: ${raw.phone}`); phone = ''; }
    let postalCode = (raw.postalCode ?? '').toUpperCase();
    if (postalCode && !/^([1-9]\d{3}\s?[A-Z]{2}|[1-9]\d{3})$/.test(postalCode)) { notes.push(`Postcode: ${raw.postalCode}`); postalCode = ''; }
    // Two addresses in one cell ("a@x.nl / b@y.nl"): the first is the address, the rest is kept in the notes.
    const mails = (raw.email ?? '').split(/[\s,;/]+/).filter((m) => m.includes('@'));
    if (mails.length > 1) notes.push(`Tweede e-mail: ${mails.slice(1).join(', ')}`);
    const whole = (v, max) => { const n = Number.parseInt(v, 10); return Number.isNaN(n) ? undefined : Math.min(Math.max(n, 1), max); };
    const review = raw.review ? REVIEW[norm(raw.review)] : undefined;
    if (raw.review && !review) return fail(`bij review staat "${raw.review}"; gebruik ontvangen, gevraagd of nee.`);
    bookings.push({
      line, status, review, paid: /^(ja|j|x|betaald)$/i.test(raw.paid ?? ''),
      body: {
        packageId: pack.id, partyDate, timeSlot, parentName: raw.parentName, firstName: raw.firstName ?? '', lastName: raw.lastName ?? '', email: mails[0] ?? '', phone, street: raw.street ?? '', postalCode, city: raw.city,
        childName: raw.childName ?? '', childAge: whole(raw.childAge, 18), guestCount: whole(raw.guestCount, 40),
        extraStations: Math.min(Math.max(Number.parseInt(raw.extraStations ?? '0', 10) || 0, 0), 2), notes: notes.filter(Boolean).join('\n'),
      },
    });
  });
  if (!fields) problems.push('Ik vind geen rij met kolomkoppen. Nodig zijn in elk geval: Datum, Tijdslot, Pakket, Naam en Plaats.');
  return { bookings, problems };
}

// An empty list with the right headings and one example, to fill in.
export function bookingsTemplate() {
  const example = ['28-11-2026', 'Middag', 'Ultimate', 'Optie', 'Voorbeeld Ouder', 'ouder@voorbeeld.nl', '06 12345678', 'Dorpsstraat 1', '1234 AB', 'Eindhoven', 'Sam', '9', '8', '0', 'Prijsafspraak of bijzonderheden'];
  return `﻿${[BOOKING_COLUMNS.map(([label]) => label), example].map((l) => l.join(';')).join('\r\n')}\r\n`;
}
