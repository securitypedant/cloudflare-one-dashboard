import { graphql } from "./graphql.ts";
import { fetchSplittingWindow, RANGE_ROLLUP, resolveRange, type Rollup } from "./traffic.ts";
import type { RangeId, ReportId, ReportResponse, ReportRow } from "../shared/types.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface ReportSpec {
	node: (rollup: Rollup) => string;
	dimensions: string[];
	sum?: string[];
	uniq?: string[];
	/** Averages, weighted by a `sum` field when windows are merged. */
	avg?: { field: string; weight: string }[];
	/** Paired id/count arrays (e.g. DNS category ids and their query counts), merged by id. */
	arrays?: { ids: string; counts: string };
	/** Extra static filter clauses (GraphQL syntax). */
	filter?: string;
	order: string;
}

const cf1 = (name: string) => (rollup: Rollup) => `cf1${name}${rollup}Groups`;

/**
 * Whitelisted aggregate queries behind /api/report. Field names verified by schema introspection
 * against cf1Gateway{Dns,Http,Network,NetworkSession}{1h,1d}Groups.
 */
export const REPORTS: Record<ReportId, ReportSpec> = {
	coverage_dns: { node: cf1("GatewayDns"), dimensions: ["coloName", "country"], sum: ["queries"], order: "sum_queries_DESC" },
	coverage_sessions: {
		node: cf1("GatewayNetworkSession"),
		dimensions: ["ingressColoName", "sourceCountry"],
		sum: ["sessions", "bytesTotal"],
		order: "sum_sessions_DESC",
	},
	entry_exit: {
		node: cf1("GatewayNetworkSession"),
		dimensions: ["ingressColoName", "egressColoName", "onRamp", "offramp"],
		sum: ["sessions", "bytesTotal"],
		order: "sum_sessions_DESC",
	},
	perf_pop: {
		node: cf1("GatewayNetworkSession"),
		dimensions: ["ingressColoName"],
		sum: ["sessions"],
		avg: [{ field: "tcpHandshakeMs", weight: "sessions" }],
		order: "sum_sessions_DESC",
	},
	perf_country: {
		node: cf1("GatewayNetworkSession"),
		dimensions: ["sourceCountry"],
		sum: ["sessions"],
		avg: [{ field: "tcpHandshakeMs", weight: "sessions" }],
		order: "sum_sessions_DESC",
	},
	sec_dns: { node: cf1("GatewayDns"), dimensions: ["resolverDecision", "country", "coloName"], sum: ["queries"], order: "sum_queries_DESC" },
	sec_http: {
		node: cf1("GatewayHttp"),
		dimensions: ["action", "country"],
		sum: ["requests", "dlpMatchedRequestsTotal", "avBlockedFiles", "isolatedRequests"],
		order: "sum_requests_DESC",
	},
	sec_network: { node: cf1("GatewayNetwork"), dimensions: ["action", "sourceCountry", "coloName"], sum: ["requests"], order: "sum_requests_DESC" },
	sec_categories: {
		node: cf1("GatewayDns"),
		dimensions: ["country"],
		sum: ["queries"],
		arrays: { ids: "queryCategoryIdArray", counts: "queryCategoryIdCountArray" },
		order: "sum_queries_DESC",
	},
	sec_blocked_categories: {
		node: cf1("GatewayDns"),
		dimensions: ["country"],
		sum: ["queries"],
		arrays: { ids: "queryCategoryIdArray", counts: "queryCategoryIdCountArray" },
		filter: 'resolverDecision_like: "blocked%"',
		order: "sum_queries_DESC",
	},
};

export function buildReportQuery(spec: ReportSpec, rollup: Rollup): string {
	const sums = [...(spec.sum ?? []), ...(spec.arrays ? [spec.arrays.ids, spec.arrays.counts] : [])];
	const blocks = [
		sums.length ? `sum { ${sums.join(" ")} }` : "",
		spec.uniq?.length ? `uniq { ${spec.uniq.join(" ")} }` : "",
		spec.avg?.length ? `avg { ${spec.avg.map((a) => a.field).join(" ")} }` : "",
	].filter(Boolean);
	return `query ($accountTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      groups: ${spec.node(rollup)}(
        filter: { datetime_geq: $start, datetime_lt: $end${spec.filter ? `, ${spec.filter}` : ""} }
        limit: 10000
        orderBy: [${spec.order}]
      ) {
        ${blocks.join("\n        ")}
        dimensions { ${spec.dimensions.join(" ")} }
      }
    }
  }
}`;
}

interface RawRow {
	dimensions: Record<string, string | null>;
	sum?: Record<string, number | number[]>;
	uniq?: Record<string, number>;
	avg?: Record<string, number>;
}

/** Normalise raw groups and merge duplicates from split windows (sums add, distinct counts max, averages weighted). */
export function mergeRows(spec: ReportSpec, raw: RawRow[]): ReportRow[] {
	const merged = new Map<string, ReportRow>();
	for (const r of raw) {
		const dims = Object.fromEntries(spec.dimensions.map((d) => [d, (r.dimensions[d] ?? "").toString()]));
		const id = spec.dimensions.map((d) => dims[d]).join("\u0000");
		const row = merged.get(id) ?? { dims, sum: {}, uniq: {}, avg: {}, arrays: {} };
		for (const f of spec.sum ?? []) row.sum[f] = (row.sum[f] ?? 0) + Number(r.sum?.[f] ?? 0);
		for (const f of spec.uniq ?? []) row.uniq[f] = Math.max(row.uniq[f] ?? 0, r.uniq?.[f] ?? 0);
		for (const { field, weight } of spec.avg ?? []) {
			const w = Number(r.sum?.[weight] ?? 0);
			const prevW = (row.sum[weight] ?? 0) - w; // row.sum already includes this window's weight
			const prev = row.avg[field] ?? 0;
			const value = r.avg?.[field] ?? 0;
			row.avg[field] = prevW + w > 0 ? (prev * prevW + value * w) / (prevW + w) : value;
		}
		if (spec.arrays) {
			const ids = (r.sum?.[spec.arrays.ids] as number[] | undefined) ?? [];
			const counts = (r.sum?.[spec.arrays.counts] as number[] | undefined) ?? [];
			ids.forEach((catId, i) => {
				row.arrays[catId] = (row.arrays[catId] ?? 0) + (counts[i] ?? 0);
			});
		}
		merged.set(id, row);
	}
	return [...merged.values()];
}

export async function fetchReport(token: string, accountId: string, id: ReportId, rangeId: RangeId): Promise<ReportResponse> {
	const spec = REPORTS[id];
	const rollup = RANGE_ROLLUP[rangeId];
	const { start, end } = resolveRange(rangeId);
	const source = spec.node(rollup);
	const base = { id, source, range: { id: rangeId, start: start.toISOString(), end: end.toISOString() } };
	const query = buildReportQuery(spec, rollup);
	try {
		const raw = await fetchSplittingWindow(
			async (from: Date, to: Date) => {
				const vars = { accountTag: accountId, start: from.toISOString(), end: to.toISOString() };
				const { data, errors } = await graphql<{ viewer: { accounts: { groups: RawRow[] | null }[] } }>(token, query, vars);
				const rows = data?.viewer.accounts[0]?.groups;
				if (errors.length || !rows) throw new Error(errors.map((e) => e.message).join("; ") || "No data returned");
				return rows;
			},
			start,
			end,
			rollup === "1d" ? DAY : HOUR,
		);
		return { ...base, rows: mergeRows(spec, raw) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		console.error(JSON.stringify({ msg: "report query failed", id, source, rangeId, error }));
		return { ...base, rows: [], error };
	}
}
