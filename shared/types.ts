export const RANGE_IDS = ["24h", "7d", "30d", "90d"] as const;
export type RangeId = (typeof RANGE_IDS)[number];
export const RANGE_HOURS: Record<RangeId, number> = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30, "90d": 24 * 90 };

export const DATASET_IDS = ["dns", "http", "network", "bandwidth", "access", "users", "devices"] as const;
export type DatasetId = (typeof DATASET_IDS)[number];

export const MAP_MODES = ["pop", "country"] as const;
export type MapMode = (typeof MAP_MODES)[number];

export type Unit = "queries" | "requests" | "sessions" | "bytes" | "logins" | "users" | "devices";

export interface DatasetMeta {
	label: string;
	unit: Unit;
	/** Distinct counts: the same user/device can appear at several locations, so values don't add up to a total. */
	distinct?: boolean;
	/** Modes that the underlying analytics can't answer, with the reason. */
	unavailable?: Partial<Record<MapMode, string>>;
	/** Longest range (days) the underlying node supports per query, per mode. */
	maxDays?: Partial<Record<MapMode, number>>;
}

export const DATASETS: Record<DatasetId, DatasetMeta> = {
	dns: { label: "Gateway DNS", unit: "queries" },
	http: { label: "Gateway HTTP", unit: "requests", maxDays: { pop: 30 } },
	network: { label: "Gateway Network", unit: "sessions" },
	bandwidth: { label: "Network bandwidth", unit: "bytes" },
	access: {
		label: "Access logins",
		unit: "logins",
		unavailable: { pop: "Access login analytics do not record which Cloudflare data center handled the login." },
	},
	users: { label: "Users", unit: "users", distinct: true },
	devices: { label: "Devices", unit: "devices", distinct: true },
};

/** Returns why a dataset/mode/range combination can't be shown, or null if it can. */
export function unavailableReason(id: DatasetId, mode: MapMode, range: RangeId): string | null {
	const meta = DATASETS[id];
	const reason = meta.unavailable?.[mode];
	if (reason) return reason;
	const maxDays = meta.maxDays?.[mode];
	if (maxDays && RANGE_HOURS[range] > maxDays * 24) {
		return `${meta.label} by ${mode === "pop" ? "data center" : "country"} is only available for up to ${maxDays} days. Choose a shorter range.`;
	}
	return null;
}

export interface Pop {
	iata: string;
	city: string;
	country: string;
	region: string;
	lat: number;
	lon: number;
}

export interface TrafficPoint {
	key: string;
	name: string;
	country?: string;
	lat: number;
	lon: number;
	value: number;
}

export interface UnmappedEntry {
	key: string;
	value: number;
}

export type TrafficLayer =
	| {
			status: "ok";
			/** "logpush" = aggregated from Logpush files in D1; "graphql" = GraphQL Analytics API. */
			backend: "logpush" | "graphql";
			source: string;
			total: number;
			points: TrafficPoint[];
			/** Traffic with no usable location (e.g. country "UNKNOWN" for tunnel/WAN on-ramps). */
			unattributed: number;
			/** Keys that had traffic but could not be placed on the map. */
			unmapped: UnmappedEntry[];
	  }
	| { status: "unavailable"; reason: string }
	| { status: "error"; source: string; error: string };

export interface TrafficResponse {
	accountId: string;
	dataset: DatasetId;
	mode: MapMode;
	range: { id: RangeId; start: string; end: string };
	generatedAt: string;
	layer: TrafficLayer;
}

export interface TimelineFrame {
	/** ISO start of the hour/day bucket. */
	t: string;
	/** location key → value in that bucket */
	values: Record<string, number>;
}

export interface TimelineResponse {
	dataset: DatasetId;
	mode: MapMode;
	bucket: "hour" | "day";
	range: { id: RangeId; start: string; end: string };
	/** Totals over the whole range, with location metadata. */
	layer: TrafficLayer;
	frames: TimelineFrame[];
}

export const REPORT_IDS = [
	"coverage_dns",
	"coverage_sessions",
	"entry_exit",
	"entry_onramp",
	"perf_pop",
	"perf_country",
	"sec_dns",
	"sec_http",
	"sec_network",
	"sec_categories",
	"sec_blocked_categories",
] as const;
export type ReportId = (typeof REPORT_IDS)[number];

export interface ReportRow {
	dims: Record<string, string>;
	sum: Record<string, number>;
	uniq: Record<string, number>;
	avg: Record<string, number>;
	/** id → count, for paired id/count arrays such as DNS categories. */
	arrays: Record<number, number>;
}

export interface ReportResponse {
	id: ReportId;
	source: string;
	range: { id: RangeId; start: string; end: string };
	rows: ReportRow[];
	error?: string;
	/** Series mode: rows carry dims.datetime, bucketed by hour or day. */
	bucket?: "hour" | "day";
	/** True when a query hit the row limit, so the smallest rows may be missing. */
	truncated?: boolean;
}

export interface DexRow {
	/** POP IATA code or ISO country code. */
	key: string;
	/** Series mode: start of the hour/day bucket (ISO). */
	t?: string;
	httpAvgMs: number | null;
	httpTests: number;
	httpFailures: number;
	warpHandshakeAvgMs: number | null;
	warpSamples: number;
}

export interface DexResponse {
	/** False until any DEX Logpush data has been ingested. */
	available: boolean;
	mode: MapMode;
	range: { id: RangeId; start: string; end: string };
	rows: DexRow[];
	bucket?: "hour" | "day";
}

export interface UserLocationRow {
	/** Series mode: start of the hour/day bucket (ISO); isp is empty in series rows. */
	t?: string;
	country: string;
	state: string;
	city: string;
	isp: string;
	/** Data center the WARP client was connected to. */
	colo: string;
	/** Device-state samples (≈ device time connected from this place). */
	samples: number;
	handshakeAvgMs: number | null;
	/** City coordinates (GeoNames); null when the city couldn't be placed. */
	lat: number | null;
	lon: number | null;
	/** Distance from the city to the data center used, and to the nearest Cloudflare POP. */
	coloDistanceKm: number | null;
	nearestIata: string | null;
	nearestDistanceKm: number | null;
}

export interface UserLocationsResponse {
	/** False until device-state events with location fields have been ingested. */
	available: boolean;
	range: { id: RangeId; start: string; end: string };
	rows: UserLocationRow[];
	bucket?: "hour" | "day";
}

export interface Vendor {
	id: string;
	name: string;
	/** [lon, lat, city] */
	points: [number, number, string][];
}

export interface ApiError {
	error: string;
	/** Stable machine-readable code (bad_request, unauthorized, misconfigured, rate_limited, upstream_error, ...). */
	code?: string;
	/** Only for bad_request: which parameter was rejected. */
	detail?: string;
}
