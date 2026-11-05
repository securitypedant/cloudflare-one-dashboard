/** Helpers that turn bucketed rows into chart series (top N keys plus an optional total). */

export interface Series {
	key: string;
	label: string;
	color: string;
	values: (number | null)[];
	/** Drawn dashed and on top (e.g. the total). */
	emphasis?: boolean;
}

export interface SeriesSet {
	buckets: string[];
	series: Series[];
}

export const SERIES_COLORS = ["#38bdf8", "#a78bfa", "#4ade80", "#f472b6", "#facc15", "#fb923c", "#2dd4bf", "#f87171"];
export const TOTAL_COLOR = "#e2e8f0";

interface Opts<T> {
	t: (r: T) => string;
	key: (r: T) => string;
	value: (r: T) => number;
	label?: (key: string) => string;
	/** Number of individual keys to draw (largest totals first). */
	top?: number;
	/** Only draw this key (e.g. the location selected on the map). */
	only?: string | null;
	/** Add a total line across all keys. */
	total?: boolean | string;
}

const sortedBuckets = <T,>(rows: T[], t: (r: T) => string) => [...new Set(rows.map(t))].sort();

/** Sum `value` per bucket per key; draw the top keys (or one key) and optionally the total. */
export function buildSeries<T>(rows: T[], { t, key, value, label = (k) => k, top = 6, only, total }: Opts<T>): SeriesSet {
	const buckets = sortedBuckets(rows, t);
	const index = new Map(buckets.map((b, i) => [b, i]));
	const byKey = new Map<string, number[]>();
	const sums = new Map<string, number>();
	const totals = new Array(buckets.length).fill(0);
	for (const r of rows) {
		const k = key(r);
		const i = index.get(t(r))!;
		const v = value(r) || 0;
		const arr = byKey.get(k) ?? byKey.set(k, new Array(buckets.length).fill(0)).get(k)!;
		arr[i] += v;
		totals[i] += v;
		sums.set(k, (sums.get(k) ?? 0) + v);
	}
	const keys = only ? (byKey.has(only) ? [only] : []) : [...sums].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k]) => k);
	const series: Series[] = keys.map((k, i) => ({ key: k, label: label(k), color: SERIES_COLORS[i % SERIES_COLORS.length], values: byKey.get(k)! }));
	if (total && !only) series.unshift({ key: "__total", label: typeof total === "string" ? total : "Total", color: TOTAL_COLOR, values: totals, emphasis: true });
	return { buckets, series };
}

/** Weighted average of `value` per bucket per key (e.g. handshake ms weighted by sessions). */
export function buildAvgSeries<T>(rows: T[], opts: Opts<T> & { weight: (r: T) => number }): SeriesSet {
	const { t, key, value, weight, label = (k) => k, top = 6, only, total } = opts;
	const buckets = sortedBuckets(rows, t);
	const index = new Map(buckets.map((b, i) => [b, i]));
	const acc = new Map<string, { w: number[]; vw: number[]; sum: number }>();
	const all = { w: new Array(buckets.length).fill(0), vw: new Array(buckets.length).fill(0) };
	for (const r of rows) {
		const k = key(r);
		const i = index.get(t(r))!;
		const w = weight(r) || 0;
		const v = value(r);
		if (!Number.isFinite(v) || w <= 0) continue;
		const a = acc.get(k) ?? acc.set(k, { w: new Array(buckets.length).fill(0), vw: new Array(buckets.length).fill(0), sum: 0 }).get(k)!;
		a.w[i] += w;
		a.vw[i] += v * w;
		a.sum += w;
		all.w[i] += w;
		all.vw[i] += v * w;
	}
	const avg = (vw: number[], w: number[]) => vw.map((x, i) => (w[i] > 0 ? x / w[i] : null));
	const keys = only ? (acc.has(only) ? [only] : []) : [...acc].sort((a, b) => b[1].sum - a[1].sum).slice(0, top).map(([k]) => k);
	const series: Series[] = keys.map((k, i) => ({ key: k, label: label(k), color: SERIES_COLORS[i % SERIES_COLORS.length], values: avg(acc.get(k)!.vw, acc.get(k)!.w) }));
	if (total && !only) series.unshift({ key: "__total", label: typeof total === "string" ? total : "Overall", color: TOTAL_COLOR, values: avg(all.vw, all.w), emphasis: true });
	return { buckets, series };
}

/** Change from the first to the last non-empty value, as a fraction (null when not comparable). */
export function seriesChange(values: (number | null)[]): number | null {
	const vals = values.filter((v): v is number => v !== null);
	if (vals.length < 2 || !vals[0]) return null;
	return (vals[vals.length - 1] - vals[0]) / vals[0];
}
