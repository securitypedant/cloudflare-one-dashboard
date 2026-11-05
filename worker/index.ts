import { fetchPops } from "./pops.ts";
import { fetchTimeline, fetchTraffic } from "./traffic.ts";
import { fetchReport } from "./reports.ts";
import { fetchVendors } from "./vendors.ts";
import { fetchCategories } from "./categories.ts";
import { fetchDex } from "./dex.ts";
import { fetchUserLocations } from "./userLocations.ts";
import { getCoverage, getDeadLetterCount, handleQueue, LOGPUSH_SOURCES, purgeOldData, type R2EventNotification } from "./logpush.ts";
import { AccessError, accessToken, verifyAccessJwt } from "./access.ts";
import { apiError, BadRequestError, cached, EMAIL_PARAM, json, parseParams, RateLimitedError } from "./http.ts";
import { fetchIdentity as fetchAccessIdentity, identityHost, roleFor, type Viewer } from "./rbac.ts";
import { fetchPosture } from "./admin/posture.ts";
import { fetchIdentity } from "./admin/identity.ts";
import { fetchDevices } from "./admin/devices.ts";
import { fetchTunnels } from "./admin/tunnels.ts";
import { fetchThreats } from "./admin/threats.ts";
import { fetchChanges } from "./admin/changes.ts";
import { fetchUserDetail, fetchUserList } from "./admin/users.ts";
import type { MeResponse } from "../shared/admin.ts";
import { DATASET_IDS, MAP_MODES, RANGE_IDS, REPORT_IDS, type RangeId } from "../shared/types.ts";

const TRAFFIC_CACHE_SECONDS: Record<RangeId, number> = { "24h": 300, "7d": 900, "30d": 3600, "90d": 3600 };
// Logpush aggregates are cheap to query and update every few minutes.
const LOGPUSH_CACHE_SECONDS = 120;
const DAY = 86400;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Fail closed unless the request carries a valid Cloudflare Access JWT for this application, then
 * resolve the viewer's role (admin = member of an ADMIN_GROUPS group in their Access identity).
 * The only bypass is ALLOW_UNAUTHENTICATED=true (set in .dev.vars) AND a localhost request (admin).
 */
async function authorize(request: Request, env: Env, url: URL): Promise<Response | Viewer> {
	if (env.ALLOW_UNAUTHENTICATED === "true" && LOCAL_HOSTS.has(url.hostname)) return { email: "local-dev", role: "admin" };
	if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
		console.error(JSON.stringify({ msg: "access not configured", hint: "set ACCESS_TEAM_DOMAIN and ACCESS_AUD" }));
		return apiError("misconfigured");
	}
	const token = accessToken(request);
	if (!token) return apiError("unauthorized");
	let email: string;
	try {
		email = await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
	} catch (err) {
		console.warn(JSON.stringify({ msg: "access token rejected", reason: err instanceof AccessError ? err.message : "verification error" }));
		return apiError("unauthorized");
	}
	if (!env.ADMIN_GROUPS) return { email, role: "viewer" };
	const host = identityHost(url.hostname, env.DASHBOARD_HOSTNAME);
	if (!host) {
		console.warn(JSON.stringify({ msg: "request hostname does not match DASHBOARD_HOSTNAME; viewer role" }));
		return { email, role: "viewer" };
	}
	try {
		return { email, role: roleFor(await fetchAccessIdentity(host, token), env.ADMIN_GROUPS) };
	} catch (err) {
		// Fail safe: if the identity (groups) can't be read, the viewer gets the non-admin view.
		console.warn(JSON.stringify({ msg: "access identity lookup failed", error: err instanceof Error ? err.message : String(err) }));
		return { email, role: "viewer" };
	}
}

function requireApiToken(env: Env): { token: string; accountId: string } {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) throw new MisconfiguredError("CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID missing");
	return { token: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID };
}

class MisconfiguredError extends Error {}
class ForbiddenError extends Error {}

const NO_PARAMS = {} as const;

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return new Response(null, { status: 404 });
		if (request.method !== "GET") return apiError("method_not_allowed");

		const auth = await authorize(request, env, url);
		if (auth instanceof Response) return auth;
		const viewer = auth;
		const requireAdmin = () => {
			if (viewer.role !== "admin") throw new ForbiddenError();
		};
		// Admin-only data is cached under its own key prefix so it can never be served to viewers.
		const scoped = (path: string) => (viewer.role === "admin" ? `/admin${path}` : path);

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
							// Configured Logpush field lists are operational detail for admins only.
							...(viewer.role === "admin" ? { fields: spec.fields } : {}),
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
					return await cached(ctx, url.pathname, canonical, TRAFFIC_CACHE_SECONDS[params.range], async () => {
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
					return await cached(ctx, url.pathname, canonical, TRAFFIC_CACHE_SECONDS[params.range], async () => {
						const report = await fetchReport(token, accountId, params.id, params.range);
						return { body: report, cacheable: !report.error };
					});
				}

				case "/api/dex": {
					const { params, canonical } = parseParams(url, { range: { values: RANGE_IDS }, mode: { values: MAP_MODES } });
					return await cached(ctx, url.pathname, canonical, LOGPUSH_CACHE_SECONDS, async () => ({
						body: await fetchDex(env.DB, params.mode, params.range),
						cacheable: true,
					}));
				}

				case "/api/user-locations": {
					const { params, canonical } = parseParams(url, { range: { values: RANGE_IDS } });
					return await cached(ctx, url.pathname, canonical, LOGPUSH_CACHE_SECONDS, async () => ({
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
					return await cached(ctx, url.pathname, canonical, DAY, async () => ({ body: await fetchCategories(token, accountId), cacheable: true }));
				}

				case "/api/me": {
					parseParams(url, NO_PARAMS);
					return json({ email: viewer.email, role: viewer.role, adminGroupsConfigured: Boolean(env.ADMIN_GROUPS) } satisfies MeResponse);
				}

				case "/api/posture": {
					requireAdmin();
					const { canonical } = parseParams(url, NO_PARAMS);
					const { token, accountId } = requireApiToken(env);
					return await cached(ctx, scoped(url.pathname), canonical, 300, async () => ({ body: await fetchPosture(token, accountId), cacheable: true }));
				}

				case "/api/identity": {
					const { params, canonical } = parseParams(url, { range: { values: RANGE_IDS } });
					const { token, accountId } = requireApiToken(env);
					return await cached(ctx, scoped(url.pathname), canonical, TRAFFIC_CACHE_SECONDS[params.range], async () => ({
						body: await fetchIdentity(token, accountId, params.range, viewer.role),
						cacheable: true,
					}));
				}

				case "/api/devices": {
					requireAdmin();
					const { canonical } = parseParams(url, NO_PARAMS);
					const { token, accountId } = requireApiToken(env);
					return await cached(ctx, scoped(url.pathname), canonical, 300, async () => ({ body: await fetchDevices(token, accountId), cacheable: true }));
				}

				case "/api/tunnels": {
					requireAdmin();
					const { canonical } = parseParams(url, NO_PARAMS);
					const { token, accountId } = requireApiToken(env);
					return await cached(ctx, scoped(url.pathname), canonical, 60, async () => ({ body: await fetchTunnels(token, accountId), cacheable: true }));
				}

				case "/api/threats": {
					const { params, canonical } = parseParams(url, { range: { values: RANGE_IDS } });
					const { token, accountId } = requireApiToken(env);
					return await cached(ctx, scoped(url.pathname), canonical, TRAFFIC_CACHE_SECONDS[params.range], async () => ({
						body: await fetchThreats(token, accountId, params.range, viewer.role),
						cacheable: true,
					}));
				}

				case "/api/changes": {
					requireAdmin();
					const { params, canonical } = parseParams(url, { range: { values: RANGE_IDS } });
					const { token, accountId } = requireApiToken(env);
					return await cached(ctx, scoped(url.pathname), canonical, 120, async () => {
						const body = await fetchChanges(token, accountId, params.range);
						return { body, cacheable: body.entries.ok };
					});
				}

				case "/api/users": {
					requireAdmin();
					const { canonical } = parseParams(url, NO_PARAMS);
					const { token, accountId } = requireApiToken(env);
					return await cached(ctx, scoped(url.pathname), canonical, 300, async () => {
						const body = await fetchUserList(token, accountId);
						return { body, cacheable: body.users.length > 0 };
					});
				}

				case "/api/user": {
					requireAdmin();
					const lowered = new URL(url);
					const email = url.searchParams.get("email");
					if (email !== null) lowered.searchParams.set("email", email.toLowerCase());
					const { params, canonical } = parseParams(lowered, { email: EMAIL_PARAM, range: { values: RANGE_IDS } });
					const { token, accountId } = requireApiToken(env);
					return await cached(ctx, scoped(url.pathname), canonical, TRAFFIC_CACHE_SECONDS[params.range], async () => ({
						body: await fetchUserDetail(token, accountId, params.email, params.range),
						cacheable: true,
					}));
				}

				default:
					return apiError("not_found");
			}
		} catch (err) {
			if (err instanceof BadRequestError) return apiError("bad_request", err.message);
			if (err instanceof ForbiddenError) return apiError("forbidden");
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
