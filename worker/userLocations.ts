import { distanceKm } from "../shared/geo.ts";
import type { Pop, RangeId, UserLocationRow, UserLocationsResponse } from "../shared/types.ts";
import { geocodeCity } from "./geocode.ts";
import { queryUserLocations, queryUserLocationSeries } from "./logpush.ts";
import { RANGE_ROLLUP, resolveRange } from "./traffic.ts";

/**
 * Where WARP users actually are (Cloudflare's geolocation of their ISP IP, from DEX device state
 * events) and which data center they connect to, with distances to that POP and to the nearest POP.
 */
export async function fetchUserLocations(db: D1Database, rangeId: RangeId, pops: Pop[], series = false): Promise<UserLocationsResponse> {
	const { start, end } = resolveRange(rangeId);
	const range = { id: rangeId, start: start.toISOString(), end: end.toISOString() };
	const bucket = RANGE_ROLLUP[rangeId] === "1d" ? ("day" as const) : ("hour" as const);
	const s = Math.floor(start.getTime() / 1000);
	const e = Math.floor(end.getTime() / 1000);
	const raw: { bucket?: number; country: string; state: string; city: string; isp?: string; colo: string; samples: number; lat_n: number; lat_total: number }[] = series
		? await queryUserLocationSeries(db, s, e, bucket === "day" ? 86400 : 3600)
		: await queryUserLocations(db, s, e);
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
			...(r.bucket !== undefined ? { t: new Date(r.bucket * 1000).toISOString() } : {}),
			country: r.country,
			state: r.state,
			city: r.city,
			isp: r.isp ?? "",
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
	return { available: true, range, rows: rows.sort((a, b) => b.samples - a.samples), ...(series ? { bucket } : {}) };
}
