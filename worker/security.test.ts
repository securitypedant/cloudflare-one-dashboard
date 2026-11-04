import { beforeEach, describe, expect, it } from "vitest";
import { AccessError, accessToken, resetJwksCache, verifyAccessJwt, type JwksFetcher } from "./access.ts";
import { BadRequestError, parseParams } from "./http.ts";
import { mapLimit, readJson, ResponseTooLargeError } from "./upstream.ts";
import { parseLocations } from "./pops.ts";
import { parseVendorPoints } from "./vendors.ts";

const config = { teamDomain: "team.cloudflareaccess.com", aud: "aud-123" };
const b64url = (data: ArrayBuffer | Uint8Array | string) =>
	btoa(String.fromCharCode(...(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data))))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

async function keyPair(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

async function sign(privateKey: CryptoKey, payload: Record<string, unknown>, kid = "k1") {
	const h = b64url(JSON.stringify({ alg: "RS256", kid }));
	const p = b64url(JSON.stringify(payload));
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${h}.${p}`));
	return `${h}.${p}.${b64url(sig)}`;
}

describe("verifyAccessJwt", () => {
	let pair: CryptoKeyPair;
	let fetcher: JwksFetcher;
	const now = 1_800_000_000;
	const good = { iss: `https://${config.teamDomain}`, aud: [config.aud], exp: now + 600, email: "user@example.com" };

	beforeEach(async () => {
		resetJwksCache();
		pair = await keyPair();
		const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
		fetcher = async () => ({ keys: [{ ...jwk, kid: "k1" }] });
	});

	it("accepts a valid token and returns the identity", async () => {
		expect(await verifyAccessJwt(await sign(pair.privateKey, good), config, now, fetcher)).toBe("user@example.com");
	});

	it("rejects wrong audience, issuer, expiry, signature and key id", async () => {
		const cases = [
			sign(pair.privateKey, { ...good, aud: ["other"] }),
			sign(pair.privateKey, { ...good, iss: "https://evil.cloudflareaccess.com" }),
			sign(pair.privateKey, { ...good, exp: now - 3600 }),
			sign((await keyPair()).privateKey, good),
			sign(pair.privateKey, good, "unknown-kid"),
		];
		for (const token of cases) await expect(verifyAccessJwt(await token, config, now, fetcher)).rejects.toBeInstanceOf(AccessError);
		await expect(verifyAccessJwt("not.a-jwt", config, now, fetcher)).rejects.toThrow();
	});

	it("reads the assertion header or the CF_Authorization cookie", () => {
		expect(accessToken(new Request("https://x/", { headers: { "Cf-Access-Jwt-Assertion": "abc" } }))).toBe("abc");
		expect(accessToken(new Request("https://x/", { headers: { Cookie: "a=1; CF_Authorization=tok; b=2" } }))).toBe("tok");
		expect(accessToken(new Request("https://x/"))).toBeNull();
	});
});

describe("parseParams", () => {
	const spec = { range: { values: ["24h", "7d"] as const }, mode: { values: ["pop", "country"] as const, optional: true } };
	const parse = (q: string) => parseParams(new URL(`https://x/api/traffic?${q}`), spec);

	it("returns typed params and a canonical cache key in spec order", () => {
		expect(parse("mode=pop&range=7d")).toEqual({ params: { range: "7d", mode: "pop" }, canonical: "range=7d&mode=pop" });
		expect(parse("range=24h").canonical).toBe("range=24h");
	});

	it("rejects unknown, duplicate, missing and invalid parameters", () => {
		for (const q of ["range=7d&cb=1", "range=7d&range=24h", "mode=pop", "range=1y", "range=7d&constructor=1"]) {
			expect(() => parse(q)).toThrow(BadRequestError);
		}
	});
});

describe("readJson", () => {
	it("parses within the limit", async () => {
		expect(await readJson(new Response('{"a":1}'), 100)).toEqual({ a: 1 });
	});

	it("rejects bodies over the limit, declared or streamed", async () => {
		await expect(readJson(new Response("x".repeat(10), { headers: { "Content-Length": "1000" } }), 100)).rejects.toBeInstanceOf(ResponseTooLargeError);
		await expect(readJson(new Response(`"${"x".repeat(200)}"`), 100)).rejects.toBeInstanceOf(ResponseTooLargeError);
	});
});

describe("mapLimit", () => {
	it("bounds concurrency and keeps order, isolating failures", async () => {
		let active = 0;
		let peak = 0;
		const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			if (n === 3) throw new Error("boom");
			return n * 10;
		});
		expect(peak).toBe(2);
		expect(results.map((r) => (r.status === "fulfilled" ? r.value : "err"))).toEqual([10, 20, "err", 40, 50, 60]);
	});
});

describe("upstream data validation", () => {
	it("drops malformed POP entries and caps strings", () => {
		const pops = parseLocations([
			{ iata: "LHR", lat: 51.47, lon: -0.46, cca2: "GB", city: "London" },
			{ iata: "<script>", lat: 1, lon: 1 },
			{ iata: "BAD", lat: 999, lon: 0 },
			{ iata: "CDG", lat: 49, lon: 2.5, city: "x".repeat(500) },
		]);
		expect(pops.find((p) => p.iata === "LHR")?.city).toBe("London");
		expect(pops.some((p) => p.iata === "BAD" || p.iata.includes("<"))).toBe(false);
		expect(pops.find((p) => p.iata === "CDG")?.city.length).toBe(80);
		expect(() => parseLocations({ not: "a list" })).toThrow();
	});

	it("validates vendor GeoJSON points", () => {
		const points = parseVendorPoints({
			features: [
				{ geometry: { coordinates: [2.35, 48.86] }, properties: { city: "Paris" } },
				{ geometry: { coordinates: ["x", 1] } },
				{ geometry: { coordinates: [500, 1] } },
			],
		});
		expect(points).toEqual([[2.35, 48.86, "Paris"]]);
		expect(() => parseVendorPoints("nope")).toThrow();
	});
});
