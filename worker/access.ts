/**
 * Cloudflare Access JWT verification, so the Worker fails closed if the Access application in front
 * of it is missing or misconfigured (instead of trusting the network path alone).
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

import { readJson } from "./upstream.ts";

export interface AccessConfig {
	/** e.g. "myteam.cloudflareaccess.com" */
	teamDomain: string;
	/** Application Audience (AUD) tag. */
	aud: string;
}

export class AccessError extends Error {}

interface Jwk extends JsonWebKey {
	kid: string;
}

const JWKS_TTL_MS = 3600_000;
/** Minimum gap between refetches triggered by an unknown key id (limits junk-token amplification). */
const JWKS_REFETCH_MIN_MS = 60_000;
const CLOCK_SKEW_SECONDS = 60;
let jwksCache: { url: string; keys: Map<string, CryptoKey>; expires: number; fetchedAt: number } | undefined;

const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(s))) as Record<string, unknown>;

export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const defaultFetcher: JwksFetcher = async (url) => {
	const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
	if (!res.ok) throw new AccessError(`JWKS fetch failed: HTTP ${res.status}`);
	return readJson<{ keys: Jwk[] }>(res, 64 * 1024);
};

async function signingKey(config: AccessConfig, kid: string, fetcher: JwksFetcher): Promise<CryptoKey> {
	const url = `https://${config.teamDomain}/cdn-cgi/access/certs`;
	const now = Date.now();
	const fresh = jwksCache && jwksCache.url === url && jwksCache.expires > now;
	// Refetch when stale, or for an unknown kid (key rotation) at most once per JWKS_REFETCH_MIN_MS.
	const rotationCheck = fresh && !jwksCache!.keys.has(kid) && now - jwksCache!.fetchedAt >= JWKS_REFETCH_MIN_MS;
	if (!fresh || rotationCheck) {
		const { keys } = await fetcher(url);
		const imported = new Map<string, CryptoKey>();
		for (const jwk of keys ?? []) {
			if (jwk.kty !== "RSA" || !jwk.kid) continue;
			imported.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
		}
		jwksCache = { url, keys: imported, expires: now + JWKS_TTL_MS, fetchedAt: now };
	}
	const key = jwksCache!.keys.get(kid);
	if (!key) throw new AccessError("unknown signing key");
	return key;
}

/** Verifies an Access JWT (signature, issuer, audience, expiry). Returns the identity email or subject. */
export async function verifyAccessJwt(token: string, config: AccessConfig, now = Date.now() / 1000, fetcher = defaultFetcher): Promise<string> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new AccessError("malformed token");
	const [h, p, s] = parts;
	const header = decodeJson(h);
	const payload = decodeJson(p);
	if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AccessError("unsupported token algorithm");
	const key = await signingKey(config, header.kid, fetcher);
	const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
	if (!valid) throw new AccessError("bad signature");
	if (payload.iss !== `https://${config.teamDomain}`) throw new AccessError("wrong issuer");
	const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!aud.includes(config.aud)) throw new AccessError("wrong audience");
	if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < now) throw new AccessError("token expired");
	if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > now) throw new AccessError("token not yet valid");
	return String(payload.email ?? payload.sub ?? "");
}

/** Reads the Access assertion from the request (header first, then the CF_Authorization cookie). */
export function accessToken(request: Request): string | null {
	const header = request.headers.get("Cf-Access-Jwt-Assertion");
	if (header) return header;
	const cookie = request.headers.get("Cookie") ?? "";
	return /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1] ?? null;
}

/** For tests: forget cached signing keys. */
export function resetJwksCache() {
	jwksCache = undefined;
}
