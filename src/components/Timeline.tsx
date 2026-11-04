interface Props {
	/** ISO bucket start times, sorted. */
	times: string[];
	index: number;
	bucket: "hour" | "day";
	playing: boolean;
	loading: boolean;
	onIndex: (index: number) => void;
	onPlayingChange: (playing: boolean) => void;
}

const formatTime = (iso: string, bucket: "hour" | "day") => {
	const d = new Date(iso);
	return bucket === "day"
		? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
		: d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
};

/** Play/scrub through hourly (24h, 7d) or daily (30d, 90d) traffic frames. */
export function Timeline({ times, index, bucket, playing, loading, onIndex, onPlayingChange }: Props) {
	if (!times.length) {
		return <div className="timeline muted">{loading ? "Loading timeline…" : "No timeline data for this view."}</div>;
	}
	return (
		<div className="timeline">
			<button className="timeline-play" onClick={() => onPlayingChange(!playing)} aria-label={playing ? "Pause" : "Play"}>
				{playing ? "❚❚" : "▶"}
			</button>
			<input
				type="range"
				min={0}
				max={times.length - 1}
				value={index}
				onChange={(e) => onIndex(Number(e.target.value))}
				aria-label="Time"
			/>
			<span className="timeline-label">
				{formatTime(times[index], bucket)}
				<span className="muted"> · {bucket === "hour" ? "local time, hourly" : "daily"}</span>
			</span>
		</div>
	);
}
