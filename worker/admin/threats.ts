import type { Role, ThreatsResponse } from "../../shared/admin.ts";
import type { RangeId } from "../../shared/types.ts";
import { cfList, section } from "../cfapi.ts";
import { fetchCategories } from "../categories.ts";
import { graphql } from "../graphql.ts";
import { rangeDates } from "./common.ts";
import { RANGE_ROLLUP } from "../traffic.ts";

const SECURITY_PARENT = /security/i;

interface Category {
	id: number;
	name?: string;
	subcategories?: Category[];
}

/** IDs of Gateway security-risk categories (the "Security Risks" parent and its subcategories). */
async function securityCategoryIds(token: string, accountId: string): Promise<Map<number, string>> {
	const res = await cfList<Category>(token, `/accounts/${accountId}/gateway/categories`, "Zero Trust Read");
	const out = new Map<number, string>();
	for (const c of res) {
		if (!SECURITY_PARENT.test(c.name ?? "")) continue;
		out.set(c.id, c.name ?? String(c.id));
		for (const s of c.subcategories ?? []) out.set(s.id, s.name ?? String(s.id));
	}
	return out;
}

/** Map Gateway app IDs to names via the app types API (falls back to "App <id>"). */
async function appNames(token: string, accountId: string): Promise<Map<number, string>> {
	const res = await cfList<{ id: number; name?: string; application_type_id?: number }>(token, `/accounts/${accountId}/gateway/app_types`, "Zero Trust Read");
	return new Map(res.filter((a) => a.application_type_id !== undefined).map((a) => [a.id, a.name ?? `App ${a.id}`]));
}

/**
 * Per-app review status from HTTP rollup rows that carry exactly one application (the dataset gives
 * app IDs and statuses as unaligned arrays, so only single-app rows are unambiguous).
 */
export function appStatuses(rows: { ids: number[]; statuses: string[]; requests: number; bytesSent: number; email?: string }[]) {
	const apps = new Map<number, { status: string; requests: number; bytesSent: number; users: Set<string> }>();
	for (const r of rows) {
		if (r.ids.length !== 1) continue;
		const id = r.ids[0];
		const a = apps.get(id) ?? { status: r.statuses.length === 1 ? r.statuses[0] : "unknown", requests: 0, bytesSent: 0, users: new Set<string>() };
		a.requests += r.requests;
		a.bytesSent += r.bytesSent;
		if (r.email) a.users.add(r.email);
		apps.set(id, a);
	}
	return apps;
}

export async function fetchThreats(token: string, accountId: string, rangeId: RangeId, role: Role): Promise<ThreatsResponse> {
	const { start, end } = rangeDates(rangeId);
	const rollup = RANGE_ROLLUP[rangeId];
	const isAdmin = role === "admin";
	const vars = { a: accountId, s: start.toISOString(), e: end.toISOString() };
	const userDim = isAdmin ? " email" : "";

	const [catIds, names, catNames] = await Promise.all([
		section(() => securityCategoryIds(token, accountId)),
		section(() => appNames(token, accountId)),
		section(() => fetchCategories(token, accountId)),
	]);

	// One query per dataset (repo convention: per-request read cap), each loaded as its own section.
	const node = (body: string) => `query ($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) { rows: ${body} } } }`;
	const load = <R,>(body: string) =>
		section(async () => (await graphql<{ viewer: { accounts: { rows: R[] }[] } }>(token, node(body), vars)).data?.viewer.accounts[0]?.rows ?? []);
	type Blocked = { sum: { queries: number; queryCategoryIdArray: number[]; queryCategoryIdCountArray: number[] }; dimensions?: { email?: string } };
	type AppRow = { sum: { requests: number; bodyBytesSent: number }; dimensions: { directApplicationIds: number[]; directApplicationStatuses: string[]; email?: string } };
	type DlpRow = { sum: { dlpMatchedRequestsTotal: number; avBlockedFiles: number; sandboxBlocks: number }; dimensions: { httpHost: string; directApplicationIds: number[]; email?: string } };
	const [blocked, appRows, dlpRows] = await Promise.all([
		load<Blocked>(`cf1GatewayDns${rollup}Groups(filter: { datetime_geq: $s, datetime_lt: $e, resolverDecision_like: "blocked%" }, limit: 2000, orderBy: [sum_queries_DESC]) {
			sum { queries queryCategoryIdArray queryCategoryIdCountArray } ${isAdmin ? "dimensions { email }" : ""}
		}`),
		load<AppRow>(`cf1GatewayHttp${rollup}Groups(filter: { datetime_geq: $s, datetime_lt: $e }, limit: 5000, orderBy: [sum_requests_DESC]) {
			sum { requests bodyBytesSent } dimensions { directApplicationIds directApplicationStatuses${userDim} }
		}`),
		load<DlpRow>(`cf1GatewayHttp${rollup}Groups(filter: { datetime_geq: $s, datetime_lt: $e }, limit: 500, orderBy: [sum_dlpMatchedRequestsTotal_DESC]) {
			sum { dlpMatchedRequestsTotal avBlockedFiles sandboxBlocks } dimensions { httpHost directApplicationIds${userDim} }
		}`),
	]);
	const appName = (id: number | undefined) => (id === undefined ? "" : (names.ok && names.data.get(id)) || `App ${id}`);

	// Security categories (blocked queries attributed to security-risk categories).
	const security = new Map<number, number>();
	const perUser = new Map<string, number>();
	for (const r of blocked.ok ? blocked.data : []) {
		let userHits = 0;
		r.sum.queryCategoryIdArray.forEach((id, i) => {
			if (!catIds.ok || !catIds.data.has(id)) return;
			const n = r.sum.queryCategoryIdCountArray[i] ?? 0;
			security.set(id, (security.get(id) ?? 0) + n);
			userHits += n;
		});
		const email = r.dimensions?.email;
		if (email && userHits) perUser.set(email, (perUser.get(email) ?? 0) + userHits);
	}
	const catName = (id: number) => (catIds.ok && catIds.data.get(id)) || (catNames.ok && catNames.data[id]) || `Category ${id}`;

	const apps = appStatuses((appRows.ok ? appRows.data : []).map((r) => ({ ids: r.dimensions.directApplicationIds ?? [], statuses: r.dimensions.directApplicationStatuses ?? [], requests: r.sum.requests, bytesSent: r.sum.bodyBytesSent, email: r.dimensions.email })));
	const dlpData = dlpRows.ok ? dlpRows.data : [];
	const failed = <T,>(s: { ok: boolean }) => s as unknown as { ok: false; error: string; missingPermission?: string } & T;

	return {
		range: rangeId,
		securityCategories: !blocked.ok
			? failed(blocked)
			: catIds.ok
			? { ok: true, data: [...security].map(([id, queries]) => ({ id, name: catName(id), queries })).sort((a, b) => b.queries - a.queries) }
			: catIds,
		shadowIt: !appRows.ok ? failed(appRows) : {
			ok: true,
			data: [...apps]
				.map(([id, a]) => ({ id, name: appName(id), status: a.status, requests: a.requests, bytesSent: a.bytesSent, ...(isAdmin ? { users: a.users.size } : {}) }))
				.sort((a, b) => b.requests - a.requests)
				.slice(0, 200),
		},
		dlp: !dlpRows.ok ? failed(dlpRows) : {
			ok: true,
			data: dlpData
				.filter((r) => r.sum.dlpMatchedRequestsTotal > 0)
				.map((r) => ({ host: r.dimensions.httpHost, app: appName(r.dimensions.directApplicationIds?.[0]), matches: r.sum.dlpMatchedRequestsTotal, ...(isAdmin ? { user: r.dimensions.email ?? "" } : {}) })),
		},
		malware: !dlpRows.ok ? failed(dlpRows) : {
			ok: true,
			data: dlpData
				.filter((r) => r.sum.avBlockedFiles > 0 || r.sum.sandboxBlocks > 0)
				.map((r) => ({ host: r.dimensions.httpHost, avBlocked: r.sum.avBlockedFiles, sandboxBlocked: r.sum.sandboxBlocks, ...(isAdmin ? { user: r.dimensions.email ?? "" } : {}) })),
		},
		...(isAdmin
			? {
					targetedUsers: !blocked.ok
						? failed(blocked)
						: perUser.has("REDACTED")
						? { ok: false as const, missingPermission: "Zero Trust: PII Read", error: 'Add "Zero Trust: PII Read" to the API token to see user names.' }
						: { ok: true as const, data: [...perUser].map(([email, queries]) => ({ email, queries })).sort((a, b) => b.queries - a.queries).slice(0, 50) },
				}
			: {}),
	};
}
