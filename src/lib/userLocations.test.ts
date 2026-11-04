import { describe, expect, it } from "vitest";
import { isFar, summarizeCities, summarizeIsps, vendorDistances, weightedMedian } from "./userLocations.ts";
import type { Pop, UserLocationRow } from "../../shared/types.ts";

const row = (o: Partial<UserLocationRow>): UserLocationRow => ({
	country: "US",
	state: "CA",
	city: "San Jose",
	isp: "Comcast",
	colo: "SJC",
	samples: 10,
	handshakeAvgMs: 10,
	lat: 37.34,
	lon: -121.89,
	coloDistanceKm: 5,
	nearestIata: "SJC",
	nearestDistanceKm: 5,
	...o,
});

describe("user locations", () => {
	const rows = [
		row({}),
		row({ isp: "AT&T", samples: 30, handshakeAvgMs: 20 }),
		row({ colo: "IAD", samples: 5, coloDistanceKm: 3900 }),
		row({ city: "Nowhere", lat: null, lon: null, coloDistanceKm: null, nearestIata: null, nearestDistanceKm: null }),
	];

	it("flags users connected far beyond their nearest POP", () => {
		expect(isFar(rows[2])).toBe(true);
		expect(isFar(rows[0])).toBe(false);
	});

	it("groups by city, merging ISPs and weighting handshake by samples", () => {
		const [sj] = summarizeCities(rows);
		expect(sj.samples).toBe(45);
		expect(sj.isps).toEqual(["Comcast", "AT&T"]);
		expect(sj.farSamples).toBe(5);
		expect(sj.colos[0]).toMatchObject({ colo: "SJC", samples: 40, handshakeAvgMs: 17.5 });
		expect(summarizeCities(rows)).toHaveLength(1); // unlocated city skipped
	});

	it("summarises ISPs", () => {
		const comcast = summarizeIsps(rows).find((i) => i.isp === "Comcast")!;
		expect(comcast.samples).toBe(25);
		expect(comcast.farShare).toBeCloseTo(0.2);
	});

	it("computes a weighted median", () => {
		expect(weightedMedian([{ value: 1, weight: 1 }, { value: 100, weight: 5 }, { value: 2, weight: 1 }])).toBe(100);
		expect(weightedMedian([])).toBeNull();
	});

	it("compares vendors from the user's city", () => {
		const pops: Pop[] = [{ iata: "SJC", city: "San Jose", country: "US", region: "", lat: 37.36, lon: -121.93 }];
		const scores = vendorDistances(summarizeCities(rows), pops, [{ id: "v", name: "V", points: [[-77.0, 38.9, "DC"]] }]);
		expect(scores[0].id).toBe("cloudflare");
		expect(scores[0].nearShare).toBe(1);
		expect(scores[1].avgDistanceKm).toBeGreaterThan(3500);
	});
});
