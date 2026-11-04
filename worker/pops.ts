import type { Pop } from "../shared/types.ts";
import { EXTRA_COLOS } from "./data/extraColos.ts";
import { cachedValue, readJson } from "./upstream.ts";

// Same source as sasecloudmap-data/provider_data/cloudflare_geojson.py
const LOCATIONS_URL = "https://speed.cloudflare.com/locations";
const MAX_BYTES = 2 * 1024 * 1024;
const TTL_SECONDS = 86400;

interface SpeedLocation {
	iata?: unknown;
	lat?: unknown;
	lon?: unknown;
	cca2?: unknown;
	region?: unknown;
	city?: unknown;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const coord = (v: unknown, limit: number) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit ? v : null);

/** Validate and normalize the speed test location list; malformed entries are dropped. */
export function parseLocations(locations: unknown): Pop[] {
	if (!Array.isArray(locations)) throw new Error("Cloudflare locations endpoint returned unexpected data");
	const byIata = new Map<string, Pop>();
	for (const loc of locations as SpeedLocation[]) {
		const iata = str(loc?.iata, 3).toUpperCase();
		const lat = coord(loc?.lat, 90);
		const lon = coord(loc?.lon, 180);
		if (!/^[A-Z]{3}$/.test(iata) || lat === null || lon === null || byIata.has(iata)) continue;
		byIata.set(iata, { iata, city: str(loc.city, 80) || iata, country: str(loc.cca2, 2).toUpperCase(), region: str(loc.region, 40), lat, lon });
	}
	// Data centers missing from the speed test list (e.g. MEX), placed at their airport.
	for (const c of EXTRA_COLOS) {
		if (!byIata.has(c.iata)) byIata.set(c.iata, { ...c, region: "" });
	}
	return [...byIata.values()];
}

export async function fetchPops(ctx?: ExecutionContext): Promise<Pop[]> {
	return cachedValue(ctx, "pops-v1", TTL_SECONDS, async () => {
		const res = await fetch(LOCATIONS_URL, { headers: { referer: "https://speed.cloudflare.com/" } });
		if (!res.ok) throw new Error(`Cloudflare locations endpoint returned HTTP ${res.status}`);
		return parseLocations(await readJson<unknown>(res, MAX_BYTES));
	});
}
