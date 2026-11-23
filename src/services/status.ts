import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

// One line on the status page in the admin.
export interface Check {
  key: string;
  label: string;
  // ok: works. warn: works but needs attention. error: broken. off: not set up.
  state: 'ok' | 'warn' | 'error' | 'off';
  detail: string;
}

export interface SystemStatus {
  checkedAt: string;
  checks: Check[];
}

const TIMEOUT_MS = 10_000;
const HOUR = 3_600_000;

// Runs a connection test with a time limit and turns the outcome into a check.
async function probe(key: string, label: string, okDetail: string, run: () => Promise<unknown>): Promise<Check> {
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('geen antwoord binnen 10 seconden')), TIMEOUT_MS)),
    ]);
    return { key, label, state: 'ok', detail: okDetail };
  } catch (err) {
    return { key, label, state: 'error', detail: `Werkt niet: ${(err as Error).message || 'onbekende fout'}` };
  }
}

const ago = (date: Date) => {
  const hours = (Date.now() - date.getTime()) / HOUR;
  if (hours < 1) return 'minder dan een uur geleden';
  if (hours < 48) return `${Math.round(hours)} uur geleden`;
  return `${Math.round(hours / 24)} dagen geleden`;
};

async function newestFile(dir: string, pattern: RegExp): Promise<{ name: string; time: Date; size: number } | null> {
  let newest: { name: string; time: Date; size: number } | null = null;
  for (const name of await readdir(dir)) {
    if (!pattern.test(name)) continue;
    const info = await stat(path.join(dir, name));
    if (!newest || info.mtime > newest.time) newest = { name, time: info.mtime, size: info.size };
  }
  return newest;
}

async function backupChecks(dir: string): Promise<Check[]> {
  const local: Check = { key: 'backup', label: 'Back-up op deze server', state: 'off', detail: 'Niet zichtbaar vanaf de website (alleen op de server zelf).' };
  const remote: Check = { key: 'backup-remote', label: 'Kopie op de tweede server', state: 'off', detail: 'Nog niet ingesteld.' };
  if (!dir) return [local, remote];
  try {
    const newest = await newestFile(dir, /^gamerxp-.*\.sql\.gz$/);
    if (!newest) {
      Object.assign(local, { state: 'warn', detail: 'Er is nog geen back-up gemaakt. De eerste komt binnen een dag.' });
    } else {
      const stale = Date.now() - newest.time.getTime() > 36 * HOUR;
      Object.assign(local, {
        state: stale ? 'error' : 'ok',
        detail: `Laatste back-up: ${ago(newest.time)} (${Math.max(1, Math.round(newest.size / 1024))} kB).${stale ? ' Dat is te lang geleden.' : ''}`,
      });
    }
  } catch {
    Object.assign(local, { state: 'warn', detail: 'De map met back-ups kan niet worden gelezen.' });
  }
  // Written by deploy/backup-peer.sh after each nightly push: "ok|fail <epoch> <host> <message>".
  try {
    const [result, epoch, host, ...message] = (await readFile(path.join(dir, '.backup-peer-status'), 'utf8')).trim().split(' ');
    const time = new Date(Number(epoch) * 1000);
    const stale = Date.now() - time.getTime() > 36 * HOUR;
    if (result === 'ok') {
      Object.assign(remote, { state: stale ? 'warn' : 'ok', detail: `Laatste kopie naar ${host}: ${ago(time)}.${stale ? ' Dat is langer dan een dag geleden.' : ''}` });
    } else {
      Object.assign(remote, { state: 'error', detail: `Kopie naar ${host} mislukt (${ago(time)}): ${message.join(' ') || 'onbekende fout'}` });
    }
  } catch {
    // No status file: the nightly copy has not run yet or is not set up.
  }
  return [local, remote];
}

async function maintenanceCheck(dir: string): Promise<Check> {
  const check: Check = { key: 'maintenance', label: 'Wekelijks onderhoud', state: 'off', detail: 'Nog geen rapport. Het onderhoud draait elke maandagnacht.' };
  if (!dir) return check;
  try {
    const newest = await newestFile(dir, /\.md$/);
    if (!newest) return check;
    const report = await readFile(path.join(dir, newest.name), 'utf8');
    const problems = report.split('\n').filter((line) => line.includes('PROBLEM')).map((line) => line.replace(/^- \*\*PROBLEM:\*\* /, ''));
    const stale = Date.now() - newest.time.getTime() > 9 * 24 * HOUR;
    if (problems.length) return { ...check, state: 'error', detail: `Laatste onderhoud (${ago(newest.time)}) meldde: ${problems.join(' ')}` };
    if (stale) return { ...check, state: 'warn', detail: `Laatste onderhoud: ${ago(newest.time)}. Het had deze week opnieuw moeten draaien.` };
    return { ...check, state: 'ok', detail: `Laatste onderhoud: ${ago(newest.time)}, alles in orde.` };
  } catch {
    return check;
  }
}

// Tests every outside connection the site depends on.
export async function checkSystem(app: FastifyInstance): Promise<SystemStatus> {
  const { config } = app;
  const off = (key: string, label: string, detail: string): Check => ({ key, label, state: 'off', detail });

  const [database, sending, reading, payments, backups, maintenance] = await Promise.all([
    probe('database', 'Database', 'Bereikbaar.', () => app.db.query('SELECT 1')),
    app.mailer.verify
      ? probe('mail-send', 'E-mail versturen', `Ingelogd bij ${config.SMTP_HOST} als ${config.SMTP_USER || 'anoniem'}.`, () => app.mailer.verify!())
      : Promise.resolve(off('mail-send', 'E-mail versturen', 'Niet ingesteld: e-mails worden alleen gelogd, niet verstuurd.')),
    app.mailSource?.check
      ? probe('mail-read', 'E-mail ophalen', `Mailbox ${config.IMAP_USER} is leesbaar.`, () => app.mailSource!.check!())
      : Promise.resolve(off('mail-read', 'E-mail ophalen', 'Niet ingesteld: antwoorden van klanten komen niet vanzelf in de admin.')),
    app.mollie?.ping
      ? probe('mollie', 'Online betalen (Mollie)', config.MOLLIE_API_KEY.startsWith('live_') ? 'Verbonden, echte betalingen.' : 'Verbonden in testmodus: er wordt geen echt geld afgeschreven.', () => app.mollie!.ping!())
      : Promise.resolve(off('mollie', 'Online betalen (Mollie)', 'Niet ingesteld: klanten kunnen niet online betalen.')),
    backupChecks(config.BACKUP_DIR),
    maintenanceCheck(config.REPORTS_DIR),
  ]);

  // Test mode on the real domain is a mistake worth pointing out.
  if (payments.state === 'ok' && !config.MOLLIE_API_KEY.startsWith('live_')) payments.state = 'warn';
  const whatsapp: Check = {
    key: 'whatsapp', label: 'WhatsApp', state: 'ok',
    detail: 'Handmatig: de admin opent WhatsApp met het bericht klaar en jij drukt op verzenden. Er is geen koppeling nodig.',
  };
  const review: Check = config.GOOGLE_REVIEW_URL
    ? { key: 'review', label: 'Google-reviewlink', state: 'ok', detail: 'Ingesteld.' }
    : off('review', 'Google-reviewlink', 'Niet ingesteld: reviewverzoeken bevatten geen directe link.');
  return { checkedAt: new Date().toISOString(), checks: [database, sending, reading, payments, ...backups, maintenance, whatsapp, review] };
}
