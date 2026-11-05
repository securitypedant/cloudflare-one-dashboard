import type { DatasetId, MapMode } from "../shared/types.ts";

export type LogpushSource =
	| "gateway_dns"
	| "gateway_http"
	| "gateway_network"
	| "zero_trust_network_sessions"
	| "access_requests"
	| "dex_application_tests"
	| "dex_device_state_events";

type LogRecord = Record<string, unknown>;

interface Output {
	dataset: DatasetId;
	dimension: MapMode;
	keyField: string;
	/** Defaults to counting records. */
	value?: (record: LogRecord) => number;
}

export type MetricId = "dex_http_ms" | "dex_http_fail" | "warp_handshake_ms";

/** Averaged measurements: stored as (n, total) per hour so averages stay exact when summed. */
interface MetricOutput {
	metric: MetricId;
	dimension: MapMode;
	keyField: string;
	/** Measurement for this record, or null to skip it. */
	value: (record: LogRecord) => number | null;
}

/** User location (Cloudflare's ISP IP geolocation) × data center, for the User locations report. */
interface LocationOutput {
	countryField: string;
	stateField: string;
	cityField: string;
	ispField: string;
	coloField: string;
	/** Optional latency measurement averaged per row. */
	latency?: (record: LogRecord) => number | null;
}

interface SourceSpec {
	timeField: string;
	/** Fields the Logpush job must send (minimal set, keeps export volume and cost down). */
	fields: string[];
	outputs: Output[];
	metrics?: MetricOutput[];
	locations?: LocationOutput;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

const isHttpTest = (r: LogRecord) => String(r.TestType ?? "").toLowerCase() === "http";
/** DEX HTTP test duration: request start → response end (both relative to test start). */
const httpDuration = (r: LogRecord) => {
	if (!isHttpTest(r)) return null;
	const d = num(r.HTTPResponseEndMs) - num(r.HTTPRequestStartMs);
	return d > 0 ? d : null;
};
const httpFailed = (r: LogRecord) => {
	if (!isHttpTest(r)) return null;
	const status = num(r.HTTPStatusCode);
	return r.HTTPErrorMessage || status === 0 || status >= 400 ? 1 : 0;
};
const warpHandshake = (r: LogRecord) => {
	const v = num(r.HandshakeLatencyMs);
	return v > 0 ? v : null; // -1 = disconnected
};

/**
 * Logpush datasets → dashboard aggregates. Field names per
 * https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/
 * HTTP and Network firewall logs have no data center field; Network Session logs have no country.
 */
export const LOGPUSH_SOURCES: Record<LogpushSource, SourceSpec> = {
	gateway_dns: {
		timeField: "Datetime",
		fields: ["Datetime", "ColoCode", "SrcIPCountryCode"],
		outputs: [
			{ dataset: "dns", dimension: "pop", keyField: "ColoCode" },
			{ dataset: "dns", dimension: "country", keyField: "SrcIPCountryCode" },
		],
	},
	gateway_http: {
		timeField: "Datetime",
		fields: ["Datetime", "SourceIPCountryCode"],
		outputs: [{ dataset: "http", dimension: "country", keyField: "SourceIPCountryCode" }],
	},
	gateway_network: {
		timeField: "Datetime",
		fields: ["Datetime", "SourceIPCountryCode"],
		outputs: [{ dataset: "network", dimension: "country", keyField: "SourceIPCountryCode" }],
	},
	zero_trust_network_sessions: {
		timeField: "SessionStartTime",
		fields: ["SessionStartTime", "IngressColoName", "BytesReceived", "BytesSent"],
		outputs: [
			{ dataset: "network", dimension: "pop", keyField: "IngressColoName" },
			{
				dataset: "bandwidth",
				dimension: "pop",
				keyField: "IngressColoName",
				value: (r) => num(r.BytesReceived) + num(r.BytesSent),
			},
		],
	},
	access_requests: {
		timeField: "CreatedAt",
		fields: ["CreatedAt", "Country"],
		outputs: [{ dataset: "access", dimension: "country", keyField: "Country" }],
	},
	dex_application_tests: {
		timeField: "Timestamp",
		fields: ["Timestamp", "TestType", "ColoCode", "HTTPClientIPCountryISO", "HTTPRequestStartMs", "HTTPResponseEndMs", "HTTPStatusCode", "HTTPErrorMessage"],
		outputs: [],
		metrics: [
			{ metric: "dex_http_ms", dimension: "pop", keyField: "ColoCode", value: httpDuration },
			{ metric: "dex_http_ms", dimension: "country", keyField: "HTTPClientIPCountryISO", value: httpDuration },
			{ metric: "dex_http_fail", dimension: "pop", keyField: "ColoCode", value: httpFailed },
			{ metric: "dex_http_fail", dimension: "country", keyField: "HTTPClientIPCountryISO", value: httpFailed },
		],
	},
	dex_device_state_events: {
		timeField: "Timestamp",
		fields: ["Timestamp", "WarpColoCode", "ISPIPv4CountryISO", "HandshakeLatencyMs", "ISPIPv4City", "ISPIPv4StateISO", "ISPIPv4ASO"],
		outputs: [],
		metrics: [
			{ metric: "warp_handshake_ms", dimension: "pop", keyField: "WarpColoCode", value: warpHandshake },
			{ metric: "warp_handshake_ms", dimension: "country", keyField: "ISPIPv4CountryISO", value: warpHandshake },
		],
		locations: {
			countryField: "ISPIPv4CountryISO",
			stateField: "ISPIPv4StateISO",
			cityField: "ISPIPv4City",
			ispField: "ISPIPv4ASO",
			coloField: "WarpColoCode",
			latency: warpHandshake,
		},
	},
};

/** Which Logpush dataset (if any) can answer a dashboard dataset/mode. */
export function logpushSourceFor(dataset: DatasetId, mode: MapMode): LogpushSource | null {
	for (const [source, spec] of Object.entries(LOGPUSH_SOURCES) as [LogpushSource, SourceSpec][]) {
		if (spec.outputs.some((o) => o.dataset === dataset && o.dimension === mode)) return source;
	}
	return null;
}

/** Objects are written by Logpush to `logpush/<dataset>/<YYYYMMDD>/<start>_<end>_<hash>.log.gz`. */
export function sourceFromKey(key: string): LogpushSource | null {
	const match = /^logpush\/([a-z_]+)\/.+\.log\.gz$/.exec(key);
	return match && Object.hasOwn(LOGPUSH_SOURCES, match[1]) ? (match[1] as LogpushSource) : null;
}

/** Accepts RFC 3339 strings and Unix seconds / milliseconds / nanoseconds. */
export function toUnixSeconds(v: unknown): number | null {
	if (typeof v === "string") {
		if (/^\d+$/.test(v)) return toUnixSeconds(Number(v));
		const ms = Date.parse(v);
		return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
	}
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
	if (v > 1e17) return Math.floor(v / 1e9);
	if (v > 1e14) return Math.floor(v / 1e6);
	if (v > 1e11) return Math.floor(v / 1e3);
	return Math.floor(v);
}

export interface AggregateRow {
	dataset: DatasetId;
	dimension: MapMode;
	hour: number;
	key: string;
	value: number;
}

export interface MetricRow {
	metric: MetricId;
	dimension: MapMode;
	hour: number;
	key: string;
	n: number;
	total: number;
}

export interface LocationRow {
	hour: number;
	country: string;
	state: string;
	city: string;
	isp: string;
	colo: string;
	samples: number;
	latN: number;
	latTotal: number;
}

/** Ingestion limits: an object that exceeds them is rejected (not retried) and recorded as a dead letter. */
export const LIMITS = {
	/** Compressed object size. Logpush files are typically a few MB. */
	maxObjectBytes: 256 * 1024 * 1024,
	/** Decompressed bytes per object. */
	maxDecompressedBytes: 2 * 1024 * 1024 * 1024,
	/** Bytes in one NDJSON line. */
	maxLineBytes: 1024 * 1024,
	/** Distinct aggregate rows (all tables) per object; bounds memory and D1 batch size. */
	maxAggregateRows: 100_000,
	/** Characters kept from any record string used as a key. */
	maxKeyLength: 128,
};

export class IngestLimitError extends Error {}

const keyText = (v: unknown) => String(v ?? "").trim().slice(0, LIMITS.maxKeyLength);

export class Aggregator {
	readonly rows = new Map<string, AggregateRow>();
	readonly metricRows = new Map<string, MetricRow>();
	readonly locationRows = new Map<string, LocationRow>();
	records = 0;
	invalid = 0;
	firstRecord = Infinity;
	lastRecord = -Infinity;

	private readonly spec: SourceSpec;

	/** Records outside [minTs, maxTs] (Unix seconds) are counted as invalid, so forged far-future or ancient timestamps can't stretch coverage. */
	private readonly window: { minTs: number; maxTs: number };

	constructor(spec: SourceSpec, window: { minTs: number; maxTs: number } = { minTs: 0, maxTs: Number.MAX_SAFE_INTEGER }) {
		this.spec = spec;
		this.window = window;
	}

	get size() {
		return this.rows.size + this.metricRows.size + this.locationRows.size;
	}

	private checkSize() {
		if (this.size > LIMITS.maxAggregateRows) throw new IngestLimitError(`more than ${LIMITS.maxAggregateRows} distinct aggregate rows`);
	}

	addLine(line: string) {
		let record: LogRecord;
		try {
			record = JSON.parse(line) as LogRecord;
		} catch {
			this.invalid++;
			return;
		}
		this.add(record);
	}

	add(record: LogRecord) {
		const ts = toUnixSeconds(record[this.spec.timeField]);
		if (ts === null || ts < this.window.minTs || ts > this.window.maxTs) {
			this.invalid++;
			return;
		}
		this.records++;
		this.firstRecord = Math.min(this.firstRecord, ts);
		this.lastRecord = Math.max(this.lastRecord, ts);
		const hour = ts - (ts % 3600);
		for (const out of this.spec.outputs) {
			const key = keyText(record[out.keyField]).toUpperCase();
			const value = out.value ? out.value(record) : 1;
			const id = `${out.dataset}\t${out.dimension}\t${hour}\t${key}`;
			const row = this.rows.get(id);
			if (row) row.value += value;
			else this.rows.set(id, { dataset: out.dataset, dimension: out.dimension, hour, key, value });
		}
		for (const m of this.spec.metrics ?? []) {
			const value = m.value(record);
			if (value === null) continue;
			const key = keyText(record[m.keyField]).toUpperCase();
			const id = `${m.metric}\t${m.dimension}\t${hour}\t${key}`;
			const row = this.metricRows.get(id);
			if (row) {
				row.n++;
				row.total += value;
			} else {
				this.metricRows.set(id, { metric: m.metric, dimension: m.dimension, hour, key, n: 1, total: value });
			}
		}
		const loc = this.spec.locations;
		if (loc) {
			const str = (f: string) => keyText(record[f]);
			const colo = str(loc.coloField).toUpperCase();
			const city = str(loc.cityField);
			if (city && colo && colo !== "NONE") {
				const row = {
					country: str(loc.countryField).toUpperCase(),
					state: str(loc.stateField).toUpperCase(),
					city,
					isp: str(loc.ispField),
					colo,
				};
				const id = [hour, row.country, row.state, row.city, row.isp, row.colo].join("\t");
				const lat = loc.latency?.(record) ?? null;
				const existing = this.locationRows.get(id) ?? { hour, ...row, samples: 0, latN: 0, latTotal: 0 };
				existing.samples++;
				if (lat !== null) {
					existing.latN++;
					existing.latTotal += lat;
				}
				this.locationRows.set(id, existing);
			}
		}
		this.checkSize();
	}
}

/** Split a text stream into non-empty lines without buffering the whole body; rejects over-long lines. */
export async function* readLines(stream: ReadableStream<string>, maxLineLength = LIMITS.maxLineBytes): AsyncGenerator<string> {
	const reader = stream.getReader();
	let rest = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		const parts = (rest + value).split("\n");
		rest = parts.pop() ?? "";
		if (rest.length > maxLineLength) {
			await reader.cancel();
			throw new IngestLimitError(`line longer than ${maxLineLength} characters`);
		}
		for (const part of parts) {
			if (part.length > maxLineLength) {
				await reader.cancel();
				throw new IngestLimitError(`line longer than ${maxLineLength} characters`);
			}
			if (part.trim()) yield part;
		}
	}
	if (rest.trim()) yield rest;
}

/** Pass bytes through, failing once more than `max` have flowed (decompression-bomb guard). */
export function byteLimit(max: number): TransformStream<Uint8Array, Uint8Array> {
	let total = 0;
	return new TransformStream({
		transform(chunk, controller) {
			total += chunk.byteLength;
			if (total > max) controller.error(new IngestLimitError(`decompressed size exceeds ${max} bytes`));
			else controller.enqueue(chunk);
		},
	});
}

const ROWS_PER_STATEMENT = 20; // 5 bound parameters per row; D1 allows 100 per statement.

/**
 * All writes for one object in a single D1 batch (one transaction). The plain INSERT into
 * ingested_objects comes first, so a concurrent duplicate delivery aborts the whole batch.
 */
export function buildStatements(db: D1Database, key: string, source: LogpushSource, agg: Aggregator, now: number) {
	const statements = [
		db
			.prepare("INSERT INTO ingested_objects (key, source, records, ingested_at) VALUES (?, ?, ?, ?)")
			.bind(key, source, agg.records, now),
	];
	const rows = [...agg.rows.values()];
	for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
		const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
		statements.push(
			db
				.prepare(
					`INSERT INTO traffic_hourly (dataset, dimension, hour, key, value) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}
					 ON CONFLICT (dataset, dimension, hour, key) DO UPDATE SET value = value + excluded.value`,
				)
				.bind(...chunk.flatMap((r) => [r.dataset, r.dimension, r.hour, r.key, r.value])),
		);
	}
	const metricRows = [...agg.metricRows.values()];
	const METRIC_ROWS = 16; // 6 bound parameters per row
	for (let i = 0; i < metricRows.length; i += METRIC_ROWS) {
		const chunk = metricRows.slice(i, i + METRIC_ROWS);
		statements.push(
			db
				.prepare(
					`INSERT INTO metric_hourly (metric, dimension, hour, key, n, total) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
					 ON CONFLICT (metric, dimension, hour, key) DO UPDATE SET n = n + excluded.n, total = total + excluded.total`,
				)
				.bind(...chunk.flatMap((r) => [r.metric, r.dimension, r.hour, r.key, r.n, r.total])),
		);
	}
	const locationRows = [...agg.locationRows.values()];
	const LOCATION_ROWS = 11; // 9 bound parameters per row
	for (let i = 0; i < locationRows.length; i += LOCATION_ROWS) {
		const chunk = locationRows.slice(i, i + LOCATION_ROWS);
		statements.push(
			db
				.prepare(
					`INSERT INTO user_location_hourly (hour, country, state, city, isp, colo, samples, lat_n, lat_total) VALUES ${chunk
						.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)")
						.join(", ")}
					 ON CONFLICT (hour, country, state, city, isp, colo) DO UPDATE SET
					   samples = samples + excluded.samples, lat_n = lat_n + excluded.lat_n, lat_total = lat_total + excluded.lat_total`,
				)
				.bind(...chunk.flatMap((r) => [r.hour, r.country, r.state, r.city, r.isp, r.colo, r.samples, r.latN, r.latTotal])),
		);
	}
	if (agg.records > 0) {
		statements.push(
			db
				.prepare(
					`INSERT INTO logpush_sources (source, first_record, last_record, updated_at) VALUES (?, ?, ?, ?)
					 ON CONFLICT (source) DO UPDATE SET
					   first_record = MIN(first_record, excluded.first_record),
					   last_record = MAX(last_record, excluded.last_record),
					   updated_at = excluded.updated_at`,
				)
				.bind(source, agg.firstRecord, agg.lastRecord, now),
		);
	}
	return statements;
}

export type IngestResult =
	| { status: "ingested"; source: LogpushSource; records: number; invalid: number; rows: number }
	| { status: "duplicate" | "skipped" | "rejected"; reason: string };

/** Accepted record time window: up to RETENTION_DAYS old and at most FUTURE_SKEW_SECONDS ahead of now. */
export const FUTURE_SKEW_SECONDS = 3600;

export function recordWindow(nowSec: number, retentionDays = DEFAULT_RETENTION_DAYS) {
	return { minTs: nowSec - retentionDays * 86400, maxTs: nowSec + FUTURE_SKEW_SECONDS };
}

export async function ingestObject(env: { LOGS: R2Bucket; DB: D1Database; RETENTION_DAYS?: string }, key: string): Promise<IngestResult> {
	const source = sourceFromKey(key);
	if (!source) return { status: "skipped", reason: "not a Logpush object for a supported dataset" };
	if (await env.DB.prepare("SELECT 1 FROM ingested_objects WHERE key = ?").bind(key).first()) {
		return { status: "duplicate", reason: "already ingested" };
	}
	const object = await env.LOGS.get(key);
	if (!object) return { status: "skipped", reason: "object no longer exists" };
	if (object.size > LIMITS.maxObjectBytes) {
		await object.body.cancel();
		throw new IngestLimitError(`object is ${object.size} bytes (limit ${LIMITS.maxObjectBytes})`);
	}

	const agg = new Aggregator(LOGPUSH_SOURCES[source], recordWindow(Math.floor(Date.now() / 1000), Number(env.RETENTION_DAYS) || undefined));
	const text = object.body
		.pipeThrough(new DecompressionStream("gzip"))
		.pipeThrough(byteLimit(LIMITS.maxDecompressedBytes))
		.pipeThrough(new TextDecoderStream());
	for await (const line of readLines(text)) agg.addLine(line);
	if (agg.records === 0) {
		// Still recorded as ingested (so it isn't retried forever), but worth an alert: Logpush field config may be wrong.
		console.warn(JSON.stringify({ msg: "logpush object had no valid records", key, invalid: agg.invalid }));
	}

	await env.DB.batch(buildStatements(env.DB, key, source, agg, Math.floor(Date.now() / 1000)));
	return { status: "ingested", source, records: agg.records, invalid: agg.invalid, rows: agg.size };
}

/** Body of an R2 event notification message. https://developers.cloudflare.com/r2/buckets/event-notifications/ */
export interface R2EventNotification {
	account: string;
	action: string;
	bucket: string;
	object: { key: string; size?: number; eTag?: string };
	eventTime: string;
}

/** R2 actions that create an object. https://developers.cloudflare.com/r2/buckets/event-notifications/ */
const CREATE_ACTIONS = new Set(["PutObject", "CopyObject", "CompleteMultipartUpload"]);

export interface QueueEnv {
	LOGS: R2Bucket;
	DB: D1Database;
	/** Bucket name the notifications must come from (the R2 binding's bucket). */
	LOGPUSH_BUCKET?: string;
	/** Notifications must name this account. */
	CLOUDFLARE_ACCOUNT_ID?: string;
	RETENTION_DAYS?: string;
}

/** Reasons to ignore a notification before touching R2: wrong bucket, non-create action, malformed body. */
export function rejectNotification(body: R2EventNotification | undefined, expectedBucket: string | undefined, expectedAccount?: string): string | null {
	if (!body || typeof body.object?.key !== "string") return "malformed notification";
	if (!CREATE_ACTIONS.has(body.action)) return `ignored action ${String(body.action)}`;
	if (expectedAccount && body.account !== expectedAccount) return "notification is for a different account";
	if (!expectedBucket) return "LOGPUSH_BUCKET is not configured";
	if (body.bucket !== expectedBucket) return "notification is for a different bucket";
	return null;
}

export async function recordDeadLetter(db: D1Database, key: string, reason: string, attempts: number) {
	await db
		.prepare(
			`INSERT INTO dead_letters (key, reason, attempts, received_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (key) DO UPDATE SET reason = excluded.reason, attempts = excluded.attempts, received_at = excluded.received_at`,
		)
		.bind(key.slice(0, 1024), reason.slice(0, 500), attempts, Math.floor(Date.now() / 1000))
		.run();
}

export async function handleQueue(batch: MessageBatch<R2EventNotification>, env: QueueEnv) {
	// Messages that exhausted their retries: record them so operators can see and replay them.
	if (batch.queue.endsWith("-dlq")) {
		for (const message of batch.messages) {
			const key = String(message.body?.object?.key ?? "(unknown)");
			await recordDeadLetter(env.DB, key, "exhausted retries", message.attempts);
			console.error(JSON.stringify({ msg: "logpush object dead-lettered", key }));
			message.ack();
		}
		return;
	}
	for (const message of batch.messages) {
		const rejected = rejectNotification(message.body, env.LOGPUSH_BUCKET, env.CLOUDFLARE_ACCOUNT_ID);
		if (rejected) {
			console.warn(JSON.stringify({ msg: "logpush notification ignored", reason: rejected }));
			message.ack();
			continue;
		}
		const key = message.body.object.key;
		try {
			const result = await ingestObject(env, key);
			console.log(JSON.stringify({ msg: "logpush object processed", key, ...result }));
			message.ack();
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			if (err instanceof IngestLimitError) {
				// Retrying cannot help: record and drop.
				console.error(JSON.stringify({ msg: "logpush object rejected", key, error }));
				await recordDeadLetter(env.DB, key, `rejected: ${error}`, message.attempts);
				message.ack();
				continue;
			}
			console.error(JSON.stringify({ msg: "logpush ingestion failed", key, attempts: message.attempts, error }));
			message.retry({ delaySeconds: 30 });
		}
	}
}

export async function getDeadLetterCount(db: D1Database): Promise<number> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM dead_letters").first<{ n: number }>();
	return row?.n ?? 0;
}

/** Default retention for hourly aggregates. */
export const DEFAULT_RETENTION_DAYS = 400;
/** Dedup rows only need to outlive the raw objects in R2 (30-day lifecycle rule). */
const INGESTED_OBJECTS_RETENTION_DAYS = 45;
const DEAD_LETTER_RETENTION_DAYS = 90;

/** Delete aggregates older than the retention window and keep coverage metadata consistent with it. */
export async function purgeOldData(db: D1Database, now: number, retentionDays = DEFAULT_RETENTION_DAYS) {
	const cutoff = now - retentionDays * 86400;
	const results = await db.batch([
		db.prepare("DELETE FROM traffic_hourly WHERE hour < ?").bind(cutoff),
		db.prepare("DELETE FROM metric_hourly WHERE hour < ?").bind(cutoff),
		db.prepare("DELETE FROM user_location_hourly WHERE hour < ?").bind(cutoff),
		db.prepare("DELETE FROM ingested_objects WHERE ingested_at < ?").bind(now - INGESTED_OBJECTS_RETENTION_DAYS * 86400),
		db.prepare("DELETE FROM dead_letters WHERE received_at < ?").bind(now - DEAD_LETTER_RETENTION_DAYS * 86400),
		// Data before the cutoff is gone, so Logpush no longer covers it.
		db.prepare("UPDATE logpush_sources SET first_record = ? WHERE first_record < ?").bind(cutoff, cutoff),
	]);
	const [traffic, metrics, locations, objects, deadLetters] = results.map((r) => r.meta.changes ?? 0);
	return { cutoff, traffic, metrics, locations, objects, deadLetters };
}

export interface SourceCoverage {
	source: LogpushSource;
	firstRecord: number;
	lastRecord: number;
	updatedAt: number;
}

export async function getCoverage(db: D1Database): Promise<SourceCoverage[]> {
	const { results } = await db
		.prepare("SELECT source, first_record AS firstRecord, last_record AS lastRecord, updated_at AS updatedAt FROM logpush_sources")
		.all<SourceCoverage>();
	return results;
}

/** Max age of the newest ingested record before we stop trusting Logpush for "up to now" ranges. */
export const FRESHNESS_SECONDS = 2 * 3600;

/** Logpush can answer a window only if ingestion started before it and is still current. */
export function isCovered(coverage: SourceCoverage | undefined, start: number, end: number, now: number): boolean {
	if (!coverage) return false;
	return coverage.firstRecord <= start && coverage.lastRecord >= Math.min(end, now) - FRESHNESS_SECONDS;
}

/** Row caps for read queries (largest first), so inflated aggregate tables can't produce unbounded responses. */
export const READ_LIMITS = { locations: 5000, metrics: 10000, series: 50000, aggregates: 5000 };

/** User city × data center device time per time bucket (no ISP, to keep series small). */
export async function queryUserLocationSeries(
	db: D1Database,
	start: number,
	end: number,
	bucketSeconds: number,
): Promise<{ bucket: number; country: string; state: string; city: string; colo: string; samples: number; lat_n: number; lat_total: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT hour - (hour % ?) AS bucket, country, state, city, colo, SUM(samples) AS samples, SUM(lat_n) AS lat_n, SUM(lat_total) AS lat_total
			 FROM user_location_hourly WHERE hour >= ? AND hour < ?
			 GROUP BY bucket, country, state, city, colo
			 ORDER BY samples DESC LIMIT ?`,
		)
		.bind(bucketSeconds, start - (start % 3600), end, READ_LIMITS.series)
		.all<{ bucket: number; country: string; state: string; city: string; colo: string; samples: number; lat_n: number; lat_total: number }>();
	return results;
}

/** Averaged DEX metrics per location per time bucket. */
export async function queryMetricSeries(
	db: D1Database,
	mode: MapMode,
	start: number,
	end: number,
	bucketSeconds: number,
): Promise<{ bucket: number; metric: MetricId; key: string; n: number; total: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT hour - (hour % ?) AS bucket, metric, key, SUM(n) AS n, SUM(total) AS total FROM metric_hourly
			 WHERE dimension = ? AND hour >= ? AND hour < ?
			 GROUP BY bucket, metric, key
			 ORDER BY n DESC LIMIT ?`,
		)
		.bind(bucketSeconds, mode, start - (start % 3600), end, READ_LIMITS.series)
		.all<{ bucket: number; metric: MetricId; key: string; n: number; total: number }>();
	return results;
}

/** User city × ISP × data center totals over a window. */
export async function queryUserLocations(
	db: D1Database,
	start: number,
	end: number,
): Promise<{ country: string; state: string; city: string; isp: string; colo: string; samples: number; lat_n: number; lat_total: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT country, state, city, isp, colo, SUM(samples) AS samples, SUM(lat_n) AS lat_n, SUM(lat_total) AS lat_total
			 FROM user_location_hourly WHERE hour >= ? AND hour < ?
			 GROUP BY country, state, city, isp, colo
			 ORDER BY samples DESC LIMIT ?`,
		)
		.bind(start - (start % 3600), end, READ_LIMITS.locations)
		.all<{ country: string; state: string; city: string; isp: string; colo: string; samples: number; lat_n: number; lat_total: number }>();
	return results;
}

/** Averaged DEX metrics per location over a window. */
export async function queryMetrics(
	db: D1Database,
	mode: MapMode,
	start: number,
	end: number,
): Promise<{ metric: MetricId; key: string; n: number; total: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT metric, key, SUM(n) AS n, SUM(total) AS total FROM metric_hourly
			 WHERE dimension = ? AND hour >= ? AND hour < ?
			 GROUP BY metric, key
			 ORDER BY n DESC LIMIT ?`,
		)
		.bind(mode, start - (start % 3600), end, READ_LIMITS.metrics)
		.all<{ metric: MetricId; key: string; n: number; total: number }>();
	return results;
}

/** Per-bucket (hour or day) totals for the time slider. */
export async function queryAggregateSeries(
	db: D1Database,
	dataset: DatasetId,
	mode: MapMode,
	start: number,
	end: number,
	bucketSeconds: number,
): Promise<{ bucket: number; key: string; value: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT hour - (hour % ?) AS bucket, key, SUM(value) AS value FROM traffic_hourly
			 WHERE dataset = ? AND dimension = ? AND hour >= ? AND hour < ?
			 GROUP BY bucket, key
			 ORDER BY value DESC LIMIT ?`,
		)
		.bind(bucketSeconds, dataset, mode, start - (start % 3600), end, READ_LIMITS.series)
		.all<{ bucket: number; key: string; value: number }>();
	return results;
}

export async function queryAggregates(
	db: D1Database,
	dataset: DatasetId,
	mode: MapMode,
	start: number,
	end: number,
): Promise<Map<string, number>> {
	const { results } = await db
		.prepare(
			`SELECT key, SUM(value) AS value FROM traffic_hourly
			 WHERE dataset = ? AND dimension = ? AND hour >= ? AND hour < ?
			 GROUP BY key
			 ORDER BY value DESC LIMIT ?`,
		)
		.bind(dataset, mode, start - (start % 3600), end, READ_LIMITS.aggregates)
		.all<{ key: string; value: number }>();
	return new Map(results.map((r) => [r.key, r.value]));
}
