// Reads an inventory list from a spreadsheet (.xlsx) or a .csv file, in the browser. The file itself
// never goes to the server: only the items found in it do, and columns with passwords are not read.

const SECRET = /pass\s?(word|wd)|wachtwoord|\bww\b|pwd|secret|token/i;
const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/[:.]+$/, '').replace(/\s+/g, ' ');

// --- .xlsx: a zip with XML inside -------------------------------------------------------------

async function unzip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let end = buffer.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Dit is geen geldig Excel-bestand.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = {};
  const text = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = text.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    files[name] = { method, data: bytes.subarray(start, start + size) };
    at += 46 + nameLength + extra + comment;
  }
  return async (name) => {
    const file = files[name];
    if (!file) return null;
    if (file.method === 0) return text.decode(file.data);
    const stream = new Blob([file.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
}

const column = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

// Excel keeps a date as the number of days since 1900.
function excelDate(days) {
  return new Date(Math.round((days - 25569) * 864e5)).toISOString().slice(0, 10);
}

async function xlsxRows(buffer) {
  const read = await unzip(buffer);
  const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
  const shared = [];
  const sharedXml = await read('xl/sharedStrings.xml');
  if (sharedXml) for (const si of parse(sharedXml).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  // Which cell styles are dates.
  const dateStyles = new Set();
  const stylesXml = await read('xl/styles.xml');
  if (stylesXml) {
    const styles = parse(stylesXml);
    const custom = {};
    for (const f of styles.getElementsByTagName('numFmt')) custom[f.getAttribute('numFmtId')] = f.getAttribute('formatCode');
    const xfs = styles.getElementsByTagName('cellXfs')[0]?.getElementsByTagName('xf') ?? [];
    [...xfs].forEach((xf, i) => {
      const id = Number(xf.getAttribute('numFmtId'));
      const code = custom[id] ?? '';
      if ((id >= 14 && id <= 22) || /[dy]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"/g, ''))) dateStyles.add(i);
    });
  }
  const workbook = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  let path = 'xl/worksheets/sheet1.xml';
  if (workbook && rels) {
    const first = parse(workbook).getElementsByTagName('sheet')[0];
    const id = first?.getAttribute('r:id');
    const rel = [...parse(rels).getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === id);
    if (rel) path = `xl/${rel.getAttribute('Target').replace(/^\/?xl\//, '')}`;
  }
  const sheetXml = await read(path);
  if (!sheetXml) throw new Error('In dit Excel-bestand staat geen werkblad.');
  const rows = [];
  for (const row of parse(sheetXml).getElementsByTagName('row')) {
    const cells = [];
    for (const c of row.getElementsByTagName('c')) {
      const type = c.getAttribute('t');
      const raw = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let value = raw;
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = c.getElementsByTagName('t')[0]?.textContent ?? '';
      else if (raw !== '' && dateStyles.has(Number(c.getAttribute('s'))) && !Number.isNaN(Number(raw))) value = excelDate(Number(raw));
      cells[column(c.getAttribute('r'))] = String(value).trim();
    }
    rows[Number(row.getAttribute('r')) - 1] = cells;
  }
  return [...rows].map((r) => [...(r ?? [])].map((v) => v ?? ''));
}

// --- .csv ---------------------------------------------------------------------------------------

function csvRows(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

// --- rows -> items ------------------------------------------------------------------------------

const KIND = { station: 'station', gamestation: 'station', stations: 'station', game: 'game', games: 'game', spel: 'game', overig: 'other', 'overig materiaal': 'other', materiaal: 'other', abonnement: 'subscription', abonnementen: 'subscription' };
const STATUS = { 'in gebruik': 'in_use', reserve: 'spare', defect: 'broken', kapot: 'broken', weg: 'gone' };
const SOURCE = { gratis: 'free', 'game pass': 'gamepass', gamepass: 'gamepass', gekocht: 'bought', koop: 'bought', 'game pass of gekocht': 'gamepass_or_bought', 'gamespass/koop': 'gamepass_or_bought', 'gamepass/koop': 'gamepass_or_bought' };
const PERIOD = { 'per maand': 'month', maand: 'month', 'per jaar': 'year', jaar: 'year', eenmalig: 'once' };
const yes = (v) => /^(ja|j|yes|y|x|true|1|waar)\b/i.test(String(v).trim());

// The columns of the standard list, as they are also exported. [header, where it goes, how to read it]
export const COLUMNS = [
  ['Soort', 'kind'], ['Naam', 'name'], ['Aantal', 'quantity'], ['Status', 'status'], ['Prijs', 'priceCents'],
  ['Verloopt op', 'expiresOn'], ['Notities', 'notes'],
  ['Serienummer console', 'd.consoleSerial'], ['Serienummer controller', 'd.controllerSerial'], ['Account e-mail', 'd.accountEmail'],
  ['Gamertag', 'd.gamertag'], ['Epic-naam', 'd.epicName'], ['Andere accounts', 'd.otherAccounts'], ['Home-console', 'd.homeConsole'],
  ['Game Pass', 'd.gamePass'], ['Game Pass notitie', 'd.gamePassNote'], ['Herkomst', 'd.source'], ['Categorie', 'd.category'],
  ['Serienummer', 'd.serial'], ['Periode', 'd.period'], ['Automatisch verlengen', 'd.autoRenew'], ['Aanbieder', 'd.provider'],
];
// Other names people give the same columns.
const ALIASES = {
  type: 'kind', item: 'name', omschrijving: 'name', 'xbox sn': 'd.consoleSerial', 'controller sn': 'd.controllerSerial',
  email: 'd.accountEmail', 'e-mail': 'd.accountEmail', 'xbox gt': 'd.gamertag', epic: 'd.epicName', 'home xb': 'd.homeConsole',
  gamepass: 'd.gamePass', vervaldatum: 'expiresOn', einddatum: 'expiresOn', opmerking: 'notes', opmerkingen: 'notes', notitie: 'notes',
  'koop prijs': 'priceCents', koopprijs: 'priceCents', kosten: 'priceCents',
};
const TARGET = Object.fromEntries(COLUMNS.map(([label, target]) => [norm(label), target]));

function money(v) {
  const n = Number(String(v).replace(/[€\s]/g, '').replace(/,-$/, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return v === '' || Number.isNaN(n) ? null : Math.round(n * 100);
}

export function date(v) {
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

function put(item, target, value) {
  if (value === '') return;
  if (target === 'kind') item.kind = KIND[norm(value)] ?? item.kind;
  else if (target === 'name') item.name = value;
  else if (target === 'quantity') item.quantity = Number.parseInt(value, 10) || 1;
  else if (target === 'status') item.status = STATUS[norm(value)] ?? 'in_use';
  else if (target === 'priceCents') item.priceCents = money(value);
  else if (target === 'expiresOn') item.expiresOn = date(value);
  else if (target === 'notes') item.notes = value;
  else if (target === 'd.gamePass' || target === 'd.autoRenew') item.details[target.slice(2)] = yes(value);
  else if (target === 'd.source') item.details.source = SOURCE[norm(value)] ?? '';
  else if (target === 'd.period') item.details.period = PERIOD[norm(value)] ?? '';
  else item.details[target.slice(2)] = value;
}

// Turns the rows of a sheet into items. Understands the standard list (a "Soort" and a "Naam" column)
// and the owner's own sheet: one row per station with its accounts, and below that a list of games.
export function itemsFromRows(rows) {
  const items = [];
  let skipped = 0;
  let headers = null; // column index -> target
  let section = null; // 'table' | 'stations' | 'games'
  let gameColumns = null;
  let station = 0;
  for (const row of rows) {
    const labels = row.map(norm);
    const filled = labels.filter(Boolean);
    if (!filled.length) continue;
    // A header row starts a new block.
    const targets = labels.map((l) => (SECRET.test(l) ? 'secret' : TARGET[l] ?? ALIASES[l] ?? null));
    const known = targets.filter((t) => t && t !== 'secret');
    if (labels[0] === 'standaard games' || (labels.includes('koop prijs') && !known.includes('name'))) {
      section = 'games';
      gameColumns = { price: labels.indexOf('koop prijs'), pass: labels.findIndex((l) => l.startsWith('gamepass') || l.startsWith('game pass')) };
      continue;
    }
    if (known.includes('kind') && known.includes('name')) { section = 'table'; headers = targets; skipped += targets.filter((t) => t === 'secret').length; continue; }
    if (known.includes('d.accountEmail') && known.length >= 3 && !known.includes('name')) {
      section = 'stations'; headers = targets; skipped += targets.filter((t) => t === 'secret').length;
      // A column without a heading right after "GamePass" holds the note about it.
      const gp = targets.indexOf('d.gamePass');
      if (gp >= 0 && !labels[gp + 1]) headers[gp + 1] = 'd.gamePassNote';
      const rivals = labels.indexOf('marvel rivals');
      if (rivals >= 0) headers[rivals] = 'rivals';
      continue;
    }
    if (section === 'games') {
      const name = row[0]?.trim();
      if (!name || /kosten p\/m|^totaal/i.test(name)) continue;
      const how = norm(row[2]);
      if (!(how in SOURCE)) continue;
      const item = { kind: 'game', name, quantity: 1, status: 'in_use', priceCents: gameColumns.price >= 0 ? money(row[gameColumns.price] ?? '') : null, details: { source: SOURCE[how] }, notes: '' };
      if (gameColumns.pass >= 0 && yes(row[gameColumns.pass] ?? '')) item.notes = 'Zit in Game Pass';
      items.push(item);
      continue;
    }
    if (!headers) continue;
    const item = { kind: section === 'stations' ? 'station' : 'other', name: '', quantity: 1, status: 'in_use', priceCents: null, details: {}, notes: '', expiresOn: null };
    headers.forEach((target, i) => {
      const value = (row[i] ?? '').trim();
      if (!target || target === 'secret' || value === '') return;
      if (target === 'rivals') item.details.otherAccounts = `Marvel Rivals: ${value}`;
      else put(item, target, value);
    });
    if (section === 'stations') {
      if (!item.details.accountEmail && !item.details.consoleSerial) continue;
      station++;
      item.name ||= `Station ${station}`;
    }
    if (!item.name) continue;
    items.push(item);
  }
  return { items, skipped };
}

// The rows of a spreadsheet or .csv file, as lists of text cells.
export async function readRows(file) {
  const name = file.name.toLowerCase();
  return name.endsWith('.csv') || name.endsWith('.txt') ? csvRows(await file.text()) : xlsxRows(await file.arrayBuffer());
}

export async function readInventoryFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) {
    const data = JSON.parse(await file.text());
    return { items: Array.isArray(data) ? data : data.items, skipped: 0 };
  }
  const rows = name.endsWith('.csv') || name.endsWith('.txt') ? csvRows(await file.text()) : await xlsxRows(await file.arrayBuffer());
  return itemsFromRows(rows);
}

// Names that are almost the same ("Fortenite" and "Fortnite", "Turtles" and "Turtles (TMNT)") count as
// one item, so a list with a typing error does not make doubles.
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function matchExisting(items, existing) {
  const plain = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const item of items) {
    if (item.kind === 'station') continue;
    const mine = plain(item.name);
    const same = existing.filter((e) => e.kind === item.kind);
    if (same.some((e) => plain(e.name) === mine)) continue;
    const close = same.find((e) => {
      const theirs = plain(e.name);
      return (mine.length >= 5 && (theirs.startsWith(mine) || mine.startsWith(theirs))) || (Math.min(mine.length, theirs.length) >= 6 && distance(mine, theirs) <= 2);
    });
    if (close) item.name = close.name;
  }
  return items;
}

// The current list as a .csv that Excel opens, in the same columns the import reads.
export function inventoryCsv(items) {
  const kind = { station: 'Station', game: 'Game', other: 'Overig', subscription: 'Abonnement' };
  const status = { in_use: 'In gebruik', spare: 'Reserve', broken: 'Defect', gone: 'Weg' };
  const source = { free: 'Gratis', gamepass: 'Game Pass', bought: 'Gekocht', gamepass_or_bought: 'Game Pass of gekocht' };
  const period = { month: 'Per maand', year: 'Per jaar', once: 'Eenmalig' };
  const cell = (item, target) => {
    const v = target.startsWith('d.') ? item.details?.[target.slice(2)] : item[target];
    if (target === 'kind') return kind[v];
    if (target === 'status') return status[v];
    if (target === 'priceCents') return v == null ? '' : (v / 100).toFixed(2).replace('.', ',');
    if (target === 'd.source') return source[v] ?? '';
    if (target === 'd.period') return period[v] ?? '';
    if (target === 'd.gamePass' || target === 'd.autoRenew') return v ? 'Ja' : v === false ? 'Nee' : '';
    return v ?? '';
  };
  const quote = (v) => (/[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [COLUMNS.map(([label]) => label), ...items.map((i) => COLUMNS.map(([, target]) => cell(i, target)))];
  return `﻿${lines.map((l) => l.map(quote).join(';')).join('\r\n')}\r\n`;
}
