/**
 * Roles from the viewer's Cloudflare Access identity. Admins are members of a group listed in
 * ADMIN_GROUPS (group name, email or id, as sent by the IdP / Access); everyone else is a viewer.
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/#user-identity
 */
import { readJson } from "./upstream.ts";

export type Role = "admin" | "viewer";

export interface Viewer {
	email: string;
	role: Role;
}

interface Identity {
	email?: string;
	groups?: ({ id?: string; name?: string; email?: string } | string)[];
}

const IDENTITY_TTL_SECONDS = 300;

const sha256 = async (s: string) =>
	[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Group identifiers (names, emails, ids) the identity belongs to, lower-cased. */
export function groupKeys(identity: Identity): Set<string> {
	const keys = new Set<string>();
	for (const g of identity.groups ?? []) {
		if (typeof g === "string") keys.add(g.toLowerCase());
		else for (const v of [g.id, g.name, g.email]) if (v) keys.add(v.toLowerCase());
	}
	return keys;
}

export function roleFor(identity: Identity, adminGroups: string | undefined): Role {
	const wanted = (adminGroups ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (!wanted.length) return "viewer";
	const have = groupKeys(identity);
	return wanted.some((g) => have.has(g)) ? "admin" : "viewer";
}

/**
 * Host to ask for the identity: the configured dashboard hostname, so the lookup never depends on the
 * request's Host. Without DASHBOARD_HOSTNAME, falls back to the request hostname (route-bound).
 * Returns null when a hostname is configured but the request arrived on a different one.
 */
export function identityHost(requestHost: string, configured: string | undefined): string | null {
	const pinned = configured?.trim().toLowerCase();
	if (!pinned) return requestHost;
	return requestHost.toLowerCase() === pinned ? pinned : null;
}

/** Fetch the Access identity (with groups) for a verified token; cached briefly per token. */
export async function fetchIdentity(hostname: string, token: string): Promise<Identity> {
	const cacheKey = new Request(`https://api-cache.internal/__identity/${await sha256(token)}`);
	const hit = await caches.default.match(cacheKey);
	if (hit) return (await hit.json()) as Identity;
	const res = await fetch(`https://${hostname}/cdn-cgi/access/get-identity`, { headers: { Cookie: `CF_Authorization=${token}` }, signal: AbortSignal.timeout(5000) });
	if (!res.ok) throw new Error(`get-identity returned HTTP ${res.status}`);
	const identity = await readJson<Identity>(res, 256 * 1024);
	const slim: Identity = { email: identity.email, groups: identity.groups };
	await caches.default.put(cacheKey, Response.json(slim, { headers: { "Cache-Control": `max-age=${IDENTITY_TTL_SECONDS}` } }));
	return slim;
}
