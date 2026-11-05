import { RateLimitedError } from "./http.ts";
import { readJson } from "./upstream.ts";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
/** After a rate-limit response, stop calling the API for this long (the budget window is 5 minutes). */
const COOLDOWN_SECONDS = 60;
const COOLDOWN_KEY = "https://api-cache.internal/__graphql-cooldown";
const RATE_LIMITED = /rate limit|budget depleted/i;

export interface GraphQLErrorEntry {
	message: string;
	path?: (string | number)[];
}

export interface GraphQLResult<T> {
	data: T | null;
	errors: GraphQLErrorEntry[];
}

export class GraphQLError extends Error {}

let cooldownUntil = 0;

/** Circuit breaker: true while a recent rate-limit response says the account budget is exhausted. */
async function coolingDown(): Promise<boolean> {
	if (Date.now() < cooldownUntil) return true;
	return Boolean(await caches.default.match(COOLDOWN_KEY).catch(() => undefined));
}

async function startCooldown() {
	cooldownUntil = Date.now() + COOLDOWN_SECONDS * 1000;
	await caches.default.put(COOLDOWN_KEY, new Response("1", { headers: { "Cache-Control": `max-age=${COOLDOWN_SECONDS}` } })).catch(() => undefined);
}

/** Throws on transport/auth failures; returns partial data alongside field-level errors. */
export async function graphql<T>(
	token: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<GraphQLResult<T>> {
	if (await coolingDown()) throw new RateLimitedError("GraphQL API rate limit cooldown active");
	const res = await fetch(GRAPHQL_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			// Budget per queried account instead of per token/user (which is shared with every other use of that credential).
			// https://developers.cloudflare.com/analytics/graphql-api/account-based-rate-limiting/
			"X-Rate-Limit-Type": "account-based",
		},
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(25_000),
	});
	const body = await readJson<{ data?: T | null; errors?: GraphQLErrorEntry[] | null }>(res, MAX_RESPONSE_BYTES).catch(() => null);
	const errors = body?.errors ?? [];
	const detail = errors.map((e) => e.message).join("; ");
	if (res.status === 429 || RATE_LIMITED.test(detail)) {
		await startCooldown();
		throw new RateLimitedError(`GraphQL API rate limited: ${detail || `HTTP ${res.status}`}`);
	}
	if (!res.ok) throw new GraphQLError(`GraphQL API returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
	if (!body?.data) throw new GraphQLError(detail || "GraphQL API returned no data");
	return { data: body.data, errors };
}
