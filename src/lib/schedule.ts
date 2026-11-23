// The whole day around a party: leaving, building up, the party, breaking down and being home again.

export interface DaySchedule {
  leave: string;
  setupStart: string;
  start: string;
  end: string;
  teardownEnd: string;
  home: string;
  // False when the driving time isn't known yet: leave and home then ignore the drive.
  travelKnown: boolean;
  // True when the start is the slot's start time because no exact start time is set yet.
  startAssumed: boolean;
}

const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const toTime = (minutes: number) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// A rough driving time when the route planner didn't give one.
export const estimateTravelMinutes = (km: number) => Math.round(km * 0.65 + 10);

export function daySchedule(
  party: { startTime: string | null; slotStart: string; durationHours: number; travelMinutes: number | null },
  setup: { setupMinutes: number; teardownMinutes: number },
): DaySchedule {
  const start = toMinutes(party.startTime ?? party.slotStart);
  const end = start + party.durationHours * 60;
  const travel = party.travelMinutes ?? 0;
  return {
    leave: toTime(start - setup.setupMinutes - travel),
    setupStart: toTime(start - setup.setupMinutes),
    start: toTime(start),
    end: toTime(end),
    teardownEnd: toTime(end + setup.teardownMinutes),
    home: toTime(end + setup.teardownMinutes + travel),
    travelKnown: party.travelMinutes !== null,
    startAssumed: party.startTime === null,
  };
}
