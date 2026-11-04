import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import countries110m from "world-atlas/countries-110m.json";
import { ISO_NUMERIC_TO_ALPHA2, NAME_TO_ALPHA2 } from "./isoNumeric.ts";

const ANTARCTICA_ID = "010";

/**
 * world-atlas is built for spherical renderers: rings crossing the antimeridian (Russia, Fiji) jump
 * from +180 to -180, which a planar map draws as bands across the whole world. Shift longitudes by
 * ±360 so consecutive points never jump more than 180°.
 */
export function unwrapRing(ring: Position[]): Position[] {
	const out: Position[] = [];
	for (const [lon, lat] of ring) {
		let x = lon;
		const prev = out.at(-1)?.[0];
		if (prev !== undefined) {
			while (x - prev > 180) x -= 360;
			while (x - prev < -180) x += 360;
		}
		out.push([x, lat]);
	}
	return out;
}

type CountryFeature = Feature<Polygon | MultiPolygon, { name: string; iso2: string }>;

const topology = countries110m as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
const raw = feature(topology, topology.objects.countries);

/** Country polygons (no Antarctica), antimeridian-safe, with ISO alpha-2 codes as `iso2`. */
export const countriesGeo = {
	type: "FeatureCollection" as const,
	features: raw.features
		.filter((f) => f.id !== ANTARCTICA_ID)
		.flatMap((f): CountryFeature[] => {
			const iso2 = ISO_NUMERIC_TO_ALPHA2[String(f.id)] ?? NAME_TO_ALPHA2[f.properties.name] ?? "";
			const g = f.geometry;
			if (g.type === "Polygon") {
				return [{ ...f, geometry: { ...g, coordinates: g.coordinates.map(unwrapRing) }, properties: { ...f.properties, iso2 } }];
			}
			if (g.type === "MultiPolygon") {
				return [{ ...f, geometry: { ...g, coordinates: g.coordinates.map((p) => p.map(unwrapRing)) }, properties: { ...f.properties, iso2 } }];
			}
			return [];
		}),
};

/** Countries with a polygon on the map; others (e.g. Singapore at this resolution) fall back to a circle. */
export const MAPPED_COUNTRIES = new Set(countriesGeo.features.map((f) => f.properties.iso2).filter(Boolean));

function inRing(lon: number, lat: number, ring: Position[]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

const inPolygon = (lon: number, lat: number, rings: Position[][]) =>
	inRing(lon, lat, rings[0]) && !rings.slice(1).some((hole) => inRing(lon, lat, hole));

/** ISO alpha-2 of the country containing a point (110m resolution; small islands may be missed). */
export function countryAt(lon: number, lat: number): string | null {
	for (const f of countriesGeo.features) {
		const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
		for (const rings of polys) {
			if (inPolygon(lon, lat, rings) || inPolygon(lon + 360, lat, rings)) return f.properties.iso2 || null;
		}
	}
	return null;
}

export { distanceKm } from "../../shared/geo.ts";

const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle arc as a polyline (longitudes unwrapped so it never jumps across the map). */
export function arc(from: [number, number], to: [number, number], segments = 32): Position[] {
	const [l1, p1, l2, p2] = [from[0], from[1], to[0], to[1]].map(toRad);
	const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
	if (d < 1e-6) return [from, to];
	const pts: Position[] = [];
	for (let i = 0; i <= segments; i++) {
		const f = i / segments;
		const a = Math.sin((1 - f) * d) / Math.sin(d);
		const b = Math.sin(f * d) / Math.sin(d);
		const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
		const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
		const z = a * Math.sin(p1) + b * Math.sin(p2);
		pts.push([(Math.atan2(y, x) * 180) / Math.PI, (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI]);
	}
	return unwrapRing(pts);
}
