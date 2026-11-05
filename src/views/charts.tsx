/** "Chart" mode for each map page: the same data over time (hourly for 24h/7d, daily for 30d/90d). */
import type { TunnelsResponse } from "../../shared/admin.ts";
import { COUNTRIES } from "../../shared/countries.ts";
import { DATASETS, unavailableReason, type DatasetId, type DexResponse, type MapMode, type Pop, type RangeId, type ReportResponse, type ReportRow, type TimelineResponse, type Unit, type UserLocationsResponse } from "../../shared/types.ts";
import { TimeChart } from "../components/TimeChart.tsx";
import { Status } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { formatKm, formatShare, formatValue } from "../lib/format.ts";
import { buildAvgSeries, buildSeries, type SeriesSet } from "../lib/series.ts";

const compact = (unit: Unit) => (v: number) => formatValue(v, unit).replace(/ [a-z]+$/, "");
const ms = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} ms`;
const pct = (v: number) => formatShare(v);
const countryName = (cc: string) => COUNTRIES[cc]?.name ?? cc;
const popLabel = (pops: Pop[]) => {
	const byIata = new Map(pops.map((p) => [p.iata, p]));
	return (iata: string) => (byIata.get(iata) ? `${iata} · ${byIata.get(iata)!.city}` : iata);
};
const t = (r: ReportRow) => r.dims.datetime;
const focusHint = (selectedKey: string | null | undefined, label: (k: string) => string) =>
	selectedKey ? `Showing ${label(selectedKey)} only. Clear the selection on the map or table to compare top locations.` : "Top locations plus the total. Click a location on the map or in the table to chart it alone.";

function ReportStatus({ r }: { r: { loading: boolean; error?: string; data?: ReportResponse } }) {
	return (
		<>
			<Status loading={r.loading} error={r.data?.error ?? r.error} />
			{r.data?.truncated && <p className="section-hint">Some smaller locations are missing: the analytics API row limit was reached. A shorter range is more complete.</p>}
		</>
	);
}

/* ---------- Traffic ---------- */

function TrafficDatasetChart({ dataset, range, mode, selectedKey, pops }: { dataset: DatasetId; range: RangeId; mode: MapMode; selectedKey: string | null; pops: Pop[] }) {
	const meta = DATASETS[dataset];
	const reason = unavailableReason(dataset, mode, range);
	const res = useApi<TimelineResponse>(reason ? null : `/api/timeline?range=${range}&dataset=${dataset}&mode=${mode}`);
	const label = mode === "pop" ? popLabel(pops) : countryName;
	if (reason) return <p className="section-hint">{meta.label}: {reason}</p>;
	const rows = (res.data?.frames ?? []).flatMap((f) => Object.entries(f.values).map(([k, v]) => ({ t: f.t, k, v })));
	// Distinct counts (users, devices) can't be summed across locations, so they get no total line.
	const data = buildSeries(rows, { t: (r) => r.t, key: (r) => r.k, value: (r) => r.v, label, only: selectedKey, total: meta.distinct ? false : "All locations" });
	return (
		<>
			<Status loading={res.loading} error={res.error ?? (res.data?.layer.status === "error" ? res.data.layer.error : undefined)} />
			{res.data && <TimeChart title={`${meta.label} by ${mode === "pop" ? "POP" : "user country"}`} data={data} bucket={res.data.bucket} format={compact(meta.unit)} hint={focusHint(selectedKey, label)} />}
		</>
	);
}

export function TrafficCharts(props: { datasets: DatasetId[]; range: RangeId; mode: MapMode; selectedKey: string | null; pops: Pop[] }) {
	return (
		<div className="chart-area">
			{props.datasets.length === 0 && <p className="muted">Pick a dataset in the toolbar.</p>}
			{props.datasets.map((d) => (
				<TrafficDatasetChart key={d} dataset={d} {...props} />
			))}
		</div>
	);
}

/* ---------- Coverage ---------- */

export function CoverageCharts({ range, pops, selectedKey, report, countryDim, coloDim, metric, unit }: { range: RangeId; pops: Pop[]; selectedKey: string | null; report: string; countryDim: string; coloDim: string; metric: string; unit: Unit }) {
	const res = useApi<ReportResponse>(`/api/report?id=${report}&range=${range}&series=1`);
	const popCountry = new Map(pops.map((p) => [p.iata, p.country]));
	const rows = (res.data?.rows ?? []).filter((r) => r.dims[countryDim] && r.dims[countryDim] !== "UNKNOWN");
	const volume = buildSeries(rows, { t, key: (r) => r.dims[countryDim].toUpperCase(), value: (r) => r.sum[metric] ?? 0, label: countryName, only: selectedKey, total: "All countries" });
	// In-country share per country per bucket = traffic served by a POP in the same country / all its traffic.
	const local = buildSeries(rows, { t, key: (r) => r.dims[countryDim].toUpperCase(), value: (r) => (popCountry.get(r.dims[coloDim]) === r.dims[countryDim].toUpperCase() ? (r.sum[metric] ?? 0) : 0), label: countryName, only: selectedKey, top: 50 });
	const share: SeriesSet = {
		buckets: local.buckets,
		series: local.series
			.filter((s) => volume.series.some((v) => v.key === s.key))
			.map((s) => {
				const vol = volume.series.find((v) => v.key === s.key)!;
				return { ...s, color: vol.color, values: s.values.map((v, i) => (vol.values[i] ? (v ?? 0) / vol.values[i]! : null)) };
			}),
	};
	return (
		<div className="chart-area">
			<ReportStatus r={res} />
			{res.data && (
				<>
					<TimeChart title="Traffic by user country" data={volume} bucket={res.data.bucket ?? "day"} format={compact(unit)} hint={focusHint(selectedKey, countryName)} />
					<TimeChart title="Share served by a POP in the same country" data={share} bucket={res.data.bucket ?? "day"} format={pct} zeroBased={false} hint="A drop means more of that country's traffic was served from POPs abroad." />
				</>
			)}
		</div>
	);
}

/* ---------- User locations ---------- */

export function UserLocationCharts({ range, selectedKey }: { range: RangeId; selectedKey: string | null }) {
	const res = useApi<UserLocationsResponse>(`/api/user-locations?range=${range}&series=1`);
	const rows = (res.data?.rows ?? []).filter((r) => r.t);
	const cityKey = (r: (typeof rows)[number]) => `${r.country}|${r.state}|${r.city}`;
	const cityLabel = (k: string) => {
		const [cc, st, city] = k.split("|");
		return [city, st, cc].filter(Boolean).join(", ");
	};
	const time = buildSeries(rows, { t: (r) => r.t!, key: cityKey, value: (r) => r.samples, label: cityLabel, only: selectedKey, total: "All cities" });
	const distance = buildAvgSeries(
		rows.filter((r) => r.coloDistanceKm !== null),
		{ t: (r) => r.t!, key: cityKey, value: (r) => r.coloDistanceKm!, weight: (r) => r.samples, label: cityLabel, only: selectedKey, top: 4, total: "All cities (weighted)" },
	);
	const bucket = res.data?.bucket ?? "day";
	return (
		<div className="chart-area">
			<Status loading={res.loading} error={res.error} />
			{res.data && !res.data.available && <p className="muted">No DEX device-state data ingested yet.</p>}
			{res.data?.available && (
				<>
					<TimeChart title="WARP device time by user city" data={time} bucket={bucket} format={(v) => formatValue(v, "samples" as Unit).replace(/ [a-z]+$/, "")} hint={focusHint(selectedKey, cityLabel)} />
					<TimeChart title="Distance from user city to the POP used" data={distance} bucket={bucket} format={formatKm} zeroBased={false} hint="Weighted by device time. A rise means users are being served from farther away." />
				</>
			)}
		</div>
	);
}

/* ---------- Entry & exit ---------- */

export function EntryExitCharts({ range, pops }: { range: RangeId; pops: Pop[] }) {
	const res = useApi<ReportResponse>(`/api/report?id=entry_onramp&range=${range}&series=1`);
	const rows = res.data?.rows ?? [];
	const bucket = res.data?.bucket ?? "day";
	return (
		<div className="chart-area">
			<ReportStatus r={res} />
			{res.data && (
				<>
					<TimeChart title="Sessions by entry POP" data={buildSeries(rows, { t, key: (r) => r.dims.ingressColoName, value: (r) => r.sum.sessions ?? 0, label: popLabel(pops), total: "All entry POPs" })} bucket={bucket} format={compact("sessions")} />
					<TimeChart title="Sessions by on-ramp" data={buildSeries(rows, { t, key: (r) => r.dims.onRamp || "unknown", value: (r) => r.sum.sessions ?? 0 })} bucket={bucket} format={compact("sessions")} hint="WARP, Magic WAN, proxy endpoints and other ways traffic reaches Cloudflare." />
				</>
			)}
		</div>
	);
}

/* ---------- Performance ---------- */

export function PerformanceCharts({ range, mode, pops, selectedKey }: { range: RangeId; mode: MapMode; pops: Pop[]; selectedKey: string | null }) {
	const res = useApi<ReportResponse>(`/api/report?id=${mode === "pop" ? "perf_pop" : "perf_country"}&range=${range}&series=1`);
	const dex = useApi<DexResponse>(`/api/dex?range=${range}&mode=${mode}&series=1`);
	const dim = mode === "pop" ? "ingressColoName" : "sourceCountry";
	const label = mode === "pop" ? popLabel(pops) : countryName;
	const rows = (res.data?.rows ?? []).filter((r) => r.dims[dim] && r.dims[dim] !== "UNKNOWN");
	const dexRows = (dex.data?.rows ?? []).filter((r) => r.t);
	return (
		<div className="chart-area">
			<ReportStatus r={res} />
			{res.data && (
				<TimeChart
					title={`TCP handshake time by ${mode === "pop" ? "entry POP" : "user country"}`}
					data={buildAvgSeries(rows, { t, key: (r) => r.dims[dim].toUpperCase(), value: (r) => r.avg.tcpHandshakeMs, weight: (r) => r.sum.sessions ?? 0, label, only: selectedKey, total: "Overall" })}
					bucket={res.data.bucket ?? "day"}
					format={ms}
					zeroBased={false}
					hint={`Client to Cloudflare, weighted by sessions. ${focusHint(selectedKey, label)}`}
				/>
			)}
			{dex.data?.available && dexRows.length > 0 && (
				<div className="chart-grid-2">
					<TimeChart title="DEX HTTP test duration" data={buildAvgSeries(dexRows.filter((r) => r.httpAvgMs !== null), { t: (r) => r.t!, key: (r) => r.key, value: (r) => r.httpAvgMs!, weight: (r) => r.httpTests || 1, label, only: selectedKey, top: 4, total: "Overall" })} bucket={dex.data.bucket ?? "day"} format={ms} zeroBased={false} />
					<TimeChart title="WARP tunnel handshake" data={buildAvgSeries(dexRows.filter((r) => r.warpHandshakeAvgMs !== null), { t: (r) => r.t!, key: (r) => r.key, value: (r) => r.warpHandshakeAvgMs!, weight: (r) => r.warpSamples || 1, label, only: selectedKey, top: 4, total: "Overall" })} bucket={dex.data.bucket ?? "day"} format={ms} zeroBased={false} />
				</div>
			)}
		</div>
	);
}

/* ---------- Blocks ---------- */

export interface BlockMetric {
	label: string;
	report: string;
	unit: Unit;
	value: (r: ReportRow) => number;
	hit: (r: ReportRow) => boolean;
	rate: boolean;
}

export function SecurityCharts({ range, metric, dim, mode, pops, selectedKey }: { range: RangeId; metric: BlockMetric; dim: string; mode: MapMode; pops: Pop[]; selectedKey: string | null }) {
	const res = useApi<ReportResponse>(`/api/report?id=${metric.report}&range=${range}&series=1`);
	const label = mode === "pop" ? popLabel(pops) : countryName;
	const rows = (res.data?.rows ?? []).filter((r) => r.dims[dim]);
	const key = (r: ReportRow) => r.dims[dim].toUpperCase();
	const hits = buildSeries(rows, { t, key, value: (r) => (metric.hit(r) ? metric.value(r) : 0), label, only: selectedKey, total: "All locations" });
	const base = (r: ReportRow) => (metric.report === "sec_http" ? (r.sum.requests ?? 0) : metric.value(r));
	const all = buildSeries(rows, { t, key, value: base, only: selectedKey, total: true });
	const rate: SeriesSet = {
		buckets: hits.buckets,
		series: hits.series.slice(0, 1).map((s) => ({ ...s, label: selectedKey ? label(selectedKey) : "All locations", values: s.values.map((v, i) => (all.series[0]?.values[i] ? (v ?? 0) / all.series[0].values[i]! : null)) })),
	};
	const bucket = res.data?.bucket ?? "day";
	return (
		<div className="chart-area">
			<ReportStatus r={res} />
			{res.data && (
				<>
					<TimeChart title={`${metric.label} by ${mode === "pop" ? "POP" : "country"}`} data={hits} bucket={bucket} format={compact(metric.unit)} hint={focusHint(selectedKey, label)} />
					{metric.rate && <TimeChart title={`${metric.label}: share of traffic`} data={rate} bucket={bucket} format={pct} zeroBased={false} />}
				</>
			)}
		</div>
	);
}

/* ---------- Tunnels ---------- */

export function TunnelCharts({ data }: { data: TunnelsResponse | undefined }) {
	const hourly = data?.magicWanHourly;
	if (!data) return <div className="chart-area" />;
	const rows = hourly?.ok ? hourly.data : [];
	// Rank tunnels by failed checks, then chart their failure rate per hour.
	const failed = buildSeries(rows, { t: (r) => r.t, key: (r) => r.tunnel, value: (r) => r.failed, top: 8 });
	const checks = buildSeries(rows, { t: (r) => r.t, key: (r) => r.tunnel, value: (r) => r.checks, top: 1000 });
	const rate: SeriesSet = {
		buckets: failed.buckets,
		series: failed.series.map((s) => {
			const c = checks.series.find((x) => x.key === s.key);
			return { ...s, values: s.values.map((v, i) => (c?.values[i] ? (v ?? 0) / c.values[i]! : null)) };
		}),
	};
	return (
		<div className="chart-area">
			{hourly && !hourly.ok && <p className="error-text">{hourly.error}</p>}
			<TimeChart title="Magic WAN health-check failure rate (last 24 hours)" data={rate} bucket="hour" format={pct} hint="The tunnels with the most failed checks. Down ≥ 50% failed, degraded ≥ 5%. Cloudflare Tunnel (cloudflared) status has no history API." emptyText="No Magic WAN health checks in the last 24 hours." />
		</div>
	);
}
