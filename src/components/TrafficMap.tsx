import { useEffect, useRef, useState } from "react";
import {
	Map as MapLibreMap,
	Marker,
	NavigationControl,
	Popup,
	setWorkerUrl,
	type GeoJSONSource,
	type LngLatLike,
	type PointLike,
	type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { FeatureCollection, LineString, Point, Position } from "geojson";
import type { DatasetId, MapMode, Pop, TrafficPoint, Unit } from "../../shared/types.ts";
import { escapeHtml, formatShare, formatValue } from "../lib/format.ts";
import { POP_COLOR } from "../lib/colors.ts";
import { countriesGeo, MAPPED_COUNTRIES } from "../lib/worldGeo.ts";

// MapLibre resolves its worker relative to its own module URL, which breaks once Vite bundles it.
setWorkerUrl(maplibreWorkerUrl);

const MIN_RADIUS = 4;
const MAX_RADIUS = 38;
const BASE_FILL = "#1a2333";
// Filter value for "no country selected". Must not be "": that's the iso2 of features without an ISO code.
const NO_SELECTION = "-";

const BASE_STYLE: StyleSpecification = {
	version: 8,
	sources: { countries: { type: "geojson", data: countriesGeo, promoteId: "iso2" } },
	layers: [
		{ id: "background", type: "background", paint: { "background-color": "#0b1220" } },
		{ id: "countries-fill", type: "fill", source: "countries", paint: { "fill-color": BASE_FILL } },
		{
			// Choropleth: colour and opacity from feature-state (`color`, `t` = 0..1).
			id: "countries-traffic",
			type: "fill",
			source: "countries",
			paint: {
				"fill-color": ["to-color", ["coalesce", ["feature-state", "color"], BASE_FILL]],
				"fill-opacity": ["interpolate", ["linear"], ["coalesce", ["feature-state", "t"], 0], 0, 0, 0.0001, 0.18, 1, 0.85],
			},
		},
		{ id: "countries-line", type: "line", source: "countries", paint: { "line-color": "#2b3a52", "line-width": 0.6 } },
		{
			id: "countries-selected",
			type: "line",
			source: "countries",
			filter: ["==", ["get", "iso2"], NO_SELECTION],
			paint: { "line-color": "#f2f5fa", "line-width": 1.8 },
		},
	],
};

/** One traffic dataset drawn on the map. */
export interface MapLayer {
	dataset: DatasetId;
	label: string;
	unit: Unit;
	color: string;
	points: TrafficPoint[];
	total: number;
	/** Value that maps to the largest circle / deepest fill. Defaults to the busiest point. */
	scaleMax?: number;
	/** Per-point colour (e.g. latency buckets); defaults to `color`. */
	colorFor?: (p: TrafficPoint) => string;
}

/** A flow drawn as a line (e.g. country → POP, entry → exit POP). */
export interface MapLine {
	coords: Position[];
	color: string;
	width: number;
	opacity?: number;
	/** Draw an arrowhead at the last coordinate to show direction. */
	arrow?: boolean;
}

/** A small HTML label pinned to the map (e.g. a country badge or POP code). Text is set safely via textContent. */
export interface MapLabel {
	key: string;
	lon: number;
	lat: number;
	text: string;
	/** Optional second part rendered in `accent` colour (e.g. "98% local"). */
	accentText?: string;
	accent?: string;
	kind: "country" | "pop";
	dimmed?: boolean;
}

/** A marker on top of the map: hollow ring (e.g. CNI facility) or filled diamond (another vendor's POP). */
export interface MapMarker {
	lon: number;
	lat: number;
	color: string;
	label: string;
	shape?: "ring" | "diamond";
}

/** Explicit country shading (overrides the dataset fill): colour plus strength 0..1 per ISO alpha-2 code. */
export interface CountryFill {
	key: string;
	color: string;
	t: number;
}

/** White arrowhead pointing up (north), used as an SDF icon so it can take each line's colour. */
function arrowImage(): ImageData {
	const size = 32;
	const canvas = new OffscreenCanvas(size, size);
	const ctx = canvas.getContext("2d")!;
	ctx.beginPath();
	ctx.moveTo(size / 2, 3);
	ctx.lineTo(size - 5, size - 5);
	ctx.lineTo(size / 2, size - 11);
	ctx.lineTo(5, size - 5);
	ctx.closePath();
	ctx.fillStyle = "#fff";
	ctx.fill();
	return ctx.getImageData(0, 0, size, size);
}

/** Compass bearing (degrees clockwise from north) of the last segment, for rotating arrowheads. */
function endBearing(coords: Position[]): number {
	const [a, b] = [coords[coords.length - 2], coords[coords.length - 1]];
	const toRad = (d: number) => (d * Math.PI) / 180;
	const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
	const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
	return (Math.atan2(y, x) * 180) / Math.PI;
}

const arrowsGeoJSON = (lines: MapLine[]): FeatureCollection<Point> => ({
	type: "FeatureCollection",
	features: lines
		.filter((l) => l.arrow && l.coords.length >= 2)
		.map((l) => ({
			type: "Feature",
			geometry: { type: "Point", coordinates: l.coords[l.coords.length - 1] },
			properties: { color: l.color, bearing: endBearing(l.coords), size: Math.min(1.1, 0.45 + l.width / 10), opacity: l.opacity ?? 0.6 },
		})),
});

const DIAMOND_PX = 14;

/** Diamond icon in `color` with a dark outline, rendered at 2x for sharp edges. */
function diamondImage(color: string): ImageData {
	const size = DIAMOND_PX * 2;
	const canvas = new OffscreenCanvas(size, size);
	const ctx = canvas.getContext("2d")!;
	const h = size / 2;
	ctx.beginPath();
	ctx.moveTo(h, 2);
	ctx.lineTo(size - 2, h);
	ctx.lineTo(h, size - 2);
	ctx.lineTo(2, h);
	ctx.closePath();
	ctx.fillStyle = color;
	ctx.fill();
	ctx.lineWidth = 3;
	ctx.strokeStyle = "#0b1220";
	ctx.stroke();
	return ctx.getImageData(0, 0, size, size);
}

interface Props {
	pops: Pop[];
	layers: MapLayer[];
	mode: MapMode;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
	lines?: MapLine[];
	markers?: MapMarker[];
	labels?: MapLabel[];
	onLabelClick?: (key: string) => void;
	countryFill?: CountryFill[];
	/** Custom hover HTML for a location key; defaults to listing each layer's value. Must escape its own text. */
	popupFor?: (key: string) => string | null;
	/** Hide the shading-dataset picker and legend rows (views that draw their own legend). */
	legend?: React.ReactNode;
	/** Overlays rendered inside the map area (e.g. the timeline control). */
	children?: React.ReactNode;
}

const layerMax = (layer: MapLayer) => layer.scaleMax ?? layer.points.reduce((m, p) => Math.max(m, p.value), 0);

type CircleProps = { key: string; color: string; radius: number; selected: boolean };

const scaled = (value: number, max: number) => (max ? Math.sqrt(Math.max(0, value) / max) : 0);

/**
 * One circle per dataset per location. Each dataset is scaled to its own busiest location (units
 * differ), so circles at a location are concentric and compare relative concentration.
 */
function trafficGeoJSON(layers: MapLayer[], selectedKey: string | null): FeatureCollection<Point, CircleProps> {
	return {
		type: "FeatureCollection",
		features: layers.flatMap((layer) => {
			const max = layerMax(layer);
			return layer.points.map((p) => ({
				type: "Feature" as const,
				geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
				properties: {
					key: p.key,
					color: layer.colorFor?.(p) ?? layer.color,
					radius: MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * scaled(p.value, max),
					selected: p.key === selectedKey,
				},
			}));
		}),
	};
}

const popsGeoJSON = (pops: Pop[]): FeatureCollection<Point> => ({
	type: "FeatureCollection",
	features: pops.map((p) => ({
		type: "Feature",
		geometry: { type: "Point", coordinates: [p.lon, p.lat] },
		properties: { iata: p.iata, city: p.city },
	})),
});

const linesGeoJSON = (lines: MapLine[]): FeatureCollection<LineString> => ({
	type: "FeatureCollection",
	features: lines.map((l) => ({
		type: "Feature",
		geometry: { type: "LineString", coordinates: l.coords },
		properties: { color: l.color, width: l.width, opacity: l.opacity ?? 0.6 },
	})),
});

const markersGeoJSON = (markers: MapMarker[], shape: "ring" | "diamond"): FeatureCollection<Point> => ({
	type: "FeatureCollection",
	features: markers
		.filter((m) => (m.shape ?? "ring") === shape)
		.map((m) => ({
			type: "Feature",
			geometry: { type: "Point", coordinates: [m.lon, m.lat] },
			properties: { color: m.color, label: m.label, icon: `diamond-${m.color}` },
		})),
});

function locationPopup(layers: MapLayer[], key: string, mode: MapMode): string {
	const rows = layers.flatMap((layer) => {
		const p = layer.points.find((x) => x.key === key);
		return p ? [{ layer, p }] : [];
	});
	if (!rows.length) return "";
	const { name } = rows[0].p;
	const title = escapeHtml(mode === "pop" ? `${name} (${key})` : name);
	const lines = rows.map(
		({ layer, p }) =>
			`<div class="popup-row"><i style="background:${layer.color}"></i>${escapeHtml(layer.label)}: ${formatValue(p.value, layer.unit)} &middot; ${formatShare(p.value / layer.total)}</div>`,
	);
	return `<strong>${title}</strong>${lines.join("")}`;
}

export function TrafficMap({
	pops,
	layers,
	mode,
	selectedKey,
	onSelect,
	lines = [],
	markers = [],
	labels = [],
	onLabelClick,
	countryFill,
	popupFor,
	legend,
	children,
}: Props) {
	const container = useRef<HTMLDivElement>(null);
	const mapRef = useRef<MapLibreMap | null>(null);
	const [ready, setReady] = useState(false);
	const [fillBy, setFillBy] = useState<DatasetId | null>(null);
	// In "By user location", one dataset shades the countries (the first selected unless the user picks another).
	const fillLayer = mode === "country" ? (layers.find((l) => l.dataset === fillBy) ?? layers[0]) : undefined;
	// Circles: every dataset in POP mode; in country mode only the fill dataset's countries that have no polygon.
	const circleLayers = fillLayer
		? [{ ...fillLayer, points: fillLayer.points.filter((p) => !MAPPED_COUNTRIES.has(p.key)) }]
		: mode === "pop"
			? layers
			: [];

	// Latest props for map event handlers registered once at init.
	const latest = useRef({ layers, mode, onSelect, popupFor });
	useEffect(() => {
		latest.current = { layers, mode, onSelect, popupFor };
	});

	useEffect(() => {
		const map = new MapLibreMap({
			container: container.current!,
			style: BASE_STYLE,
			center: [15, 25],
			zoom: 1.2,
			minZoom: 0.8,
			maxZoom: 8,
			renderWorldCopies: false,
			attributionControl: false,
		});
		mapRef.current = map;
		map.on("error", (e) => console.error("[map]", e.error?.message ?? e.error));
		map.addControl(new NavigationControl({ showCompass: false }), "top-left");
		const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 8 });

		map.on("load", () => {
			map.addSource("lines", { type: "geojson", data: linesGeoJSON([]) });
			map.addSource("arrows", { type: "geojson", data: arrowsGeoJSON([]) });
			map.addImage("arrow", arrowImage(), { sdf: true, pixelRatio: 2 });
			map.addSource("traffic", { type: "geojson", data: trafficGeoJSON([], null) });
			map.addSource("pops", { type: "geojson", data: popsGeoJSON([]) });
			map.addSource("markers", { type: "geojson", data: markersGeoJSON([], "ring") });
			map.addSource("diamonds", { type: "geojson", data: markersGeoJSON([], "diamond") });
			map.addLayer({
				id: "flow-lines",
				type: "line",
				source: "lines",
				layout: { "line-cap": "round" },
				paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"] },
			});
			map.addLayer({
				id: "flow-arrows",
				type: "symbol",
				source: "arrows",
				layout: {
					"icon-image": "arrow",
					"icon-size": ["get", "size"],
					"icon-rotate": ["get", "bearing"],
					"icon-rotation-alignment": "map",
					"icon-allow-overlap": true,
					"icon-ignore-placement": true,
				},
				paint: { "icon-color": ["get", "color"], "icon-opacity": ["get", "opacity"] },
			});
			map.addLayer({
				id: "traffic-circles",
				type: "circle",
				source: "traffic",
				// Larger circles first so smaller concentric ones stay visible on top.
				layout: { "circle-sort-key": ["-", 0, ["get", "radius"]] },
				paint: {
					"circle-radius": ["interpolate", ["linear"], ["zoom"], 1, ["get", "radius"], 6, ["*", ["get", "radius"], 2.5]],
					"circle-color": ["get", "color"],
					"circle-opacity": ["case", ["get", "selected"], 0.35, 0.12],
					"circle-stroke-color": ["get", "color"],
					"circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.5],
				},
			});
			map.addLayer({
				id: "markers",
				type: "circle",
				source: "markers",
				paint: {
					"circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3, 6, 6],
					"circle-color": "rgba(0,0,0,0)",
					"circle-stroke-color": ["get", "color"],
					"circle-stroke-width": 1.5,
				},
			});
			map.addLayer({
				id: "pops",
				type: "circle",
				source: "pops",
				paint: {
					"circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2, 6, 4.5],
					"circle-color": POP_COLOR,
					"circle-stroke-color": "#0b1220",
					"circle-stroke-width": 0.5,
				},
			});
			// Other vendors' POPs on top of everything, as diamonds so they never read as Cloudflare dots.
			map.addLayer({
				id: "diamonds",
				type: "symbol",
				source: "diamonds",
				layout: {
					"icon-image": ["get", "icon"],
					"icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 6, 0.8],
					"icon-allow-overlap": true,
					"icon-ignore-placement": true,
				},
			});
			setReady(true);
		});

		const showPopup = (lngLat: LngLatLike, html: string) => popup.setLngLat(lngLat).setHTML(html).addTo(map);

		/** Location key under the cursor: a traffic circle, or a shaded country in "By user location". */
		const keyAt = (point: PointLike) => {
			const [circle] = map.queryRenderedFeatures(point, { layers: ["traffic-circles"] });
			if (circle) return (circle.properties as CircleProps).key;
			const [country] = map.queryRenderedFeatures(point, { layers: ["countries-traffic"] });
			return country?.state?.t ? (country.properties.iso2 as string) : null;
		};

		map.on("mousemove", (e) => {
			if (!map.getLayer("traffic-circles")) return;
			const key = keyAt(e.point);
			const [pop] = map.queryRenderedFeatures(e.point, { layers: ["pops"] });
			const [marker] = map.queryRenderedFeatures(e.point, { layers: ["diamonds", "markers"] });
			const { layers, mode, popupFor } = latest.current;
			map.getCanvas().style.cursor = key ? "pointer" : "";
			const html = key ? (popupFor ? popupFor(key) : locationPopup(layers, key, mode)) : "";
			if (marker && !(pop && pop.properties.iata === key)) {
				showPopup(e.lngLat, escapeHtml(String(marker.properties.label)));
			} else if (pop) {
				const { city, iata } = pop.properties as { city: string; iata: string };
				const traffic = iata === key ? html : "";
				showPopup(e.lngLat, traffic || `<strong>${escapeHtml(`${city} (${iata})`)}</strong><br>Cloudflare data center`);
			} else if (html) {
				showPopup(e.lngLat, html);
			} else {
				popup.remove();
			}
		});
		map.on("click", (e) => {
			if (!map.getLayer("traffic-circles")) return;
			latest.current.onSelect(keyAt(e.point));
		});

		return () => {
			setReady(false);
			mapRef.current = null;
			map.remove();
		};
	}, []);

	useEffect(() => {
		const map = mapRef.current;
		if (!map || !ready) return;
		(map.getSource("pops") as GeoJSONSource).setData(popsGeoJSON(pops));
	}, [ready, pops]);

	useEffect(() => {
		const map = mapRef.current;
		if (!map || !ready) return;
		(map.getSource("traffic") as GeoJSONSource).setData(trafficGeoJSON(circleLayers, selectedKey));
		(map.getSource("lines") as GeoJSONSource).setData(linesGeoJSON(lines));
		(map.getSource("arrows") as GeoJSONSource).setData(arrowsGeoJSON(lines));
		(map.getSource("markers") as GeoJSONSource).setData(markersGeoJSON(markers, "ring"));
		for (const color of new Set(markers.filter((m) => m.shape === "diamond").map((m) => m.color))) {
			if (!map.hasImage(`diamond-${color}`)) map.addImage(`diamond-${color}`, diamondImage(color), { pixelRatio: 2 });
		}
		(map.getSource("diamonds") as GeoJSONSource).setData(markersGeoJSON(markers, "diamond"));
	});

	// HTML labels (country badges, POP codes). Few enough to rebuild when they change.
	const labelKey = labels.map((l) => `${l.key}|${l.text}|${l.accentText ?? ""}|${l.dimmed ? 1 : 0}`).join(";");
	const labelsRef = useRef(labels);
	const onLabelClickRef = useRef(onLabelClick);
	useEffect(() => {
		labelsRef.current = labels;
		onLabelClickRef.current = onLabelClick;
	});
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !ready) return;
		const created = labelsRef.current.map((l) => {
			const el = document.createElement("div");
			el.className = `map-label ${l.kind}${l.dimmed ? " dimmed" : ""}`;
			const main = document.createElement("span");
			main.textContent = l.text;
			el.appendChild(main);
			if (l.accentText) {
				const accent = document.createElement("span");
				accent.className = "accent";
				accent.textContent = l.accentText;
				if (l.accent) accent.style.color = l.accent;
				el.appendChild(accent);
			}
			el.addEventListener("click", (e) => {
				e.stopPropagation();
				onLabelClickRef.current?.(l.key);
			});
			return new Marker({ element: el, anchor: l.kind === "pop" ? "bottom" : "center", offset: l.kind === "pop" ? [0, -6] : [0, 0] })
				.setLngLat([l.lon, l.lat])
				.addTo(map);
		});
		return () => created.forEach((m) => m.remove());
	}, [ready, labelKey]);

	// Country choropleth: feature-state per ISO alpha-2 code.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !ready) return;
		map.removeFeatureState({ source: "countries" });
		map.setFilter("countries-selected", ["==", ["get", "iso2"], ((mode === "country" || countryFill) && selectedKey) || NO_SELECTION]);
		if (countryFill) {
			for (const c of countryFill) {
				if (MAPPED_COUNTRIES.has(c.key)) map.setFeatureState({ source: "countries", id: c.key }, { t: c.t, color: c.color });
			}
			return;
		}
		if (!fillLayer) return;
		const max = layerMax(fillLayer);
		for (const p of fillLayer.points) {
			if (!MAPPED_COUNTRIES.has(p.key)) continue;
			map.setFeatureState({ source: "countries", id: p.key }, { t: scaled(p.value, max), color: fillLayer.colorFor?.(p) ?? fillLayer.color });
		}
	}, [ready, fillLayer, countryFill, mode, selectedKey]);

	// Fly to a location only when the selection changes, not on every data refresh.
	useEffect(() => {
		const map = mapRef.current;
		const point = latest.current.layers.flatMap((l) => l.points).find((p) => p.key === selectedKey);
		if (map && point) map.easeTo({ center: [point.lon, point.lat], zoom: Math.max(map.getZoom(), 3) });
	}, [selectedKey]);

	// One legend entry per vendor shown as diamonds (label is "<vendor>: <city>").
	const vendorLegend = [...new Map(markers.filter((m) => m.shape === "diamond").map((m) => [m.color, m.label.split(":")[0]]))];

	return (
		<div className="map-wrap">
			<div ref={container} className="map" />
			{children}
			<div className="legend">
				<span>
					<i className="dot" style={{ background: POP_COLOR }} /> Cloudflare POP ({pops.length})
				</span>
				{vendorLegend.map(([color, name]) => (
					<span key={color}>
						<i className="diamond" style={{ background: color }} /> {name} POP ({markers.filter((m) => m.color === color).length})
					</span>
				))}
				{legend ?? (
					<>
						{mode === "pop" &&
							layers.map((l) => (
								<span key={l.dataset}>
									<i className="ring" style={{ borderColor: l.color, background: `${l.color}22` }} />
									{l.label} by data center
								</span>
							))}
						{fillLayer && (
							<>
								<span className="legend-gradient">
									<i style={{ background: `linear-gradient(90deg, ${fillLayer.color}2e, ${fillLayer.color}d9)` }} />
									{fillLayer.label} by user country
								</span>
								{layers.length > 1 && (
									<label className="legend-fill-by">
										Shade by{" "}
										<select value={fillLayer.dataset} onChange={(e) => setFillBy(e.target.value as DatasetId)}>
											{layers.map((l) => (
												<option key={l.dataset} value={l.dataset}>
													{l.label}
												</option>
											))}
										</select>
									</label>
								)}
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
}
