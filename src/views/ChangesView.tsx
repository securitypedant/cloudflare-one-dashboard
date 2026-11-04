import { useMemo, useState } from "react";
import type { AuditEntry, ChangesResponse } from "../../shared/admin.ts";
import type { RangeId } from "../../shared/types.ts";
import { DataTable } from "../components/DataTable.tsx";
import { SectionView } from "../components/SectionView.tsx";
import { Section, Stat, Status, StatusPill } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";

const day = (iso: string) => iso.slice(0, 10);
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
/** "access_application.update" style actions → readable. */
const verb = (action: string) => action.replace(/[_.]/g, " ");

/** Old/new values side by side, with changed lines highlighted. */
function ValueDiff({ oldValue, newValue }: { oldValue: string | null; newValue: string | null }) {
	if (!oldValue && !newValue) return <p className="muted">No values recorded for this change.</p>;
	const oldLines = (oldValue ?? "").split("\n");
	const newLines = (newValue ?? "").split("\n");
	const oldSet = new Set(oldLines);
	const newSet = new Set(newLines);
	return (
		<div className="diff">
			<div>
				<div className="diff-head">Before</div>
				<pre>
					{oldLines.map((l, i) => (
						<div key={i} className={newSet.has(l) ? "" : "diff-del"}>
							{l || " "}
						</div>
					))}
				</pre>
			</div>
			<div>
				<div className="diff-head">After</div>
				<pre>
					{newLines.map((l, i) => (
						<div key={i} className={oldSet.has(l) ? "" : "diff-add"}>
							{l || " "}
						</div>
					))}
				</pre>
			</div>
		</div>
	);
}

export function ChangesView({ range }: { range: RangeId }) {
	const res = useApi<ChangesResponse>(`/api/changes?range=${range}`);
	const [ztOnly, setZtOnly] = useState(true);
	const [pickedDay, setPickedDay] = useState<string | null>(null);
	const entries = useMemo(() => (res.data?.entries.ok ? res.data.entries.data : []), [res.data]);
	const scoped = useMemo(() => (ztOnly ? entries.filter((e) => e.zeroTrust) : entries), [entries, ztOnly]);
	const perDay = useMemo(() => {
		const m = new Map<string, number>();
		for (const e of scoped) m.set(day(e.when), (m.get(day(e.when)) ?? 0) + 1);
		return [...m].sort((a, b) => a[0].localeCompare(b[0]));
	}, [scoped]);
	const maxDay = Math.max(1, ...perDay.map(([, n]) => n));
	const actors = new Set(scoped.map((e) => e.actor)).size;
	const failed = scoped.filter((e) => !e.result).length;

	return (
		<main className="page">
			<Status loading={res.loading} error={res.error} />
			{res.data && (
				<SectionView result={res.data.entries}>
					{() => (
						<>
							<section className="stats">
								<Stat label="changes" value={scoped.length.toLocaleString()} hint={ztOnly ? "Zero Trust only" : "all account changes"} />
								<Stat label="people / systems making changes" value={String(actors)} />
								<Stat label="failed actions" value={String(failed)} />
							</section>
							<Section title="Changes per day" hint={pickedDay ? `Showing ${pickedDay}. Click the bar again to clear.` : "Click a day to filter the table."}>
								<div className="day-chart clickable">
									{perDay.map(([d, n]) => (
										<button key={d} className={`day-bar ${pickedDay === d ? "picked" : ""}`} title={`${d}: ${n} changes`} onClick={() => setPickedDay(pickedDay === d ? null : d)}>
											<span style={{ height: `${(n / maxDay) * 100}%`, background: "#38bdf8" }} />
										</button>
									))}
								</div>
							</Section>
							<Section title="Audit log">
								<DataTable<AuditEntry>
									rows={scoped}
									rowKey={(e) => e.id}
									placeholder="Search actor, action, resource, values…"
									searchText={(e) => `${e.actor} ${e.action} ${e.resourceType} ${e.resourceId} ${e.interface} ${e.actorIp} ${e.oldValue ?? ""} ${e.newValue ?? ""}`}
									facets={[
										{ key: "actor", label: "Actor", value: (e) => e.actor || e.actorType },
										{ key: "action", label: "Action", value: (e) => e.action },
										{ key: "resource", label: "Resource", value: (e) => e.resourceType },
										{ key: "interface", label: "Via", value: (e) => e.interface },
										{ key: "result", label: "Result", value: (e) => (e.result ? "succeeded" : "failed") },
									]}
									extraFilter={pickedDay ? (e) => day(e.when) === pickedDay : undefined}
									toolbar={
										<label className="toolbar-label">
											<input type="checkbox" checked={ztOnly} onChange={(e) => setZtOnly(e.target.checked)} /> Zero Trust only
										</label>
									}
									columns={[
										{ key: "when", label: "When", render: (e) => time(e.when), sort: (e) => e.when, width: "140px" },
										{ key: "actor", label: "Actor", render: (e) => <span className="name">{e.actor || e.actorType}</span>, sort: (e) => e.actor },
										{ key: "action", label: "Action", render: (e) => verb(e.action), sort: (e) => e.action },
										{ key: "resource", label: "Resource", render: (e) => <span title={e.resourceId}>{e.resourceType}</span>, sort: (e) => e.resourceType },
										{ key: "result", label: "Result", render: (e) => (e.result ? <span className="ok-text">✓</span> : <StatusPill text="failed" color="#f87171" />), sort: (e) => (e.result ? 1 : 0), width: "70px" },
									]}
									initialSort={{ key: "when", dir: "desc" }}
									expand={(e) => (
										<div className="detail">
											<p className="muted">
												{e.actorType} {e.actor} {e.actorIp && `from ${e.actorIp}`} via {e.interface || "unknown"} · resource {e.resourceType} <code>{e.resourceId}</code> · {new Date(e.when).toLocaleString()}
											</p>
											<ValueDiff oldValue={e.oldValue} newValue={e.newValue} />
										</div>
									)}
									emptyText="No changes match."
								/>
								{res.data?.truncated && <p className="section-hint">Showing the newest 5,000 changes. Pick a shorter range to see older ones.</p>}
							</Section>
						</>
					)}
				</SectionView>
			)}
		</main>
	);
}
