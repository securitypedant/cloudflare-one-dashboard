import { describe, expect, it } from "vitest";
import { arc, countryAt, distanceKm, MAPPED_COUNTRIES } from "./worldGeo.ts";

describe("worldGeo", () => {
	it("finds the country containing a point", () => {
		expect(countryAt(-0.12, 51.5)).toBe("GB"); // London
		expect(countryAt(2.35, 48.86)).toBe("FR"); // Paris
		expect(countryAt(-99.07, 19.43)).toBe("MX"); // MEX airport
		expect(countryAt(139.7, 35.7)).toBe("JP"); // Tokyo
		expect(countryAt(-30, 0)).toBeNull(); // Atlantic
	});

	it("knows which countries have polygons", () => {
		expect(MAPPED_COUNTRIES.has("US")).toBe(true);
		expect(MAPPED_COUNTRIES.has("XK")).toBe(true);
	});

	it("computes great-circle distances", () => {
		expect(distanceKm(-0.46, 51.47, -73.78, 40.64)).toBeGreaterThan(5500); // LHR → JFK ≈ 5540 km
		expect(distanceKm(-0.46, 51.47, -73.78, 40.64)).toBeLessThan(5600);
	});

	it("builds arcs without antimeridian jumps", () => {
		const pts = arc([139.7, 35.7], [-122.4, 37.8]); // Tokyo → San Francisco across the Pacific
		for (let i = 1; i < pts.length; i++) expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThan(30);
	});
});
