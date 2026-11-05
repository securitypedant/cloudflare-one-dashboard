import { useState } from "react";
import { UserLocationCharts } from "./charts.tsx";
import type { Pop, RangeId, UserLocationsResponse, Vendor } from "../../shared/types.ts";
import { TrafficMap, type MapLayer, type MapLine } from "../components/TrafficMap.tsx";
import { VendorPicker } from "../components/VendorPicker.tsx";
import { BarRow, Section, Stat, Status } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { formatKm, formatShare } from "../lib/format.ts";
import type { PopupLine } from "../lib/popup.ts";
import { FAR_EXTRA_KM, isFar, summarizeCities, summarizeIsps, vendorDistances, weightedMedian } from "../lib/userLocations.ts";
import { vendorColor, vendorMarkers, VENDOR_PALETTE } from "../lib/vendors.ts";
import { arc } from "../lib/worldGeo.ts";

const CITY_COLOR = "#f472b6";
const NEAR_LINE = "#4ade80";
const FAR_LINE = "#fbbf24";
const NEAR_KM = 300;

interface Props {
	range: RangeId;
	pops: Pop[];
	vendorIds: string[];
	onVendorIds: (ids: string[]) => void;
	view?: "map" | "chart";
}

const formatMs = (ms: number | null) => (ms === null ? "–" : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`);

export function UserLocationsView({ range, pops, vendorIds, onVendorIds, view = "map" }: Props) {
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const data = useApi<UserLocationsResponse>(`/api/user-locations?range=${range}`);
	const vendors = useApi<Vendor[]>("/api/vendors");
	const byIata = new Map(pops.map((p) => [p.iata, p]));

	const rows = data.data?.rows ?? [];
	const located = rows.filter((r) => r.lat !== null);
	const unlocated = rows.filter((r) => r.lat === null);
	const cities = summarizeCities(rows);
	const isps = summarizeIsps(rows);
	const totalSamples = rows.reduce((s, r) => s + r.samples, 0);
	const locatedSamples = located.reduce((s, r) => s + r.samples, 0);
	const farSamples = located.filter(isFar).reduce((s, r) => s + r.samples, 0);
	const medianKm = weightedMedian(located.flatMap((r) => (r.coloDistanceKm !== null ? [{ value: r.coloDistanceKm, weight: r.samples }] : [])));
	const scores = vendors.data && cities.length ? vendorDistances(cities, pops, vendors.data, NEAR_KM) : [];

	// City → POP lines: green when the user is on (or near) their nearest POP, amber when much further away.
	const maxSamples = Math.max(1, ...located.map((r) => r.samples));
	const lines: MapLine[] = located.flatMap((r) => {
		const pop = byIata.get(r.colo);
		if (!pop) return [];
		const key = `${r.country}|${r.state}|${r.city}`;
		return [
			{
				coords: arc([r.lon!, r.lat!], [pop.lon, pop.lat]),
				color: isFar(r) ? FAR_LINE : NEAR_LINE,
				width: 1 + 4 * Math.sqrt(r.samples / maxSamples),
				opacity: selectedKey && selectedKey !== key ? 0.12 : 0.75,
			},
		];
	});
	const cityLayer: MapLayer = {
		dataset: "users",
		label: "WARP users",
		unit: "devices",
		color: CITY_COLOR,
		points: cities.map((c) => ({ key: c.key, name: c.city, country: c.country, lat: c.lat, lon: c.lon, value: c.samples })),
		total: locatedSamples,
	};

	const popupFor = (key: string) => {
		const c = cities.find((x) => x.key === key);
		if (!c) return null;
		const lines: PopupLine[] = [
			`${formatShare(c.samples / locatedSamples)} of WARP device time`,
			...c.colos.slice(0, 3).map((p) => `${p.colo} · ${p.distanceKm !== null ? formatKm(p.distanceKm) : "?"} · ${formatMs(p.handshakeAvgMs)}`),
		];
		if (c.nearestIata && c.colos[0]?.colo !== c.nearestIata) lines.push(`Nearest POP: ${c.nearestIata} (${formatKm(c.nearestDistanceKm ?? 0)})`);
		if (c.isps.length) lines.push({ text: c.isps.slice(0, 3).join(", "), muted: true });
		return { title: `${c.city}${c.state ? `, ${c.state}` : ""}, ${c.country}`, lines };
	};

	const toggleVendor = (id: string) => {
		if (id === "cloudflare") return;
		onVendorIds(vendorIds.includes(id) ? vendorIds.filter((v) => v !== id) : vendorIds.length < VENDOR_PALETTE.length ? [...vendorIds, id] : vendorIds);
	};
	const farCities = cities.filter((c) => c.farSamples > 0).sort((a, b) => b.farSamples - a.farSamples);

	return (
		<>
			<nav className="toolbar">
				<span className="toolbar-label">WARP users by ISP location (Cloudflare IP geolocation, via DEX)</span>
				<span className="toolbar-sep" />
				<VendorPicker vendors={vendors.data} selected={vendorIds} onChange={onVendorIds} />
				{data.loading && <span className="muted loading">Loading…</span>}
			</nav>
			<main className="main">
				{view === "map" ? (
					<TrafficMap
						pops={pops}
						layers={[cityLayer]}
						mode="pop"
						selectedKey={selectedKey}
						onSelect={setSelectedKey}
						lines={lines}
						markers={vendorMarkers(vendors.data, vendorIds)}
						popupFor={popupFor}
						legend={
							<>
								<span>
									<i className="ring" style={{ borderColor: CITY_COLOR }} /> User city (size: device time)
								</span>
								<span>
									<i className="line-swatch" style={{ background: NEAR_LINE }} /> Connected to a nearby POP
								</span>
								<span>
									<i className="line-swatch" style={{ background: FAR_LINE }} /> &gt;{FAR_EXTRA_KM} km beyond the nearest POP
								</span>
							</>
						}
					/>
				) : (
					<UserLocationCharts range={range} selectedKey={selectedKey} />
				)}
				<aside className="sidebar">
					<Status loading={data.loading} error={data.error} />
					{data.data && !data.data.available && (
						<Section title="No user locations yet">
							<p className="section-hint">
								Create the <code>dex_device_state_events</code> Logpush job (path <code>logpush/dex_device_state_events</code>) with the fields{" "}
								<code>Timestamp</code>, <code>WarpColoCode</code>, <code>ISPIPv4CountryISO</code>, <code>HandshakeLatencyMs</code>,{" "}
								<code>ISPIPv4City</code>, <code>ISPIPv4StateISO</code>, <code>ISPIPv4ASO</code>. Locations appear within minutes of the first files.
							</p>
						</Section>
					)}
					{data.data?.available && rows.length === 0 && <div className="muted">No WARP device data in this period.</div>}
					{rows.length > 0 && (
						<>
							<section className="stats">
								<Stat label="user cities" value={`${cities.length}`} hint={`${isps.length} ISPs`} />
								<Stat label="median distance to POP used" value={medianKm !== null ? formatKm(medianKm) : "–"} hint="city → data center, by device time" />
								<Stat
									label={`>${FAR_EXTRA_KM} km beyond nearest POP`}
									value={formatShare(locatedSamples ? farSamples / locatedSamples : 0)}
									hint={farCities.length ? farCities.slice(0, 3).map((c) => c.city).join(", ") : "everyone on a nearby POP"}
								/>
								{unlocated.length > 0 && (
									<Stat
										label="city not placed"
										value={formatShare(unlocated.reduce((s, r) => s + r.samples, 0) / totalSamples)}
										hint={unlocated.slice(0, 3).map((r) => r.city).join(", ")}
									/>
								)}
							</section>

							<Section
								title="Distance from your users to each vendor"
								hint={`Distance from each user city to the vendor's nearest POP, weighted by device time. POP lists from sasecloudmap.com. Click rows to show vendors on the map.`}
							>
								<Status loading={vendors.loading} error={vendors.error} />
								{scores.length > 0 && (
									<table className="table compact">
										<thead>
											<tr>
												<th>Vendor</th>
												<th className="num">POPs</th>
												<th className="num" title={`Share of device time with a vendor POP within ${NEAR_KM} km of the user's city`}>
													≤{NEAR_KM} km
												</th>
												<th className="num" title="Share of device time from countries where the vendor has a POP">
													In-country
												</th>
												<th className="num">Avg dist.</th>
											</tr>
										</thead>
										<tbody>
											{scores.map((s) => {
												const on = vendorIds.includes(s.id);
												return (
													<tr key={s.id} className={`${on ? "selected" : ""} ${s.id === "cloudflare" ? "highlight" : ""}`} onClick={() => toggleVendor(s.id)}>
														<td className="name">
															{s.id === "cloudflare" ? (
																<i className="dot inline" style={{ background: "#f6821f" }} />
															) : (
																<i className="diamond inline" style={{ background: on ? vendorColor(vendorIds, s.id) : "transparent", borderColor: "#7d8ba3" }} />
															)}
															{s.name}
														</td>
														<td className="num">{s.pops}</td>
														<td className="num">{formatShare(s.nearShare)}</td>
														<td className="num">{formatShare(s.inCountryShare)}</td>
														<td className="num">{formatKm(s.avgDistanceKm)}</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								)}
							</Section>

							<Section title="User cities" hint="Click a city to highlight its connections.">
								<table className="table compact">
									<thead>
										<tr>
											<th>City</th>
											<th>Connected to</th>
										</tr>
									</thead>
									<tbody>
										{cities.map((c) => (
											<tr key={c.key} className={c.key === selectedKey ? "selected" : undefined} onClick={() => setSelectedKey(c.key === selectedKey ? null : c.key)}>
												<td>
													<div className="name">{c.city}</div>
													<div className="sub">
														{[c.state, c.country].filter(Boolean).join(", ")} · {formatShare(c.samples / locatedSamples)}
													</div>
												</td>
												<td>
													{c.colos.slice(0, 3).map((p) => {
														const far = p.distanceKm !== null && c.nearestDistanceKm !== null && p.distanceKm - c.nearestDistanceKm > FAR_EXTRA_KM;
														return (
															<BarRow
																key={p.colo}
																label={
																	<span title={`Avg WARP handshake ${formatMs(p.handshakeAvgMs)}`}>
																		{p.colo} <span className="muted">{p.distanceKm !== null ? formatKm(p.distanceKm) : ""}</span>
																	</span>
																}
																share={p.samples / c.samples}
																value={formatMs(p.handshakeAvgMs)}
																color={far ? FAR_LINE : NEAR_LINE}
															/>
														);
													})}
													{c.nearestIata && c.colos[0]?.colo !== c.nearestIata && (
														<div className="sub">
															Nearest POP: {c.nearestIata} ({formatKm(c.nearestDistanceKm ?? 0)})
														</div>
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</Section>

							<Section title="ISPs" hint="Average distance to the POP used; a high far-share can indicate unusual ISP routing.">
								<table className="table compact">
									<thead>
										<tr>
											<th>ISP</th>
											<th className="num">Share</th>
											<th className="num">Avg dist.</th>
											<th className="num">Far</th>
											<th className="num">Handshake</th>
										</tr>
									</thead>
									<tbody>
										{isps.slice(0, 20).map((i) => (
											<tr key={i.isp}>
												<td>
													<div className="name">{i.isp}</div>
													<div className="sub">{i.cities} cities</div>
												</td>
												<td className="num">{formatShare(i.samples / totalSamples)}</td>
												<td className="num">{formatKm(i.avgDistanceKm)}</td>
												<td className="num" style={{ color: i.farShare > 0.1 ? FAR_LINE : undefined }}>
													{formatShare(i.farShare)}
												</td>
												<td className="num">{formatMs(i.handshakeAvgMs)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</Section>
							<p className="footnote">
								Source: Logpush dex_device_state_events (ISP IP geolocation by Cloudflare). City coordinates from{" "}
								<a href="https://www.geonames.org/">GeoNames</a> (CC BY 4.0). Locations are the user's internet connection, not their exact position.
							</p>
						</>
					)}
				</aside>
			</main>
		</>
	);
}
