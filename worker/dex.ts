import { getCoverage, queryMetrics } from "./logpush.ts";
import { resolveRange } from "./traffic.ts";
import type { DexResponse, DexRow, MapMode, RangeId } from "../shared/types.ts";

/** DEX HTTP test and WARP handshake averages per POP or country, from Logpush aggregates in D1. */
export async function fetchDex(db: D1Database, mode: MapMode, rangeId: RangeId): Promise<DexResponse> {
	const { start, end } = resolveRange(rangeId);
	const range = { id: rangeId, start: start.toISOString(), end: end.toISOString() };
	const coverage = await getCoverage(db);
	const available = coverage.some((c) => c.source === "dex_application_tests" || c.source === "dex_device_state_events");
	if (!available) return { available, mode, range, rows: [] };

	const metrics = await queryMetrics(db, mode, Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000));
	const rows = new Map<string, DexRow>();
	for (const { metric, key, n, total } of metrics) {
		if (!key || key === "NONE") continue;
		const row = rows.get(key) ?? { key, httpAvgMs: null, httpTests: 0, httpFailures: 0, warpHandshakeAvgMs: null, warpSamples: 0 };
		if (metric === "dex_http_ms") row.httpAvgMs = n ? total / n : null;
		if (metric === "dex_http_fail") {
			row.httpTests = n;
			row.httpFailures = total;
		}
		if (metric === "warp_handshake_ms") {
			row.warpHandshakeAvgMs = n ? total / n : null;
			row.warpSamples = n;
		}
		rows.set(key, row);
	}
	return { available, mode, range, rows: [...rows.values()].sort((a, b) => b.httpTests + b.warpSamples - (a.httpTests + a.warpSamples)) };
}
