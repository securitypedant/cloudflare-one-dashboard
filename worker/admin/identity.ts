import type { CountRow, IdentityResponse, Role } from "../../shared/admin.ts";
import type { RangeId } from "../../shared/types.ts";
import { COUNTRIES } from "../../shared/countries.ts";
import { section } from "../cfapi.ts";
import { DAY_MS, listAccessUsers, queryInWindows, rangeDates } from "./common.ts";
import { cfList } from "../cfapi.ts";
import type { AccessApp } from "./posture.ts";

interface LoginRow {
	count: number;
	dimensions: { date: string; country: string; identityProvider: string; isSuccessfulLogin: number; appId: string; userUuid: string };
}

const LOGIN_QUERY = `query ($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
	logins: accessLoginRequestsAdaptiveGroups(filter: { datetime_geq: $s, datetime_lt: $e }, limit: 10000, orderBy: [count_DESC]) {
		count dimensions { date country identityProvider isSuccessfulLogin appId userUuid }
	}
} } }`;

/** Access logins limited to 7-day windows by the dataset. */
export async function fetchLogins(token: string, accountId: string, start: Date, end: Date, userUuid?: string): Promise<LoginRow[]> {
	const query = userUuid ? LOGIN_QUERY.replace("datetime_lt: $e }", "datetime_lt: $e, userUuid: $u }").replace("$e: Time!)", "$e: Time!, $u: String!)") : LOGIN_QUERY;
	return queryInWindows<LoginRow>(token, query, { a: accountId, ...(userUuid ? { u: userUuid } : {}) }, start, end, 7 * DAY_MS, (acct) => (acct.logins as LoginRow[]) ?? []);
}

export function countBy(rows: LoginRow[], key: (r: LoginRow) => string, label: (k: string) => string): CountRow[] {
	const m = new Map<string, CountRow>();
	for (const r of rows) {
		const k = key(r) || "unknown";
		const row = m.get(k) ?? { key: k, label: label(k), success: 0, failure: 0 };
		if (r.dimensions.isSuccessfulLogin) row.success += r.count;
		else row.failure += r.count;
		m.set(k, row);
	}
	return [...m.values()].sort((a, b) => b.success + b.failure - (a.success + a.failure));
}

export async function fetchIdentity(token: string, accountId: string, rangeId: RangeId, role: Role): Promise<IdentityResponse> {
	const { start, end } = rangeDates(rangeId);
	const [rows, apps] = await Promise.all([
		fetchLogins(token, accountId, start, end),
		section(() => cfList<AccessApp>(token, `/accounts/${accountId}/access/apps`, "Access: Apps and Policies Read")),
	]);
	const appById = new Map((apps.ok ? apps.data : []).map((a) => [a.id, a]));
	const success = rows.filter((r) => r.dimensions.isSuccessfulLogin).reduce((s, r) => s + r.count, 0);
	const failure = rows.reduce((s, r) => s + r.count, 0) - success;
	const daily = new Map<string, { date: string; success: number; failure: number }>();
	for (const r of rows) {
		const d = daily.get(r.dimensions.date) ?? { date: r.dimensions.date, success: 0, failure: 0 };
		if (r.dimensions.isSuccessfulLogin) d.success += r.count;
		else d.failure += r.count;
		daily.set(r.dimensions.date, d);
	}
	const byApp = countBy(rows, (r) => r.dimensions.appId, (k) => appById.get(k)?.name ?? k).map((r) => ({ ...r, domain: appById.get(r.key)?.domain }));
	const result: IdentityResponse = {
		range: rangeId,
		totals: { success, failure, users: new Set(rows.map((r) => r.dimensions.userUuid).filter(Boolean)).size },
		byCountry: countBy(rows, (r) => r.dimensions.country, (k) => COUNTRIES[k]?.name ?? k),
		byIdp: countBy(rows, (r) => r.dimensions.identityProvider, (k) => k),
		byApp,
		daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
	};
	if (role !== "admin") return result;

	const users = await section(() => listAccessUsers(token, accountId));
	const now = Date.now();
	const loginsByUser = new Map(countBy(rows, (r) => r.dimensions.userUuid, (k) => k).map((r) => [r.key, r]));
	const userRows = users.ok
		? users.data.map((u) => {
				const l = loginsByUser.get(u.id);
				const last = u.last_successful_login ? Date.parse(u.last_successful_login) : NaN;
				return {
					email: u.email ?? "",
					name: u.name ?? "",
					success: l?.success ?? 0,
					failure: l?.failure ?? 0,
					lastLogin: u.last_successful_login ?? null,
					seats: [u.access_seat && "Access", u.gateway_seat && "Gateway"].filter((s): s is string => Boolean(s)),
					devices: u.active_device_count ?? 0,
					inactiveDays: Number.isFinite(last) ? Math.floor((now - last) / DAY_MS) : null,
				};
			})
		: [];
	result.users = users.ok ? { ok: true, data: userRows.sort((a, b) => b.failure - a.failure || b.success - a.success) } : users;
	result.seats = users.ok
		? {
				ok: true,
				data: {
					access: userRows.filter((u) => u.seats.includes("Access")).length,
					gateway: userRows.filter((u) => u.seats.includes("Gateway")).length,
					inactive30d: userRows.filter((u) => u.seats.length && (u.inactiveDays === null || u.inactiveDays > 30)).length,
				},
			}
		: users;
	result.unusedApps = apps.ok
		? { ok: true, data: apps.data.filter((a) => !byApp.some((r) => r.key === a.id)).map((a) => ({ id: a.id, name: a.name ?? a.id, domain: a.domain ?? "" })) }
		: apps;
	return result;
}
