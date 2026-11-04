import { describe, expect, it } from "vitest";
import { change, layerStats, topMovers } from "./stats.ts";
import type { TrafficPoint } from "../../shared/types.ts";

const pt = (key: string, value: number, country: string): TrafficPoint => ({ key, name: key, country, lat: 0, lon: 0, value });

describe("layerStats", () => {
	it("computes coverage and concentration", () => {
		const points = [pt("A", 10, "US"), pt("B", 60, "US"), pt("C", 30, "IE")];
		expect(layerStats(points, 125, 25)).toEqual({
			locations: 3,
			countries: 2,
			topShare: 0.6,
			locationsFor80: 2,
			unattributedShare: 0.2,
		});
	});

	it("handles empty layers", () => {
		expect(layerStats([], 0, 0)).toEqual({ locations: 0, countries: 0, topShare: 0, locationsFor80: 0, unattributedShare: 0 });
	});
});

describe("change", () => {
	it("computes relative change, new, and missing", () => {
		expect(change(140, 100)).toBeCloseTo(0.4);
		expect(change(5, 0)).toBe("new");
		expect(change(0, 0)).toBeNull();
		expect(change(5, undefined)).toBeNull();
	});
});

describe("topMovers", () => {
	it("ranks by absolute change and ignores tiny locations", () => {
		const cur = [pt("FRA", 1400, "DE"), pt("LHR", 900, "GB"), pt("NEW", 300, "FR"), pt("TINY", 5, "XX")];
		const prev = [pt("FRA", 1000, "DE"), pt("LHR", 1000, "GB"), pt("TINY", 1, "XX")];
		expect(topMovers(cur, prev).map((m) => [m.key, m.change])).toEqual([
			["FRA", 0.4],
			["NEW", "new"],
			["LHR", -0.1],
		]);
	});
});
