import { COUNTRIES } from "../../shared/countries.ts";
import type { Pop, Vendor } from "../../shared/types.ts";
import { countryAt, distanceKm } from "./worldGeo.ts";

export interface Flow {
	country: string;
	pop: Pop;
	value: number;
	inCountry: boolean;
}

const UNKNOWN = new Set(["", "UNKNOWN", "XX"]);

/** Country → POP flows with both ends resolvable (known country with a centroid, known POP). */
export function buildFlows(rows: { country: string; colo: string; value: number }[], pops: Pop[]): { flows: Flow[]; unattributed: number } {
	const byIata = new Map(pops.map((p) => [p.iata, p]));
	const flows: Flow[] = [];
	let unattributed = 0;
	for (const { country, colo, value } of rows) {
		const pop = byIata.get(colo.toUpperCase());
		const cc = country.toUpperCase();
		if (!pop || UNKNOWN.has(cc) || !COUNTRIES[cc]) {
			unattributed += value;
			continue;
		}
		flows.push({ country: cc, pop, value, inCountry: pop.country === cc });
	}
	return { flows: flows.sort((a, b) => b.value - a.value), unattributed };
}

export interface CountryCoverage {
	country: string;
	name: string;
	total: number;
	inCountryShare: number;
	pops: { iata: string; city: string; country: string; value: number; distanceKm: number }[];
}

/** Per user country: which POPs served it, how much stayed in-country, and how far the others are from the country centre. */
export function countryCoverage(flows: Flow[]): CountryCoverage[] {
	const by = new Map<string, CountryCoverage>();
	for (const f of flows) {
		const c = COUNTRIES[f.country];
		const row = by.get(f.country) ?? { country: f.country, name: c.name, total: 0, inCountryShare: 0, pops: [] };
		row.total += f.value;
		if (f.inCountry) row.inCountryShare += f.value;
		row.pops.push({ iata: f.pop.iata, city: f.pop.city, country: f.pop.country, value: f.value, distanceKm: distanceKm(c.lon, c.lat, f.pop.lon, f.pop.lat) });
		by.set(f.country, row);
	}
	return [...by.values()]
		.map((r) => ({ ...r, inCountryShare: r.total ? r.inCountryShare / r.total : 0, pops: r.pops.sort((a, b) => b.value - a.value) }))
		.sort((a, b) => b.total - a.total);
}

export interface VendorScore {
	id: string;
	name: string;
	pops: number;
	countries: number;
	/** Share of your traffic from countries where the vendor has at least one POP. */
	inCountryShare: number;
	/** Traffic-weighted distance from where your traffic enters Cloudflare today to the vendor's nearest POP. */
	avgDistanceKm: number;
	/** Share of your traffic with a vendor POP within `nearKm` of where it enters Cloudflare today. */
	nearShare: number;
}

export const NEAR_KM = 500;

/**
 * Compare vendors on your actual traffic. User location is approximated by the Cloudflare POP that
 * served the traffic (anycast lands users at a nearby POP), so Cloudflare's own distance is ~0 by
 * construction: the other vendors' numbers are the extra distance their nearest POP would add.
 */
export function scoreVendors(flows: Flow[], pops: Pop[], vendors: Vendor[]): VendorScore[] {
	const total = flows.reduce((s, f) => s + f.value, 0);
	const byCountry = new Map<string, number>();
	const byPop = new Map<string, { pop: Pop; value: number }>();
	for (const f of flows) {
		byCountry.set(f.country, (byCountry.get(f.country) ?? 0) + f.value);
		const p = byPop.get(f.pop.iata) ?? { pop: f.pop, value: 0 };
		p.value += f.value;
		byPop.set(f.pop.iata, p);
	}
	const candidates: { id: string; name: string; points: { lon: number; lat: number; country: string | null }[] }[] = [
		{ id: "cloudflare", name: "Cloudflare", points: pops.map((p) => ({ lon: p.lon, lat: p.lat, country: p.country })) },
		...vendors.map((v) => ({ id: v.id, name: v.name, points: v.points.map(([lon, lat]) => ({ lon, lat, country: countryAt(lon, lat) })) })),
	];
	return candidates
		.map(({ id, name, points }) => {
			const countries = new Set(points.map((p) => p.country).filter((c): c is string => !!c));
			let inCountry = 0;
			for (const [cc, v] of byCountry) if (countries.has(cc)) inCountry += v;
			let weighted = 0;
			let near = 0;
			for (const { pop, value } of byPop.values()) {
				const nearest = points.reduce((m, p) => Math.min(m, distanceKm(pop.lon, pop.lat, p.lon, p.lat)), Infinity);
				weighted += nearest * value;
				if (nearest <= NEAR_KM) near += value;
			}
			return {
				id,
				name,
				pops: points.length,
				countries: countries.size,
				inCountryShare: total ? inCountry / total : 0,
				avgDistanceKm: total ? weighted / total : 0,
				nearShare: total ? near / total : 0,
			};
		})
		.sort((a, b) => a.avgDistanceKm - b.avgDistanceKm || b.pops - a.pops);
}
