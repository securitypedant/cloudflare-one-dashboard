import type { Role, ThreatsResponse } from "../../shared/admin.ts";
import type { RangeId } from "../../shared/types.ts";
import { DataTable } from "../components/DataTable.tsx";
import { SectionView } from "../components/SectionView.tsx";
import { BarRow, Section, Status, StatusPill } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { STATUS_COLORS } from "../lib/colors.ts";
import { formatBytes } from "../lib/format.ts";

const STATUS_LABEL: Record<string, string> = { approved: "Approved", unapproved: "Unapproved", inReview: "In review", unreviewed: "Unreviewed", unknown: "Mixed" };

export function ThreatsView({ range, role, onOpenUser }: { range: RangeId; role: Role; onOpenUser: (email: string) => void }) {
	const res = useApi<ThreatsResponse>(`/api/threats?range=${range}`);
	const d = res.data;
	const isAdmin = role === "admin";
	const userCell = (u?: string) => (u ? <button className="link-button" onClick={() => onOpenUser(u)}>{u}</button> : <span className="muted">—</span>);

	return (
		<main className="page">
			<Status loading={res.loading} error={res.error} />
			{d && (
				<>
					<div className="grid-2">
						<Section title="Security threats blocked" hint="Blocked DNS queries in security-risk categories (malware, phishing, command and control, …).">
							<SectionView result={d.securityCategories}>
								{(cats) => {
									const max = Math.max(1, ...cats.map((c) => c.queries));
									return cats.length ? cats.slice(0, 12).map((c) => <BarRow key={c.id} label={c.name} share={c.queries / max} value={c.queries.toLocaleString()} color="#f87171" />) : <div className="ok-text">No security-category blocks in this period.</div>;
								}}
							</SectionView>
						</Section>
						{isAdmin && (
							<Section title="Most targeted users" hint="Users with the most blocked security-risk queries.">
								<SectionView result={d.targetedUsers}>
									{(users) =>
										users.length ? (
											<table className="table compact">
												<tbody>
													{users.slice(0, 12).map((u) => (
														<tr key={u.email}>
															<td>{userCell(u.email)}</td>
															<td className="num">{u.queries.toLocaleString()}</td>
														</tr>
													))}
												</tbody>
											</table>
										) : (
											<div className="ok-text">No user-attributed security blocks.</div>
										)
									}
								</SectionView>
							</Section>
						)}
					</div>

					<Section title="Shadow IT: SaaS applications in use" hint="Review status comes from Cloudflare One's application review (Shadow IT). Unapproved and unreviewed apps with uploads deserve a look.">
						<SectionView result={d.shadowIt}>
							{(apps) => (
								<DataTable
									rows={apps}
									rowKey={(a) => String(a.id)}
									searchText={(a) => `${a.name} ${a.status}`}
									facets={[{ key: "status", label: "Review status", value: (a) => STATUS_LABEL[a.status] ?? a.status }]}
									columns={[
										{ key: "name", label: "Application", render: (a) => <span className="name">{a.name}</span>, sort: (a) => a.name },
										{ key: "status", label: "Status", render: (a) => <StatusPill text={STATUS_LABEL[a.status] ?? a.status} color={STATUS_COLORS[a.status] ?? STATUS_COLORS.unknown} />, sort: (a) => a.status },
										{ key: "requests", label: "Requests", render: (a) => a.requests.toLocaleString(), sort: (a) => a.requests, align: "right" },
										{ key: "sent", label: "Uploaded", render: (a) => formatBytes(a.bytesSent), sort: (a) => a.bytesSent, align: "right" },
										...(isAdmin ? [{ key: "users", label: "Users", render: (a: (typeof apps)[number]) => a.users ?? "—", sort: (a: (typeof apps)[number]) => a.users ?? 0, align: "right" as const }] : []),
									]}
									initialSort={{ key: "requests", dir: "desc" }}
									pageSize={50}
								/>
							)}
						</SectionView>
					</Section>

					<div className="grid-2">
						<Section title="Data loss prevention" hint="Requests that matched a DLP profile, by destination.">
							<SectionView result={d.dlp}>
								{(rows) => (
									<DataTable
										rows={rows}
										rowKey={(r) => `${r.host}|${r.user ?? ""}`}
										searchText={(r) => `${r.host} ${r.app} ${r.user ?? ""}`}
										pageSize={25}
										columns={[
											{ key: "host", label: "Destination", render: (r) => <span className="name">{r.host}</span>, sort: (r) => r.host },
											{ key: "app", label: "App", render: (r) => r.app, sort: (r) => r.app },
											...(isAdmin ? [{ key: "user", label: "User", render: (r: (typeof rows)[number]) => userCell(r.user), sort: (r: (typeof rows)[number]) => r.user ?? "" }] : []),
											{ key: "matches", label: "Matches", render: (r) => r.matches.toLocaleString(), sort: (r) => r.matches, align: "right" },
										]}
										initialSort={{ key: "matches", dir: "desc" }}
										emptyText="No DLP matches in this period."
									/>
								)}
							</SectionView>
						</Section>
						<Section title="Malware blocked" hint="Files blocked by antivirus scanning or the sandbox.">
							<SectionView result={d.malware}>
								{(rows) => (
									<DataTable
										rows={rows}
										rowKey={(r) => `${r.host}|${r.user ?? ""}`}
										searchText={(r) => `${r.host} ${r.user ?? ""}`}
										pageSize={25}
										columns={[
											{ key: "host", label: "Source", render: (r) => <span className="name">{r.host}</span>, sort: (r) => r.host },
											...(isAdmin ? [{ key: "user", label: "User", render: (r: (typeof rows)[number]) => userCell(r.user), sort: (r: (typeof rows)[number]) => r.user ?? "" }] : []),
											{ key: "av", label: "AV", render: (r) => r.avBlocked.toLocaleString(), sort: (r) => r.avBlocked, align: "right" },
											{ key: "sandbox", label: "Sandbox", render: (r) => r.sandboxBlocked.toLocaleString(), sort: (r) => r.sandboxBlocked, align: "right" },
										]}
										initialSort={{ key: "av", dir: "desc" }}
										emptyText="No malware blocked in this period."
									/>
								)}
							</SectionView>
						</Section>
					</div>
					<p className="footnote">Source: Gateway DNS and HTTP analytics (cf1Gateway rollups), Gateway categories and application APIs.</p>
				</>
			)}
		</main>
	);
}
