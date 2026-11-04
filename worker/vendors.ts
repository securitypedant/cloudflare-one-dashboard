import type { Vendor } from "../shared/types.ts";

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

interface GeoJSON {
	features: { geometry: { coordinates: [number, number] }; properties?: { city?: string } }[];
}

export async function fetchVendors(): Promise<Vendor[]> {
	const results = await Promise.allSettled(
		VENDORS.map(async ({ id, name }) => {
			const res = await fetch(`https://sasecloudmap.com/api/${id}`, { cf: { cacheTtl: 86400, cacheEverything: true } });
			if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
			const geo = (await res.json()) as GeoJSON;
			const points = geo.features.map((f) => [f.geometry.coordinates[0], f.geometry.coordinates[1], f.properties?.city ?? ""] as [number, number, string]);
			return { id, name, points };
		}),
	);
	return results.flatMap((r, i) => {
		if (r.status === "fulfilled") return [r.value];
		console.error(JSON.stringify({ msg: "vendor fetch failed", vendor: VENDORS[i].id, error: String(r.reason) }));
		return [];
	});
}
