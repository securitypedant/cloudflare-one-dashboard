import { COUNTRIES } from "../shared/countries.ts";
import { graphql } from "./graphql.ts";
import { getCoverage, isCovered, logpushSourceFor, queryAggregates, queryAggregateSeries } from "./logpush.ts";
import {
	DATASETS,
	RANGE_HOURS,
	type TimelineResponse,
	unavailableReason,
	type DatasetId,
	type MapMode,
	type Pop,
	type RangeId,
	type TrafficLayer,
	type TrafficPoint,
	type TrafficResponse,
	type UnmappedEntry,
} from "../shared/types.ts";

export type Rollup = "1h" | "1d";

/** cf1 rollup to use per range: hourly up to 31 days, daily beyond (per node `settings`). */
export const RANGE_ROLLUP: Record<RangeId, Rollup> = { "24h": "1h", "7d": "1h", "30d": "1d", "90d": "1d" };

export interface LayerQuery {
	node: (rollup: Rollup) => string;
	dimension: string;
	/** `count` for adaptive datasets, a `sum` field, or a `uniq` (distinct count) field. */
	metric: "count" | { sum: string } | { uniq: string };
	/** Time bucket dimension per rollup, for timelines. Defaults to `datetime` (cf1 rollups). */
	time?: Record<Rollup, string>;
}

const cf1 = (name: string) => (rollup: Rollup) => `cf1${name}${rollup}Groups`;

/** GraphQL Analytics nodes backing each dataset and map mode. `null` = not answerable (see shared DATASETS). */
export const LAYER_QUERIES: Record<DatasetId, Record<MapMode, LayerQuery | null>> = {
	dns: {
		pop: { node: cf1("GatewayDns"), dimension: "coloName", metric: { sum: "queries" } },
		country: { node: cf1("GatewayDns"), dimension: "country", metric: { sum: "queries" } },
	},
	http: {
		// The cf1 HTTP rollups have no data center dimension, so use the adaptive dataset (max 30 days).
		pop: {
			node: () => "gatewayL7RequestsAdaptiveGroups",
			dimension: "coloCode",
			metric: "count",
			time: { "1h": "datetimeHour", "1d": "date" },
		},
		country: { node: cf1("GatewayHttp"), dimension: "country", metric: { sum: "requests" } },
	},
	network: {
		pop: { node: cf1("GatewayNetwork"), dimension: "coloName", metric: { sum: "requests" } },
		country: { node: cf1("GatewayNetwork"), dimension: "sourceCountry", metric: { sum: "requests" } },
	},
	bandwidth: {
		pop: { node: cf1("GatewayNetworkSession"), dimension: "ingressColoName", metric: { sum: "bytesTotal" } },
		country: { node: cf1("GatewayNetworkSession"), dimension: "sourceCountry", metric: { sum: "bytesTotal" } },
	},
	access: {
		pop: null,
		country: { node: cf1("AccessLogins"), dimension: "country", metric: { sum: "logins" } },
	},
	// Distinct users / devices seen by Gateway DNS (the broadest dataset). Not available from Logpush aggregates.
	users: {
		pop: { node: cf1("GatewayDns"), dimension: "coloName", metric: { uniq: "users" } },
		country: { node: cf1("GatewayDns"), dimension: "country", metric: { uniq: "users" } },
	},
	devices: {
		pop: { node: cf1("GatewayDns"), dimension: "coloName", metric: { uniq: "devices" } },
		country: { node: cf1("GatewayDns"), dimension: "country", metric: { uniq: "devices" } },
	},
};

function metricSelection(metric: LayerQuery["metric"]): { select: string; order: string } {
	if (metric === "count") return { select: "count", order: "orderBy: [count_DESC]" };
	if ("sum" in metric) return { select: `sum { ${metric.sum} }`, order: `orderBy: [sum_${metric.sum}_DESC]` };
	return { select: `uniq { ${metric.uniq} }`, order: "" };
}

const UNATTRIBUTED_COUNTRIES = new Set(["", "UNKNOWN", "XX"]);

export const timeDimension = (layer: LayerQuery, rollup: Rollup) => layer.time?.[rollup] ?? "datetime";

export function buildLayerQuery(layer: LayerQuery, rollup: Rollup, withTime = false): string {
	const { select, order } = metricSelection(layer.metric);
	const dims = withTime ? `${layer.dimension} ${timeDimension(layer, rollup)}` : layer.dimension;
	return `query ($accountTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      groups: ${layer.node(rollup)}(
        filter: { datetime_geq: $start, datetime_lt: $end }
        limit: 10000
        ${order}
      ) {
        ${select}
        dimensions { ${dims} }
      }
    }
  }
}`;
}

interface GroupRow {
	count?: number;
	sum?: Record<string, number>;
	uniq?: Record<string, number>;
	dimensions: Record<string, string | null>;
}

interface LayerQueryResult {
	viewer: { accounts: { groups: GroupRow[] | null }[] };
}

const rowValue = (m: LayerQuery["metric"], row: GroupRow) =>
	m === "count" ? (row.count ?? 0) : "sum" in m ? (row.sum?.[m.sum] ?? 0) : (row.uniq?.[m.uniq] ?? 0);
const isDistinct = (m: LayerQuery["metric"]) => m !== "count" && "uniq" in m;
const rowKey = (layer: LayerQuery, row: GroupRow) => (row.dimensions[layer.dimension] ?? "").trim().toUpperCase();

/**
 * Collapse GraphQL groups into key -> value, normalising keys to upper case. Duplicate keys (split
 * windows, case differences) are summed, except distinct counts, which can't be added: the largest
 * window's count is kept as a lower bound.
 */
export function aggregateRows(layer: LayerQuery, rows: GroupRow[]): Map<string, number> {
	const totals = new Map<string, number>();
	for (const row of rows) {
		const key = rowKey(layer, row);
		const value = rowValue(layer.metric, row);
		const prev = totals.get(key) ?? 0;
		totals.set(key, isDistinct(layer.metric) ? Math.max(prev, value) : prev + value);
	}
	return totals;
}

export function toLayer(
	mode: MapMode,
	source: string,
	totals: Map<string, number>,
	popsByIata: Map<string, Pop>,
	backend: "logpush" | "graphql" = "graphql",
): TrafficLayer {
	const points: TrafficPoint[] = [];
	const unmapped: UnmappedEntry[] = [];
	let unattributed = 0;
	let total = 0;

	for (const [key, value] of totals) {
		total += value;
		if (mode === "pop") {
			const pop = popsByIata.get(key);
			if (!key) unattributed += value;
			else if (pop) points.push({ key, name: pop.city, country: pop.country, lat: pop.lat, lon: pop.lon, value });
			else unmapped.push({ key, value });
		} else {
			const country = COUNTRIES[key];
			if (UNATTRIBUTED_COUNTRIES.has(key)) unattributed += value;
			else if (country) points.push({ key, name: country.name, country: key, lat: country.lat, lon: country.lon, value });
			else unmapped.push({ key, value });
		}
	}

	points.sort((a, b) => b.value - a.value);
	unmapped.sort((a, b) => b.value - a.value);
	return { status: "ok", backend, source, total, points, unattributed, unmapped };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Hourly rollups: a rolling window ending at the current minute.
 * Daily rollups: whole UTC days (including today), so the window never exceeds the node's maxDuration.
 * `offset` shifts the window back by whole range lengths (1 = the previous period, for trends).
 */
export function resolveRange(rangeId: RangeId, now = new Date(), offset = 0): { start: Date; end: Date } {
	const hours = RANGE_HOURS[rangeId];
	const shift = offset * hours * HOUR;
	const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - shift);
	if (RANGE_ROLLUP[rangeId] === "1d") {
		const startOfToday = Math.floor((end.getTime() + shift) / DAY) * DAY;
		return { start: new Date(startOfToday - (hours / 24 - 1) * DAY - shift), end };
	}
	return { start: new Date(end.getTime() - hours * HOUR), end };
}

const TOO_MUCH_DATA = /read too much data/i;
const MAX_SPLIT_DEPTH = 4;

/**
 * The GraphQL API caps how much data one query may read, which busy accounts hit on long ranges.
 * When that happens, split the window in half (on rollup boundaries) and retry each half
 * sequentially, up to 2^MAX_SPLIT_DEPTH sub-windows. Windows are half-open, so rows are never
 * double counted.
 */
export async function fetchSplittingWindow<T>(
	fetchWindow: (start: Date, end: Date) => Promise<T[]>,
	start: Date,
	end: Date,
	align: number,
	depth = 0,
): Promise<T[]> {
	try {
		return await fetchWindow(start, end);
	} catch (err) {
		const mid = Math.floor((start.getTime() + end.getTime()) / 2 / align) * align;
		const canSplit = depth < MAX_SPLIT_DEPTH && mid > start.getTime() && mid < end.getTime();
		if (!canSplit || !(err instanceof Error && TOO_MUCH_DATA.test(err.message))) throw err;
		const first = await fetchSplittingWindow(fetchWindow, start, new Date(mid), align, depth + 1);
		const second = await fetchSplittingWindow(fetchWindow, new Date(mid), end, align, depth + 1);
		return [...first, ...second];
	}
}

/** Answer from Logpush aggregates in D1 when they fully cover the window; otherwise null. */
async function fromLogpush(
	db: D1Database,
	dataset: DatasetId,
	mode: MapMode,
	start: Date,
	end: Date,
	popsByIata: Map<string, Pop>,
): Promise<TrafficLayer | null> {
	const source = logpushSourceFor(dataset, mode);
	if (!source) return null;
	const startSec = Math.floor(start.getTime() / 1000);
	const endSec = Math.floor(end.getTime() / 1000);
	try {
		const coverage = (await getCoverage(db)).find((c) => c.source === source);
		if (!isCovered(coverage, startSec, endSec, Math.floor(Date.now() / 1000))) return null;
		const totals = await queryAggregates(db, dataset, mode, startSec, endSec);
		return toLayer(mode, `Logpush ${source}`, totals, popsByIata, "logpush");
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		console.error(JSON.stringify({ msg: "logpush aggregate query failed; using GraphQL", dataset, mode, error }));
		return null;
	}
}

export interface TrafficOptions {
	token: string;
	accountId: string;
	db?: D1Database;
	dataset: DatasetId;
	mode: MapMode;
	rangeId: RangeId;
	/** 0 = current period, 1 = previous period of the same length. */
	offset?: number;
	pops: Pop[];
}

export async function fetchTraffic(opts: TrafficOptions): Promise<TrafficResponse> {
	const { token, accountId, db, dataset, mode, rangeId, pops, offset = 0 } = opts;
	const { start, end } = resolveRange(rangeId, new Date(), offset);
	const variables = { accountTag: accountId, start: start.toISOString(), end: end.toISOString() };
	const base = { accountId, dataset, mode, range: { id: rangeId, start: variables.start, end: variables.end } };
	const respond = (layer: TrafficLayer): TrafficResponse => ({ ...base, generatedAt: new Date().toISOString(), layer });
	const popsByIata = new Map(pops.map((p) => [p.iata, p]));

	const logpushLayer = db && (await fromLogpush(db, dataset, mode, start, end, popsByIata));
	if (logpushLayer) return respond(logpushLayer);

	const layer = LAYER_QUERIES[dataset][mode];
	const reason = unavailableReason(dataset, mode, rangeId);
	if (!layer || reason) return respond({ status: "unavailable", reason: reason ?? "Not available." });

	const rollup = RANGE_ROLLUP[rangeId];
	const source = layer.node(rollup);
	try {
		const rows = await queryGraphQL(token, accountId, layer, rollup, start, end, false);
		return respond(toLayer(mode, source, aggregateRows(layer, rows), popsByIata));
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		console.error(JSON.stringify({ msg: "graphql layer query failed", dataset, mode, source, rangeId, offset, error }));
		return respond({ status: "error", source, error });
	}
}

async function queryGraphQL(
	token: string,
	accountId: string,
	layer: LayerQuery,
	rollup: Rollup,
	start: Date,
	end: Date,
	withTime: boolean,
): Promise<GroupRow[]> {
	const query = buildLayerQuery(layer, rollup, withTime);
	const fetchWindow = async (from: Date, to: Date): Promise<GroupRow[]> => {
		const vars = { accountTag: accountId, start: from.toISOString(), end: to.toISOString() };
		const { data, errors } = await graphql<LayerQueryResult>(token, query, vars);
		const rows = data?.viewer.accounts[0]?.groups;
		if (errors.length || !rows) throw new Error(errors.map((e) => e.message).join("; ") || "No data returned");
		return rows;
	};
	return fetchSplittingWindow(fetchWindow, start, end, rollup === "1d" ? DAY : HOUR);
}

/** Normalise a GraphQL time dimension ("2026-11-03T10:00:00Z" or "2026-11-03") to an ISO bucket start. */
export const bucketStart = (v: string | null | undefined) => (v ? new Date(v.length === 10 ? `${v}T00:00:00Z` : v).toISOString() : "");

/**
 * Per-bucket values for the time slider: hourly frames for 24h/7d, daily for 30d/90d. Locations and
 * totals come from the same rows, so the frames and the overall layer always agree.
 */
export async function fetchTimeline(opts: TrafficOptions): Promise<TimelineResponse> {
	const { token, accountId, db, dataset, mode, rangeId, pops } = opts;
	const { start, end } = resolveRange(rangeId);
	const bucket = RANGE_ROLLUP[rangeId] === "1d" ? "day" : "hour";
	const base = { dataset, mode, bucket, range: { id: rangeId, start: start.toISOString(), end: end.toISOString() } } as const;
	const popsByIata = new Map(pops.map((p) => [p.iata, p]));
	const distinct = DATASETS[dataset].distinct ?? false;
	const toFrames = (rows: { t: string; key: string; value: number }[]) => {
		const byTime = new Map<string, Record<string, number>>();
		const totals = new Map<string, number>();
		for (const { t, key, value } of rows) {
			const frame = byTime.get(t) ?? {};
			frame[key] = distinct ? Math.max(frame[key] ?? 0, value) : (frame[key] ?? 0) + value;
			byTime.set(t, frame);
			totals.set(key, distinct ? Math.max(totals.get(key) ?? 0, value) : (totals.get(key) ?? 0) + value);
		}
		const frames = [...byTime].sort(([a], [b]) => a.localeCompare(b)).map(([t, values]) => ({ t, values }));
		return { frames, totals };
	};

	// Logpush aggregates when they cover the window (hour buckets in D1, summed to days for long ranges).
	const lpSource = logpushSourceFor(dataset, mode);
	if (db && lpSource) {
		const s = Math.floor(start.getTime() / 1000);
		const e = Math.floor(end.getTime() / 1000);
		try {
			const coverage = (await getCoverage(db)).find((c) => c.source === lpSource);
			if (isCovered(coverage, s, e, Math.floor(Date.now() / 1000))) {
				const rows = await queryAggregateSeries(db, dataset, mode, s, e, bucket === "day" ? 86400 : 3600);
				const { frames, totals } = toFrames(rows.map((r) => ({ t: new Date(r.bucket * 1000).toISOString(), key: r.key, value: r.value })));
				return { ...base, frames, layer: toLayer(mode, `Logpush ${lpSource}`, totals, popsByIata, "logpush") };
			}
		} catch (err) {
			console.error(JSON.stringify({ msg: "logpush timeline failed; using GraphQL", dataset, mode, error: String(err) }));
		}
	}

	const layer = LAYER_QUERIES[dataset][mode];
	const reason = unavailableReason(dataset, mode, rangeId);
	if (!layer || reason) return { ...base, frames: [], layer: { status: "unavailable", reason: reason ?? "Not available." } };
	const rollup = RANGE_ROLLUP[rangeId];
	const source = layer.node(rollup);
	try {
		const rows = await queryGraphQL(token, accountId, layer, rollup, start, end, true);
		const tdim = timeDimension(layer, rollup);
		const { frames, totals } = toFrames(
			rows.map((r) => ({ t: bucketStart(r.dimensions[tdim]), key: rowKey(layer, r), value: rowValue(layer.metric, r) })),
		);
		return { ...base, frames, layer: toLayer(mode, source, totals, popsByIata) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		console.error(JSON.stringify({ msg: "graphql timeline failed", dataset, mode, source, rangeId, error }));
		return { ...base, frames: [], layer: { status: "error", source, error } };
	}
}
