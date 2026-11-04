import { distanceKm } from "../shared/geo.ts";
import type { Pop, RangeId, UserLocationRow, UserLocationsResponse } from "../shared/types.ts";
import { geocodeCity } from "./geocode.ts";
import { queryUserLocations } from "./logpush.ts";
import { resolveRange } from "./traffic.ts";

/**
 * Where WARP users actually are (Cloudflare's geolocation of their ISP IP, from DEX device state
 * events) and which data center they connect to, with distances to that POP and to the nearest POP.
 */
export async function fetchUserLocations(db: D1Database, rangeId: RangeId, pops: Pop[]): Promise<UserLocationsResponse> {
	const { start, end } = resolveRange(rangeId);
	const range = { id: rangeId, start: start.toISOString(), end: end.toISOString() };
	const raw = await queryUserLocations(db, Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000));
	if (!raw.length) {
		const { results } = await db.prepare("SELECT COUNT(*) AS n FROM user_location_hourly").all<{ n: number }>();
		return { available: (results[0]?.n ?? 0) > 0, range, rows: [] };
	}

	const byIata = new Map(pops.map((p) => [p.iata, p]));
	const nearestCache = new Map<string, { iata: string; km: number } | null>();
	const nearest = (lat: number, lon: number) => {
		const k = `${lat},${lon}`;
		if (!nearestCache.has(k)) {
			let best: { iata: string; km: number } | null = null;
			for (const p of pops) {
				const km = distanceKm(lon, lat, p.lon, p.lat);
				if (!best || km < best.km) best = { iata: p.iata, km };
			}
			nearestCache.set(k, best);
		}
		return nearestCache.get(k)!;
	};

	const rows: UserLocationRow[] = raw.map((r) => {
		const loc = geocodeCity(r.country, r.state, r.city);
		const pop = byIata.get(r.colo);
		const near = loc ? nearest(loc.lat, loc.lon) : null;
		return {
			country: r.country,
			state: r.state,
			city: r.city,
			isp: r.isp,
			colo: r.colo,
			samples: r.samples,
			handshakeAvgMs: r.lat_n ? r.lat_total / r.lat_n : null,
			lat: loc?.lat ?? null,
			lon: loc?.lon ?? null,
			coloDistanceKm: loc && pop ? distanceKm(loc.lon, loc.lat, pop.lon, pop.lat) : null,
			nearestIata: near?.iata ?? null,
			nearestDistanceKm: near?.km ?? null,
		};
	});
	return { available: true, range, rows: rows.sort((a, b) => b.samples - a.samples) };
}
