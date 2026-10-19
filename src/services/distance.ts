import type { Config } from '../config.js';

export interface DistanceService {
  // One-way driving distance in km from the base location, or null when the address can't be found.
  drivingKm(postalCode: string, city: string): Promise<number | null>;
}

type Point = { lon: number; lat: number };

const TIMEOUT_MS = 6000;

function haversineKm(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function createDistanceService(config: Config, log: (msg: string, err?: unknown) => void): DistanceService {
  const cache = new Map<string, Point | null>();

  // Looks up a Dutch address or postcode with PDOK Locatieserver.
  async function geocode(query: string): Promise<Point | null> {
    const key = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (cache.has(key)) return cache.get(key)!;
    const url = new URL(config.GEOCODER_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('rows', '1');
    url.searchParams.set('fl', 'centroide_ll');
    url.searchParams.set('fq', 'type:(postcode OR adres OR woonplaats)');
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Geocoder answered ${res.status}`);
    const body = (await res.json()) as { response?: { docs?: { centroide_ll?: string }[] } };
    const match = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(body.response?.docs?.[0]?.centroide_ll ?? '');
    const point = match ? { lon: Number(match[1]), lat: Number(match[2]) } : null;
    cache.set(key, point);
    return point;
  }

  async function routeKm(from: Point, to: Point): Promise<number> {
    const url = `${config.ROUTING_URL}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Router answered ${res.status}`);
    const body = (await res.json()) as { routes?: { distance: number }[] };
    const meters = body.routes?.[0]?.distance;
    if (meters === undefined) throw new Error('No route found');
    return meters / 1000;
  }

  return {
    async drivingKm(postalCode, city) {
      try {
        const [base, target] = await Promise.all([geocode(config.BASE_LOCATION), geocode(`${postalCode} ${city}`)]);
        if (!base || !target) return null;
        let km: number;
        try {
          km = await routeKm(base, target);
        } catch (err) {
          // Routing service unavailable: estimate from the straight-line distance.
          log('Routing failed, estimating distance', err);
          km = haversineKm(base, target) * 1.3;
        }
        return Math.round(km * 10) / 10;
      } catch (err) {
        log('Distance lookup failed', err);
        return null;
      }
    },
  };
}
