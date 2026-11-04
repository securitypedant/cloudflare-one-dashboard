import type { Finding, PostureResponse, Severity } from "../../shared/admin.ts";
import { DataTable } from "../components/DataTable.tsx";
import { Section, SeverityBadge, Stat, Status } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";

const scoreColor = (s: number) => (s >= 85 ? "#4ade80" : s >= 60 ? "#facc15" : "#f87171");

export function PostureView() {
	const posture = useApi<PostureResponse>("/api/posture");
	const p = posture.data;
	const count = (s: Severity) => p?.findings.filter((f) => f.severity === s).length ?? 0;

	return (
		<main className="page">
			<Status loading={posture.loading} error={posture.error} />
			{p && (
				<>
					<section className="stats">
						<div className="stat score">
							<div className="stat-value" style={{ color: scoreColor(p.score) }}>
								{p.score}
							</div>
							<div className="stat-label">configuration score (out of 100)</div>
						</div>
						<Stat label="high" value={String(count("high"))} />
						<Stat label="medium" value={String(count("medium"))} />
						<Stat label="low" value={String(count("low"))} />
						<Stat label="info" value={String(count("info"))} />
					</section>

					<Section title="Findings" hint="Ranked by severity. Expand a row for where to fix it. The score drops 15 points per high, 7 per medium and 2 per low finding.">
						<DataTable<Finding>
							rows={p.findings}
							rowKey={(f) => f.id}
							searchText={(f) => `${f.title} ${f.resource} ${f.detail} ${f.category}`}
							facets={[
								{ key: "severity", label: "Severity", value: (f) => f.severity },
								{ key: "category", label: "Area", value: (f) => f.category },
							]}
							columns={[
								{ key: "severity", label: "Severity", render: (f) => <SeverityBadge severity={f.severity} />, sort: (f) => ["high", "medium", "low", "info"].indexOf(f.severity), width: "90px" },
								{ key: "category", label: "Area", render: (f) => f.category, sort: (f) => f.category, width: "120px" },
								{ key: "title", label: "Finding", render: (f) => <span className="name">{f.title}</span>, sort: (f) => f.title },
								{ key: "resource", label: "Resource", render: (f) => f.resource, sort: (f) => f.resource },
							]}
							initialSort={{ key: "severity", dir: "asc" }}
							expand={(f) => (
								<div className="detail">
									<p>{f.detail}</p>
									<p className="muted">Where to fix: {f.fix}</p>
								</div>
							)}
							emptyText="No findings: nice work."
						/>
					</Section>

					<div className="grid-2">
						<Section title="Checks run" hint="A check that couldn't run lists the token permission it needs.">
							<table className="table compact">
								<tbody>
									{Object.entries(p.sections).map(([name, s]) => (
										<tr key={name}>
											<td className="name">{name}</td>
											<td>
												{s.ok ? (
													<span className="ok-text">✓ {s.count !== undefined ? `${s.count} checked` : "checked"}</span>
												) : s.missingPermission ? (
													<span className="permission-note">
														Needs <code>{s.missingPermission}</code>
													</span>
												) : (
													<span className="error-text">{s.error}</span>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</Section>
						<Section title="Gateway rule matches (30 days)" hint="Rules with no matches may be shadowed by a higher rule or no longer needed.">
							<DataTable
								rows={p.ruleHits}
								rowKey={(r) => r.id}
								searchText={(r) => r.name}
								pageSize={25}
								columns={[
									{ key: "name", label: "Rule", render: (r) => <span className={r.enabled ? "name" : "muted"}>{r.name}</span>, sort: (r) => r.name },
									{ key: "action", label: "Action", render: (r) => r.action, sort: (r) => r.action },
									{ key: "filters", label: "Type", render: (r) => r.filters.join(", ") },
									{ key: "hits", label: "Matches", render: (r) => r.hits.toLocaleString(), sort: (r) => r.hits, align: "right" },
								]}
								initialSort={{ key: "hits", dir: "asc" }}
								emptyText="No Gateway rules readable."
							/>
						</Section>
					</div>
				</>
			)}
		</main>
	);
}
