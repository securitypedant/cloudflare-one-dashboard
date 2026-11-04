import type { Pop } from "../shared/types.ts";
import { EXTRA_COLOS } from "./data/extraColos.ts";

// Same source as sasecloudmap-data/provider_data/cloudflare_geojson.py
const LOCATIONS_URL = "https://speed.cloudflare.com/locations";

interface SpeedLocation {
	iata: string;
	lat: number;
	lon: number;
	cca2?: string;
	region?: string;
	city?: string;
}

export async function fetchPops(): Promise<Pop[]> {
	const res = await fetch(LOCATIONS_URL, {
		headers: { referer: "https://speed.cloudflare.com/" },
		cf: { cacheTtl: 86400, cacheEverything: true },
	});
	if (!res.ok) {
		throw new Error(`Cloudflare locations endpoint returned HTTP ${res.status}`);
	}
	const locations = (await res.json()) as SpeedLocation[];
	const byIata = new Map<string, Pop>();
	for (const loc of locations) {
		if (!loc.iata || byIata.has(loc.iata)) continue;
		byIata.set(loc.iata, {
			iata: loc.iata,
			city: loc.city?.trim() || loc.iata,
			country: loc.cca2 ?? "",
			region: loc.region ?? "",
			lat: loc.lat,
			lon: loc.lon,
		});
	}
	// Data centers missing from the speed test list (e.g. MEX), placed at their airport.
	for (const c of EXTRA_COLOS) {
		if (!byIata.has(c.iata)) byIata.set(c.iata, { ...c, region: "" });
	}
	return [...byIata.values()];
}
