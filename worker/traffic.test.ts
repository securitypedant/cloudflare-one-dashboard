import { describe, expect, it } from "vitest";
import { aggregateRows, bucketStart, buildLayerQuery, fetchSplittingWindow, LAYER_QUERIES, resolveRange, toLayer, type LayerQuery } from "./traffic.ts";
import type { Pop } from "../shared/types.ts";

const pops: Pop[] = [
	{ iata: "SJC", city: "San Jose", country: "US", region: "North America", lat: 37.36, lon: -121.93 },
	{ iata: "DUB", city: "Dublin", country: "IE", region: "Europe", lat: 53.42, lon: -6.27 },
];
const popsByIata = new Map(pops.map((p) => [p.iata, p]));

const dnsPop: LayerQuery = { node: (r) => `cf1GatewayDns${r}Groups`, dimension: "coloName", metric: { sum: "queries" } };

describe("buildLayerQuery", () => {
	it("uses the rollup-specific node, sum ordering and dimension", () => {
		const q = buildLayerQuery(dnsPop, "1h");
		expect(q).toContain("groups: cf1GatewayDns1hGroups(");
		expect(q).toContain("orderBy: [sum_queries_DESC]");
		expect(q).toContain("sum { queries }");
		expect(q).toContain("dimensions { coloName }");
	});

	it("uses count for adaptive datasets", () => {
		const http = LAYER_QUERIES.http.pop!;
		const q = buildLayerQuery(http, "1d");
		expect(q).toContain("groups: gatewayL7RequestsAdaptiveGroups(");
		expect(q).toContain("orderBy: [count_DESC]");
		expect(q).toMatch(/\n\s+count\n/);
	});
});

describe("aggregateRows", () => {
	it("sums duplicate keys case-insensitively and treats null as empty", () => {
		const totals = aggregateRows(dnsPop, [
			{ sum: { queries: 10 }, dimensions: { coloName: "sjc" } },
			{ sum: { queries: 5 }, dimensions: { coloName: "SJC" } },
			{ sum: { queries: 2 }, dimensions: { coloName: null } },
		]);
		expect(Object.fromEntries(totals)).toEqual({ SJC: 15, "": 2 });
	});
});

describe("toLayer", () => {
	it("places POPs, buckets unknown colos as unmapped and empty keys as unattributed", () => {
		const layer = toLayer("pop", "src", new Map([["DUB", 5], ["SJC", 20], ["ZZZ", 3], ["", 2]]), popsByIata);
		expect(layer).toMatchObject({ status: "ok", total: 30, unattributed: 2, unmapped: [{ key: "ZZZ", value: 3 }] });
		if (layer.status !== "ok") throw new Error();
		expect(layer.points.map((p) => [p.key, p.name, p.value])).toEqual([
			["SJC", "San Jose", 20],
			["DUB", "Dublin", 5],
		]);
	});

	it("places countries at centroids and treats UNKNOWN as unattributed", () => {
		const layer = toLayer("country", "src", new Map([["US", 10], ["UNKNOWN", 4], ["T1", 1]]), popsByIata);
		if (layer.status !== "ok") throw new Error();
		expect(layer.points).toHaveLength(1);
		expect(layer.points[0]).toMatchObject({ key: "US", name: "United States" });
		expect(layer.unattributed).toBe(4);
		expect(layer.unmapped).toEqual([{ key: "T1", value: 1 }]);
	});
});

describe("fetchSplittingWindow", () => {
	const DAY = 86_400_000;
	const start = new Date("2026-10-01T00:00:00Z");
	const end = new Date("2026-10-31T00:00:00Z");

	it("splits on 'too much data' into contiguous half-open windows aligned to the rollup", async () => {
		const calls: [string, string][] = [];
		const rows = await fetchSplittingWindow(
			async (s, e) => {
				calls.push([s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]);
				if (e.getTime() - s.getTime() > 10 * DAY) throw new Error("Your query would read too much data.");
				return [`${s.toISOString().slice(5, 10)}..${e.toISOString().slice(5, 10)}`];
			},
			start,
			end,
			DAY,
		);
		expect(rows).toEqual(["10-01..10-08", "10-08..10-16", "10-16..10-23", "10-23..10-31"]);
		expect(calls).toHaveLength(7);
	});

	it("rethrows other errors without splitting", async () => {
		let calls = 0;
		const failing = async () => {
			calls++;
			throw new Error("Rate limiter budget depleted");
		};
		await expect(fetchSplittingWindow(failing, start, end, DAY)).rejects.toThrow("budget");
		expect(calls).toBe(1);
	});
});

describe("bucketStart", () => {
	it("normalises hour timestamps and plain dates", () => {
		expect(bucketStart("2026-11-03T10:00:00Z")).toBe("2026-11-03T10:00:00.000Z");
		expect(bucketStart("2026-11-03")).toBe("2026-11-03T00:00:00.000Z");
		expect(bucketStart(null)).toBe("");
	});
});

describe("aggregateRows with distinct counts", () => {
	it("keeps the max instead of summing duplicate keys", () => {
		const totals = aggregateRows(LAYER_QUERIES.users.pop!, [
			{ uniq: { users: 3 }, dimensions: { coloName: "SJC" } },
			{ uniq: { users: 5 }, dimensions: { coloName: "SJC" } },
		]);
		expect(totals.get("SJC")).toBe(5);
	});
});

describe("resolveRange", () => {
	const now = new Date("2026-11-02T12:34:56.789Z");

	it("uses a rolling window for hourly rollups", () => {
		const { start, end } = resolveRange("7d", now);
		expect(end.toISOString()).toBe("2026-11-02T12:34:00.000Z");
		expect(start.toISOString()).toBe("2026-10-26T12:34:00.000Z");
	});

	it("shifts back one full range for the previous period", () => {
		const hourly = resolveRange("7d", now, 1);
		expect(hourly.start.toISOString()).toBe("2026-10-19T12:34:00.000Z");
		expect(hourly.end.toISOString()).toBe("2026-10-26T12:34:00.000Z");
		const daily = resolveRange("30d", now, 1);
		expect(daily.start.toISOString()).toBe("2026-09-04T00:00:00.000Z");
		expect(daily.end.toISOString()).toBe("2026-10-03T12:34:00.000Z");
	});

	it("uses whole UTC days (including today) for daily rollups", () => {
		const { start, end } = resolveRange("30d", now);
		expect(end.toISOString()).toBe("2026-11-02T12:34:00.000Z");
		expect(start.toISOString()).toBe("2026-10-04T00:00:00.000Z");
		expect(end.getTime() - start.getTime()).toBeLessThanOrEqual(30 * 86_400_000);
	});
});
