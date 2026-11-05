import { describe, expect, it } from "vitest";
import {
	Aggregator,
	buildStatements,
	byteLimit,
	IngestLimitError,
	isCovered,
	LIMITS,
	LOGPUSH_SOURCES,
	logpushSourceFor,
	purgeOldData,
	readLines,
	recordWindow,
	rejectNotification,
	sourceFromKey,
	toUnixSeconds,
	type SourceCoverage,
} from "./logpush.ts";

describe("sourceFromKey", () => {
	it("extracts the dataset from the Logpush path layout", () => {
		expect(sourceFromKey("logpush/gateway_dns/20261103/20261103T100000Z_20261103T100030Z_abc.log.gz")).toBe("gateway_dns");
		expect(sourceFromKey("logpush/zero_trust_network_sessions/20261103/x.log.gz")).toBe("zero_trust_network_sessions");
	});

	it("ignores unsupported datasets and non-log objects", () => {
		expect(sourceFromKey("logpush/http_requests/20261103/x.log.gz")).toBeNull();
		expect(sourceFromKey("logpush/gateway_dns/20261103/ownership-challenge-1234.txt")).toBeNull();
		expect(sourceFromKey("other/gateway_dns/x.log.gz")).toBeNull();
	});
});

describe("logpushSourceFor", () => {
	it("maps dashboard views to the Logpush dataset that can answer them", () => {
		expect(logpushSourceFor("dns", "pop")).toBe("gateway_dns");
		expect(logpushSourceFor("bandwidth", "pop")).toBe("zero_trust_network_sessions");
		expect(logpushSourceFor("network", "country")).toBe("gateway_network");
		expect(logpushSourceFor("http", "pop")).toBeNull();
		expect(logpushSourceFor("bandwidth", "country")).toBeNull();
	});
});

describe("toUnixSeconds", () => {
	it("handles RFC 3339 and Unix s/ms/ns", () => {
		const t = Date.UTC(2026, 10, 3, 10, 15, 30) / 1000;
		expect(toUnixSeconds("2026-11-03T10:15:30Z")).toBe(t);
		expect(toUnixSeconds(t)).toBe(t);
		expect(toUnixSeconds(t * 1e3 + 123)).toBe(t);
		expect(toUnixSeconds(t * 1e9)).toBe(t);
		expect(toUnixSeconds(String(t))).toBe(t);
		expect(toUnixSeconds("nope")).toBeNull();
		expect(toUnixSeconds(undefined)).toBeNull();
	});
});

describe("Aggregator", () => {
	it("buckets DNS records by hour into both POP and country rows", () => {
		const agg = new Aggregator(LOGPUSH_SOURCES.gateway_dns);
		agg.addLine('{"Datetime":"2026-11-03T10:15:00Z","ColoCode":"sjc","SrcIPCountryCode":"US"}');
		agg.addLine('{"Datetime":"2026-11-03T10:45:00Z","ColoCode":"SJC","SrcIPCountryCode":"US"}');
		agg.addLine('{"Datetime":"2026-11-03T11:05:00Z","ColoCode":"DUB","SrcIPCountryCode":""}');
		agg.addLine("not json");
		agg.addLine('{"ColoCode":"LAX"}');

		expect(agg.records).toBe(3);
		expect(agg.invalid).toBe(2);
		expect(agg.firstRecord).toBe(toUnixSeconds("2026-11-03T10:15:00Z"));
		expect(agg.lastRecord).toBe(toUnixSeconds("2026-11-03T11:05:00Z"));
		const h10 = toUnixSeconds("2026-11-03T10:00:00Z");
		const h11 = toUnixSeconds("2026-11-03T11:00:00Z");
		expect([...agg.rows.values()]).toEqual([
			{ dataset: "dns", dimension: "pop", hour: h10, key: "SJC", value: 2 },
			{ dataset: "dns", dimension: "country", hour: h10, key: "US", value: 2 },
			{ dataset: "dns", dimension: "pop", hour: h11, key: "DUB", value: 1 },
			{ dataset: "dns", dimension: "country", hour: h11, key: "", value: 1 },
		]);
	});

	it("sums bytes for bandwidth and counts sessions", () => {
		const agg = new Aggregator(LOGPUSH_SOURCES.zero_trust_network_sessions);
		agg.add({ SessionStartTime: 1793787330, IngressColoName: "IAD", BytesReceived: 100, BytesSent: 50 });
		agg.add({ SessionStartTime: 1793787331, IngressColoName: "IAD", BytesReceived: "10", BytesSent: 5 });
		const rows = [...agg.rows.values()];
		expect(rows.find((r) => r.dataset === "network")?.value).toBe(2);
		expect(rows.find((r) => r.dataset === "bandwidth")?.value).toBe(165);
	});
});

describe("Aggregator metrics (DEX)", () => {
	it("averages HTTP test duration, counts failures, and skips disconnected WARP samples", () => {
		const tests = new Aggregator(LOGPUSH_SOURCES.dex_application_tests);
		const t = "2026-11-03T10:15:00Z";
		tests.add({ Timestamp: t, TestType: "http", ColoCode: "lhr", HTTPClientIPCountryISO: "GB", HTTPRequestStartMs: 10, HTTPResponseEndMs: 110, HTTPStatusCode: 200 });
		tests.add({ Timestamp: t, TestType: "http", ColoCode: "LHR", HTTPClientIPCountryISO: "GB", HTTPRequestStartMs: 0, HTTPResponseEndMs: 300, HTTPStatusCode: 503 });
		tests.add({ Timestamp: t, TestType: "traceroute", ColoCode: "LHR" });
		const rows = [...tests.metricRows.values()];
		expect(rows.find((r) => r.metric === "dex_http_ms" && r.dimension === "pop")).toMatchObject({ key: "LHR", n: 2, total: 400 });
		expect(rows.find((r) => r.metric === "dex_http_fail" && r.dimension === "country")).toMatchObject({ key: "GB", n: 2, total: 1 });
		expect(tests.rows.size).toBe(0);

		const warp = new Aggregator(LOGPUSH_SOURCES.dex_device_state_events);
		warp.add({ Timestamp: t, WarpColoCode: "SJC", ISPIPv4CountryISO: "US", HandshakeLatencyMs: 20 });
		warp.add({ Timestamp: t, WarpColoCode: "SJC", ISPIPv4CountryISO: "US", HandshakeLatencyMs: -1 });
		expect([...warp.metricRows.values()].find((r) => r.dimension === "pop")).toMatchObject({ key: "SJC", n: 1, total: 20 });
	});
});

describe("Aggregator locations (DEX device state)", () => {
	it("aggregates samples and handshake latency per hour, city, ISP and colo; skips 'none' colos", () => {
		const agg = new Aggregator(LOGPUSH_SOURCES.dex_device_state_events);
		const base = { Timestamp: "2026-11-03T10:15:00Z", ISPIPv4CountryISO: "fr", ISPIPv4StateISO: "ara", ISPIPv4City: "Lyon", ISPIPv4ASO: "Orange", WarpColoCode: "mrs" };
		agg.add({ ...base, HandshakeLatencyMs: 10 });
		agg.add({ ...base, HandshakeLatencyMs: 20 });
		agg.add({ ...base, HandshakeLatencyMs: -1 });
		agg.add({ ...base, WarpColoCode: "none", HandshakeLatencyMs: 5 });
		const rows = [...agg.locationRows.values()];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ country: "FR", state: "ARA", city: "Lyon", isp: "Orange", colo: "MRS", samples: 3, latN: 2, latTotal: 30 });
	});
});

describe("ingestion hardening", () => {
	it("only accepts own dataset keys (no prototype properties)", () => {
		expect(sourceFromKey("logpush/constructor/20261103/x.log.gz")).toBeNull();
		expect(sourceFromKey("logpush/toString/20261103/x.log.gz")).toBeNull();
		expect(sourceFromKey("logpush/gateway_dns/20261103/x.log.gz")).toBe("gateway_dns");
	});

	it("rejects notifications for other buckets, non-create actions and malformed bodies", () => {
		const ok = { account: "a", action: "PutObject", bucket: "logs", object: { key: "logpush/gateway_dns/x.log.gz" }, eventTime: "" };
		expect(rejectNotification(ok, "logs")).toBeNull();
		expect(rejectNotification({ ...ok, action: "CompleteMultipartUpload" }, "logs")).toBeNull();
		expect(rejectNotification({ ...ok, bucket: "other" }, "logs")).toMatch(/different bucket/);
		expect(rejectNotification({ ...ok, action: "DeleteObject" }, "logs")).toMatch(/ignored action/);
		expect(rejectNotification(undefined, "logs")).toMatch(/malformed/);
		expect(rejectNotification(ok, undefined)).toMatch(/not configured/);
		expect(rejectNotification(ok, "logs", "a")).toBeNull();
		expect(rejectNotification({ ...ok, account: "someone-else" }, "logs", "a")).toMatch(/different account/);
	});

	it("rejects records outside the plausible time window", () => {
		const now = Date.UTC(2026, 10, 4) / 1000;
		const agg = new Aggregator(LOGPUSH_SOURCES.gateway_dns, recordWindow(now, 400));
		agg.add({ Datetime: new Date(now * 1000).toISOString(), ColoCode: "LHR", SrcIPCountryCode: "GB" });
		agg.add({ Datetime: new Date((now + 2 * 3600) * 1000).toISOString(), ColoCode: "LHR", SrcIPCountryCode: "GB" });
		agg.add({ Datetime: new Date((now - 401 * 86400) * 1000).toISOString(), ColoCode: "LHR", SrcIPCountryCode: "GB" });
		expect(agg.records).toBe(1);
		expect(agg.invalid).toBe(2);
		expect(agg.lastRecord).toBe(now);
	});

	it("truncates record-derived keys and caps distinct aggregate rows", () => {
		const agg = new Aggregator(LOGPUSH_SOURCES.gateway_dns);
		agg.add({ Datetime: "2026-11-03T10:00:00Z", ColoCode: "x".repeat(1000), SrcIPCountryCode: "GB" });
		expect([...agg.rows.values()][0].key.length).toBe(LIMITS.maxKeyLength);
		const saved = LIMITS.maxAggregateRows;
		LIMITS.maxAggregateRows = 10;
		try {
			expect(() => {
				for (let i = 0; i < 20; i++) agg.add({ Datetime: "2026-11-03T10:00:00Z", ColoCode: `C${i}`, SrcIPCountryCode: `K${i}` });
			}).toThrow(IngestLimitError);
		} finally {
			LIMITS.maxAggregateRows = saved;
		}
	});

	it("rejects over-long lines and decompression beyond the byte limit", async () => {
		const longLine = new ReadableStream<string>({
			start(c) {
				c.enqueue("x".repeat(50));
				c.close();
			},
		});
		await expect(async () => {
			for await (const line of readLines(longLine, 10)) void line;
		}).rejects.toBeInstanceOf(IngestLimitError);

		const bytes = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array(8));
				c.enqueue(new Uint8Array(8));
				c.close();
			},
		}).pipeThrough(byteLimit(10));
		const reader = bytes.getReader();
		await expect((async () => { for (;;) if ((await reader.read()).done) break; })()).rejects.toBeInstanceOf(IngestLimitError);
	});

	it("purges old data and moves coverage forward to the cutoff", async () => {
		const sql: { query: string; args: unknown[] }[] = [];
		const db = {
			prepare: (query: string) => ({ bind: (...args: unknown[]) => ({ query, args }) }),
			batch: async (stmts: { query: string; args: unknown[] }[]) => {
				sql.push(...stmts);
				return stmts.map(() => ({ meta: { changes: 1 } }));
			},
		} as unknown as D1Database;
		const now = 1_800_000_000;
		const result = await purgeOldData(db, now, 10);
		const cutoff = now - 10 * 86400;
		expect(result.cutoff).toBe(cutoff);
		expect(sql.find((s) => s.query.startsWith("DELETE FROM user_location_hourly"))?.args).toEqual([cutoff]);
		expect(sql.find((s) => s.query.startsWith("UPDATE logpush_sources"))?.args).toEqual([cutoff, cutoff]);
		expect(sql).toHaveLength(6);
	});
});

describe("readLines", () => {
	it("reassembles lines split across chunks", async () => {
		const chunks = ['{"a":1}\n{"b"', ':2}\n\n{"c":3}'];
		const stream = new ReadableStream<string>({
			start(controller) {
				for (const c of chunks) controller.enqueue(c);
				controller.close();
			},
		});
		const lines: string[] = [];
		for await (const line of readLines(stream)) lines.push(line);
		expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
	});
});

describe("buildStatements", () => {
	const fakeDb = {
		prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args }) }),
	} as unknown as D1Database;

	it("records the object first, chunks upserts to stay within D1's 100 bound parameters, then updates coverage", () => {
		const agg = new Aggregator(LOGPUSH_SOURCES.gateway_http);
		for (let i = 0; i < 45; i++) agg.add({ Datetime: 1793787330, SourceIPCountryCode: `C${i}` });
		const statements = buildStatements(fakeDb, "logpush/gateway_http/x.log.gz", "gateway_http", agg, 1) as unknown as {
			sql: string;
			args: unknown[];
		}[];
		expect(statements).toHaveLength(1 + 3 + 1);
		expect(statements[0].sql).toMatch(/^INSERT INTO ingested_objects/);
		expect(statements.slice(1, 4).map((s) => s.args.length)).toEqual([100, 100, 25]);
		expect(statements[4].sql).toMatch(/INSERT INTO logpush_sources/);
	});
});

describe("isCovered", () => {
	const now = 1_800_000_000;
	const coverage: SourceCoverage = { source: "gateway_dns", firstRecord: now - 86400 * 2, lastRecord: now - 300, updatedAt: now };

	it("requires ingestion to have started before the window and to be fresh", () => {
		expect(isCovered(coverage, now - 86400, now, now)).toBe(true);
		expect(isCovered(coverage, now - 86400 * 7, now, now)).toBe(false);
		expect(isCovered({ ...coverage, lastRecord: now - 3 * 3600 }, now - 86400, now, now)).toBe(false);
		expect(isCovered(undefined, now - 86400, now, now)).toBe(false);
	});
});
