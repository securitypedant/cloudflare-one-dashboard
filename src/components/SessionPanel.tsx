import { useEffect, useRef, type ReactNode } from "react";
import type { SessionResponse } from "../../shared/admin.ts";
import { COUNTRIES } from "../../shared/countries.ts";
import { useApi } from "../lib/api.ts";
import { formatKm } from "../lib/format.ts";
import { SectionView } from "./SectionView.tsx";
import { Status, StatusPill } from "./ui.tsx";

const country = (cc: string | null) => (cc ? (COUNTRIES[cc]?.name ?? cc) : null);
const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");

function Rows({ rows }: { rows: [string, ReactNode][] }) {
	return (
		<dl className="kv">
			{rows
				.filter(([, v]) => v !== null && v !== undefined && v !== "")
				.map(([k, v]) => (
					<div key={k}>
						<dt>{k}</dt>
						<dd>{v}</dd>
					</div>
				))}
		</dl>
	);
}

/** "Your session": who you are signed in as, how you reach the dashboard, and which account it shows. */
export function SessionPanel({ onClose }: { onClose: () => void }) {
	const session = useApi<SessionResponse>("/api/session");
	const closeRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		closeRef.current?.focus();
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	const s = session.data;
	const c = s?.connection;

	return (
		<div className="help-backdrop" onClick={onClose}>
			<aside className="help-panel" role="dialog" aria-modal="true" aria-labelledby="session-title" onClick={(e) => e.stopPropagation()}>
				<header>
					<h2 id="session-title">Your session</h2>
					<button ref={closeRef} className="link-button" onClick={onClose} aria-label="Close">
						✕
					</button>
				</header>
				<Status loading={session.loading} error={session.error} />
				{s && c && (
					<>
						<section>
							<h3>Connected to Cloudflare</h3>
							{c.colo && (
								<p className="session-hero">
									<span className="session-pop">{c.colo}</span>
									<span>
										{join(c.coloCity, country(c.coloCountry))}
										{c.distanceKm !== null && <span className="muted"> · {formatKm(c.distanceKm)} from you</span>}
									</span>
								</p>
							)}
							<Rows
								rows={[
									["Your location", join(c.city, c.region, country(c.country))],
									["Network", c.asOrganization ? `${c.asOrganization}${c.asn ? ` (AS${c.asn})` : ""}` : null],
									["IP address", c.ip],
									["Round-trip time", c.rttMs !== null ? `${c.rttMs} ms` : null],
									["Protocol", join(c.httpProtocol, c.tlsVersion)],
								]}
							/>
							<p className="muted session-note">The POP that handled this page request, as seen by the dashboard's Worker. With WARP on, this is usually the POP your device is connected to.</p>
						</section>

						<section>
							<h3>Your identity</h3>
							<Rows
								rows={[
									["Email", s.viewer.email],
									["Dashboard access", <StatusPill key="r" text={s.viewer.role === "admin" ? "full" : "limited"} color={s.viewer.role === "admin" ? "#f6821f" : "#94a3b8"} />],
								]}
							/>
							<SectionView result={s.identity}>
								{(id) =>
									id ? (
										<>
											<Rows
												rows={[
													["Signed in with", id.idp === "cloudflare" ? "Cloudflare account login" : id.idp],
													["Signed in", id.authenticatedAt ? new Date(id.authenticatedAt).toLocaleString() : null],
													["WARP", id.warp ? "Connected" : "Not connected"],
													["Gateway", id.gateway ? "Filtering this device" : "Not filtering this device"],
													["Device ID", id.deviceId ? <code key="d">{id.deviceId}</code> : null],
												]}
											/>
											{id.posture.length > 0 && (
												<details className="session-details">
													<summary>
														Device posture: {id.posture.filter((p) => p.success).length} of {id.posture.length} checks passing
													</summary>
													<ul className="plain-list">
														{id.posture.map((p) => (
															<li key={`${p.name}-${p.type}`}>
																<span style={{ color: p.success ? "#4ade80" : "#94a3b8" }}>{p.success ? "✓" : "·"}</span> {p.name} <span className="muted">{p.type}</span>
															</li>
														))}
													</ul>
												</details>
											)}
											{id.groups.length > 0 && (
												<details className="session-details">
													<summary>Groups ({id.groups.length})</summary>
													<ul className="plain-list">
														{id.groups.map((g) => (
															<li key={g.id || g.name}>
																{g.name} <span className="muted">{g.id !== g.name ? g.id : ""}</span>
															</li>
														))}
													</ul>
												</details>
											)}
										</>
									) : (
										<p className="muted">No Access identity for this session (local development, or a request outside the dashboard hostname).</p>
									)
								}
							</SectionView>
						</section>

						<section>
							<h3>Cloudflare account</h3>
							<SectionView result={s.account}>
								{(a) => (
									<Rows
										rows={[
											["Account", a.name],
											["Account ID", <code key="i">{a.id}</code>],
											["Type", a.type],
											["Created", a.createdOn ? new Date(a.createdOn).toLocaleDateString() : null],
											["Zero Trust team", a.teamName],
											["Team domain", a.teamDomain],
										]}
									/>
								)}
							</SectionView>
						</section>

						<section>
							<h3>Dashboard</h3>
							<Rows
								rows={[
									["Version", s.dashboard.version],
									["Hostname", s.dashboard.hostname],
								]}
							/>
						</section>
					</>
				)}
			</aside>
		</div>
	);
}
