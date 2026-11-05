import type { IdentityResponse, Role } from "../../shared/admin.ts";
import type { RangeId } from "../../shared/types.ts";
import { DataTable } from "../components/DataTable.tsx";
import { SectionView } from "../components/SectionView.tsx";
import { Section, Stat, Status } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { formatShare } from "../lib/format.ts";
import { useState } from "react";
import { TimeChart } from "../components/TimeChart.tsx";
import { buildSeries } from "../lib/series.ts";
import { COUNTRIES } from "../../shared/countries.ts";

const OK = "#4ade80";
const FAIL = "#f87171";

function SuccessFailBars({ rows, limit = 10 }: { rows: { key: string; label: string; success: number; failure: number }[]; limit?: number }) {
	const max = Math.max(1, ...rows.map((r) => r.success + r.failure));
	return (
		<>
			{rows.slice(0, limit).map((r) => (
				<div key={r.key} className="bar-row" title={`${r.success} succeeded, ${r.failure} failed`}>
					<div className="bar-row-label">{r.label}</div>
					<div className="bar-row-track stacked">
						<span style={{ width: `${(r.success / max) * 100}%`, background: OK }} />
						<span style={{ width: `${(r.failure / max) * 100}%`, background: FAIL }} />
					</div>
					<div className="bar-row-value">
						{r.success.toLocaleString()} / <span style={{ color: FAIL }}>{r.failure.toLocaleString()}</span>
					</div>
				</div>
			))}
		</>
	);
}

export function IdentityView({ range, role, onOpenUser }: { range: RangeId; role: Role; onOpenUser: (email: string) => void }) {
	const res = useApi<IdentityResponse>(`/api/identity?range=${range}`);
	const d = res.data;
	const total = d ? d.totals.success + d.totals.failure : 0;

	return (
		<main className="page">
			<Status loading={res.loading} error={res.error} />
			{d && (
				<>
					<section className="stats">
						<Stat label="Access logins" value={total.toLocaleString()} hint={`${formatShare(total ? d.totals.failure / total : 0)} failed`} />
						<Stat label="users signing in" value={d.totals.users.toLocaleString()} />
						{d.seats?.ok && (
							<>
								<Stat label="Access / Gateway seats" value={`${d.seats.data.access} / ${d.seats.data.gateway}`} />
								<Stat label="seats inactive > 30 days" value={String(d.seats.data.inactive30d)} hint="candidates to reclaim" />
							</>
						)}
					</section>

					<LoginCharts d={d} />

					<div className="grid-3">
						<Section title="By country">
							<SuccessFailBars rows={d.byCountry} />
						</Section>
						<Section title="By identity provider">
							<SuccessFailBars rows={d.byIdp} />
						</Section>
						<Section title="By application">
							<SuccessFailBars rows={d.byApp} />
						</Section>
					</div>

					{role === "admin" && (
						<>
							<Section title="Users" hint="Failed logins first. Click a user for their full activity. Seats inactive for 30+ days can usually be reclaimed.">
								<SectionView result={d.users}>
									{(users) => (
										<DataTable
											rows={users}
											rowKey={(u) => u.email}
											searchText={(u) => `${u.email} ${u.name}`}
											facets={[{ key: "seat", label: "Seat", value: (u) => u.seats.join(" + ") || "none" }]}
											columns={[
												{ key: "email", label: "User", render: (u) => <button className="link-button" onClick={() => onOpenUser(u.email)}>{u.email}</button>, sort: (u) => u.email },
												{ key: "name", label: "Name", render: (u) => u.name, sort: (u) => u.name },
												{ key: "success", label: "Logins", render: (u) => u.success.toLocaleString(), sort: (u) => u.success, align: "right" },
												{ key: "failure", label: "Failed", render: (u) => <span style={{ color: u.failure ? FAIL : undefined }}>{u.failure.toLocaleString()}</span>, sort: (u) => u.failure, align: "right" },
												{ key: "devices", label: "Devices", render: (u) => u.devices, sort: (u) => u.devices, align: "right" },
												{ key: "inactive", label: "Last login", render: (u) => (u.inactiveDays === null ? "never" : `${u.inactiveDays}d ago`), sort: (u) => u.inactiveDays ?? 1e9, align: "right" },
											]}
											initialSort={{ key: "failure", dir: "desc" }}
										/>
									)}
								</SectionView>
							</Section>
							<Section title="Applications with no logins in this period" hint="Candidates to remove, or apps whose users connect another way.">
								<SectionView result={d.unusedApps}>
									{(apps) =>
										apps.length ? (
											<ul className="plain-list">
												{apps.map((a) => (
													<li key={a.id}>
														<span className="name">{a.name}</span> <span className="muted">{a.domain}</span>
													</li>
												))}
											</ul>
										) : (
											<div className="ok-text">Every application had logins.</div>
										)
									}
								</SectionView>
							</Section>
						</>
					)}
					<p className="footnote">Source: Access login analytics (accessLoginRequestsAdaptiveGroups), Access users and applications APIs.</p>
				</>
			)}
		</main>
	);
}


const BREAKDOWNS = {
	country: { label: "Country", key: (r: IdentityResponse["timeline"][number]) => r.country, name: (k: string) => COUNTRIES[k]?.name ?? k },
	idp: { label: "Identity provider", key: (r: IdentityResponse["timeline"][number]) => r.idp, name: (k: string) => k },
	app: { label: "Application", key: (r: IdentityResponse["timeline"][number]) => r.app, name: (k: string) => k },
} as const;

/** Logins over time, split by country, identity provider or app; succeeded vs failed. */
function LoginCharts({ d }: { d: IdentityResponse }) {
	const [by, setBy] = useState<keyof typeof BREAKDOWNS>("country");
	const b = BREAKDOWNS[by];
	const fmt = (v: number) => Math.round(v).toLocaleString();
	return (
		<>
			<div className="chart-toolbar">
				<span className="muted">Break down by</span>
				<div className="segmented">
					{(Object.keys(BREAKDOWNS) as (keyof typeof BREAKDOWNS)[]).map((k) => (
						<button key={k} className={by === k ? "active" : ""} aria-pressed={by === k} onClick={() => setBy(k)}>
							{BREAKDOWNS[k].label}
						</button>
					))}
				</div>
			</div>
			<div className="chart-grid-2">
				<TimeChart title={`Successful logins by ${b.label.toLowerCase()}`} data={buildSeries(d.timeline, { t: (r) => r.t, key: b.key, value: (r) => r.success, label: b.name, total: "All logins" })} bucket={d.bucket} format={fmt} />
				<TimeChart title={`Failed logins by ${b.label.toLowerCase()}`} data={buildSeries(d.timeline, { t: (r) => r.t, key: b.key, value: (r) => r.failure, label: b.name, total: "All failures" })} bucket={d.bucket} format={fmt} hint="Denied by policy, failed identity-provider login, or blocked." />
			</div>
		</>
	);
}
