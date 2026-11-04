import { useState } from "react";
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

export function TunnelsView({ pops }: { pops: Pop[] }) {
	const res = useApi<TunnelsResponse>("/api/tunnels");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const d = res.data;
	const byIata = new Map(pops.map((p) => [p.iata, p]));
	const all: TunnelRow[] = [...(d?.cloudflared.ok ? d.cloudflared.data : []), ...(d?.magicWan.ok ? d.magicWan.data : [])];

	// One circle per POP with connectors; colour = worst status of the tunnels attached there.
	const atPop = new Map<string, TunnelRow[]>();
	for (const t of all) for (const c of t.connectors) if (c.iata) atPop.set(c.iata, [...(atPop.get(c.iata) ?? []).filter((x) => x.id !== t.id), t]);
	const layer: MapLayer = {
		dataset: "network",
		label: "Tunnel connectors",
		unit: "sessions",
		color: STATUS_COLORS.healthy,
		points: [...atPop].flatMap(([iata, tunnels]) => {
			const p = byIata.get(iata);
			return p ? [{ key: iata, name: p.city, country: p.country, lat: p.lat, lon: p.lon, value: tunnels.length }] : [];
		}),
		total: all.length,
		colorFor: (p) => statusColor(worst((atPop.get(p.key) ?? []).map((t) => t.status))),
	};
	const lines: MapLine[] = [];
	const popupFor = (key: string) => {
		const tunnels = atPop.get(key);
		if (!tunnels) return null;
		const lines: PopupLine[] = tunnels.map((t) => ({ text: `${t.name} · ${t.status}${t.failureRate !== undefined ? ` · ${formatShare(t.failureRate)} failed checks` : ""}`, color: statusColor(t.status) }));
		return { title: `${byIata.get(key)?.city ?? key} (${key})`, lines };
	};
	const count = (s: string) => all.filter((t) => t.status === s).length;

	return (
		<main className="main">
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
			/>
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
