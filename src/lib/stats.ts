import type { Pop, TrafficPoint } from "../../shared/types.ts";

export interface LayerStats {
	/** Number of locations (POPs or countries) with traffic. */
	locations: number;
	/** Distinct countries those locations are in. */
	countries: number;
	/** Share of mapped traffic handled by the busiest location. */
	topShare: number;
	/** Smallest number of locations that together carry at least 80% of mapped traffic. */
	locationsFor80: number;
	/** Share of all traffic with no usable location. */
	unattributedShare: number;
}

export function layerStats(points: TrafficPoint[], total: number, unattributed: number): LayerStats {
	const sorted = [...points].sort((a, b) => b.value - a.value);
	const mapped = sorted.reduce((sum, p) => sum + p.value, 0);

	let locationsFor80 = 0;
	for (let running = 0; running < mapped * 0.8 && locationsFor80 < sorted.length; locationsFor80++) {
		running += sorted[locationsFor80].value;
	}

	return {
		locations: sorted.length,
		countries: new Set(sorted.map((p) => p.country).filter(Boolean)).size,
		topShare: mapped ? sorted[0].value / mapped : 0,
		locationsFor80,
		unattributedShare: total ? unattributed / total : 0,
	};
}

/** Relative change vs the previous period: a fraction, "new" when there was nothing before, or null. */
export function change(current: number, previous: number | undefined): number | "new" | null {
	if (previous === undefined) return null;
	if (previous === 0) return current > 0 ? "new" : null;
	return (current - previous) / previous;
}

export interface Mover {
	key: string;
	name: string;
	current: number;
	previous: number;
	change: number | "new";
}

/**
 * Locations whose traffic moved most vs the previous period, by absolute change. Ignores locations
 * below `minShare` of the larger period's total so tiny locations don't dominate with big percentages.
 */
export function topMovers(current: TrafficPoint[], previous: TrafficPoint[], limit = 3, minShare = 0.02): Mover[] {
	const prev = new Map(previous.map((p) => [p.key, p]));
	const cur = new Map(current.map((p) => [p.key, p]));
	const total = Math.max(
		current.reduce((s, p) => s + p.value, 0),
		previous.reduce((s, p) => s + p.value, 0),
	);
	const keys = new Set([...cur.keys(), ...prev.keys()]);
	const movers: Mover[] = [];
	for (const key of keys) {
		const c = cur.get(key)?.value ?? 0;
		const p = prev.get(key)?.value ?? 0;
		const ch = change(c, p);
		if (ch === null || ch === 0 || Math.max(c, p) < total * minShare) continue;
		movers.push({ key, name: cur.get(key)?.name ?? prev.get(key)!.name, current: c, previous: p, change: ch });
	}
	return movers.sort((a, b) => Math.abs(b.current - b.previous) - Math.abs(a.current - a.previous)).slice(0, limit);
}

export function popNetworkStats(pops: Pop[]) {
	return { pops: pops.length, countries: new Set(pops.map((p) => p.country).filter(Boolean)).size };
}
