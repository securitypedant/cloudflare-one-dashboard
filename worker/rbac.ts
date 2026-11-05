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

export interface Identity {
	email?: string;
	groups?: ({ id?: string; name?: string; email?: string } | string)[];
	idp?: { id?: string; type?: string };
	is_warp?: boolean;
	is_gateway?: boolean;
	device_id?: string;
	user_uuid?: string;
	/** Seconds since epoch when the user last authenticated. */
	iat?: number;
	geo?: { country?: string };
	/** Reduced to rule name/type/result; the raw map includes inputs we don't need. */
	posture?: { name: string; type: string; success: boolean }[];
}

/** Keep only fields the dashboard shows; drop raw posture inputs, sessions and IPs. */
export function slimIdentity(raw: Record<string, unknown>): Identity {
	const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : undefined);
	const posture = raw.devicePosture && typeof raw.devicePosture === "object" ? Object.values(raw.devicePosture as Record<string, Record<string, unknown>>) : [];
	const idp = raw.idp as { id?: unknown; type?: unknown } | undefined;
	return {
		email: str(raw.email),
		groups: Array.isArray(raw.groups) ? (raw.groups as Identity["groups"])!.slice(0, 200) : [],
		idp: idp ? { id: str(idp.id), type: str(idp.type) } : undefined,
		is_warp: raw.is_warp === true,
		is_gateway: raw.is_gateway === true,
		device_id: str(raw.device_id),
		user_uuid: str(raw.user_uuid),
		iat: typeof raw.iat === "number" ? raw.iat : undefined,
		geo: { country: str((raw.geo as { country?: unknown } | undefined)?.country) },
		posture: posture.slice(0, 100).map((r) => ({ name: str(r?.rule_name) ?? "", type: str(r?.type) ?? "", success: r?.success === true })),
	};
}

const IDENTITY_TTL_SECONDS = 300;
/** Bump when the cached identity shape changes. */
const IDENTITY_CACHE_VERSION = "v2";

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
	if (wanted.includes("*")) return "admin";
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
	const cacheKey = new Request(`https://api-cache.internal/__identity/${IDENTITY_CACHE_VERSION}/${await sha256(token)}`);
	const hit = await caches.default.match(cacheKey);
	if (hit) return (await hit.json()) as Identity;
	const res = await fetch(`https://${hostname}/cdn-cgi/access/get-identity`, { headers: { Cookie: `CF_Authorization=${token}` }, signal: AbortSignal.timeout(5000) });
	if (!res.ok) throw new Error(`get-identity returned HTTP ${res.status}`);
	const slim = slimIdentity(await readJson<Record<string, unknown>>(res, 256 * 1024));
	await caches.default.put(cacheKey, Response.json(slim, { headers: { "Cache-Control": `max-age=${IDENTITY_TTL_SECONDS}` } }));
	return slim;
}
