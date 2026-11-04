import { DATASETS, type DatasetId, type MapMode, type Pop, type RangeId, type TrafficLayer } from "../../shared/types.ts";
import { formatAmount, formatChange, formatShare, formatValue } from "../lib/format.ts";
import { change, layerStats, popNetworkStats, topMovers } from "../lib/stats.ts";
import { DATASET_COLORS, DATASET_SHORT } from "../lib/colors.ts";

export interface SidebarEntry {
	dataset: DatasetId;
	/** undefined while loading */
	layer: TrafficLayer | undefined;
	/** Same view for the previous period, for trends. */
	previous?: TrafficLayer;
}

interface Props {
	entries: SidebarEntry[];
	mode: MapMode;
	pops: Pop[];
	range: RangeId;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
}

type OkLayer = Extract<TrafficLayer, { status: "ok" }>;

const PERIOD_LABEL: Record<RangeId, string> = { "24h": "previous 24h", "7d": "previous 7 days", "30d": "previous 30 days", "90d": "previous 90 days" };

const okOrUndefined = (l: TrafficLayer | undefined) => (l?.status === "ok" ? l : undefined);

function Change({ value }: { value: number | "new" | null }) {
	const text = formatChange(value);
	if (!text) return null;
	const cls = value === "new" || (typeof value === "number" && value >= 0) ? "up" : "down";
	return <span className={`change ${cls}`}>{text}</span>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className="stat">
			<div className="stat-value">{value}</div>
			<div className="stat-label">{label}</div>
			{hint && <div className="stat-hint">{hint}</div>}
		</div>
	);
}

function DatasetCard({ dataset, layer, previous, mode, range }: SidebarEntry & { mode: MapMode; range: RangeId }) {
	const { label, unit, distinct } = DATASETS[dataset];
	const color = DATASET_COLORS[dataset];
	const noun = mode === "pop" ? "POPs" : "countries";
	const prev = okOrUndefined(previous);
	let body;
	if (!layer) body = <div className="muted">Loading…</div>;
	else if (layer.status === "unavailable") body = <div className="muted">{layer.reason}</div>;
	else if (layer.status === "error") body = <div className="error-text">{layer.error}</div>;
	else {
		const s = layerStats(layer.points, layer.total, layer.unattributed);
		const peak = layer.points[0];
		const movers = prev ? topMovers(layer.points, prev.points) : [];
		body = (
			<>
				{distinct ? (
					<>
						<div className="card-total">{peak ? `${formatValue(peak.value, unit)} at ${peak.name}` : `0 ${unit}`}</div>
						<div className="card-meta">
							Seen at {s.locations} {noun} (distinct per location; one {unit.slice(0, -1)} can appear at several)
						</div>
					</>
				) : (
					<>
						<div className="card-total">
							{formatValue(layer.total, unit)} <Change value={change(layer.total, prev?.total)} />
							{prev && <span className="card-vs"> vs {PERIOD_LABEL[range]}</span>}
						</div>
						<div className="card-meta">
							{s.locations} {noun} · 80% in {s.locationsFor80} · busiest {formatShare(s.topShare)}
							{layer.unattributed > 0 && <> · {formatShare(s.unattributedShare)} no source location</>}
						</div>
					</>
				)}
				{movers.length > 0 && (
					<div className="card-meta">
						Biggest movers:{" "}
						{movers.map((m, i) => (
							<span key={m.key}>
								{i > 0 && ", "}
								{mode === "pop" ? m.key : m.name} <Change value={m.change} />
							</span>
						))}
					</div>
				)}
				{layer.unmapped.length > 0 && (
					<div className="card-meta">Not on map: {layer.unmapped.map((u) => `${u.key} (${formatValue(u.value, unit)})`).join(", ")}</div>
				)}
				<div className="card-source">
					<span className={`source-badge ${layer.backend}`}>{layer.backend === "logpush" ? "Logpush" : "GraphQL"}</span> {layer.source}
				</div>
			</>
		);
	}
	return (
		<div className="dataset-card" style={{ borderLeftColor: color }}>
			<div className="card-title">{label}</div>
			{body}
		</div>
	);
}

interface Cell {
	value: number;
	share: number;
	change: number | "new" | null;
}

interface Row {
	key: string;
	name: string;
	sub: string;
	cells: Partial<Record<DatasetId, Cell>>;
	score: number;
}

/** Union of locations across datasets, ranked by average share (units differ between datasets). */
function combinedRows(layers: { dataset: DatasetId; layer: OkLayer; previous?: OkLayer }[], mode: MapMode): Row[] {
	const rows = new Map<string, Row>();
	for (const { dataset, layer, previous } of layers) {
		const prevByKey = previous ? new Map(previous.points.map((p) => [p.key, p.value])) : undefined;
		for (const p of layer.points) {
			const row = rows.get(p.key) ?? {
				key: p.key,
				name: p.name,
				sub: mode === "pop" ? `${p.key} · ${p.country}` : p.key,
				cells: {},
				score: 0,
			};
			const share = layer.total ? p.value / layer.total : 0;
			row.cells[dataset] = { value: p.value, share, change: prevByKey ? change(p.value, prevByKey.get(p.key) ?? 0) : null };
			row.score += share / layers.length;
			rows.set(p.key, row);
		}
	}
	return [...rows.values()].sort((a, b) => b.score - a.score);
}

export function Sidebar({ entries, mode, pops, range, selectedKey, onSelect }: Props) {
	const isPop = mode === "pop";
	const okLayers = entries.flatMap((e) =>
		e.layer?.status === "ok" ? [{ dataset: e.dataset, layer: e.layer, previous: okOrUndefined(e.previous) }] : [],
	);
	const rows = combinedRows(okLayers, mode);
	const network = popNetworkStats(pops);
	const usedCountries = new Set(rows.map((r) => (isPop ? pops.find((p) => p.iata === r.key)?.country : r.key)).filter(Boolean));

	if (!entries.length) return <aside className="sidebar muted">Select one or more traffic types to add them to the map.</aside>;

	return (
		<aside className="sidebar">
			<section className="stats">
				{isPop ? (
					<>
						<Stat
							label="Cloudflare POPs used"
							value={`${rows.length} / ${network.pops}`}
							hint={`${formatShare(network.pops ? rows.length / network.pops : 0)} of the network, all selected traffic`}
						/>
						<Stat label="countries with active POPs" value={`${usedCountries.size}`} hint={`of ${network.countries} with POPs`} />
					</>
				) : (
					<Stat label="countries with users" value={`${rows.length}`} hint="all selected traffic" />
				)}
			</section>

			<section className="dataset-cards">
				{entries.map((e) => (
					<DatasetCard key={e.dataset} {...e} mode={mode} range={range} />
				))}
			</section>

			{okLayers.length > 0 && (
				<table className="table">
					<thead>
						<tr>
							<th>{isPop ? "Data center" : "Country"}</th>
							{okLayers.map(({ dataset }) => (
								<th key={dataset} className="num" title={`${DATASETS[dataset].label}: share of total, change vs ${PERIOD_LABEL[range]}`}>
									<i className="swatch" style={{ background: DATASET_COLORS[dataset], borderColor: DATASET_COLORS[dataset] }} />
									{DATASET_SHORT[dataset]}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.key} className={r.key === selectedKey ? "selected" : undefined} onClick={() => onSelect(r.key === selectedKey ? null : r.key)}>
								<td>
									<div className="name">{r.name}</div>
									<div className="sub">{r.sub}</div>
								</td>
								{okLayers.map(({ dataset }) => {
									const cell = r.cells[dataset];
									const { unit, distinct } = DATASETS[dataset];
									return (
										<td key={dataset} className="num share" title={cell ? formatValue(cell.value, unit) : undefined}>
											{cell ? (
												<>
													<span className="bar" style={{ width: `${cell.share * 100}%`, background: DATASET_COLORS[dataset] }} />
													{distinct ? formatAmount(cell.value, unit) : formatShare(cell.share)}
													<div className="cell-change">
														<Change value={cell.change} />
													</div>
												</>
											) : (
												<span className="muted">–</span>
											)}
										</td>
									);
								})}
							</tr>
						))}
						{rows.length === 0 && (
							<tr>
								<td colSpan={okLayers.length + 1} className="muted">
									No traffic in this period.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			)}
		</aside>
	);
}
