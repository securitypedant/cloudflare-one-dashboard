import type { Vendor } from "../shared/types.ts";
import { cachedValue, mapLimit, readJson } from "./upstream.ts";

/** SASE vendors published by sasecloudmap.com (see ../sasecloudmap-data/provider_data). Cloudflare uses our own POP list. */
const VENDORS: { id: string; name: string }[] = [
	{ id: "zscaler", name: "Zscaler" },
	{ id: "netskope", name: "Netskope" },
	{ id: "paloalto", name: "Prisma Access (PANW)" },
	{ id: "catonetworks", name: "Cato Networks" },
	{ id: "checkpoint", name: "Check Point Harmony" },
	{ id: "fortisase", name: "Fortinet (FortiSASE)" },
	{ id: "iboss", name: "iboss" },
	{ id: "cisco", name: "Cisco Umbrella" },
	{ id: "forcepoint", name: "Forcepoint" },
];

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_POINTS = 2000;
const CONCURRENCY = 3;
const TTL_SECONDS = 86400;

/** Validate a vendor GeoJSON FeatureCollection into [lon, lat, city] points; malformed features are dropped. */
export function parseVendorPoints(geo: unknown): [number, number, string][] {
	const features = (geo as { features?: unknown })?.features;
	if (!Array.isArray(features)) throw new Error("unexpected GeoJSON");
	const points: [number, number, string][] = [];
	for (const f of features.slice(0, MAX_POINTS)) {
		const [lon, lat] = (f?.geometry?.coordinates ?? []) as unknown[];
		if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
		const city = typeof f?.properties?.city === "string" ? f.properties.city.trim().slice(0, 80) : "";
		points.push([lon, lat, city]);
	}
	return points;
}

export async function fetchVendors(ctx?: ExecutionContext): Promise<Vendor[]> {
	return cachedValue(ctx, "vendors-v1", TTL_SECONDS, async () => {
		const results = await mapLimit(VENDORS, CONCURRENCY, async ({ id, name }) => {
			const res = await fetch(`https://sasecloudmap.com/api/${id}`);
			if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
			return { id, name, points: parseVendorPoints(await readJson<unknown>(res, MAX_BYTES)) };
		});
		return results.flatMap((r, i) => {
			if (r.status === "fulfilled") return [r.value];
			console.error(JSON.stringify({ msg: "vendor fetch failed", vendor: VENDORS[i].id, error: String(r.reason) }));
			return [];
		});
	});
}
