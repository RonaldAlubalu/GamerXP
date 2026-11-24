import { describe, expect, it } from 'vitest';
// The reader runs in the browser; the part that turns rows into items is plain code.
// @ts-expect-error a browser module without types
import { itemsFromRows, matchExisting, inventoryCsv } from '../public/admin/inventory-file.js';

describe('inventory from a spreadsheet', () => {
  it("reads the owner's own sheet: a row per station, then the games, and never the password columns", () => {
    const { items, skipped } = itemsFromRows([
      ['Accounts'],
      ['Email', 'WW:', 'Xbox GT:', 'Epic:', 'Epic WW:', 'Marvel Rivals', 'Xbox SN:', 'Controller SN:', 'Home XB:', 'GamePass:', ''],
      ['a1@example.com', 'geheim-1', 'GT1', 'Epic1', 'geheim-2', 'Rivals1', '111', '222', 'Nee', 'Ja', 'Per 22-10'],
      ['a2@example.com', 'geheim-3', 'GT2', 'Epic2', '', 'Rivals2', '333', '444', 'Ja, GP01', 'Nee', ''],
      [],
      ['Standaard Games', 'GamePass Premium', '', 'Koop prijs'],
      ['Game pass kosten p/m', '', '', '10'],
      ['Fortenite', '', 'Gratis', '', 'geheim-4'],
      ['MineCraft', 'x', 'GamesPass/Koop', '10'],
      ['', '', '', '=SUM(D7:D9)'],
    ]);
    expect(skipped).toBe(2);
    expect(JSON.stringify(items)).not.toContain('geheim');
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ kind: 'station', name: 'Station 1', details: { accountEmail: 'a1@example.com', gamertag: 'GT1', epicName: 'Epic1', otherAccounts: 'Marvel Rivals: Rivals1', consoleSerial: '111', controllerSerial: '222', gamePass: true, gamePassNote: 'Per 22-10' } });
    expect(items[1]).toMatchObject({ name: 'Station 2', details: { homeConsole: 'Ja, GP01', gamePass: false } });
    expect(items[2]).toMatchObject({ kind: 'game', name: 'Fortenite', priceCents: null, details: { source: 'free' } });
    expect(items[3]).toMatchObject({ kind: 'game', name: 'MineCraft', priceCents: 1000, details: { source: 'gamepass_or_bought' }, notes: 'Zit in Game Pass' });
  });

  it('treats a name with a typing error as the item that is already there', () => {
    const existing = [{ kind: 'game', name: 'Fortnite' }, { kind: 'game', name: 'Turtles (TMNT)' }, { kind: 'game', name: 'FC26' }];
    const items = matchExisting([{ kind: 'game', name: 'Fortenite' }, { kind: 'game', name: 'Turtles' }, { kind: 'game', name: 'FC25' }], existing);
    expect(items.map((i: { name: string }) => i.name)).toEqual(['Fortnite', 'Turtles (TMNT)', 'FC25']);
  });

  it('reads back the list it exports', () => {
    const list = [
      { kind: 'subscription', name: 'Game Pass', quantity: 1, status: 'in_use', priceCents: 5000, expiresOn: '2027-01-31', notes: 'Voor alle; accounts', details: { period: 'month', autoRenew: true, provider: 'Microsoft' } },
      { kind: 'other', name: 'Switch 8 poorts', quantity: 2, status: 'spare', priceCents: null, expiresOn: null, notes: '', details: { category: 'Netwerk', serial: 'SN-1' } },
    ];
    const csv = inventoryCsv(list).replace(/^﻿/, '');
    const rows = csv.trim().split('\r\n').map((line: string) => line.match(/("([^"]|"")*"|[^;]*)(;|$)/g)!.slice(0, -1).map((c) => c.replace(/;$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')));
    const { items } = itemsFromRows(rows);
    expect(items[0]).toMatchObject({ kind: 'subscription', name: 'Game Pass', priceCents: 5000, expiresOn: '2027-01-31', notes: 'Voor alle; accounts', details: { period: 'month', autoRenew: true, provider: 'Microsoft' } });
    expect(items[1]).toMatchObject({ kind: 'other', name: 'Switch 8 poorts', quantity: 2, status: 'spare', details: { category: 'Netwerk', serial: 'SN-1' } });
  });
});
