import { useState } from "react";
import { SecurityCharts } from "./charts.tsx";
import { COUNTRIES } from "../../shared/countries.ts";
import type { MapMode, Pop, RangeId, ReportResponse, ReportRow, TrafficPoint } from "../../shared/types.ts";
import { TrafficMap, type MapLayer } from "../components/TrafficMap.tsx";
import { BarRow, Section, Stat, Status } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { formatShare, formatValue } from "../lib/format.ts";

const BLOCK_COLOR = "#f87171";
const DLP_COLOR = "#fb923c";
const CATEGORY_COLOR = "#a78bfa";

/** Which report rows count as "blocked", and how to read location / volume from them. */
const METRICS = {
	dns: {
		label: "Blocked DNS",
		report: "sec_dns",
		unit: "queries",
		value: (r: ReportRow) => r.sum.queries ?? 0,
		hit: (r: ReportRow) => r.dims.resolverDecision.startsWith("blocked"),
		key: { country: "country", pop: "coloName" },
		color: BLOCK_COLOR,
	},
	http: {
		label: "Blocked HTTP",
		report: "sec_http",
		unit: "requests",
		value: (r: ReportRow) => r.sum.requests ?? 0,
		hit: (r: ReportRow) => r.dims.action === "block",
		key: { country: "country", pop: null },
		color: BLOCK_COLOR,
	},
	network: {
		label: "Blocked network",
		report: "sec_network",
		unit: "sessions",
		value: (r: ReportRow) => r.sum.requests ?? 0,
		hit: (r: ReportRow) => r.dims.action.toLowerCase().includes("block"),
		key: { country: "sourceCountry", pop: "coloName" },
		color: BLOCK_COLOR,
	},
	dlp: {
		label: "DLP matches",
		report: "sec_http",
		unit: "requests",
		value: (r: ReportRow) => r.sum.dlpMatchedRequestsTotal ?? 0,
		hit: () => true,
		key: { country: "country", pop: null },
		color: DLP_COLOR,
	},
	av: {
		label: "AV blocked files",
		report: "sec_http",
		unit: "requests",
		value: (r: ReportRow) => r.sum.avBlockedFiles ?? 0,
		hit: () => true,
		key: { country: "country", pop: null },
		color: DLP_COLOR,
	},
} as const;
type MetricId = keyof typeof METRICS;

/** Totals per location: matching events, and all events of that report (for a rate). */
function byLocation(rows: ReportRow[], metric: (typeof METRICS)[MetricId], dim: string) {
	const out = new Map<string, { hits: number; all: number }>();
	for (const r of rows) {
		const key = (r.dims[dim] ?? "").toUpperCase();
		const v = metric.value(r);
		const base = metric.report === "sec_http" ? (r.sum.requests ?? 0) : v;
		const row = out.get(key) ?? { hits: 0, all: 0 };
		row.all += base;
		if (metric.hit(r)) row.hits += v;
		out.set(key, row);
	}
	return out;
}

const isRate = (id: MetricId) => id === "dns" || id === "http" || id === "network";

export function SecurityView({ range, pops, view = "map" }: { range: RangeId; pops: Pop[]; view?: "map" | "chart" }) {
	const [metricId, setMetricId] = useState<MetricId>("dns");
	const [mode, setMode] = useState<MapMode>("country");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const metric = METRICS[metricId];
	const effectiveMode: MapMode = metric.key.pop ? mode : "country";
	const dim = metric.key[effectiveMode]!;

	const dns = useApi<ReportResponse>(`/api/report?id=sec_dns&range=${range}`);
	const http = useApi<ReportResponse>(`/api/report?id=sec_http&range=${range}`);
	const network = useApi<ReportResponse>(`/api/report?id=sec_network&range=${range}`);
	const cats = useApi<ReportResponse>(`/api/report?id=sec_categories&range=${range}`);
	const blockedCats = useApi<ReportResponse>(`/api/report?id=sec_blocked_categories&range=${range}`);
	const names = useApi<Record<number, string>>("/api/categories");
	const reports = { sec_dns: dns, sec_http: http, sec_network: network } as const;
	const current = reports[metric.report];
	const byIata = new Map(pops.map((p) => [p.iata, p]));

	const totals = (id: MetricId) => {
		const m = METRICS[id];
		const rows = reports[m.report].data?.rows ?? [];
		const hits = rows.filter(m.hit).reduce((s, r) => s + m.value(r), 0);
		const all = rows.reduce((s, r) => s + (m.report === "sec_http" ? (r.sum.requests ?? 0) : m.value(r)), 0);
		return { hits, all };
	};

	const locations = [...byLocation(current.data?.rows ?? [], metric, dim)]
		.filter(([, v]) => v.hits > 0)
		.sort((a, b) => b[1].hits - a[1].hits);
	const totalHits = locations.reduce((s, [, v]) => s + v.hits, 0);
	const points: TrafficPoint[] = locations.flatMap(([key, v]) => {
		if (effectiveMode === "pop") {
			const p = byIata.get(key);
			return p ? [{ key, name: p.city, country: p.country, lat: p.lat, lon: p.lon, value: v.hits }] : [];
		}
		const c = COUNTRIES[key];
		return c ? [{ key, name: c.name, country: key, lat: c.lat, lon: c.lon, value: v.hits }] : [];
	});
	const layer: MapLayer = { dataset: "dns", label: metric.label, unit: metric.unit, color: metric.color, points, total: totalHits };
	const locationMap = new Map(locations);
	const popupFor = (key: string) => {
		const v = locationMap.get(key);
		const name = effectiveMode === "pop" ? byIata.get(key)?.city : COUNTRIES[key]?.name;
		if (!v) return null;
		return {
			title: name ?? key,
			lines: [`${metric.label}: ${formatValue(v.hits, metric.unit)}${isRate(metricId) && v.all ? ` (${formatShare(v.hits / v.all)} of traffic)` : ""}`],
		};
	};

	// Categories: all DNS, or blocked DNS only; for the selected country when one is selected.
	const categoryRows = (resp: ReportResponse | undefined) => {
		const counts = new Map<number, number>();
		for (const r of resp?.rows ?? []) {
			if (selectedKey && effectiveMode === "country" && r.dims.country.toUpperCase() !== selectedKey) continue;
			for (const [id, c] of Object.entries(r.arrays)) counts.set(Number(id), (counts.get(Number(id)) ?? 0) + c);
		}
		const total = [...counts.values()].reduce((s, v) => s + v, 0);
		return { total, top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10) };
	};
	const allCats = categoryRows(cats.data);
	const blocked = categoryRows(blockedCats.data);
	const catName = (id: number) => names.data?.[id] ?? `Category ${id}`;
	const scope = selectedKey && effectiveMode === "country" ? (COUNTRIES[selectedKey]?.name ?? selectedKey) : "all locations";

	return (
		<>
			<nav className="toolbar">
				<div className="segmented" role="tablist" aria-label="Security metric">
					{(Object.keys(METRICS) as MetricId[]).map((id) => (
						<button
							key={id}
							role="tab"
							aria-selected={metricId === id}
							className={metricId === id ? "active" : ""}
							onClick={() => {
								setMetricId(id);
								setSelectedKey(null);
							}}
						>
							{METRICS[id].label}
						</button>
					))}
				</div>
				<span className="toolbar-sep" />
				<div className="segmented" role="tablist" aria-label="Map mode">
					{(["country", "pop"] as MapMode[]).map((m) => (
						<button
							key={m}
							role="tab"
							aria-selected={effectiveMode === m}
							className={effectiveMode === m ? "active" : ""}
							disabled={m === "pop" && !metric.key.pop}
							title={m === "pop" && !metric.key.pop ? "HTTP analytics have no data center dimension" : undefined}
							onClick={() => {
								setMode(m);
								setSelectedKey(null);
							}}
						>
							{m === "pop" ? "By Cloudflare POP" : "By user location"}
						</button>
					))}
				</div>
				{current.loading && <span className="muted loading">Loading…</span>}
			</nav>
			<main className="main">
				{view === "map" ? (
					<TrafficMap
						pops={pops}
						layers={[layer]}
						mode={effectiveMode}
						selectedKey={selectedKey}
						onSelect={setSelectedKey}
						popupFor={popupFor}
						legend={
							<span className="legend-gradient">
								<i style={{ background: `linear-gradient(90deg, ${metric.color}2e, ${metric.color}d9)` }} />
								{metric.label} {effectiveMode === "pop" ? "by data center" : "by user country"}
							</span>
						}
					/>
				) : (
					<SecurityCharts range={range} metric={{ ...metric, rate: isRate(metricId) }} dim={dim} mode={effectiveMode} pops={pops} selectedKey={selectedKey} />
				)}
				<aside className="sidebar">
					<section className="stats">
						{(["dns", "http", "network"] as MetricId[]).map((id) => {
							const t = totals(id);
							return (
								<Stat
									key={id}
									label={METRICS[id].label.toLowerCase()}
									value={formatValue(t.hits, METRICS[id].unit)}
									hint={t.all ? `${formatShare(t.hits / t.all)} of ${METRICS[id].unit}` : undefined}
								/>
							);
						})}
						<Stat label="DLP matches" value={formatValue(totals("dlp").hits, "requests")} hint={`${formatValue(totals("av").hits, "requests")} AV-blocked files`} />
					</section>

					<Section title={`Most ${metric.label.toLowerCase()} comes from`}>
						<Status loading={current.loading} error={current.data?.error ?? current.error} />
						{!current.loading && locations.length === 0 && <div className="ok-text">None in this period.</div>}
						{locations.slice(0, 12).map(([key, v]) => {
							const name = effectiveMode === "pop" ? `${key} · ${byIata.get(key)?.city ?? ""}` : (COUNTRIES[key]?.name ?? (key || "Unknown"));
							return (
								<div key={key} className={`clickable ${key === selectedKey ? "selected" : ""}`} onClick={() => setSelectedKey(key === selectedKey ? null : key)}>
									<BarRow
										label={name}
										share={v.hits / (totalHits || 1)}
										value={`${formatValue(v.hits, metric.unit).replace(` ${metric.unit}`, "")}${isRate(metricId) && v.all ? ` · ${formatShare(v.hits / v.all)}` : ""}`}
										color={metric.color}
									/>
								</div>
							);
						})}
						{isRate(metricId) && locations.length > 0 && <p className="section-hint">Value · share of that location's {metric.unit} that was blocked.</p>}
					</Section>

					<Section
						title={`Blocked DNS categories (${scope})`}
						hint={names.error ? "Category names need the API token to have Zero Trust: Read; showing IDs." : undefined}
					>
						<Status loading={blockedCats.loading} error={blockedCats.data?.error ?? blockedCats.error} />
						{!blockedCats.loading && blocked.top.length === 0 && <div className="ok-text">No blocked DNS queries.</div>}
						{blocked.top.map(([id, c]) => (
							<BarRow key={id} label={catName(id)} share={c / blocked.total} value={formatValue(c, "queries").replace(" queries", "")} color={BLOCK_COLOR} />
						))}
					</Section>

					<Section title={`Top DNS categories (${scope})`} hint="Queries can match several categories, so shares overlap.">
						<Status loading={cats.loading} error={cats.data?.error ?? cats.error} />
						{allCats.top.map(([id, c]) => (
							<BarRow key={id} label={catName(id)} share={c / allCats.total} value={formatValue(c, "queries").replace(" queries", "")} color={CATEGORY_COLOR} />
						))}
					</Section>
					<p className="footnote">Source: GraphQL Analytics API · cf1Gateway{"{Dns,Http,Network}"} rollups</p>
				</aside>
			</main>
		</>
	);
}
