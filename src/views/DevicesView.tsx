import type { DeviceRow, DevicesResponse } from "../../shared/admin.ts";
import { DataTable } from "../components/DataTable.tsx";
import { SectionView } from "../components/SectionView.tsx";
import { BarRow, Section, Stat, Status, StatusPill } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { formatShare } from "../lib/format.ts";

const STALE_DAYS = 30;

const countBy = (rows: DeviceRow[], key: (r: DeviceRow) => string) => {
	const m = new Map<string, number>();
	for (const r of rows) m.set(key(r) || "unknown", (m.get(key(r) || "unknown") ?? 0) + 1);
	return [...m].sort((a, b) => b[1] - a[1]);
};

export function DevicesView({ onOpenUser }: { onOpenUser: (email: string) => void }) {
	const res = useApi<DevicesResponse>("/api/devices");
	const d = res.data;

	return (
		<main className="page">
			<Status loading={res.loading} error={res.error} />
			{d && (
				<SectionView result={d.devices}>
					{(devices) => {
						const stale = devices.filter((x) => x.staleDays === null || x.staleDays > STALE_DAYS);
						const outdated = devices.filter((x) => x.outdated);
						const byOs = countBy(devices, (x) => x.os);
						const byVersion = countBy(devices, (x) => x.clientVersion).slice(0, 8);
						return (
							<>
								<section className="stats">
									<Stat label="enrolled devices" value={devices.length.toLocaleString()} />
									<Stat label={`not seen in ${STALE_DAYS}+ days`} value={stale.length.toLocaleString()} hint={formatShare(devices.length ? stale.length / devices.length : 0)} />
									<Stat label="outdated WARP client" value={outdated.length.toLocaleString()} hint={d.latestClientVersion ? `newest seen: ${d.latestClientVersion}` : undefined} />
								</section>
								<div className="grid-2">
									<Section title="Operating systems">
										{byOs.map(([os, n]) => (
											<BarRow key={os} label={os} share={n / devices.length} value={`${n}`} color="#38bdf8" />
										))}
									</Section>
									<Section title="WARP client versions" hint="Outdated = more than two releases behind the newest version in your fleet.">
										{byVersion.map(([v, n]) => (
											<BarRow key={v} label={v} share={n / devices.length} value={`${n}`} color={devices.find((x) => x.clientVersion === v)?.outdated ? "#fb923c" : "#4ade80"} />
										))}
									</Section>
								</div>
								<Section title="Devices" hint="Oldest last-seen first. Click a user to see all their activity.">
									<DataTable
										rows={devices}
										rowKey={(x) => x.id}
										searchText={(x) => `${x.name} ${x.user} ${x.os} ${x.osVersion} ${x.clientVersion}`}
										facets={[
											{ key: "os", label: "OS", value: (x) => x.os },
											{ key: "health", label: "Status", value: (x) => (x.staleDays === null || x.staleDays > STALE_DAYS ? "stale" : x.outdated ? "outdated client" : "ok") },
										]}
										columns={[
											{ key: "name", label: "Device", render: (x) => <span className="name">{x.name}</span>, sort: (x) => x.name },
											{ key: "user", label: "User", render: (x) => (x.user ? <button className="link-button" onClick={() => onOpenUser(x.user)}>{x.user}</button> : <span className="muted">—</span>), sort: (x) => x.user },
											{ key: "os", label: "OS", render: (x) => `${x.os} ${x.osVersion}`, sort: (x) => x.os },
											{ key: "client", label: "WARP", render: (x) => (x.outdated ? <StatusPill text={x.clientVersion} color="#fb923c" /> : x.clientVersion), sort: (x) => x.clientVersion },
											{ key: "seen", label: "Last seen", render: (x) => (x.staleDays === null ? "never" : x.staleDays === 0 ? "today" : `${x.staleDays}d ago`), sort: (x) => x.staleDays ?? 1e9, align: "right" },
										]}
										initialSort={{ key: "seen", dir: "desc" }}
									/>
								</Section>
								<Section title="Device posture checks" hint="Configured checks. Per-device results aren't exposed by the API.">
									<SectionView result={d.postureRules}>
										{(rules) => (rules.length ? <ul className="plain-list">{rules.map((r) => <li key={r.id}><span className="name">{r.name}</span> <span className="muted">{r.type}</span></li>)}</ul> : <div className="muted">No posture checks configured.</div>)}
									</SectionView>
								</Section>
							</>
						);
					}}
				</SectionView>
			)}
		</main>
	);
}
