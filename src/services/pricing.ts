import type { Config } from '../config.js';

export interface PriceExtra {
  label: string;
  // Negative for a discount.
  amountCents: number;
}

export interface PriceInput {
  packageName: string;
  packagePriceCents: number;
  extraStations: number;
  // One-way driving distance; null when not known yet.
  travelKm: number | null;
  eveningSurcharge: boolean;
  extras: PriceExtra[];
}

export interface PriceLine {
  key: string;
  label: string;
  amountCents: number;
}

export function travelCents(km: number, config: Config): number {
  return Math.min(Math.round(km * 2 * config.TRAVEL_CENTS_PER_KM), config.TRAVEL_MAX_CENTS);
}

// Package + extra stations + travel costs + evening surcharge + custom extras.
export function calculatePrice(input: PriceInput, config: Config): { lines: PriceLine[]; totalCents: number } {
  const lines: PriceLine[] = [{ key: 'package', label: input.packageName, amountCents: input.packagePriceCents }];
  if (input.extraStations > 0) {
    lines.push({
      key: 'extra_stations',
      label: `${input.extraStations} extra gamestation${input.extraStations > 1 ? 's' : ''}`,
      amountCents: input.extraStations * config.EXTRA_STATION_CENTS,
    });
  }
  if (input.travelKm !== null) {
    const km = Number(input.travelKm);
    const cents = travelCents(km, config);
    const capped = cents === config.TRAVEL_MAX_CENTS && km * 2 * config.TRAVEL_CENTS_PER_KM > cents;
    lines.push({
      key: 'travel',
      label: `Reiskosten (${km.toLocaleString('nl-NL')} km enkele reis, ${(km * 2).toLocaleString('nl-NL')} km retour${capped ? ', maximum' : ''})`,
      amountCents: cents,
    });
  } else {
    lines.push({ key: 'travel', label: 'Reiskosten (afstand nog niet bekend)', amountCents: 0 });
  }
  if (input.eveningSurcharge) {
    lines.push({ key: 'evening', label: 'Avondtoeslag (eindtijd na 19:30)', amountCents: config.EVENING_SURCHARGE_CENTS });
  }
  input.extras.forEach((e, i) => lines.push({ key: `extra_${i}`, label: e.label, amountCents: e.amountCents }));
  return { lines, totalCents: Math.max(0, lines.reduce((sum, l) => sum + l.amountCents, 0)) };
}
