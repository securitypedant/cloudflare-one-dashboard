import { useEffect, useMemo, useRef, useState } from "react";
import { seriesChange, type SeriesSet } from "../lib/series.ts";

interface Props {
	title: string;
	data: SeriesSet;
	bucket: "hour" | "day";
	format: (v: number) => string;
	height?: number;
	hint?: string;
	/** Y axis from 0 (counts) or fitted to the data (averages). */
	zeroBased?: boolean;
	emptyText?: string;
}

const PAD = { top: 12, right: 14, bottom: 26, left: 56 };

const tickLabel = (iso: string, bucket: "hour" | "day") => {
	const d = new Date(iso);
	return bucket === "hour"
		? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" })
		: d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Line chart over time: hover for values at a bucket; click legend entries to hide/show lines. */
export function TimeChart({ title, data, bucket, format, height = 240, hint, zeroBased = true, emptyText = "No data in this period." }: Props) {
	const wrap = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(600);
	const [hidden, setHidden] = useState<Set<string>>(new Set());
	const [hover, setHover] = useState<number | null>(null);

	useEffect(() => {
		const el = wrap.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const visible = data.series.filter((s) => !hidden.has(s.key));
	const n = data.buckets.length;
	const { min, max } = useMemo(() => {
		const vals = visible.flatMap((s) => s.values.filter((v): v is number => v !== null));
		if (!vals.length) return { min: 0, max: 1 };
		const lo = zeroBased ? 0 : Math.min(...vals);
		const hi = Math.max(...vals);
		const pad = zeroBased ? 0 : (hi - lo) * 0.1 || 1;
		return { min: Math.max(0, lo - pad), max: hi + pad || 1 };
	}, [visible, zeroBased]);

	const w = width - PAD.left - PAD.right;
	const h = height - PAD.top - PAD.bottom;
	const x = (i: number) => PAD.left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
	const y = (v: number) => PAD.top + h - ((v - min) / (max - min)) * h;
	const path = (values: (number | null)[]) => {
		let d = "";
		let pen = false;
		values.forEach((v, i) => {
			if (v === null) {
				pen = false;
				return;
			}
			d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
			pen = true;
		});
		return d;
	};
	const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + (max - min) * f);
	const xTickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 110))));

	const onMove = (e: React.MouseEvent<SVGRectElement>) => {
		const rect = e.currentTarget.getBoundingClientRect();
		const px = e.clientX - rect.left;
		setHover(n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px / rect.width) * (n - 1)))));
	};
	const toggle = (key: string) =>
		setHidden((cur) => {
			const next = new Set(cur);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	return (
		<section className="chart-card">
			<header>
				<h3>{title}</h3>
				{hint && <p className="section-hint">{hint}</p>}
			</header>
			<div ref={wrap} className="chart-wrap">
				{n === 0 ? (
					<div className="muted chart-empty">{emptyText}</div>
				) : (
					<svg width={width} height={height} role="img" aria-label={title}>
						{yTicks.map((v, i) => (
							<g key={i}>
								<line x1={PAD.left} x2={PAD.left + w} y1={y(v)} y2={y(v)} className="chart-grid" />
								<text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="chart-axis">
									{format(v)}
								</text>
							</g>
						))}
						{data.buckets.map((b, i) =>
							i % xTickEvery === 0 ? (
								<text key={b} x={x(i)} y={height - 8} textAnchor="middle" className="chart-axis">
									{tickLabel(b, bucket)}
								</text>
							) : null,
						)}
						{visible.map((s) => (
							<path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={s.emphasis ? 2.5 : 1.75} strokeDasharray={s.emphasis ? "5 3" : undefined} />
						))}
						{hover !== null && (
							<g>
								<line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + h} className="chart-cursor" />
								{visible.map((s) =>
									s.values[hover] !== null ? <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={3} fill={s.color} /> : null,
								)}
							</g>
						)}
						<rect x={PAD.left} y={PAD.top} width={w} height={h} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
					</svg>
				)}
				{hover !== null && n > 0 && (
					<div className="chart-tooltip" style={{ left: Math.min(x(hover) + 12, width - 200) }}>
						<strong>{tickLabel(data.buckets[hover], bucket)}</strong>
						{visible.map((s) => (
							<div key={s.key}>
								<i style={{ background: s.color }} /> {s.label}: {s.values[hover] === null ? "—" : format(s.values[hover]!)}
							</div>
						))}
					</div>
				)}
			</div>
			<div className="chart-legend">
				{data.series.map((s) => {
					const change = seriesChange(s.values);
					return (
						<button key={s.key} className={hidden.has(s.key) ? "off" : ""} onClick={() => toggle(s.key)} aria-pressed={!hidden.has(s.key)}>
							<i style={{ background: s.color }} /> {s.label}
							{change !== null && (
								<span className={change >= 0 ? "up" : "down"}>
									{" "}
									{change >= 0 ? "▲" : "▼"}
									{Math.abs(change * 100).toFixed(0)}%
								</span>
							)}
						</button>
					);
				})}
			</div>
		</section>
	);
}
