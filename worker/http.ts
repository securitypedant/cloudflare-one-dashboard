import type { ApiError } from "../shared/types.ts";

/** Headers on every API response. */
const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	// Analytics are only for Access-authenticated viewers: never let shared/intermediary caches store them.
	"Cache-Control": "private, no-store",
};

export const json = (body: unknown, init: ResponseInit = {}) =>
	Response.json(body, { ...init, headers: { ...SECURITY_HEADERS, ...init.headers } });

/** Stable, non-revealing error codes. Details go to Worker logs only. */
export type ErrorCode = "bad_request" | "unauthorized" | "forbidden" | "not_found" | "method_not_allowed" | "misconfigured" | "rate_limited" | "upstream_error";

const MESSAGES: Record<ErrorCode, string> = {
	bad_request: "Invalid request parameters.",
	unauthorized: "Authentication required.",
	forbidden: "This view is limited to dashboard admins.",
	not_found: "Not found.",
	method_not_allowed: "Method not allowed.",
	misconfigured: "The dashboard is not configured correctly. Check the Worker logs.",
	rate_limited: "Analytics API rate limit reached. Try again in a minute.",
	upstream_error: "Could not load data from the analytics API. Check the Worker logs.",
};

const STATUS: Record<ErrorCode, number> = {
	bad_request: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	method_not_allowed: 405,
	misconfigured: 500,
	rate_limited: 503,
	upstream_error: 502,
};

export const apiError = (code: ErrorCode, detail?: string) =>
	json({ error: MESSAGES[code], code, ...(detail ? { detail } : {}) } satisfies ApiError, { status: STATUS[code] });

/** Public, non-sensitive message for an error kept in a 200 response body (layer/report errors). */
export const publicErrorMessage = (err: unknown) => (err instanceof RateLimitedError ? MESSAGES.rate_limited : MESSAGES.upstream_error);

export class RateLimitedError extends Error {}

export class BadRequestError extends Error {}

/** A parameter is either one of a fixed list of values, or a string matching an anchored pattern. */
type ParamRule = { values: readonly string[]; optional?: boolean } | { pattern: RegExp; maxLength: number; optional?: boolean; values?: undefined };
type ParamSpec = Record<string, ParamRule>;
type ParamValue<R extends ParamRule> = R extends { values: readonly (infer V)[] } ? V : string;

/** Email-like identifiers (per-user page). Lower-cased by the caller before matching. */
export const EMAIL_PARAM = { pattern: /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/, maxLength: 254 } as const;
/** UUID path/query identifiers. */
export const UUID_PARAM = { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, maxLength: 36 } as const;

/**
 * Strict query parsing: every parameter must be known, appear at most once, and match its allowed
 * values or pattern. Rejecting unknown parameters keeps the cache key canonical (no cache-busting
 * variants). Returns the canonical query string (fixed key order) for use as a cache key.
 */
export function parseParams<S extends ParamSpec>(url: URL, spec: S): { params: { [K in keyof S]: ParamValue<S[K]> }; canonical: string } {
	const seen = new Set<string>();
	for (const name of url.searchParams.keys()) {
		if (!(Object.hasOwn(spec, name))) throw new BadRequestError(`unknown parameter "${name}"`);
		if (seen.has(name)) throw new BadRequestError(`duplicate parameter "${name}"`);
		seen.add(name);
	}
	const params: Record<string, string> = {};
	const parts: string[] = [];
	for (const [name, rule] of Object.entries(spec)) {
		const value = url.searchParams.get(name);
		if (value === null) {
			if (rule.optional) continue;
			throw new BadRequestError(`missing parameter "${name}"`);
		}
		if (rule.values) {
			if (!rule.values.includes(value)) throw new BadRequestError(`"${name}" must be one of ${rule.values.join(", ")}`);
		} else if (value.length > rule.maxLength || !rule.pattern.test(value)) {
			throw new BadRequestError(`"${name}" is not valid`);
		}
		params[name] = value;
		parts.push(`${name}=${encodeURIComponent(value)}`);
	}
	return { params: params as { [K in keyof S]: ParamValue<S[K]> }, canonical: parts.join("&") };
}

/**
 * Edge cache for API results, consulted only AFTER the Access check (unlike Cache-Control-driven
 * caching, which can serve before the Worker runs). Keyed by path + canonical params.
 */
export async function cached(ctx: ExecutionContext, path: string, canonical: string, ttlSeconds: number, produce: () => Promise<{ body: unknown; cacheable: boolean }>): Promise<Response> {
	const key = new Request(`https://api-cache.internal${path}?${canonical}`);
	const cache = caches.default;
	const hit = await cache.match(key);
	if (hit) return json(await hit.json(), { headers: { "X-Dashboard-Cache": "hit" } });
	const { body, cacheable } = await produce();
	if (cacheable && ttlSeconds > 0) {
		ctx.waitUntil(cache.put(key, Response.json(body, { headers: { "Cache-Control": `max-age=${ttlSeconds}` } })));
	}
	return json(body, { headers: { "X-Dashboard-Cache": "miss" } });
}
