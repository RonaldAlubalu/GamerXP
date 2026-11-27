import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { addDays } from '../lib/dates.js';

// Visitor counts for the owner, without cookies and without keeping anything that points to a
// person: see migrations/041_site_visits.sql.

const KEEP_DAYS = 730;
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|scrapy|facebookexternalhit|whatsapp/i;

let salt: { day: string; value: string } | null = null;

// Today's key. A new day gets a new one and the old one is gone for good.
async function daySalt(db: Db, day: string): Promise<string> {
  if (salt?.day === day) return salt.value;
  const fresh = JSON.stringify({ day, value: randomBytes(24).toString('hex') });
  const { rows } = await db.query<{ value: { day: string; value: string } }>(
    `INSERT INTO settings (key, value) VALUES ('visit_salt', $1)
     ON CONFLICT (key) DO UPDATE SET value = CASE WHEN settings.value->>'day' = $2 THEN settings.value ELSE EXCLUDED.value END
     RETURNING value`,
    [fresh, day],
  );
  salt = rows[0]!.value;
  await db.query('DELETE FROM site_visits WHERE day < $1', [addDays(day, -KEEP_DAYS)]);
  return salt.value;
}

// "www.google.com" -> "google.com"; our own pages and empty referrers count as direct.
export function sourceOf(referrer: string, tagged: string, ownHost: string): string {
  if (tagged) return tagged.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 60);
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '').toLowerCase();
    return host === ownHost.replace(/^www\./, '') ? '' : host.slice(0, 60);
  } catch {
    return '';
  }
}

export async function recordVisit(
  db: Db,
  visit: { day: string; ip: string; userAgent: string; path: string; source: string },
): Promise<boolean> {
  if (!visit.userAgent || BOT.test(visit.userAgent)) return false;
  const visitor = createHash('sha256').update(`${await daySalt(db, visit.day)}|${visit.ip}|${visit.userAgent}`).digest('hex').slice(0, 20);
  const device = /Mobi|Android|iPhone/i.test(visit.userAgent) ? 'phone' : /iPad|Tablet/i.test(visit.userAgent) ? 'tablet' : 'desktop';
  await db.query('INSERT INTO site_visits (day, visitor, path, source, device) VALUES ($1, $2, $3, $4, $5)', [visit.day, visitor, visit.path, visit.source, device]);
  return true;
}

export interface VisitStats {
  from: string;
  to: string;
  visitors: number;
  views: number;
  requests: number;
  messages: number;
  days: { day: string; visitors: number; views: number; requests: number }[];
  pages: { path: string; visitors: number; views: number }[];
  sources: { source: string; visitors: number }[];
  devices: { device: string; visitors: number }[];
}

// A visitor who comes back on another day counts again: the code differs per day.
export async function visitStats(db: Db, from: string, to: string, timezone: string): Promise<VisitStats> {
  const range = [from, to];
  const perDay = await db.query<{ day: string; visitors: number; views: number }>(
    `SELECT day::text, count(DISTINCT visitor)::int AS visitors, count(*)::int AS views FROM site_visits WHERE day BETWEEN $1 AND $2 GROUP BY day`,
    range,
  );
  const requests = await db.query<{ day: string; n: number }>(
    `SELECT (created_at AT TIME ZONE $3)::date::text AS day, count(*)::int AS n FROM bookings
      WHERE via_website AND (created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2 GROUP BY 1`,
    [...range, timezone],
  );
  const messages = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM contact_messages WHERE (created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2`,
    [...range, timezone],
  );
  const pages = await db.query<{ path: string; visitors: number; views: number }>(
    `SELECT path, count(DISTINCT (day, visitor))::int AS visitors, count(*)::int AS views FROM site_visits
      WHERE day BETWEEN $1 AND $2 GROUP BY path ORDER BY visitors DESC, views DESC, path LIMIT 15`,
    range,
  );
  // Where a visitor came from: the first page of the day says so.
  const sources = await db.query<{ source: string; visitors: number }>(
    `SELECT source, count(*)::int AS visitors FROM (
       SELECT DISTINCT ON (day, visitor) source FROM site_visits WHERE day BETWEEN $1 AND $2 ORDER BY day, visitor, id
     ) first GROUP BY source ORDER BY visitors DESC, source LIMIT 12`,
    range,
  );
  const devices = await db.query<{ device: string; visitors: number }>(
    `SELECT device, count(DISTINCT (day, visitor))::int AS visitors FROM site_visits WHERE day BETWEEN $1 AND $2 GROUP BY device ORDER BY visitors DESC`,
    range,
  );
  const visits = new Map(perDay.rows.map((r) => [r.day, r]));
  const asked = new Map(requests.rows.map((r) => [r.day, r.n]));
  const days: VisitStats['days'] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push({ day, visitors: visits.get(day)?.visitors ?? 0, views: visits.get(day)?.views ?? 0, requests: asked.get(day) ?? 0 });
  }
  return {
    from,
    to,
    visitors: days.reduce((n, d) => n + d.visitors, 0),
    views: days.reduce((n, d) => n + d.views, 0),
    requests: days.reduce((n, d) => n + d.requests, 0),
    messages: messages.rows[0]!.n,
    days,
    pages: pages.rows,
    sources: sources.rows,
    devices: devices.rows,
  };
}
