import type pg from 'pg';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { addDays, today } from '../lib/dates.js';

type Queryable = Db | pg.PoolClient;

export const SLOT_KEYS = ['ochtend', 'middag', 'avond'] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];

export interface TimeSlot {
  key: SlotKey;
  label: string;
  start: string;
  end: string;
}

export interface AvailabilitySettings {
  // How many parties can take place in the same time slot (number of setups).
  slotCapacity: number;
  // How many parties can take place on one day in total.
  dailyCapacity: number;
  // Bookings must be made at least this many days ahead...
  minLeadDays: number;
  // ...and at most this many days ahead.
  maxAdvanceDays: number;
}

export interface SlotStatus {
  key: SlotKey;
  // Open according to the weekly schedule or an exception for this date.
  open: boolean;
  booked: number;
  available: boolean;
}

export interface DayAvailability {
  date: string;
  blocked: boolean;
  reason: string;
  slots: SlotStatus[];
}

export async function getSettings(db: Queryable): Promise<AvailabilitySettings> {
  const defaults: AvailabilitySettings = { slotCapacity: 1, dailyCapacity: 2, minLeadDays: 3, maxAdvanceDays: 365 };
  const { rows } = await db.query<{ value: Partial<AvailabilitySettings> }>(
    "SELECT value FROM settings WHERE key = 'availability'",
  );
  return { ...defaults, ...rows[0]?.value };
}

export async function saveSettings(db: Queryable, settings: AvailabilitySettings): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('availability', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(settings)],
  );
}

export async function getTimeSlots(db: Queryable): Promise<TimeSlot[]> {
  const { rows } = await db.query<TimeSlot>(
    `SELECT key, label, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end"
       FROM time_slots ORDER BY sort_order`,
  );
  return rows;
}

// Weekly schedule as { 1: { ochtend: false, middag: true, ... }, ..., 7: {...} } (ISO weekdays).
export async function getWeeklySchedule(db: Queryable): Promise<Record<number, Record<SlotKey, boolean>>> {
  const { rows } = await db.query<{ weekday: number; slot: SlotKey; open: boolean }>(
    'SELECT weekday, slot, open FROM weekly_availability',
  );
  const schedule: Record<number, Record<SlotKey, boolean>> = {};
  for (let d = 1; d <= 7; d++) schedule[d] = { ochtend: false, middag: false, avond: false };
  for (const r of rows) schedule[r.weekday]![r.slot] = r.open;
  return schedule;
}

export async function bookingWindow(
  db: Queryable,
  config: Config,
  now?: Date,
): Promise<{ minDate: string; maxDate: string }> {
  const settings = await getSettings(db);
  const t = today(config.TIMEZONE, now);
  return { minDate: addDays(t, settings.minLeadDays), maxDate: addDays(t, settings.maxAdvanceDays) };
}

const isoWeekday = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

// Works out, for every date between from and to, which slots are open, booked and still available.
// Every booking except a cancelled one occupies its slot.
export async function getAvailability(
  db: Queryable,
  config: Config,
  from: string,
  to: string,
): Promise<DayAvailability[]> {
  const [settings, schedule, overrides, blocked, booked] = await Promise.all([
    getSettings(db),
    getWeeklySchedule(db),
    db.query<{ date: string; slot: SlotKey; open: boolean }>(
      'SELECT date, slot, open FROM slot_overrides WHERE date BETWEEN $1 AND $2',
      [from, to],
    ),
    db.query<{ date: string; reason: string }>('SELECT date, reason FROM blocked_dates WHERE date BETWEEN $1 AND $2', [
      from,
      to,
    ]),
    db.query<{ date: string; slot: SlotKey; count: number }>(
      `SELECT party_date AS date, time_slot AS slot, count(*)::int AS count FROM bookings
        WHERE party_date BETWEEN $1 AND $2 AND status <> 'cancelled'
        GROUP BY party_date, time_slot`,
      [from, to],
    ),
  ]);

  const overrideMap = new Map(overrides.rows.map((o) => [`${o.date}|${o.slot}`, o.open]));
  const blockedMap = new Map(blocked.rows.map((b) => [b.date, b.reason]));
  const bookedMap = new Map(booked.rows.map((b) => [`${b.date}|${b.slot}`, b.count]));

  const days: DayAvailability[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const isBlocked = blockedMap.has(date);
    const counts = SLOT_KEYS.map((key) => bookedMap.get(`${date}|${key}`) ?? 0);
    const dayTotal = counts.reduce((a, b) => a + b, 0);
    const slots = SLOT_KEYS.map((key, i): SlotStatus => {
      const open = overrideMap.get(`${date}|${key}`) ?? schedule[isoWeekday(date)]![key];
      const bookedCount = counts[i]!;
      return {
        key,
        open,
        booked: bookedCount,
        available: open && !isBlocked && bookedCount < settings.slotCapacity && dayTotal < settings.dailyCapacity,
      };
    });
    days.push({ date, blocked: isBlocked, reason: blockedMap.get(date) ?? '', slots });
  }
  return days;
}

// Dates in the range that still have at least one bookable slot, with those slots.
export async function availableSlots(
  db: Queryable,
  config: Config,
  from: string,
  to: string,
): Promise<Record<string, SlotKey[]>> {
  const result: Record<string, SlotKey[]> = {};
  for (const day of await getAvailability(db, config, from, to)) {
    const free = day.slots.filter((s) => s.available).map((s) => s.key);
    if (free.length) result[day.date] = free;
  }
  return result;
}
