import { CITIES_TSV } from "./data/cities.ts";

interface City {
	admin1: string;
	lat: number;
	lon: number;
	population: number;
}

/** "São Paulo" / "Sao Paulo" / "SAO-PAULO" → "sao paulo" */
export const normalizeCity = (s: string) =>
	s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

let index: Map<string, City[]> | undefined;

function getIndex(): Map<string, City[]> {
	if (index) return index;
	index = new Map();
	for (const line of CITIES_TSV.split("\n")) {
		const [cc, admin1, name, lat, lon, pop] = line.split("|");
		const key = `${cc}|${normalizeCity(name)}`;
		const list = index.get(key) ?? [];
		list.push({ admin1, lat: Number(lat), lon: Number(lon), population: Number(pop) });
		index.set(key, list);
	}
	return index;
}

/**
 * Coordinates for a city reported by Cloudflare's IP geolocation (English name, ISO country and
 * state codes). Disambiguates same-named cities by state when it matches the GeoNames admin1 code
 * (e.g. US states), otherwise picks the most populous. Null if the city isn't in cities15000.
 */
export function geocodeCity(country: string, state: string, city: string): { lat: number; lon: number } | null {
	if (!country || !city) return null;
	const candidates = getIndex().get(`${country.toUpperCase()}|${normalizeCity(city)}`);
	if (!candidates?.length) return null;
	const inState = state ? candidates.filter((c) => c.admin1.toUpperCase() === state.toUpperCase()) : [];
	const pool = inState.length ? inState : candidates;
	const best = pool.reduce((a, b) => (b.population > a.population ? b : a));
	return { lat: best.lat, lon: best.lon };
}
