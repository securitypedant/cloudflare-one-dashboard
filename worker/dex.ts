import { getCoverage, queryMetrics, queryMetricSeries } from "./logpush.ts";
import { RANGE_ROLLUP, resolveRange } from "./traffic.ts";
import type { DexResponse, DexRow, MapMode, RangeId } from "../shared/types.ts";

/** DEX HTTP test and WARP handshake averages per POP or country, from Logpush aggregates in D1. */
export async function fetchDex(db: D1Database, mode: MapMode, rangeId: RangeId, series = false): Promise<DexResponse> {
	const { start, end } = resolveRange(rangeId);
	const range = { id: rangeId, start: start.toISOString(), end: end.toISOString() };
	const coverage = await getCoverage(db);
	const available = coverage.some((c) => c.source === "dex_application_tests" || c.source === "dex_device_state_events");
	if (!available) return { available, mode, range, rows: [] };

	const bucket = RANGE_ROLLUP[rangeId] === "1d" ? ("day" as const) : ("hour" as const);
	const s = Math.floor(start.getTime() / 1000);
	const e = Math.floor(end.getTime() / 1000);
	const metrics: { bucket?: number; metric: string; key: string; n: number; total: number }[] = series
		? await queryMetricSeries(db, mode, s, e, bucket === "day" ? 86400 : 3600)
		: await queryMetrics(db, mode, s, e);
	const rows = new Map<string, DexRow>();
	for (const { bucket: b, metric, key, n, total } of metrics) {
		if (!key || key === "NONE") continue;
		const t = b !== undefined ? new Date(b * 1000).toISOString() : undefined;
		const id = t ? `${t}|${key}` : key;
		const row = rows.get(id) ?? { key, ...(t ? { t } : {}), httpAvgMs: null, httpTests: 0, httpFailures: 0, warpHandshakeAvgMs: null, warpSamples: 0 };
		if (metric === "dex_http_ms") row.httpAvgMs = n ? total / n : null;
		if (metric === "dex_http_fail") {
			row.httpTests = n;
			row.httpFailures = total;
		}
		if (metric === "warp_handshake_ms") {
			row.warpHandshakeAvgMs = n ? total / n : null;
			row.warpSamples = n;
		}
		rows.set(id, row);
	}
	return { available, mode, range, rows: [...rows.values()].sort((a, b) => b.httpTests + b.warpSamples - (a.httpTests + a.warpSamples)), ...(series ? { bucket } : {}) };
}
