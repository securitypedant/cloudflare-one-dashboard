import { fetchPops } from "./pops.ts";
import { fetchTimeline, fetchTraffic } from "./traffic.ts";
import { fetchReport } from "./reports.ts";
import { fetchVendors } from "./vendors.ts";
import { fetchCategories } from "./categories.ts";
import { fetchDex } from "./dex.ts";
import { fetchUserLocations } from "./userLocations.ts";
import { getCoverage, handleQueue, LOGPUSH_SOURCES, type R2EventNotification } from "./logpush.ts";
import {
	DATASET_IDS,
	MAP_MODES,
	RANGE_IDS,
	REPORT_IDS,
	type ApiError,
	type DatasetId,
	type MapMode,
	type RangeId,
	type ReportId,
} from "../shared/types.ts";

/**
 * `sharedMaxAge` lets Workers Cache serve the response without re-running the Worker, which
 * protects the GraphQL API budget. Safe because each deployment serves a single account and
 * every caller has already passed Cloudflare Access.
 */
const json = (body: unknown, init: ResponseInit & { sharedMaxAge?: number } = {}) => {
	const { sharedMaxAge = 0, ...rest } = init;
	const cacheControl = sharedMaxAge ? `public, max-age=60, s-maxage=${sharedMaxAge}` : "no-store";
	return Response.json(body, { ...rest, headers: { "Cache-Control": cacheControl, ...rest.headers } });
};

const TRAFFIC_CACHE_SECONDS: Record<RangeId, number> = { "24h": 300, "7d": 900, "30d": 3600, "90d": 3600 };
// Logpush aggregates are cheap to query and update every few minutes.
const LOGPUSH_CACHE_SECONDS = 120;

const error = (status: number, message: string) => json({ error: message } satisfies ApiError, { status });

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return new Response(null, { status: 404 });
		if (request.method !== "GET") return error(405, "Method not allowed");

		try {
			switch (url.pathname) {
				case "/api/pops":
					return json(await fetchPops(), { sharedMaxAge: 86400 });

				case "/api/logpush/status": {
					const coverage = await getCoverage(env.DB);
					const sources = Object.entries(LOGPUSH_SOURCES).map(([source, spec]) => {
						const c = coverage.find((x) => x.source === source);
						return {
							source,
							fields: spec.fields,
							firstRecord: c ? new Date(c.firstRecord * 1000).toISOString() : null,
							lastRecord: c ? new Date(c.lastRecord * 1000).toISOString() : null,
						};
					});
					return json({ sources });
				}

				case "/api/traffic":
				case "/api/timeline": {
					const rangeId = url.searchParams.get("range") as RangeId;
					const dataset = url.searchParams.get("dataset") as DatasetId;
					const mode = url.searchParams.get("mode") as MapMode;
					const offset = Number(url.searchParams.get("offset") ?? 0);
					if (!RANGE_IDS.includes(rangeId)) return error(400, `range must be one of ${RANGE_IDS.join(", ")}`);
					if (!DATASET_IDS.includes(dataset)) return error(400, `dataset must be one of ${DATASET_IDS.join(", ")}`);
					if (!MAP_MODES.includes(mode)) return error(400, `mode must be one of ${MAP_MODES.join(", ")}`);
					if (offset !== 0 && offset !== 1) return error(400, "offset must be 0 or 1");
					if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
						return error(500, "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be configured for this Worker.");
					}
					const opts = {
						token: env.CLOUDFLARE_API_TOKEN,
						accountId: env.CLOUDFLARE_ACCOUNT_ID,
						db: env.DB,
						dataset,
						mode,
						rangeId,
						offset,
						pops: mode === "pop" ? await fetchPops() : [],
					};
					const result = url.pathname === "/api/timeline" ? await fetchTimeline(opts) : await fetchTraffic(opts);
					const { layer } = result;
					const sharedMaxAge =
						layer.status === "error" ? 0 : layer.status === "ok" && layer.backend === "logpush" ? LOGPUSH_CACHE_SECONDS : TRAFFIC_CACHE_SECONDS[rangeId];
					return json(result, { sharedMaxAge });
				}

				case "/api/report": {
					const id = url.searchParams.get("id") as ReportId;
					const rangeId = url.searchParams.get("range") as RangeId;
					if (!REPORT_IDS.includes(id)) return error(400, `id must be one of ${REPORT_IDS.join(", ")}`);
					if (!RANGE_IDS.includes(rangeId)) return error(400, `range must be one of ${RANGE_IDS.join(", ")}`);
					const report = await fetchReport(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID, id, rangeId);
					return json(report, { sharedMaxAge: report.error ? 0 : TRAFFIC_CACHE_SECONDS[rangeId] });
				}

				case "/api/dex": {
					const rangeId = url.searchParams.get("range") as RangeId;
					const mode = url.searchParams.get("mode") as MapMode;
					if (!RANGE_IDS.includes(rangeId)) return error(400, `range must be one of ${RANGE_IDS.join(", ")}`);
					if (!MAP_MODES.includes(mode)) return error(400, `mode must be one of ${MAP_MODES.join(", ")}`);
					return json(await fetchDex(env.DB, mode, rangeId), { sharedMaxAge: LOGPUSH_CACHE_SECONDS });
				}

				case "/api/user-locations": {
					const rangeId = url.searchParams.get("range") as RangeId;
					if (!RANGE_IDS.includes(rangeId)) return error(400, `range must be one of ${RANGE_IDS.join(", ")}`);
					return json(await fetchUserLocations(env.DB, rangeId, await fetchPops()), { sharedMaxAge: LOGPUSH_CACHE_SECONDS });
				}

				case "/api/vendors":
					return json(await fetchVendors(), { sharedMaxAge: 86400 });

				case "/api/categories":
					return json(await fetchCategories(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID), { sharedMaxAge: 86400 });

				default:
					return error(404, "Not found");
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(JSON.stringify({ msg: "api request failed", path: url.pathname, error: message }));
			return error(502, message);
		}
	},

	async queue(batch, env) {
		await handleQueue(batch, env);
	},
} satisfies ExportedHandler<Env, R2EventNotification>;
