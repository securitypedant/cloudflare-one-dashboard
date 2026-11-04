import { describe, expect, it } from "vitest";
import { buildFlows, countryCoverage, scoreVendors } from "./coverage.ts";
import type { Pop, Vendor } from "../../shared/types.ts";

const pops: Pop[] = [
	{ iata: "LHR", city: "London", country: "GB", region: "", lat: 51.47, lon: -0.46 },
	{ iata: "DUB", city: "Dublin", country: "IE", region: "", lat: 53.42, lon: -6.27 },
	{ iata: "SJC", city: "San Jose", country: "US", region: "", lat: 37.36, lon: -121.93 },
];

describe("coverage", () => {
	const rows = [
		{ country: "GB", colo: "LHR", value: 80 },
		{ country: "GB", colo: "DUB", value: 20 },
		{ country: "US", colo: "SJC", value: 100 },
		{ country: "UNKNOWN", colo: "SJC", value: 50 },
		{ country: "US", colo: "ZZZ", value: 5 },
	];

	it("builds flows and flags in-country vs cross-border", () => {
		const { flows, unattributed } = buildFlows(rows, pops);
		expect(unattributed).toBe(55);
		expect(flows.map((f) => [f.country, f.pop.iata, f.inCountry])).toEqual([
			["US", "SJC", true],
			["GB", "LHR", true],
			["GB", "DUB", false],
		]);
	});

	it("summarises per country", () => {
		const gb = countryCoverage(buildFlows(rows, pops).flows).find((c) => c.country === "GB")!;
		expect(gb.total).toBe(100);
		expect(gb.inCountryShare).toBeCloseTo(0.8);
		expect(gb.pops.map((p) => p.iata)).toEqual(["LHR", "DUB"]);
	});

	it("scores vendors on in-country coverage and extra distance", () => {
		const vendors: Vendor[] = [{ id: "v", name: "Vendor", points: [[-0.12, 51.5, "London"]] }];
		const scores = scoreVendors(buildFlows(rows, pops).flows, pops, vendors);
		const cf = scores.find((s) => s.id === "cloudflare")!;
		const v = scores.find((s) => s.id === "v")!;
		expect(cf.avgDistanceKm).toBe(0);
		expect(cf.inCountryShare).toBe(1);
		expect(v.inCountryShare).toBeCloseTo(0.5); // only GB traffic has an in-country vendor POP
		expect(v.avgDistanceKm).toBeGreaterThan(3000); // SJC traffic is ~8,600 km from London
		expect(v.nearShare).toBeCloseTo(0.5); // LHR + DUB traffic within 500 km
	});
});
