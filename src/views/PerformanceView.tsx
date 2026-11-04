import { useState } from "react";
import { COUNTRIES } from "../../shared/countries.ts";
import type { DexResponse, MapMode, Pop, RangeId, ReportResponse, TrafficPoint } from "../../shared/types.ts";
import { TrafficMap, type MapLayer } from "../components/TrafficMap.tsx";
import { Section, Stat, Status } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { formatValue } from "../lib/format.ts";

/** Latency bands for colouring (ms). */
const BANDS = [
	{ max: 20, color: "#4ade80", label: "< 20 ms" },
	{ max: 50, color: "#facc15", label: "20–50 ms" },
	{ max: 100, color: "#fb923c", label: "50–100 ms" },
	{ max: Infinity, color: "#f87171", label: "≥ 100 ms" },
];
const bandColor = (ms: number) => BANDS.find((b) => ms < b.max)!.color;
const formatMs = (ms: number) => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;

interface Row {
	key: string;
	name: string;
	sub: string;
	sessions: number;
	ms: number;
}

const MODE_LABELS: Record<MapMode, string> = { pop: "By Cloudflare POP", country: "By user location" };

export function PerformanceView({ range, pops }: { range: RangeId; pops: Pop[] }) {
	const [mode, setMode] = useState<MapMode>("pop");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const report = useApi<ReportResponse>(`/api/report?id=${mode === "pop" ? "perf_pop" : "perf_country"}&range=${range}`);
	const dex = useApi<DexResponse>(`/api/dex?range=${range}&mode=${mode}`);
	const byIata = new Map(pops.map((p) => [p.iata, p]));

	const rows: Row[] = (report.data?.rows ?? [])
		.flatMap((r) => {
			const key = (mode === "pop" ? r.dims.ingressColoName : r.dims.sourceCountry).toUpperCase();
			const sessions = r.sum.sessions ?? 0;
			const ms = r.avg.tcpHandshakeMs ?? 0;
			if (mode === "pop") {
				const p = byIata.get(key);
				return p ? [{ key, name: p.city, sub: `${key} · ${p.country}`, sessions, ms }] : [];
			}
			const c = COUNTRIES[key];
			return c ? [{ key, name: c.name, sub: key, sessions, ms }] : [];
		})
		.sort((a, b) => b.sessions - a.sessions);
	const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);
	const weightedMs = totalSessions ? rows.reduce((s, r) => s + r.ms * r.sessions, 0) / totalSessions : 0;
	const slow = rows.filter((r) => r.ms >= 50);

	const points: TrafficPoint[] = rows.flatMap((r) => {
		const loc = mode === "pop" ? byIata.get(r.key) : COUNTRIES[r.key];
		return loc ? [{ key: r.key, name: r.name, country: mode === "pop" ? (loc as Pop).country : r.key, lat: loc.lat, lon: loc.lon, value: r.sessions }] : [];
	});
	const msByKey = new Map(rows.map((r) => [r.key, r.ms]));
	const layer: MapLayer = {
		dataset: "network",
		label: "TCP handshake",
		unit: "sessions",
		color: BANDS[0].color,
		points,
		total: totalSessions,
		colorFor: (p) => bandColor(msByKey.get(p.key) ?? 0),
		// Country fill strength is driven by session volume; colour by latency band.
	};
	const popupFor = (key: string) => {
		const r = rows.find((x) => x.key === key);
		const d = dex.data?.rows.find((x) => x.key === key);
		if (!r && !d) return null;
		const lines: string[] = [];
		if (r) lines.push(`TCP handshake ${formatMs(r.ms)} · ${formatValue(r.sessions, "sessions")}`);
		if (d?.httpAvgMs != null) lines.push(`DEX HTTP test ${formatMs(d.httpAvgMs)} (${d.httpTests} tests)`);
		if (d?.warpHandshakeAvgMs != null) lines.push(`WARP handshake ${formatMs(d.warpHandshakeAvgMs)}`);
		return { title: r?.name ?? d!.key, lines };
	};

	return (
		<>
			<nav className="toolbar">
				<div className="segmented" role="tablist" aria-label="Map mode">
					{(Object.keys(MODE_LABELS) as MapMode[]).map((m) => (
						<button
							key={m}
							role="tab"
							aria-selected={mode === m}
							className={mode === m ? "active" : ""}
							onClick={() => {
								setMode(m);
								setSelectedKey(null);
							}}
						>
							{MODE_LABELS[m]}
						</button>
					))}
				</div>
				{(report.loading || dex.loading) && <span className="muted loading">Loading…</span>}
			</nav>
			<main className="main">
				<TrafficMap
					pops={pops}
					layers={[layer]}
					mode={mode}
					selectedKey={selectedKey}
					onSelect={setSelectedKey}
					popupFor={popupFor}
					legend={
						<>
							{BANDS.map((b) => (
								<span key={b.label}>
									<i className="ring" style={{ borderColor: b.color, background: `${b.color}33` }} /> TCP handshake {b.label}
								</span>
							))}
							<span className="muted">{mode === "pop" ? "Circle size: sessions" : "Shade strength: sessions"}</span>
						</>
					}
				/>
				<aside className="sidebar">
					<Status loading={report.loading} error={report.data?.error ?? report.error} />
					{report.data && !report.data.error && (
						<>
							<section className="stats">
								<Stat label="avg TCP handshake" value={formatMs(weightedMs)} hint="client → Cloudflare, weighted by sessions" />
								<Stat
									label={`${mode === "pop" ? "POPs" : "countries"} ≥ 50 ms`}
									value={`${slow.length} / ${rows.length}`}
									hint={slow.length ? slow.slice(0, 3).map((r) => (mode === "pop" ? r.key : r.name)).join(", ") : "none"}
								/>
							</section>

							<DexSection dex={dex} />

							<Section title={`TCP handshake ${mode === "pop" ? "by entry POP" : "by user country"}`}>
								<table className="table compact">
									<thead>
										<tr>
											<th>{mode === "pop" ? "Data center" : "Country"}</th>
											<th className="num">Sessions</th>
											<th className="num">Handshake</th>
										</tr>
									</thead>
									<tbody>
										{rows.map((r) => (
											<tr key={r.key} className={r.key === selectedKey ? "selected" : undefined} onClick={() => setSelectedKey(r.key === selectedKey ? null : r.key)}>
												<td>
													<div className="name">{r.name}</div>
													<div className="sub">{r.sub}</div>
												</td>
												<td className="num">{formatValue(r.sessions, "sessions").replace(" sessions", "")}</td>
												<td className="num">
													<span className="latency" style={{ color: bandColor(r.ms) }}>
														{formatMs(r.ms)}
													</span>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</Section>
							<p className="footnote">Source: GraphQL Analytics API · {report.data.source} (avg tcpHandshakeMs)</p>
						</>
					)}
				</aside>
			</main>
		</>
	);
}

function DexSection({ dex }: { dex: { data?: DexResponse; error?: string; loading: boolean } }) {
	const rows = dex.data?.rows ?? [];
	return (
		<Section
			title="Digital Experience Monitoring"
			hint={
				dex.data && !dex.data.available
					? "No DEX data ingested yet. Create the dex_application_tests and dex_device_state_events Logpush jobs (see README)."
					: "Real user experience from DEX tests and WARP clients, via Logpush."
			}
		>
			<Status loading={dex.loading} error={dex.error} />
			{rows.length > 0 && (
				<table className="table compact">
					<thead>
						<tr>
							<th>Location</th>
							<th className="num" title="Average DEX HTTP test duration">
								HTTP test
							</th>
							<th className="num" title="DEX HTTP tests with an error or non-2xx/3xx status">
								Failures
							</th>
							<th className="num" title="Average WARP tunnel handshake latency">
								WARP hs
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.key}>
								<td className="name">{r.key}</td>
								<td className="num">{r.httpAvgMs != null ? <span style={{ color: bandColor(r.httpAvgMs / 4) }}>{formatMs(r.httpAvgMs)}</span> : "–"}</td>
								<td className="num">{r.httpTests ? `${((r.httpFailures / r.httpTests) * 100).toFixed(1)}%` : "–"}</td>
								<td className="num">{r.warpHandshakeAvgMs != null ? formatMs(r.warpHandshakeAvgMs) : "–"}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</Section>
	);
}
