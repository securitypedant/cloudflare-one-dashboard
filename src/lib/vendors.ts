import type { Vendor } from "../../shared/types.ts";
import type { MapMarker } from "../components/TrafficMap.tsx";

/** Distinct from Cloudflare orange and the traffic colours; vendors are also drawn as diamonds. */
export const VENDOR_PALETTE = ["#f8fafc", "#e879f9", "#fde047", "#93c5fd", "#86efac", "#fca5a5"];

/** Colour per selected vendor, stable in selection order. */
export const vendorColor = (selected: string[], id: string) => VENDOR_PALETTE[Math.max(0, selected.indexOf(id)) % VENDOR_PALETTE.length];

export function vendorMarkers(vendors: Vendor[] | undefined, selected: string[]): MapMarker[] {
	return (vendors ?? [])
		.filter((v) => selected.includes(v.id))
		.flatMap((v) => v.points.map(([lon, lat, city]) => ({ lon, lat, color: vendorColor(selected, v.id), label: `${v.name}: ${city}`, shape: "diamond" as const })));
}
