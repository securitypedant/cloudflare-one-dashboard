import { fetchPops } from "./pops.ts";
import { fetchTimeline, fetchTraffic } from "./traffic.ts";
import { fetchReport } from "./reports.ts";
import { fetchVendors } from "./vendors.ts";
import { fetchCategories } from "./categories.ts";
import { fetchDex } from "./dex.ts";
import { fetchUserLocations } from "./userLocations.ts";
import { getCoverage, getDeadLetterCount, handleQueue, LOGPUSH_SOURCES, purgeOldData, type R2EventNotification } from "./logpush.ts";
import { AccessError, accessToken, verifyAccessJwt } from "./access.ts";
import { apiError, BadRequestError, cached, json, parseParams, RateLimitedError } from "./http.ts";
import { DATASET_IDS, MAP_MODES, RANGE_IDS, REPORT_IDS, type RangeId } from "../shared/types.ts";

const TRAFFIC_CACHE_SECONDS: Record<RangeId, number> = { "24h": 300, "7d": 900, "30d": 3600, "90d": 3600 };
// Logpush aggregates are cheap to query and update every few minutes.
const LOGPUSH_CACHE_SECONDS = 120;
const DAY = 86400;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Fail closed unless the request carries a valid Cloudflare Access JWT for this application.
 * The only bypass is ALLOW_UNAUTHENTICATED=true (set in .dev.vars) AND a localhost request.
 */
async function authorize(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (env.ALLOW_UNAUTHENTICATED === "true" && LOCAL_HOSTS.has(url.hostname)) return null;
	if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
		console.error(JSON.stringify({ msg: "access not configured", hint: "set ACCESS_TEAM_DOMAIN and ACCESS_AUD" }));
		return apiError("misconfigured");
	}
	const token = accessToken(request);
	if (!token) return apiError("unauthorized");
	try {
		await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
		return null;
	} catch (err) {
		console.warn(JSON.stringify({ msg: "access token rejected", reason: err instanceof AccessError ? err.message : "verification error" }));
		return apiError("unauthorized");
	}
}

function requireApiToken(env: Env): { token: string; accountId: string } {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) throw new MisconfiguredError("CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID missing");
	return { token: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID };
}

class MisconfiguredError extends Error {}

const NO_PARAMS = {} as const;

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return new Response(null, { status: 404 });
		if (request.method !== "GET") return apiError("method_not_allowed");

		const denied = await authorize(request, env, url);
		if (denied) return denied;

		try {
			switch (url.pathname) {
				case "/api/pops": {
					parseParams(url, NO_PARAMS);
					return json(await fetchPops(ctx));
				}

				case "/api/logpush/status": {
					parseParams(url, NO_PARAMS);
					const [coverage, deadLetters] = await Promise.all([getCoverage(env.DB), getDeadLetterCount(env.DB)]);
					const sources = Object.entries(LOGPUSH_SOURCES).map(([source, spec]) => {
						const c = coverage.find((x) => x.source === source);
						return {
							source,
							fields: spec.fields,
							firstRecord: c ? new Date(c.firstRecord * 1000).toISOString() : null,
							lastRecord: c ? new Date(c.lastRecord * 1000).toISOString() : null,
						};
					});
					return json({ sources, deadLetters });
				}

				case "/api/traffic":
				case "/api/timeline": {
					const isTimeline = url.pathname === "/api/timeline";
					const { params, canonical } = parseParams(url, {
						range: { values: RANGE_IDS },
						dataset: { values: DATASET_IDS },
						mode: { values: MAP_MODES },
						// Previous-period comparison only applies to /api/traffic.
						...(isTimeline ? {} : { offset: { values: ["0", "1"] as const, optional: true } }),
					});
					const { token, accountId } = requireApiToken(env);
					return cached(ctx, url.pathname, canonical, TRAFFIC_CACHE_SECONDS[params.range], async () => {
						const opts = {
							token,
							accountId,
							db: env.DB,
							dataset: params.dataset,
							mode: params.mode,
							rangeId: params.range,
							offset: "offset" in params && params.offset === "1" ? 1 : 0,
							pops: params.mode === "pop" ? await fetchPops(ctx) : [],
						};
						const result = isTimeline ? await fetchTimeline(opts) : await fetchTraffic(opts);
						return { body: result, cacheable: result.layer.status !== "error" };
					});
				}

				case "/api/report": {
					const { params, canonical } = parseParams(url, { id: { values: REPORT_IDS }, range: { values: RANGE_IDS } });
					const { token, accountId } = requireApiToken(env);
					return cached(ctx, url.pathname, canonical, TRAFFIC_CACHE_SECONDS[params.range], async () => {
						const report = await fetchReport(token, accountId, params.id, params.range);
						return { body: report, cacheable: !report.error };
					});
				}

				case "/api/dex": {
					const { params, canonical } = parseParams(url, { range: { values: RANGE_IDS }, mode: { values: MAP_MODES } });
					return cached(ctx, url.pathname, canonical, LOGPUSH_CACHE_SECONDS, async () => ({
						body: await fetchDex(env.DB, params.mode, params.range),
						cacheable: true,
					}));
				}

				case "/api/user-locations": {
					const { params, canonical } = parseParams(url, { range: { values: RANGE_IDS } });
					return cached(ctx, url.pathname, canonical, LOGPUSH_CACHE_SECONDS, async () => ({
						body: await fetchUserLocations(env.DB, params.range, await fetchPops(ctx)),
						cacheable: true,
					}));
				}

				case "/api/vendors": {
					parseParams(url, NO_PARAMS);
					return json(await fetchVendors(ctx));
				}

				case "/api/categories": {
					const { canonical } = parseParams(url, NO_PARAMS);
					const { token, accountId } = requireApiToken(env);
					return cached(ctx, url.pathname, canonical, DAY, async () => ({ body: await fetchCategories(token, accountId), cacheable: true }));
				}

				default:
					return apiError("not_found");
			}
		} catch (err) {
			if (err instanceof BadRequestError) return apiError("bad_request", err.message);
			const message = err instanceof Error ? err.message : String(err);
			console.error(JSON.stringify({ msg: "api request failed", path: url.pathname, error: message }));
			if (err instanceof MisconfiguredError) return apiError("misconfigured");
			if (err instanceof RateLimitedError) return apiError("rate_limited");
			return apiError("upstream_error");
		}
	},

	async queue(batch, env) {
		await handleQueue(batch, env);
	},

	async scheduled(_controller, env) {
		const result = await purgeOldData(env.DB, Math.floor(Date.now() / 1000), Number(env.RETENTION_DAYS) || undefined);
		console.log(JSON.stringify({ msg: "retention purge", ...result }));
	},
} satisfies ExportedHandler<Env, R2EventNotification>;
