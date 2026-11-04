import { describe, expect, it } from "vitest";
import { geocodeCity, normalizeCity } from "./geocode.ts";

describe("geocodeCity", () => {
	it("normalises names", () => {
		expect(normalizeCity("São Paulo")).toBe("sao paulo");
		expect(normalizeCity("Saint-Étienne")).toBe("saint etienne");
	});

	it("finds cities and disambiguates US states", () => {
		const sj = geocodeCity("US", "CA", "San Jose")!;
		expect(sj.lat).toBeCloseTo(37.34, 1);
		expect(sj.lon).toBeCloseTo(-121.89, 1);
		const portlandOR = geocodeCity("US", "OR", "Portland")!;
		const portlandME = geocodeCity("US", "ME", "Portland")!;
		expect(portlandOR.lon).toBeLessThan(-120);
		expect(portlandME.lon).toBeGreaterThan(-75);
		expect(geocodeCity("FR", "ARA", "Lyon")!.lat).toBeCloseTo(45.75, 1);
		expect(geocodeCity("BR", "SP", "São Paulo")).not.toBeNull();
	});

	it("returns null for unknown places", () => {
		expect(geocodeCity("US", "CA", "Nowhereville")).toBeNull();
		expect(geocodeCity("", "", "")).toBeNull();
	});
});
