import type { UserDetailResponse, UserSummary } from "../../shared/admin.ts";
import type { RangeId } from "../../shared/types.ts";
import { COUNTRIES } from "../../shared/countries.ts";
import { PermissionError, section } from "../cfapi.ts";
import { graphql } from "../graphql.ts";
import { RANGE_ROLLUP } from "../traffic.ts";
import { cfList } from "../cfapi.ts";
import { listAccessUsers, listDevices, rangeDates, USERS_PERMISSION, type AccessUser } from "./common.ts";
import { toDeviceRows } from "./devices.ts";
import { fetchLogins } from "./identity.ts";
import type { AccessApp } from "./posture.ts";

type GatewayAcct = {
	dns: { sum: { queries: number; queryCategoryIdArray: number[]; queryCategoryIdCountArray: number[] }; dimensions: { resolverDecision: string; coloName: string; country: string; email?: string } }[];
	http: { sum: { requests: number; dlpMatchedRequestsTotal: number; avBlockedFiles: number; isolatedRequests: number }; dimensions: { httpHost: string; email?: string } }[];
	net: { sum: { requests: number }; dimensions: { action: string; email?: string } }[];
};

/**
 * One user's Gateway activity. Filtering on `email` needs a PII permission on the token; if it's
 * refused, group by email instead and keep only this user's rows (grouping is allowed without it).
 */
async function fetchUserGateway(token: string, accountId: string, email: string, start: Date, end: Date, rollup: string): Promise<GatewayAcct> {
	const build = (filterByEmail: boolean) => {
		// Case-insensitive match (stored emails may differ in case); rows are re-checked exactly below.
		const f = filterByEmail ? ", email_ilike: $u" : "";
		const d = " email";
		const limit = filterByEmail ? 2000 : FALLBACK_LIMIT;
		return `query ($a: String!, $s: Time!, $e: Time!${filterByEmail ? ", $u: String!" : ""}) { viewer { accounts(filter: { accountTag: $a }) {
			dns: cf1GatewayDns${rollup}Groups(filter: { datetime_geq: $s, datetime_lt: $e${f} }, limit: ${limit}, orderBy: [sum_queries_DESC]) {
				sum { queries queryCategoryIdArray queryCategoryIdCountArray } dimensions { resolverDecision coloName country${d} }
			}
			http: cf1GatewayHttp${rollup}Groups(filter: { datetime_geq: $s, datetime_lt: $e${f} }, limit: ${limit}, orderBy: [sum_requests_DESC]) {
				sum { requests dlpMatchedRequestsTotal avBlockedFiles isolatedRequests } dimensions { httpHost${d} }
			}
			net: cf1GatewayNetwork${rollup}Groups(filter: { datetime_geq: $s, datetime_lt: $e${f} }, limit: ${limit}, orderBy: [sum_requests_DESC]) {
				sum { requests } dimensions { action${d} }
			}
		} } }`;
	};
	const vars = { a: accountId, s: start.toISOString(), e: end.toISOString() };
	try {
		const { data } = await graphql<{ viewer: { accounts: GatewayAcct[] } }>(token, build(true), { ...vars, u: email });
		const acct = data?.viewer.accounts[0] ?? { dns: [], http: [], net: [] };
		// ILIKE treats "_" and "%" as wildcards, so keep only exact (case-insensitive) matches.
		const exact = <T extends { dimensions: { email?: string } }>(rows: T[]) => rows.filter((r) => r.dimensions.email?.toLowerCase() === email);
		return { dns: exact(acct.dns), http: exact(acct.http), net: exact(acct.net) };
	} catch (err) {
		if (!/insufficient permissions to filter on field/i.test(err instanceof Error ? err.message : "")) throw err;
		const { data } = await graphql<{ viewer: { accounts: GatewayAcct[] } }>(token, build(false), vars);
		const acct = data?.viewer.accounts[0] ?? { dns: [], http: [], net: [] };
		if ([...acct.dns, ...acct.http, ...acct.net].some((r) => isRedacted(r.dimensions.email))) throw new PermissionError(PII_PERMISSION);
		const mine = <T extends { dimensions: { email?: string } }>(rows: T[]) => rows.filter((r) => r.dimensions.email?.toLowerCase() === email);
		const result = { dns: mine(acct.dns), http: mine(acct.http), net: mine(acct.net) };
		// Grouping is capped at FALLBACK_LIMIT rows; if a capped list has none of this user's rows, the
		// answer is unknown rather than zero. Filtering by email (PII permission) gives an exact result.
		const truncated = [acct.dns, acct.http, acct.net].some((rows) => rows.length >= FALLBACK_LIMIT);
		if (truncated && !result.dns.length && !result.http.length && !result.net.length) throw new PermissionError(PII_PERMISSION);
		return result;
	}
}

const FALLBACK_LIMIT = 10_000;

/** Without this permission, analytics return user emails as "REDACTED". */
export const PII_PERMISSION = "Zero Trust: PII Read";
export const isRedacted = (email: string | undefined) => email === "REDACTED";

/** Users for the per-user picker: Access users if readable, otherwise the busiest Gateway identities. */
export async function fetchUserList(token: string, accountId: string): Promise<{ users: UserSummary[]; missingPermission?: string }> {
	try {
		const users = (await listAccessUsers(token, accountId)).filter((u) => u.email);
		if (!users.length) throw new Error("no Access users returned");
		return { users: users.map((u) => ({ email: u.email!.toLowerCase(), name: u.name ?? "" })) };
	} catch {
		const { start, end } = rangeDates("30d");
		const query = `query ($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
			users: cf1GatewayDns1dGroups(filter: { datetime_geq: $s, datetime_lt: $e }, limit: 1000, orderBy: [sum_queries_DESC]) { dimensions { email } }
		} } }`;
		const { data } = await graphql<{ viewer: { accounts: { users: { dimensions: { email: string } }[] }[] } }>(token, query, { a: accountId, s: start.toISOString(), e: end.toISOString() });
		const rows = data?.viewer.accounts[0]?.users ?? [];
		if (rows.some((u) => isRedacted(u.dimensions.email))) return { users: [], missingPermission: PII_PERMISSION };
		const emails = new Set(rows.map((u) => u.dimensions.email?.toLowerCase()).filter((e): e is string => Boolean(e) && e.includes("@")));
		return { users: [...emails].map((email) => ({ email, name: "" })) };
	}
}

export async function fetchUserDetail(token: string, accountId: string, email: string, rangeId: RangeId): Promise<UserDetailResponse> {
	const { start, end } = rangeDates(rangeId);
	const rollup = RANGE_ROLLUP[rangeId];
	const now = Date.now();

	const profileUser = await section<AccessUser | null>(async () => {
		const users = await cfList<AccessUser>(token, `/accounts/${accountId}/access/users`, USERS_PERMISSION, { email }, 50);
		return users.find((u) => u.email?.toLowerCase() === email) ?? null;
	});

	const [devices, logins, apps, gateway] = await Promise.all([
		section(async () => toDeviceRows((await listDevices(token, accountId)).filter((d) => d.user?.email?.toLowerCase() === email), now).rows),
		section(async () => {
			const uuid = profileUser.ok ? profileUser.data?.id : undefined;
			if (!uuid) return [];
			return fetchLogins(token, accountId, start, end, uuid);
		}),
		section(() => cfList<AccessApp>(token, `/accounts/${accountId}/access/apps`, "Access: Apps and Policies Read")),
		section(() => fetchUserGateway(token, accountId, email, start, end, rollup)),
	]);

	const sumBy = <T,>(rows: T[], key: (r: T) => string, val: (r: T) => number) => {
		const m = new Map<string, number>();
		for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
		return [...m].sort((a, b) => b[1] - a[1]);
	};
	const appById = new Map((apps.ok ? apps.data : []).map((a) => [a.id, a.name ?? a.id]));
	const fail = <T,>(s: { ok: false; error: string; missingPermission?: string }) => s as UserDetailResponse["dns"] & T;

	return {
		email,
		range: rangeId,
		profile: profileUser.ok
			? {
					ok: true,
					data: profileUser.data
						? {
								name: profileUser.data.name ?? "",
								lastLogin: profileUser.data.last_successful_login ?? null,
								seats: [profileUser.data.access_seat && "Access", profileUser.data.gateway_seat && "Gateway"].filter((s): s is string => Boolean(s)),
								createdAt: profileUser.data.created_at ?? null,
							}
						: null,
				}
			: profileUser,
		devices,
		logins: logins.ok
			? {
					ok: true,
					data: (() => {
						const m = new Map<string, { country: string; app: string; idp: string; success: number; failure: number }>();
						for (const r of logins.data) {
							const k = `${r.dimensions.country}|${r.dimensions.appId}|${r.dimensions.identityProvider}`;
							const row = m.get(k) ?? { country: COUNTRIES[r.dimensions.country]?.name ?? r.dimensions.country, app: appById.get(r.dimensions.appId) ?? r.dimensions.appId, idp: r.dimensions.identityProvider, success: 0, failure: 0 };
							if (r.dimensions.isSuccessfulLogin) row.success += r.count;
							else row.failure += r.count;
							m.set(k, row);
						}
						return [...m.values()].sort((a, b) => b.success + b.failure - (a.success + a.failure));
					})(),
				}
			: logins,
		dns: gateway.ok
			? {
					ok: true,
					data: (() => {
						const dns = gateway.data.dns;
						const cats = new Map<number, number>();
						for (const r of dns.filter((x) => x.dimensions.resolverDecision.startsWith("blocked"))) {
							r.sum.queryCategoryIdArray.forEach((id, i) => cats.set(id, (cats.get(id) ?? 0) + (r.sum.queryCategoryIdCountArray[i] ?? 0)));
						}
						return {
							queries: dns.reduce((s, r) => s + r.sum.queries, 0),
							blocked: dns.filter((r) => r.dimensions.resolverDecision.startsWith("blocked")).reduce((s, r) => s + r.sum.queries, 0),
							byDecision: sumBy(dns, (r) => r.dimensions.resolverDecision, (r) => r.sum.queries).map(([decision, queries]) => ({ decision, queries })),
							pops: sumBy(dns, (r) => r.dimensions.coloName, (r) => r.sum.queries).map(([colo, queries]) => ({ colo, queries })),
							countries: sumBy(dns, (r) => r.dimensions.country, (r) => r.sum.queries).map(([country, queries]) => ({ country, queries })),
							blockedCategories: [...cats].map(([id, queries]) => ({ id, queries })).sort((a, b) => b.queries - a.queries),
						};
					})(),
				}
			: fail(gateway),
		http: gateway.ok
			? {
					ok: true,
					data: {
						requests: gateway.data.http.reduce((s, r) => s + r.sum.requests, 0),
						dlpMatches: gateway.data.http.reduce((s, r) => s + r.sum.dlpMatchedRequestsTotal, 0),
						avBlocked: gateway.data.http.reduce((s, r) => s + r.sum.avBlockedFiles, 0),
						isolated: gateway.data.http.reduce((s, r) => s + r.sum.isolatedRequests, 0),
						topHosts: gateway.data.http.slice(0, 15).map((r) => ({ host: r.dimensions.httpHost, requests: r.sum.requests })),
					},
				}
			: (gateway as unknown as UserDetailResponse["http"]),
		network: gateway.ok
			? {
					ok: true,
					data: {
						sessions: gateway.data.net.reduce((s, r) => s + r.sum.requests, 0),
						blocked: gateway.data.net.filter((r) => /block/i.test(r.dimensions.action)).reduce((s, r) => s + r.sum.requests, 0),
					},
				}
			: (gateway as unknown as UserDetailResponse["network"]),
	};
}
