import { describe, expect, it } from 'vitest';
// @ts-expect-error a browser module without types
import { bookingsFromRows, bookingsTemplate } from '../public/admin/bookings-file.js';

const packages = [{ id: 1, name: 'Standaard Xperience' }, { id: 2, name: 'Ultimate Xperience' }];

describe('bookings from a spreadsheet', () => {
  it('reads a row per party and says what is wrong with the rows it cannot use', () => {
    const { bookings, problems } = bookingsFromRows([
      ['Datum', 'Tijdslot', 'Pakket', 'Fase', 'Naam', 'E-mail', 'Telefoon', 'Straat', 'Postcode', 'Plaats', 'Jarige', 'Leeftijd', 'Extra stations', 'Afspraken'],
      ['28-11-2026', 'Avond', 'Ultimate', 'Optie', 'Jan Jansen', '', 'bel na 18u', 'Zaal 1', '', 'Capelle', '', '', '', '€ 400 all-in'],
      ['2026-12-19', 'middag', 'Standaard', 'Definitief', 'Piet', 'piet@example.com', '+31 6 12345678', 'Straat 5', '2907 ck', 'Capelle', 'Dila', '10', '2', ''],
      ['', 'Middag', 'Ultimate', '', 'Zonder datum', '', '', '', '', 'Almere'],
      ['01-02-2027', 'Middag', 'Deluxe', '', 'Verkeerd pakket', '', '', '', '', 'Almere'],
    ], packages);
    expect(bookings).toHaveLength(2);
    expect(bookings[0]).toMatchObject({ status: 'contacted', body: { packageId: 2, partyDate: '2026-11-28', timeSlot: 'avond', parentName: 'Jan Jansen', email: '', phone: '', city: 'Capelle', notes: '€ 400 all-in\nTelefoon: bel na 18u' } });
    expect(bookings[1]).toMatchObject({ status: 'confirmed', body: { packageId: 1, partyDate: '2026-12-19', postalCode: '2907 CK', phone: '+31 6 12345678', childName: 'Dila', childAge: 10, extraStations: 2 } });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('Rij 4 (Zonder datum)');
    expect(problems[1]).toContain('Deluxe');
  });

  it('reads back its own example file', () => {
    const rows = bookingsTemplate().replace(/^﻿/, '').trim().split('\r\n').map((l: string) => l.split(';'));
    const { bookings, problems } = bookingsFromRows(rows, packages);
    expect(problems).toEqual([]);
    expect(bookings[0]).toMatchObject({ status: 'contacted', body: { packageId: 2, childAge: 9, guestCount: 8 } });
  });
  it('reads a list of parties that are over: name in two parts, review and paid', () => {
    const { bookings, problems } = bookingsFromRows([
      ['Datum', 'Tijdslot', 'Pakket', 'Fase', 'Voornaam', 'Achternaam', 'E-mail', 'Plaats', 'Review', 'Betaald'],
      ['31-01-2026', 'Middag', 'Standaard', 'Afgerond', 'Tahnee', 'de Bruin', 't@example.com', 'Apeldoorn', 'Ontvangen', 'Ja'],
      ['08-02-2026', 'Middag', 'Standaard', 'Afgerond', 'Lia', '', 'lia@example.com / werk@example.com', 'Den Bosch', '', ''],
      ['09-02-2026', 'Middag', 'Standaard', 'Afgerond', 'Fout', 'Review', '', 'Den Bosch', 'misschien', ''],
    ], packages);
    expect(bookings[0]).toMatchObject({ status: 'completed', review: 'received', paid: true, body: { parentName: 'Tahnee de Bruin', firstName: 'Tahnee', lastName: 'de Bruin' } });
    expect(bookings[1]).toMatchObject({ review: undefined, paid: false, body: { parentName: 'Lia', firstName: 'Lia', email: 'lia@example.com', notes: 'Tweede e-mail: werk@example.com' } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('misschien');
  });
});
