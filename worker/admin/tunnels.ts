import type { TunnelRow, TunnelsResponse } from "../../shared/admin.ts";
import { cfList, section } from "../cfapi.ts";
import { graphql } from "../graphql.ts";
import { DAY_MS, outdatedChecker } from "./common.ts";

interface CfdTunnel {
	id: string;
	name?: string;
	status?: string;
	connections?: { colo_name?: string; client_version?: string; opened_at?: string; origin_ip?: string; is_pending_reconnect?: boolean }[];
}

/** "lhr01" / "LHR" → "LHR". */
export const coloToIata = (colo: string) => (/^[a-z]{3}/i.exec(colo)?.[0] ?? "").toUpperCase();

export function toTunnelRows(tunnels: CfdTunnel[]): { rows: TunnelRow[]; latest: string | null } {
	const { latest, isOutdated } = outdatedChecker(tunnels.flatMap((t) => (t.connections ?? []).map((c) => c.client_version ?? "")));
	const rows = tunnels.map((t) => {
		const connectors = (t.connections ?? []).map((c) => ({
			colo: c.colo_name ?? "",
			iata: coloToIata(c.colo_name ?? ""),
			version: c.client_version ?? "",
			openedAt: c.opened_at ?? null,
			originIp: c.origin_ip,
		}));
		return {
			id: t.id,
			name: (t.name ?? t.id).slice(0, 100),
			kind: "cloudflared" as const,
			status: t.status ?? "unknown",
			connectors,
			outdated: connectors.some((c) => isOutdated(c.version)),
		};
	});
	const order: Record<string, number> = { down: 0, degraded: 1, inactive: 2, healthy: 3 };
	return { rows: rows.sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4)), latest };
}

interface HealthRow {
	count: number;
	dimensions: { tunnelName: string; siteName: string; edgeColoName: string; resultStatus: string };
}

/** Down at ≥ 50% failed health checks, degraded at ≥ 5%. */
export const healthStatus = (failureRate: number) => (failureRate >= 0.5 ? "down" : failureRate >= 0.05 ? "degraded" : "healthy");

/** Magic WAN tunnel health checks over the last 24 hours, per tunnel and per checking data center. */
export function toMagicRows(rows: HealthRow[]): TunnelRow[] {
	const by = new Map<string, { checks: number; failed: number; colos: Map<string, { checks: number; failed: number }> }>();
	for (const r of rows) {
		const name = r.dimensions.tunnelName || "(unnamed)";
		const t = by.get(name) ?? { checks: 0, failed: 0, colos: new Map<string, { checks: number; failed: number }>() };
		const failed = r.dimensions.resultStatus !== "ok" && r.dimensions.resultStatus !== "healthy" ? r.count : 0;
		t.checks += r.count;
		t.failed += failed;
		const c = t.colos.get(r.dimensions.edgeColoName) ?? { checks: 0, failed: 0 };
		c.checks += r.count;
		c.failed += failed;
		t.colos.set(r.dimensions.edgeColoName, c);
		by.set(name, t);
	}
	return [...by]
		.map(([name, t]) => {
			const failureRate = t.checks ? t.failed / t.checks : 0;
			return {
				id: name,
				name,
				kind: "magic-wan" as const,
				status: healthStatus(failureRate),
				connectors: [...t.colos].map(([colo, c]) => ({
					colo,
					iata: coloToIata(colo),
					version: "",
					openedAt: null,
					checks: c.checks,
					failureRate: c.checks ? c.failed / c.checks : 0,
					status: healthStatus(c.checks ? c.failed / c.checks : 0),
				})),
				outdated: false,
				failureRate,
				checks: t.checks,
			};
		})
		.sort((a, b) => b.failureRate - a.failureRate);
}

export async function fetchTunnels(token: string, accountId: string): Promise<TunnelsResponse> {
	const now = Date.now();
	const [cfd, magic] = await Promise.all([
		section(() => cfList<CfdTunnel>(token, `/accounts/${accountId}/cfd_tunnel`, "Cloudflare Tunnel Read", { is_deleted: "false" })),
		section(async () => {
			const query = `query ($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
				checks: magicTransitTunnelHealthChecksAdaptiveGroups(filter: { datetime_geq: $s, datetime_lt: $e }, limit: 5000) { count dimensions { tunnelName siteName edgeColoName resultStatus } }
			} } }`;
			const { data } = await graphql<{ viewer: { accounts: { checks: HealthRow[] }[] } }>(token, query, { a: accountId, s: new Date(now - DAY_MS).toISOString(), e: new Date(now).toISOString() });
			return toMagicRows(data?.viewer.accounts[0]?.checks ?? []);
		}),
	]);
	const converted = cfd.ok ? toTunnelRows(cfd.data) : null;
	return {
		cloudflared: converted ? { ok: true, data: converted.rows } : (cfd as Exclude<typeof cfd, { ok: true }>),
		magicWan: magic,
		latestConnectorVersion: converted?.latest ?? null,
	};
}
