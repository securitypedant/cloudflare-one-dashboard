import { useState } from "react";
import { TunnelCharts } from "./charts.tsx";
import type { TunnelRow, TunnelsResponse } from "../../shared/admin.ts";
import type { Pop } from "../../shared/types.ts";
import { DataTable } from "../components/DataTable.tsx";
import { SectionView } from "../components/SectionView.tsx";
import { TrafficMap, type MapLayer, type MapLine } from "../components/TrafficMap.tsx";
import { Section, Stat, Status, StatusPill } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { STATUS_COLORS } from "../lib/colors.ts";
import type { PopupLine } from "../lib/popup.ts";
import { formatShare } from "../lib/format.ts";

const statusColor = (s: string) => STATUS_COLORS[s] ?? STATUS_COLORS.unknown;
const worst = (statuses: string[]) => ["down", "degraded", "inactive", "healthy"].find((s) => statuses.includes(s)) ?? "unknown";

const STATUSES = ["healthy", "degraded", "down", "inactive"] as const;
const KINDS = [
	{ id: "cloudflared", label: "Cloudflare Tunnels" },
	{ id: "magic-wan", label: "Magic WAN" },
] as const;
type Kind = (typeof KINDS)[number]["id"];

interface AtPop {
	tunnel: TunnelRow;
	/** Status at this POP: per-data-center health for Magic WAN, the tunnel's status for cloudflared. */
	status: string;
	failureRate?: number;
}

export function TunnelsView({ pops, view = "map" }: { pops: Pop[]; view?: "map" | "chart" }) {
	const res = useApi<TunnelsResponse>("/api/tunnels");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	// Magic WAN health checks run from every Cloudflare data center, so it starts hidden to keep the map readable.
	const [kinds, setKinds] = useState<Record<Kind, boolean>>({ cloudflared: true, "magic-wan": false });
	const [statuses, setStatuses] = useState<Set<string>>(() => new Set(STATUSES));
	const [focus, setFocus] = useState("");
	const d = res.data;
	const byIata = new Map(pops.map((p) => [p.iata, p]));
	const all: TunnelRow[] = [...(d?.cloudflared.ok ? d.cloudflared.data : []), ...(d?.magicWan.ok ? d.magicWan.data : [])];
	const tunnelKey = (t: TunnelRow) => `${t.kind}:${t.id}`;

	// One circle per POP; colour = worst visible status there, size = visible tunnels there.
	const atPop = new Map<string, AtPop[]>();
	for (const t of all) {
		if (!kinds[t.kind] || (focus && tunnelKey(t) !== focus)) continue;
		for (const c of t.connectors) {
			const status = c.status ?? t.status;
			if (!c.iata || !statuses.has(status)) continue;
			const list = atPop.get(c.iata) ?? [];
			if (!list.some((x) => x.tunnel === t)) list.push({ tunnel: t, status, failureRate: c.failureRate });
			atPop.set(c.iata, list);
		}
	}
	const layer: MapLayer = {
		dataset: "network",
		label: "Tunnel connectors",
		unit: "sessions",
		color: STATUS_COLORS.healthy,
		points: [...atPop].flatMap(([iata, list]) => {
			const p = byIata.get(iata);
			return p ? [{ key: iata, name: p.city, country: p.country, lat: p.lat, lon: p.lon, value: list.length }] : [];
		}),
		total: all.length,
		colorFor: (p) => statusColor(worst((atPop.get(p.key) ?? []).map((x) => x.status))),
	};
	const lines: MapLine[] = [];
	const popupFor = (key: string) => {
		const list = atPop.get(key);
		if (!list) return null;
		const lines: PopupLine[] = list.map(({ tunnel, status, failureRate }) => ({
			text: `${tunnel.name} · ${status}${failureRate !== undefined ? ` · ${formatShare(failureRate)} of checks from here failed` : ""}`,
			color: statusColor(status),
		}));
		return { title: `${byIata.get(key)?.city ?? key} (${key})`, lines };
	};
	const toggleStatus = (st: string) =>
		setStatuses((cur) => {
			const next = new Set(cur);
			if (next.has(st)) next.delete(st);
			else next.add(st);
			return next;
		});
	const focusable = all.filter((t) => kinds[t.kind]);
	const count = (s: string) => all.filter((t) => t.status === s).length;

	return (
		<main className="main">
			{view === "map" ? (
				<TrafficMap
					pops={pops}
					layers={[layer]}
					mode="pop"
					selectedKey={selectedKey}
					onSelect={setSelectedKey}
					lines={lines}
					popupFor={popupFor}
					legend={
						<>
							{["healthy", "degraded", "down", "inactive"].map((s) => (
								<span key={s}>
									<i className="ring" style={{ borderColor: statusColor(s), background: `${statusColor(s)}33` }} /> {s}
								</span>
							))}
							<span className="muted">Circle size: tunnels connected at that POP</span>
						</>
					}
				>
					<div className="map-filters" role="group" aria-label="Map filters">
						<div className="map-filters-row">
							<span className="muted">Show</span>
							{KINDS.map((k) => (
								<label key={k.id}>
									<input type="checkbox" checked={kinds[k.id]} onChange={(e) => { setKinds((cur) => ({ ...cur, [k.id]: e.target.checked })); setFocus(""); }} /> {k.label}
								</label>
							))}
						</div>
						<div className="map-filters-row">
							<span className="muted">Status</span>
							{STATUSES.map((st) => (
								<button key={st} type="button" className={`chip ${statuses.has(st) ? "on" : ""}`} style={{ borderColor: statusColor(st), color: statuses.has(st) ? statusColor(st) : undefined }} aria-pressed={statuses.has(st)} onClick={() => toggleStatus(st)}>
									{st}
								</button>
							))}
						</div>
						<div className="map-filters-row">
							<select value={focus} onChange={(e) => setFocus(e.target.value)} aria-label="Show one tunnel">
								<option value="">All tunnels ({focusable.length})</option>
								{focusable.map((t) => (
									<option key={tunnelKey(t)} value={tunnelKey(t)}>
										{t.name} ({t.status})
									</option>
								))}
							</select>
						</div>
						{kinds["magic-wan"] && <div className="map-filters-hint muted">Magic WAN: each circle is a Cloudflare data center running health checks, coloured by its own results.</div>}
					</div>
				</TrafficMap>
			) : (
				<TunnelCharts data={d} />
			)}
			<aside className="sidebar">
				<Status loading={res.loading} error={res.error} />
				{d && (
					<>
						<section className="stats">
							<Stat label="tunnels" value={String(all.length)} />
							<Stat label="down / degraded" value={`${count("down")} / ${count("degraded")}`} />
							<Stat label="outdated connectors" value={String(all.filter((t) => t.outdated).length)} hint={d.latestConnectorVersion ? `newest: ${d.latestConnectorVersion}` : undefined} />
						</section>
						<Section title="Cloudflare Tunnels (cloudflared)">
							<SectionView result={d.cloudflared}>
								{(rows) => <TunnelTable rows={rows} onSelect={setSelectedKey} />}
							</SectionView>
						</Section>
						<Section title="Magic WAN tunnels" hint="Health checks over the last 24 hours. Down ≥ 50% failed, degraded ≥ 5%.">
							<SectionView result={d.magicWan}>
								{(rows) => (rows.length ? <TunnelTable rows={rows} onSelect={setSelectedKey} /> : <div className="muted">No Magic WAN health checks in the last 24 hours.</div>)}
							</SectionView>
						</Section>
					</>
				)}
			</aside>
		</main>
	);
}

function TunnelTable({ rows, onSelect }: { rows: TunnelRow[]; onSelect: (key: string) => void }) {
	return (
		<DataTable
			rows={rows}
			rowKey={(t) => `${t.kind}:${t.id}`}
			searchText={(t) => `${t.name} ${t.status} ${t.connectors.map((c) => c.iata).join(" ")}`}
			facets={[{ key: "status", label: "Status", value: (t) => t.status }]}
			pageSize={50}
			columns={[
				{ key: "name", label: "Tunnel", render: (t) => <span className="name">{t.name}</span>, sort: (t) => t.name },
				{ key: "status", label: "Status", render: (t) => <StatusPill text={t.status} color={statusColor(t.status)} />, sort: (t) => ["down", "degraded", "inactive", "healthy"].indexOf(t.status) },
				{
					key: "pops",
					label: "POPs",
					render: (t) => (
						<span>
							{[...new Set(t.connectors.map((c) => c.iata))].map((i) => (
								<button key={i} className="link-button" onClick={(e) => { e.stopPropagation(); onSelect(i); }}>
									{i}
								</button>
							))}
						</span>
					),
				},
			]}
			expand={(t) => (
				<div className="detail">
					{t.kind === "magic-wan" ? (
						<p>{(t.checks ?? 0).toLocaleString()} health checks, {formatShare(t.failureRate ?? 0)} failed.</p>
					) : t.connectors.length ? (
						<table className="table compact">
							<tbody>
								{t.connectors.map((c, i) => (
									<tr key={i}>
										<td>{c.colo}</td>
										<td>{c.version}</td>
										<td className="muted">{c.openedAt ? `since ${new Date(c.openedAt).toLocaleString()}` : ""}</td>
										<td className="muted">{c.originIp ?? ""}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : (
						<p className="muted">No active connectors.</p>
					)}
				</div>
			)}
		/>
	);
}
