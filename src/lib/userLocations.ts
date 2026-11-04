import type { Pop, UserLocationRow, Vendor } from "../../shared/types.ts";
import { countryAt, distanceKm } from "./worldGeo.ts";

/** A user connecting further than this beyond their nearest POP is flagged as "served from far away". */
export const FAR_EXTRA_KM = 300;

export interface CityColo {
	colo: string;
	samples: number;
	distanceKm: number | null;
	handshakeAvgMs: number | null;
}

export interface CitySummary {
	key: string;
	city: string;
	state: string;
	country: string;
	lat: number;
	lon: number;
	samples: number;
	isps: string[];
	colos: CityColo[];
	nearestIata: string | null;
	nearestDistanceKm: number | null;
	/** Samples connected to a POP more than FAR_EXTRA_KM further than the nearest one. */
	farSamples: number;
}

export const isFar = (r: Pick<UserLocationRow, "coloDistanceKm" | "nearestDistanceKm">) =>
	r.coloDistanceKm !== null && r.nearestDistanceKm !== null && r.coloDistanceKm - r.nearestDistanceKm > FAR_EXTRA_KM;

/** Group located rows by city (merging ISPs), with per-POP breakdowns. */
export function summarizeCities(rows: UserLocationRow[]): CitySummary[] {
	const cities = new Map<string, CitySummary>();
	for (const r of rows) {
		if (r.lat === null || r.lon === null) continue;
		const key = `${r.country}|${r.state}|${r.city}`;
		const c = cities.get(key) ?? {
			key,
			city: r.city,
			state: r.state,
			country: r.country,
			lat: r.lat,
			lon: r.lon,
			samples: 0,
			isps: [],
			colos: [],
			nearestIata: r.nearestIata,
			nearestDistanceKm: r.nearestDistanceKm,
			farSamples: 0,
		};
		c.samples += r.samples;
		if (r.isp && !c.isps.includes(r.isp)) c.isps.push(r.isp);
		if (isFar(r)) c.farSamples += r.samples;
		const colo = c.colos.find((x) => x.colo === r.colo);
		if (colo) {
			const hs = [colo.handshakeAvgMs, r.handshakeAvgMs];
			colo.handshakeAvgMs =
				hs[0] !== null && hs[1] !== null ? (hs[0] * colo.samples + hs[1] * r.samples) / (colo.samples + r.samples) : (hs[0] ?? hs[1]);
			colo.samples += r.samples;
		} else {
			c.colos.push({ colo: r.colo, samples: r.samples, distanceKm: r.coloDistanceKm, handshakeAvgMs: r.handshakeAvgMs });
		}
		cities.set(key, c);
	}
	for (const c of cities.values()) c.colos.sort((a, b) => b.samples - a.samples);
	return [...cities.values()].sort((a, b) => b.samples - a.samples);
}

export interface IspSummary {
	isp: string;
	samples: number;
	cities: number;
	avgDistanceKm: number;
	farShare: number;
	handshakeAvgMs: number | null;
}

export function summarizeIsps(rows: UserLocationRow[]): IspSummary[] {
	const by = new Map<string, { samples: number; cities: Set<string>; dist: number; distN: number; far: number; hs: number; hsN: number }>();
	for (const r of rows) {
		const isp = r.isp || "Unknown ISP";
		const s = by.get(isp) ?? { samples: 0, cities: new Set<string>(), dist: 0, distN: 0, far: 0, hs: 0, hsN: 0 };
		s.samples += r.samples;
		s.cities.add(`${r.country}|${r.city}`);
		if (r.coloDistanceKm !== null) {
			s.dist += r.coloDistanceKm * r.samples;
			s.distN += r.samples;
		}
		if (isFar(r)) s.far += r.samples;
		if (r.handshakeAvgMs !== null) {
			s.hs += r.handshakeAvgMs * r.samples;
			s.hsN += r.samples;
		}
		by.set(isp, s);
	}
	return [...by]
		.map(([isp, s]) => ({
			isp,
			samples: s.samples,
			cities: s.cities.size,
			avgDistanceKm: s.distN ? s.dist / s.distN : 0,
			farShare: s.samples ? s.far / s.samples : 0,
			handshakeAvgMs: s.hsN ? s.hs / s.hsN : null,
		}))
		.sort((a, b) => b.samples - a.samples);
}

/** Sample-weighted median of a per-row value (e.g. distance to the POP used). */
export function weightedMedian(items: { value: number; weight: number }[]): number | null {
	const sorted = items.filter((i) => i.weight > 0).sort((a, b) => a.value - b.value);
	const total = sorted.reduce((s, i) => s + i.weight, 0);
	let run = 0;
	for (const i of sorted) {
		run += i.weight;
		if (run >= total / 2) return i.value;
	}
	return null;
}

export interface VendorDistance {
	id: string;
	name: string;
	pops: number;
	/** Sample-weighted average distance from user cities to the vendor's nearest POP. */
	avgDistanceKm: number;
	/** Share of samples with a vendor POP within `nearKm`. */
	nearShare: number;
	/** Share of samples from countries where the vendor has a POP. */
	inCountryShare: number;
}

/** Compare vendors by distance from where users actually are (city) to each vendor's nearest POP. */
export function vendorDistances(cities: CitySummary[], pops: Pop[], vendors: Vendor[], nearKm = 300): VendorDistance[] {
	const total = cities.reduce((s, c) => s + c.samples, 0);
	const candidates = [
		{ id: "cloudflare", name: "Cloudflare", points: pops.map((p) => ({ lon: p.lon, lat: p.lat, country: p.country as string | null })) },
		...vendors.map((v) => ({ id: v.id, name: v.name, points: v.points.map(([lon, lat]) => ({ lon, lat, country: countryAt(lon, lat) })) })),
	];
	return candidates
		.map(({ id, name, points }) => {
			const countries = new Set(points.map((p) => p.country).filter(Boolean));
			let weighted = 0;
			let near = 0;
			let inCountry = 0;
			for (const c of cities) {
				const d = points.reduce((m, p) => Math.min(m, distanceKm(c.lon, c.lat, p.lon, p.lat)), Infinity);
				weighted += d * c.samples;
				if (d <= nearKm) near += c.samples;
				if (countries.has(c.country)) inCountry += c.samples;
			}
			return {
				id,
				name,
				pops: points.length,
				avgDistanceKm: total ? weighted / total : 0,
				nearShare: total ? near / total : 0,
				inCountryShare: total ? inCountry / total : 0,
			};
		})
		.sort((a, b) => a.avgDistanceKm - b.avgDistanceKm);
}
