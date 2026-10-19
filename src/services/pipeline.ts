import type pg from 'pg';
import type { Db } from '../db/pool.js';

// The stages a booking moves through, in order. 'cancelled' can be reached from any stage.
export const STAGES = [
  'new',
  'contacted',
  'confirmed',
  'deposit_paid',
  'scheduled',
  'party_held',
  'completed',
] as const;

export const STATUSES = [...STAGES, 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

export interface StageInfo {
  label: string;
  // Shown to the parent on the status page.
  customerLabel: string;
  customerText: string;
  // Checklist created for every new booking.
  tasks: string[];
}

export const STAGE_INFO: Record<Status, StageInfo> = {
  new: {
    label: 'Nieuw',
    customerLabel: 'Aanvraag ontvangen',
    customerText: 'We hebben je aanvraag ontvangen. Binnen 24 uur laten we weten of jouw datum nog vrij is.',
    tasks: ['Aanvraag bekeken', 'Binnen 24 uur gereageerd'],
  },
  contacted: {
    label: 'Contact opgenomen',
    customerLabel: 'In overleg',
    customerText: 'We hebben contact met je opgenomen om de details door te nemen.',
    tasks: [
      'Reiskosten berekend (€0,50 per km retour vanaf Eindhoven, max. €100)',
      'Avondtoeslag nodig? (€50 bij eindtijd na 19:30)',
      'Ruimte besproken: grote tafel en stopcontacten',
    ],
  },
  confirmed: {
    label: 'Bevestigd',
    customerLabel: 'Bevestigd',
    customerText:
      'Je datum is vrij! Na ontvangst van de aanbetaling (binnen 5 dagen) staat je feest definitief vast.',
    tasks: ['Bevestiging en aanbetalingsverzoek (€100) verstuurd', 'Aanbetaling binnen 5 dagen? Anders vervalt de reservering'],
  },
  deposit_paid: {
    label: 'Aanbetaling ontvangen',
    customerLabel: 'Aanbetaling ontvangen',
    customerText: 'Bedankt voor je aanbetaling. Je feest staat definitief in onze agenda.',
    tasks: ['Aanbetaling ontvangen en gecontroleerd'],
  },
  scheduled: {
    label: 'Ingepland',
    customerLabel: 'Voorbereiding',
    customerText: 'We bereiden je feest voor: games klaarzetten, alles updaten en de route plannen.',
    tasks: [
      'Starttijd en gewenste games/thema afgestemd',
      'Alle games geüpdatet (uiterlijk 48 uur vooraf)',
      'Bus ingeladen: gamestations, extra stations en netwerk',
      'Ultimate: neonverlichting, prijzen en toernooischema mee',
    ],
  },
  party_held: {
    label: 'Feest geweest',
    customerLabel: 'Feest gegeven',
    customerText: 'Het feest is geweest. We hopen dat jullie een geweldige dag hebben gehad!',
    tasks: [
      'Opgebouwd (60 minuten vooraf)',
      'Standaard: borg (€100) ontvangen',
      'Afgebouwd en apparatuur compleet retour',
    ],
  },
  completed: {
    label: 'Afgerond',
    customerLabel: 'Afgerond',
    customerText: 'Alles is afgerond. Bedankt dat je voor Gamer Xperience hebt gekozen!',
    tasks: [
      'Restbedrag ontvangen (overboeking of contant)',
      'Standaard: borg terugbetaald',
      'Bedankmail en Google-reviewverzoek verstuurd',
    ],
  },
  cancelled: {
    label: 'Geannuleerd',
    customerLabel: 'Geannuleerd',
    customerText: 'Deze boeking is geannuleerd. Neem contact met ons op als je een nieuwe datum wilt plannen.',
    tasks: [],
  },
};

export function stageIndex(status: Status): number {
  return STAGES.indexOf(status as (typeof STAGES)[number]);
}

type Queryable = Db | pg.PoolClient;

export async function createDefaultTasks(db: Queryable, bookingId: string): Promise<void> {
  const rows = STAGES.flatMap((stage) => STAGE_INFO[stage].tasks.map((label) => ({ stage, label })));
  await db.query(
    `INSERT INTO booking_tasks (booking_id, stage, label, sort_order)
     SELECT $1, t.stage, t.label, t.ord FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(stage, label, ord)`,
    [bookingId, rows.map((r) => r.stage), rows.map((r) => r.label)],
  );
}

export async function addEvent(
  db: Queryable,
  bookingId: string,
  event: { type: string; message?: string; fromStatus?: string; toStatus?: string; actor?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO booking_events (booking_id, type, from_status, to_status, message, actor)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [bookingId, event.type, event.fromStatus ?? null, event.toStatus ?? null, event.message ?? '', event.actor ?? 'system'],
  );
}
