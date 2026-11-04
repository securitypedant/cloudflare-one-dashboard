import { useState } from "react";
import type { UserDetailResponse, UserSummary } from "../../shared/admin.ts";
import type { RangeId } from "../../shared/types.ts";
import { COUNTRIES } from "../../shared/countries.ts";
import { SectionView } from "../components/SectionView.tsx";
import { BarRow, Section, Stat, Status, StatusPill } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { formatShare } from "../lib/format.ts";

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export function UserView({ range, email, onEmail }: { range: RangeId; email: string | null; onEmail: (email: string | null) => void }) {
	const list = useApi<{ users: UserSummary[]; missingPermission?: string }>("/api/users");
	const [input, setInput] = useState(email ?? "");
	const detail = useApi<UserDetailResponse>(email ? `/api/user?email=${encodeURIComponent(email)}&range=${range}` : null);
	const categories = useApi<Record<number, string>>("/api/categories");
	const d = detail.data;

	return (
		<main className="page">
			<form
				className="user-search"
				onSubmit={(e) => {
					e.preventDefault();
					const v = input.trim().toLowerCase();
					if (isEmail(v)) onEmail(v);
				}}
			>
				<input list="user-list" type="search" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Find a user by email…" aria-label="User email" />
				<datalist id="user-list">
					{list.data?.users.map((u) => (
						<option key={u.email} value={u.email}>
							{u.name}
						</option>
					))}
				</datalist>
				<button type="submit" disabled={!isEmail(input.trim())}>
					Show user
				</button>
				{list.data?.missingPermission && (
					<span className="permission-note">
						User names in analytics need <code>{list.data.missingPermission}</code>.
					</span>
				)}
			</form>
			{!email && <p className="muted">Pick a user to see their devices, sign-ins, locations, and Gateway activity in one place.</p>}
			<Status loading={detail.loading} error={detail.error} />
			{d && (
				<>
					<h2 className="user-title">
						{d.email}
						{d.profile.ok && d.profile.data?.name && <span className="muted"> · {d.profile.data.name}</span>}
					</h2>
					<section className="stats">
						<SectionView result={d.profile}>
							{(p) => (
								<>
									<Stat label="last login" value={p?.lastLogin ? new Date(p.lastLogin).toLocaleDateString() : "never"} />
									<Stat label="seats" value={p?.seats.join(" + ") || "none"} />
								</>
							)}
						</SectionView>
						{d.dns.ok && <Stat label="DNS queries" value={d.dns.data.queries.toLocaleString()} hint={`${formatShare(d.dns.data.queries ? d.dns.data.blocked / d.dns.data.queries : 0)} blocked`} />}
						{d.http.ok && <Stat label="HTTP requests" value={d.http.data.requests.toLocaleString()} hint={`${d.http.data.dlpMatches} DLP matches · ${d.http.data.avBlocked} AV blocks`} />}
						{d.network.ok && <Stat label="network sessions" value={d.network.data.sessions.toLocaleString()} hint={`${d.network.data.blocked} blocked`} />}
					</section>

					<div className="grid-2">
						<Section title="Devices">
							<SectionView result={d.devices}>
								{(devices) =>
									devices.length ? (
										<table className="table compact">
											<tbody>
												{devices.map((x) => (
													<tr key={x.id}>
														<td className="name">{x.name}</td>
														<td>{x.os} {x.osVersion}</td>
														<td>{x.outdated ? <StatusPill text={x.clientVersion} color="#fb923c" /> : x.clientVersion}</td>
														<td className="num">{x.staleDays === null ? "never" : `${x.staleDays}d ago`}</td>
													</tr>
												))}
											</tbody>
										</table>
									) : (
										<div className="muted">No enrolled devices.</div>
									)
								}
							</SectionView>
						</Section>
						<Section title="Sign-ins" hint="Access logins by country, application and identity provider.">
							<SectionView result={d.logins}>
								{(rows) =>
									rows.length ? (
										<table className="table compact">
											<thead>
												<tr>
													<th>Country</th>
													<th>App</th>
													<th>IdP</th>
													<th className="num">OK</th>
													<th className="num">Failed</th>
												</tr>
											</thead>
											<tbody>
												{rows.slice(0, 20).map((r, i) => (
													<tr key={i}>
														<td>{r.country}</td>
														<td>{r.app}</td>
														<td>{r.idp}</td>
														<td className="num">{r.success}</td>
														<td className="num" style={{ color: r.failure ? "#f87171" : undefined }}>{r.failure}</td>
													</tr>
												))}
											</tbody>
										</table>
									) : (
										<div className="muted">No Access logins in this period.</div>
									)
								}
							</SectionView>
						</Section>
					</div>

					<SectionView result={d.dns}>
						{(dns) => (
							<div className="grid-3">
								<Section title="Where they connect from">
									{dns.countries.slice(0, 8).map((c) => <BarRow key={c.country} label={COUNTRIES[c.country]?.name ?? c.country} share={c.queries / (dns.queries || 1)} value={formatShare(c.queries / (dns.queries || 1))} color="#38bdf8" />)}
								</Section>
								<Section title="Cloudflare POPs used">
									{dns.pops.slice(0, 8).map((p) => <BarRow key={p.colo} label={p.colo} share={p.queries / (dns.queries || 1)} value={formatShare(p.queries / (dns.queries || 1))} color="#f6821f" />)}
								</Section>
								<Section title="Blocked categories">
									{dns.blockedCategories.length ? (
										dns.blockedCategories.slice(0, 8).map((c) => <BarRow key={c.id} label={categories.data?.[c.id] ?? `Category ${c.id}`} share={c.queries / (dns.blockedCategories[0].queries || 1)} value={c.queries.toLocaleString()} color="#f87171" />)
									) : (
										<div className="ok-text">Nothing blocked.</div>
									)}
								</Section>
							</div>
						)}
					</SectionView>
					<SectionView result={d.http}>
						{(http) =>
							http.topHosts.length ? (
								<Section title="Top web destinations">
									{http.topHosts.map((h) => <BarRow key={h.host} label={h.host} share={h.requests / (http.topHosts[0].requests || 1)} value={h.requests.toLocaleString()} color="#a78bfa" />)}
								</Section>
							) : null
						}
					</SectionView>
					<p className="footnote">Visible to dashboard admins only. Sources: Access users and devices APIs, Access login and Gateway analytics.</p>
				</>
			)}
		</main>
	);
}
