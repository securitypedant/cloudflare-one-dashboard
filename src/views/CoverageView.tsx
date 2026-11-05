import { useState } from "react";
import { CoverageCharts } from "./charts.tsx";
import { COUNTRIES } from "../../shared/countries.ts";
import type { Pop, RangeId, ReportResponse, Vendor } from "../../shared/types.ts";
import { TrafficMap, type CountryFill, type MapLabel, type MapLayer, type MapLine } from "../components/TrafficMap.tsx";
import { VendorPicker } from "../components/VendorPicker.tsx";
import { BarRow, Section, Stat, Status } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { buildFlows, countryCoverage, NEAR_KM, scoreVendors } from "../lib/coverage.ts";
import { formatKm, formatShare, formatValue } from "../lib/format.ts";
import { vendorColor, vendorMarkers, VENDOR_PALETTE } from "../lib/vendors.ts";
import { arc } from "../lib/worldGeo.ts";

/** In-country share bands for country shading. */
const BANDS = [
	{ min: 0.9, color: "#4ade80", label: "≥ 90% served in-country" },
	{ min: 0.5, color: "#fbbf24", label: "50–90%" },
	{ min: 0, color: "#f87171", label: "< 50%" },
];
const bandColor = (share: number) => BANDS.find((b) => share >= b.min)!.color;
const IN_COUNTRY = "#4ade80";
const CROSS_BORDER = "#fbbf24";
const POP_CIRCLE = "#38bdf8";
const USER_COUNTRY = "#64748b";

const SOURCES = {
	dns: { label: "DNS queries", report: "coverage_dns", country: "country", colo: "coloName", metric: "queries", unit: "queries" },
	sessions: { label: "Network sessions", report: "coverage_sessions", country: "sourceCountry", colo: "ingressColoName", metric: "sessions", unit: "sessions" },
} as const;
type SourceId = keyof typeof SOURCES;

interface Props {
	range: RangeId;
	pops: Pop[];
	vendorIds: string[];
	onVendorIds: (ids: string[]) => void;
	view?: "map" | "chart";
}

export function CoverageView({ range, pops, vendorIds, onVendorIds, view = "map" }: Props) {
	const [sourceId, setSourceId] = useState<SourceId>("dns");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const source = SOURCES[sourceId];
	const report = useApi<ReportResponse>(`/api/report?id=${source.report}&range=${range}`);
	const vendors = useApi<Vendor[]>("/api/vendors");

	const rows = (report.data?.rows ?? []).map((r) => ({ country: r.dims[source.country], colo: r.dims[source.colo], value: r.sum[source.metric] ?? 0 }));
	const { flows, unattributed } = buildFlows(rows, pops);
	const total = flows.reduce((s, f) => s + f.value, 0);
	const inCountry = flows.filter((f) => f.inCountry).reduce((s, f) => s + f.value, 0);
	const countries = countryCoverage(flows);
	const scores = vendors.data && flows.length ? scoreVendors(flows, pops, vendors.data) : [];

	// Subtle neutral tint marks which countries have users; the badges and lines carry the story.
	const countryFill: CountryFill[] = countries.map((c) => ({
		key: c.country,
		color: USER_COUNTRY,
		t: selectedKey && selectedKey !== c.country ? 0.15 : 0.45,
	}));

	// One arrow per country → POP flow (≥1% of that country's traffic), from the country badge to the POP.
	const crossBorder = flows.filter((f) => !f.inCountry);
	const countryTotals = new Map(countries.map((c) => [c.country, c.total]));
	const shown = flows.filter((f) => f.value >= (countryTotals.get(f.country) ?? 0) * 0.01);
	const maxFlow = shown[0]?.value || 1;
	const lines: MapLine[] = shown.map((f) => {
		const c = COUNTRIES[f.country];
		return {
			coords: arc([c.lon, c.lat], [f.pop.lon, f.pop.lat]),
			color: f.inCountry ? IN_COUNTRY : CROSS_BORDER,
			width: 1.5 + 6 * Math.sqrt(f.value / maxFlow),
			opacity: selectedKey && selectedKey !== f.country ? 0.1 : 0.9,
			arrow: true,
		};
	});

	const labels: MapLabel[] = [
		...countries.map((c) => ({
			key: c.country,
			lon: COUNTRIES[c.country].lon,
			lat: COUNTRIES[c.country].lat,
			kind: "country" as const,
			text: `Users in ${c.name}`,
			accentText: `${formatShare(c.inCountryShare)} local`,
			accent: bandColor(c.inCountryShare),
			dimmed: !!selectedKey && selectedKey !== c.country,
			avoid: shown.filter((f) => f.country === c.country).map((f) => [f.pop.lon, f.pop.lat] as [number, number]),
		})),
		...[...new Set(shown.map((f) => f.pop.iata))].map((iata) => {
			const p = shown.find((f) => f.pop.iata === iata)!.pop;
			return {
				key: iata,
				lon: p.lon,
				lat: p.lat,
				kind: "pop" as const,
				text: iata,
				dimmed: !!selectedKey && !shown.some((f) => f.pop.iata === iata && f.country === selectedKey),
			};
		}),
	];

	const byPop = new Map<string, { pop: Pop; value: number }>();
	for (const f of flows) byPop.set(f.pop.iata, { pop: f.pop, value: (byPop.get(f.pop.iata)?.value ?? 0) + f.value });
	const popLayer: MapLayer = {
		dataset: "dns",
		label: `${source.label} by POP`,
		unit: source.unit,
		color: POP_CIRCLE,
		points: [...byPop.values()].map(({ pop, value }) => ({ key: pop.iata, name: pop.city, country: pop.country, lat: pop.lat, lon: pop.lon, value })),
		total,
	};

	const popupFor = (key: string) => {
		const p = byPop.get(key);
		if (p) {
			const served = flows.filter((f) => f.pop.iata === key);
			return {
				title: `${p.pop.city} (${key})`,
				lines: [`${formatValue(p.value, source.unit)} from ${served.map((f) => COUNTRIES[f.country].name).join(", ")}`],
			};
		}
		const c = countries.find((x) => x.country === key);
		if (!c) return null;
		return {
			title: c.name,
			lines: [
				`${formatShare(c.inCountryShare)} served in-country · ${formatValue(c.total, source.unit)}`,
				c.pops
					.slice(0, 4)
					.map((p) => `${p.iata}${p.country !== c.country ? ` (${p.country})` : ""} ${formatShare(p.value / c.total)}`)
					.join(", "),
			],
		};
	};

	const toggleVendor = (id: string) => {
		if (id === "cloudflare") return;
		onVendorIds(vendorIds.includes(id) ? vendorIds.filter((v) => v !== id) : vendorIds.length < VENDOR_PALETTE.length ? [...vendorIds, id] : vendorIds);
	};

	return (
		<>
			<nav className="toolbar">
				<div className="segmented" role="tablist" aria-label="Traffic source">
					{(Object.keys(SOURCES) as SourceId[]).map((id) => (
						<button key={id} role="tab" aria-selected={sourceId === id} className={sourceId === id ? "active" : ""} onClick={() => setSourceId(id)}>
							{SOURCES[id].label}
						</button>
					))}
				</div>
				<span className="toolbar-sep" />
				<VendorPicker vendors={vendors.data} selected={vendorIds} onChange={onVendorIds} />
				{(report.loading || vendors.loading) && <span className="muted loading">Loading…</span>}
			</nav>
			<main className="main">
				{view === "map" ? (
					<TrafficMap
						pops={pops}
						layers={[popLayer]}
						mode="pop"
						selectedKey={selectedKey}
						onSelect={setSelectedKey}
						lines={lines}
						markers={vendorMarkers(vendors.data, vendorIds)}
						labels={labels}
						onLabelClick={(key) => key.length === 2 && setSelectedKey(key === selectedKey ? null : key)}
						countryFill={countryFill}
						popupFor={popupFor}
						legend={
							<>
								<span>
									<i className="legend-badge">Users in …</i> where users are (country level)
								</span>
								<span>
									<i className="line-swatch" style={{ background: IN_COUNTRY }} /> → served by a POP in the same country
								</span>
								<span>
									<i className="line-swatch" style={{ background: CROSS_BORDER }} /> → served from another country
								</span>
								<span>
									<i className="ring" style={{ borderColor: POP_CIRCLE }} /> {source.label} per POP
								</span>
								<span className="muted">Line width: volume · click a badge to focus</span>
							</>
						}
					/>
				) : (
					<CoverageCharts range={range} pops={pops} selectedKey={selectedKey} report={source.report} countryDim={source.country} coloDim={source.colo} metric={source.metric} unit={source.unit} />
				)}
				<aside className="sidebar">
					<Status loading={report.loading} error={report.data?.error ?? report.error} />
					{report.data && !report.data.error && (
						<>
							<section className="stats">
								<Stat label="served in the user's own country" value={formatShare(total ? inCountry / total : 0)} hint={`${source.label}, known country`} />
								<Stat
									label="cross-border flows"
									value={`${crossBorder.length}`}
									hint={crossBorder.length ? `${formatShare((total - inCountry) / total)} of traffic` : "everything served locally"}
								/>
								<Stat label="user countries" value={`${countries.length}`} hint={`served by ${byPop.size} POPs`} />
								{unattributed > 0 && (
									<Stat
										label="no source country"
										value={formatShare(unattributed / (total + unattributed))}
										hint="e.g. Tunnel / WAN on-ramps; not on the map"
									/>
								)}
							</section>

							<Section
								title="Compared with other SASE vendors"
								hint={
									<>
										How far each vendor's nearest POP is from where your traffic enters Cloudflare today, weighted by your traffic (Cloudflare is 0
										by definition). POP lists from <a href="https://sasecloudmap.com/">sasecloudmap.com</a>. Click rows to show vendors on the map.
									</>
								}
							>
								<Status loading={vendors.loading} error={vendors.error} />
								{scores.length > 0 && (
									<table className="table compact">
										<thead>
											<tr>
												<th>Vendor</th>
												<th className="num">POPs</th>
												<th className="num" title="Share of your traffic from countries where the vendor has a POP">
													In-country
												</th>
												<th className="num" title={`Share of your traffic with a vendor POP within ${NEAR_KM} km`}>
													≤{NEAR_KM} km
												</th>
												<th className="num" title="Traffic-weighted distance to the vendor's nearest POP">
													Avg dist.
												</th>
											</tr>
										</thead>
										<tbody>
											{scores.map((s) => {
												const on = vendorIds.includes(s.id);
												return (
													<tr key={s.id} className={`${on ? "selected" : ""} ${s.id === "cloudflare" ? "highlight" : ""}`} onClick={() => toggleVendor(s.id)}>
														<td>
															<div className="name">
																{s.id === "cloudflare" ? (
																	<i className="dot inline" style={{ background: "#f6821f" }} />
																) : (
																	<i className="diamond inline" style={{ background: on ? vendorColor(vendorIds, s.id) : "transparent", borderColor: "#7d8ba3" }} />
																)}
																{s.name}
															</div>
															<div className="sub">{s.countries} countries</div>
														</td>
														<td className="num">{s.pops}</td>
														<td className="num">{formatShare(s.inCountryShare)}</td>
														<td className="num">{formatShare(s.nearShare)}</td>
														<td className="num">{formatKm(s.avgDistanceKm)}</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								)}
							</Section>

							<Section title="Which POPs serve each country" hint="Click a country to outline it and highlight its cross-border flows.">
								<table className="table compact">
									<thead>
										<tr>
											<th>Country</th>
											<th>Served by</th>
											<th className="num">In-country</th>
										</tr>
									</thead>
									<tbody>
										{countries.map((c) => (
											<tr key={c.country} className={c.country === selectedKey ? "selected" : undefined} onClick={() => setSelectedKey(c.country === selectedKey ? null : c.country)}>
												<td>
													<div className="name">{c.name}</div>
													<div className="sub">{formatValue(c.total, source.unit)}</div>
												</td>
												<td>
													{c.pops.slice(0, 4).map((p) => (
														<BarRow
															key={p.iata}
															label={
																<span title={`${p.city}, ${formatKm(p.distanceKm)} from the country centre`}>
																	{p.iata}
																	{p.country !== c.country && <span className="muted"> ({p.country})</span>}
																</span>
															}
															share={p.value / c.total}
															value={formatShare(p.value / c.total)}
															color={p.country === c.country ? BANDS[0].color : CROSS_BORDER}
														/>
													))}
												</td>
												<td className="num" style={{ color: bandColor(c.inCountryShare) }}>
													{formatShare(c.inCountryShare)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</Section>
							<p className="footnote">Source: GraphQL Analytics API · {report.data.source}</p>
						</>
					)}
				</aside>
			</main>
		</>
	);
}
