import { describe, expect, it } from "vitest";
import { buildAvgSeries, buildSeries, seriesChange } from "./series.ts";

const rows = [
	{ t: "2026-11-01", k: "LHR", v: 10, w: 1 },
	{ t: "2026-11-01", k: "FRA", v: 5, w: 3 },
	{ t: "2026-11-02", k: "LHR", v: 20, w: 1 },
	{ t: "2026-11-03", k: "SJC", v: 1, w: 1 },
];

describe("buildSeries", () => {
	it("sums per bucket, keeps the top keys and adds a total", () => {
		const s = buildSeries(rows, { t: (r) => r.t, key: (r) => r.k, value: (r) => r.v, top: 2, total: true });
		expect(s.buckets).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
		expect(s.series.map((x) => x.key)).toEqual(["__total", "LHR", "FRA"]);
		expect(s.series[0].values).toEqual([15, 20, 1]);
		expect(s.series[1].values).toEqual([10, 20, 0]);
	});

	it("charts one key alone when selected, without a total", () => {
		const s = buildSeries(rows, { t: (r) => r.t, key: (r) => r.k, value: (r) => r.v, only: "FRA", total: true });
		expect(s.series.map((x) => x.key)).toEqual(["FRA"]);
		expect(buildSeries(rows, { t: (r) => r.t, key: (r) => r.k, value: (r) => r.v, only: "NOPE" }).series).toEqual([]);
	});
});

describe("buildAvgSeries", () => {
	it("weights averages and leaves empty buckets null", () => {
		const s = buildAvgSeries(rows, { t: (r) => r.t, key: (r) => r.k, value: (r) => r.v, weight: (r) => r.w, total: true });
		expect(s.series[0].values[0]).toBeCloseTo((10 * 1 + 5 * 3) / 4);
		const fra = s.series.find((x) => x.key === "FRA")!;
		expect(fra.values).toEqual([5, null, null]);
	});
});

describe("seriesChange", () => {
	it("compares the first and last values", () => {
		expect(seriesChange([10, null, 15])).toBeCloseTo(0.5);
		expect(seriesChange([null, 4])).toBeNull();
		expect(seriesChange([0, 5])).toBeNull();
	});
});
