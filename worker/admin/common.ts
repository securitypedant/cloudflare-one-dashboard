import type { RangeId } from "../../shared/types.ts";
import { cfList } from "../cfapi.ts";
import { graphql } from "../graphql.ts";
import { resolveRange } from "../traffic.ts";

export const DAY_MS = 86_400_000;

/** Run a GraphQL group query over [start, end) in windows no longer than `maxSpanMs`, concatenating rows. */
export async function queryInWindows<R>(token: string, query: string, vars: Record<string, unknown>, start: Date, end: Date, maxSpanMs: number, pick: (acct: Record<string, unknown>) => R[]): Promise<R[]> {
	const out: R[] = [];
	for (let t = start.getTime(); t < end.getTime(); t += maxSpanMs) {
		const s = new Date(t);
		const e = new Date(Math.min(t + maxSpanMs, end.getTime()));
		const { data } = await graphql<{ viewer: { accounts: Record<string, unknown>[] } }>(token, query, { ...vars, s: s.toISOString(), e: e.toISOString() });
		const acct = data?.viewer.accounts[0];
		if (acct) out.push(...pick(acct));
	}
	return out;
}

export const rangeDates = (rangeId: RangeId) => resolveRange(rangeId);

/** Compare dotted version strings ("2025.1.861.0" > "2024.11.309.0"). */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d;
	}
	return 0;
}

/**
 * A version is "outdated" when its first two components (e.g. year.month for WARP, cloudflared)
 * are more than `releasesBehind` distinct releases older than the newest one seen.
 */
export function outdatedChecker(versions: string[], releasesBehind = 2): { latest: string | null; isOutdated: (v: string) => boolean } {
	const valid = versions.filter((v) => /^\d+(\.\d+)+/.test(v));
	if (!valid.length) return { latest: null, isOutdated: () => false };
	const sorted = [...new Set(valid)].sort(compareVersions).reverse();
	const minors = [...new Set(sorted.map((v) => v.split(".").slice(0, 2).join(".")))];
	const allowed = new Set(minors.slice(0, releasesBehind + 1));
	return { latest: sorted[0], isOutdated: (v) => /^\d+(\.\d+)+/.test(v) && !allowed.has(v.split(".").slice(0, 2).join(".")) };
}

export interface AccessUser {
	id: string;
	email?: string;
	name?: string;
	last_successful_login?: string | null;
	access_seat?: boolean;
	gateway_seat?: boolean;
	active_device_count?: number;
	created_at?: string | null;
}

export const USERS_PERMISSION = "Access: Users Read (or Zero Trust Read)";

export const listAccessUsers = (token: string, accountId: string) => cfList<AccessUser>(token, `/accounts/${accountId}/access/users`, USERS_PERMISSION);

export interface CfDevice {
	id: string;
	name?: string;
	user?: { email?: string; name?: string };
	device_type?: string;
	os_version?: string;
	os_distro_name?: string;
	version?: string;
	last_seen?: string | null;
	deleted?: boolean;
}

export const DEVICES_PERMISSION = "Zero Trust Read";

export const listDevices = (token: string, accountId: string) => cfList<CfDevice>(token, `/accounts/${accountId}/devices`, DEVICES_PERMISSION);
