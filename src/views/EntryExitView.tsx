import { useState } from "react";
import { EntryExitCharts } from "./charts.tsx";
import { CNI_SITES } from "../../shared/cni.ts";
import { inRegion, REGIONS } from "../../shared/regions.ts";
import type { Pop, RangeId, ReportResponse } from "../../shared/types.ts";
import { TrafficMap, type MapLayer, type MapLine, type MapMarker } from "../components/TrafficMap.tsx";
import { BarRow, Section, Stat, Status } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { formatBytes, formatShare, formatValue } from "../lib/format.ts";
import type { PopupLine } from "../lib/popup.ts";
import { arc } from "../lib/worldGeo.ts";

const ENTRY_COLOR = "#38bdf8";
const EXIT_LINE = "#a78bfa";
const VIOLATION = "#f87171";
const CNI_V2 = "#22d3ee";
const CNI_V1 = "#94a3b8";
const RAMP_COLORS = ["#38bdf8", "#a78bfa", "#4ade80", "#f472b6", "#facc15", "#2dd4bf"];

interface Pair {
	ingress: string;
	egress: string;
	onRamp: string;
	offramp: string;
	sessions: number;
	bytes: number;
}

const sumBy = <T,>(items: T[], key: (t: T) => string, value: (t: T) => number) => {
	const m = new Map<string, number>();
	for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + value(i));
	return [...m].sort((a, b) => b[1] - a[1]);
};

export function EntryExitView({ range, pops, view = "map" }: { range: RangeId; pops: Pop[]; view?: "map" | "chart" }) {
	const [regionId, setRegionId] = useState("");
	const [showCni, setShowCni] = useState(true);
	const report = useApi<ReportResponse>(`/api/report?id=entry_exit&range=${range}`);
	const byIata = new Map(pops.map((p) => [p.iata, p]));
	const region = REGIONS.find((r) => r.id === regionId);

	const pairs: Pair[] = (report.data?.rows ?? []).map((r) => ({
		ingress: r.dims.ingressColoName.toUpperCase(),
		egress: r.dims.egressColoName.toUpperCase(),
		onRamp: r.dims.onRamp || "Unknown",
		offramp: r.dims.offramp || "Unknown",
		sessions: r.sum.sessions ?? 0,
		bytes: r.sum.bytesTotal ?? 0,
	}));
	const total = pairs.reduce((s, p) => s + p.sessions, 0);
	const totalBytes = pairs.reduce((s, p) => s + p.bytes, 0);
	const ingress = sumBy(pairs, (p) => p.ingress, (p) => p.sessions);
	const egressElsewhere = pairs.filter((p) => p.egress && p.egress !== p.ingress).reduce((s, p) => s + p.sessions, 0);
	const onRamps = sumBy(pairs, (p) => p.onRamp, (p) => p.sessions);
	const offRamps = sumBy(pairs, (p) => p.offramp, (p) => p.sessions);
	const routes = sumBy(
		pairs.filter((p) => p.egress && p.egress !== p.ingress),
		(p) => `${p.ingress}→${p.egress}`,
		(p) => p.sessions,
	);

	// Regional Services check: entry POPs outside the selected region.
	const violations = region ? ingress.filter(([iata]) => byIata.get(iata) && !inRegion(region, byIata.get(iata)!.country)) : [];
	const violatingSessions = violations.reduce((s, [, v]) => s + v, 0);
	const violatingSet = new Set(violations.map(([iata]) => iata));

	const cniByMetro = new Map<string, typeof CNI_SITES>();
	for (const s of CNI_SITES) cniByMetro.set(s.metro, [...(cniByMetro.get(s.metro) ?? []), s]);
	const activeWithCni = ingress.filter(([iata]) => cniByMetro.has(iata));

	const layer: MapLayer = {
		dataset: "network",
		label: "Entry POP",
		unit: "sessions",
		color: ENTRY_COLOR,
		points: ingress.flatMap(([iata, sessions]) => {
			const p = byIata.get(iata);
			return p ? [{ key: iata, name: p.city, country: p.country, lat: p.lat, lon: p.lon, value: sessions }] : [];
		}),
		total,
		colorFor: (p) => (violatingSet.has(p.key) ? VIOLATION : ENTRY_COLOR),
	};
	const lines: MapLine[] = routes.flatMap(([route, sessions]) => {
		const [a, b] = route.split("→").map((k) => byIata.get(k));
		return a && b ? [{ coords: arc([a.lon, a.lat], [b.lon, b.lat]), color: EXIT_LINE, width: 1.5 + 5 * Math.sqrt(sessions / (routes[0][1] || 1)), opacity: 0.75 }] : [];
	});
	const markers: MapMarker[] = showCni
		? [...cniByMetro].flatMap(([metro, sites]) => {
				const p = byIata.get(metro);
				if (!p) return [];
				const v2 = sites.some((s) => s.v2 > 0);
				return [{ lon: p.lon, lat: p.lat, color: v2 ? CNI_V2 : CNI_V1, label: `CNI ${metro}: ${sites.map((s) => `${s.site} (${[s.v1 && "v1", s.v2 && "v2"].filter(Boolean).join("/")})`).join("; ")}` }];
			})
		: [];

	const popupFor = (key: string) => {
		const p = byIata.get(key);
		const mine = pairs.filter((x) => x.ingress === key);
		if (!p || !mine.length) return null;
		const sessions = mine.reduce((s, x) => s + x.sessions, 0);
		const exits = sumBy(mine, (x) => x.egress || "?", (x) => x.sessions).slice(0, 3);
		const ramps = sumBy(mine, (x) => x.onRamp, (x) => x.sessions).slice(0, 3);
		const cni = cniByMetro.get(key);
		const lines: PopupLine[] = [
			`${formatValue(sessions, "sessions")} enter here`,
			`Exit: ${exits.map(([e, v]) => `${e} ${formatShare(v / sessions)}`).join(", ")}`,
			`On-ramp: ${ramps.map(([r, v]) => `${r} ${formatShare(v / sessions)}`).join(", ")}`,
		];
		if (cni) lines.push(`CNI: ${cni.map((s) => s.site).join(", ")}`);
		if (violatingSet.has(key)) lines.push({ text: `Outside ${region!.label}`, color: VIOLATION });
		return { title: `${p.city} (${key})`, lines };
	};

	return (
		<>
			<nav className="toolbar">
				<label className="toolbar-label">
					Regional Services check{" "}
					<select value={regionId} onChange={(e) => setRegionId(e.target.value)}>
						<option value="">Off</option>
						{REGIONS.map((r) => (
							<option key={r.id} value={r.id}>
								{r.label}
							</option>
						))}
					</select>
				</label>
				<span className="toolbar-sep" />
				<label className="toolbar-label">
					<input type="checkbox" checked={showCni} onChange={(e) => setShowCni(e.target.checked)} /> CNI locations
				</label>
				{report.loading && <span className="muted loading">Loading…</span>}
			</nav>
			<main className="main">
				{view === "map" ? (
					<TrafficMap
						pops={pops}
						layers={[layer]}
						mode="pop"
						selectedKey={null}
						onSelect={() => {}}
						lines={lines}
						markers={markers}
						popupFor={popupFor}
						legend={
							<>
								<span>
									<i className="ring" style={{ borderColor: ENTRY_COLOR }} /> Where traffic enters Cloudflare
								</span>
								<span>
									<i className="line-swatch" style={{ background: EXIT_LINE }} /> Exits at a different POP
								</span>
								{region && (
									<span>
										<i className="ring" style={{ borderColor: VIOLATION }} /> Entry outside {region.label}
									</span>
								)}
								{showCni && (
									<>
										<span>
											<i className="ring" style={{ borderColor: CNI_V2 }} /> CNI (v2 available)
										</span>
										<span>
											<i className="ring" style={{ borderColor: CNI_V1 }} /> CNI (v1 only)
										</span>
									</>
								)}
							</>
						}
					/>
				) : (
					<EntryExitCharts range={range} pops={pops} />
				)}
				<aside className="sidebar">
					<Status loading={report.loading} error={report.data?.error ?? report.error} />
					{report.data && !report.data.error && (
						<>
							<section className="stats">
								<Stat label="network sessions" value={formatValue(total, "sessions")} hint={formatBytes(totalBytes)} />
								<Stat label="entry POPs" value={`${ingress.length}`} />
								<Stat label="exit at a different POP" value={formatShare(total ? egressElsewhere / total : 0)} hint="e.g. dedicated egress IPs" />
								<Stat label="entry POPs with CNI" value={`${activeWithCni.length} / ${ingress.length}`} hint="Direct CNI facility in the metro" />
							</section>

							{region && (
								<Section
									title={`Regional Services: ${region.label}`}
									hint="Entry data centers checked by country against the managed region. Custom regions and certification-based regions aren't modelled."
								>
									{violations.length === 0 ? (
										<div className="ok-text">All {formatValue(total, "sessions")} entered Cloudflare inside {region.label}.</div>
									) : (
										<>
											<div className="error-text">
												{formatShare(violatingSessions / total)} of sessions entered outside {region.label}:
											</div>
											{violations.map(([iata, v]) => (
												<BarRow
													key={iata}
													label={`${iata} (${byIata.get(iata)?.country})`}
													share={v / total}
													value={formatValue(v, "sessions")}
													color={VIOLATION}
												/>
											))}
										</>
									)}
								</Section>
							)}

							<Section title="On-ramps" hint="How traffic reaches Cloudflare.">
								{onRamps.map(([name, v], i) => (
									<BarRow key={name} label={name} share={v / total} value={formatShare(v / total)} color={RAMP_COLORS[i % RAMP_COLORS.length]} />
								))}
							</Section>
							<Section title="Off-ramps" hint="Where traffic leaves Cloudflare.">
								{offRamps.map(([name, v], i) => (
									<BarRow key={name} label={name} share={v / total} value={formatShare(v / total)} color={RAMP_COLORS[i % RAMP_COLORS.length]} />
								))}
							</Section>
							{routes.length > 0 && (
								<Section title="Entry → exit at different POPs">
									{routes.slice(0, 15).map(([route, v]) => (
										<BarRow key={route} label={route} share={v / total} value={formatShare(v / total)} color={EXIT_LINE} />
									))}
								</Section>
							)}
							{activeWithCni.length > 0 && (
								<Section title="CNI at your entry POPs" hint="Direct Cloudflare Network Interconnect facilities in the same metro.">
									<table className="table compact">
										<tbody>
											{activeWithCni.map(([iata]) => (
												<tr key={iata}>
													<td className="name">{iata}</td>
													<td>
														{cniByMetro.get(iata)!.map((s) => (
															<div key={s.site} className="sub">
																{s.site} · {[s.v1 && "v1", s.v2 && "v2"].filter(Boolean).join(" / ")}
																{s.diverse && " · diverse metro"}
															</div>
														))}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</Section>
							)}
							<p className="footnote">
								Source: GraphQL Analytics API · {report.data.source}. CNI list from{" "}
								<a href="https://developers.cloudflare.com/network-interconnect/locations/">Cloudflare docs</a>.
							</p>
						</>
					)}
				</aside>
			</main>
		</>
	);
}
