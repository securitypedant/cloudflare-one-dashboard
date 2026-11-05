import { useEffect, useRef, useState } from "react";
import { TrafficCharts } from "./charts.tsx";
import {
	DATASET_IDS,
	DATASETS,
	MAP_MODES,
	unavailableReason,
	type DatasetId,
	type MapMode,
	type Pop,
	type RangeId,
	type TimelineResponse,
	type TrafficLayer,
	type TrafficResponse,
	type Vendor,
} from "../../shared/types.ts";
import { TrafficMap, type MapLayer } from "../components/TrafficMap.tsx";
import { Sidebar, type SidebarEntry } from "../components/Sidebar.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { DATASET_COLORS } from "../lib/colors.ts";
import { getJson, useApi } from "../lib/api.ts";
import { VendorPicker } from "../components/VendorPicker.tsx";
import { vendorMarkers } from "../lib/vendors.ts";

const MODE_LABELS: Record<MapMode, string> = { pop: "By Cloudflare POP", country: "By user location" };
const FRAME_MS = 700;

/** current = selected range; previous = the period before it (trends); timeline = per-bucket frames. */
type Kind = "current" | "previous" | "timeline";

interface View {
	range: RangeId;
	dataset: DatasetId;
	mode: MapMode;
	kind: Kind;
}

/** Result for one view. Never rejects: failures become an `error` layer. */
interface ViewResult {
	layer: TrafficLayer;
	period?: TrafficResponse["range"];
	frames?: TimelineResponse["frames"];
}

const viewKey = (v: View) => `${v.range}|${v.dataset}|${v.mode}|${v.kind}`;

async function loadView(view: View): Promise<ViewResult> {
	const reason = unavailableReason(view.dataset, view.mode, view.range);
	if (reason) return { layer: { status: "unavailable", reason } };
	// Fixed parameter order: the query string is part of the Workers Cache key.
	const params = `range=${view.range}&dataset=${view.dataset}&mode=${view.mode}`;
	try {
		if (view.kind === "timeline") {
			const t = await getJson<TimelineResponse>(`/api/timeline?${params}`);
			return { layer: t.layer, frames: t.frames, period: t.range };
		}
		const t = await getJson<TrafficResponse>(`/api/traffic?${params}${view.kind === "previous" ? "&offset=1" : ""}`);
		return { layer: t.layer, period: t.range };
	} catch (e) {
		return { layer: { status: "error", source: "/api", error: (e as Error).message } };
	}
}

interface Props {
	range: RangeId;
	pops: Pop[];
	vendorIds: string[];
	onVendorIds: (ids: string[]) => void;
	view?: "map" | "chart";
}

export function TrafficView({ range, pops, vendorIds, onVendorIds, view = "map" }: Props) {
	const vendors = useApi<Vendor[]>("/api/vendors");
	const [mode, setMode] = useState<MapMode>("pop");
	const [selected, setSelected] = useState<DatasetId[]>(["dns"]);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [results, setResults] = useState<Record<string, ViewResult>>({});
	const [timelineOn, setTimelineOn] = useState(false);
	const [frame, setFrame] = useState(0);
	const [playing, setPlaying] = useState(false);
	const cache = useRef(new Map<string, Promise<ViewResult>>());

	// Load every selected dataset (current + previous period, and frames when the timeline is open).
	useEffect(() => {
		const kinds: Kind[] = timelineOn ? ["current", "previous", "timeline"] : ["current", "previous"];
		for (const dataset of selected) {
			for (const kind of kinds) {
				const key = viewKey({ range, dataset, mode, kind });
				if (cache.current.has(key)) continue;
				const pending = loadView({ range, dataset, mode, kind });
				cache.current.set(key, pending);
				pending.then((result) => {
					if (result.layer.status === "error") cache.current.delete(key);
					setResults((prev) => ({ ...prev, [key]: result }));
				});
			}
		}
	}, [range, mode, selected, timelineOn]);

	const resultFor = (dataset: DatasetId, kind: Kind) => results[viewKey({ range, dataset, mode, kind })];
	const entries: SidebarEntry[] = selected.map((dataset) => ({
		dataset,
		layer: resultFor(dataset, "current")?.layer,
		previous: resultFor(dataset, "previous")?.layer,
	}));
	const loading = entries.some((e) => !e.layer) || (timelineOn && selected.some((d) => !resultFor(d, "timeline")));

	// Timeline: union of frame times across the selected datasets.
	const timelines = selected.flatMap((dataset) => {
		const r = resultFor(dataset, "timeline");
		return r?.layer.status === "ok" && r.frames ? [{ dataset, layer: r.layer, frames: r.frames }] : [];
	});
	const frameTimes = [...new Set(timelines.flatMap((t) => t.frames.map((f) => f.t)))].sort();
	const frameIndex = Math.min(frame, Math.max(frameTimes.length - 1, 0));
	const frameTime = frameTimes[frameIndex];

	useEffect(() => {
		if (!playing || frameTimes.length < 2) return;
		const id = setInterval(() => setFrame((f) => (f + 1) % frameTimes.length), FRAME_MS);
		return () => clearInterval(id);
	}, [playing, frameTimes.length]);

	const mapLayers: MapLayer[] = timelineOn
		? timelines.map(({ dataset, layer, frames }) => {
				const values = frames.find((f) => f.t === frameTime)?.values ?? {};
				const points = layer.points.flatMap((p) => (values[p.key] ? [{ ...p, value: values[p.key] }] : []));
				const { label, unit } = DATASETS[dataset];
				return {
					dataset,
					label,
					unit,
					color: DATASET_COLORS[dataset],
					points,
					total: points.reduce((s, p) => s + p.value, 0),
					// Same scale for every frame so circles grow and shrink through the day.
					scaleMax: Math.max(0, ...frames.flatMap((f) => Object.values(f.values))),
				};
			})
		: entries.flatMap(({ dataset, layer }) => {
				if (layer?.status !== "ok") return [];
				const { label, unit } = DATASETS[dataset];
				return [{ dataset, label, unit, color: DATASET_COLORS[dataset], points: layer.points, total: layer.total }];
			});

	const toggleDataset = (id: DatasetId) => {
		setSelected((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : DATASET_IDS.filter((d) => d === id || prev.includes(d))));
	};
	const changeMode = (m: MapMode) => {
		setMode(m);
		setSelectedKey(null);
		setFrame(0);
	};

	return (
		<>
			<nav className="toolbar" aria-label="Traffic map options">
				<div className="segmented" role="tablist" aria-label="Map mode">
					{MAP_MODES.map((m) => (
						<button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "active" : ""} onClick={() => changeMode(m)}>
							{MODE_LABELS[m]}
						</button>
					))}
				</div>
				<span className="toolbar-sep" />
				{DATASET_IDS.map((id) => {
					const reason = unavailableReason(id, mode, range);
					const on = selected.includes(id);
					const color = DATASET_COLORS[id];
					return (
						<button
							key={id}
							className={`dataset-toggle${on ? " on" : ""}`}
							style={on ? { borderColor: color, background: `${color}26` } : undefined}
							aria-pressed={on}
							onClick={() => toggleDataset(id)}
							title={reason ?? undefined}
						>
							<i className="swatch" style={{ background: on ? color : "transparent", borderColor: color }} />
							{DATASETS[id].label}
							{reason && <span className="badge">n/a</span>}
						</button>
					);
				})}
				<span className="toolbar-sep" />
				<button
					className={timelineOn ? "active" : ""}
					aria-pressed={timelineOn}
					onClick={() => {
						setTimelineOn((on) => !on);
						setPlaying(false);
					}}
				>
					▶ Timeline
				</button>
				<span className="toolbar-sep" />
				<VendorPicker vendors={vendors.data} selected={vendorIds} onChange={onVendorIds} />
				{loading && <span className="muted loading">Loading…</span>}
			</nav>

			<main className="main">
				{view === "map" ? (
					<TrafficMap
						pops={pops}
						layers={mapLayers}
						mode={mode}
						selectedKey={selectedKey}
						onSelect={setSelectedKey}
						markers={vendorMarkers(vendors.data, vendorIds)}
					>
						{timelineOn && (
							<Timeline
								times={frameTimes}
								index={frameIndex}
								bucket={range === "30d" || range === "90d" ? "day" : "hour"}
								playing={playing}
								loading={timelines.length < selected.length}
								onIndex={(i) => {
									setFrame(i);
									setPlaying(false);
								}}
								onPlayingChange={setPlaying}
							/>
						)}
					</TrafficMap>
				) : (
					<TrafficCharts datasets={selected} range={range} mode={mode} selectedKey={selectedKey} pops={pops} />
				)}
				<Sidebar entries={entries} mode={mode} pops={pops} range={range} selectedKey={selectedKey} onSelect={setSelectedKey} />
			</main>
		</>
	);
}
