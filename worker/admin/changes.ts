import type { AuditEntry, ChangesResponse } from "../../shared/admin.ts";
import type { RangeId } from "../../shared/types.ts";
import { cfGet, section } from "../cfapi.ts";
import { rangeDates } from "./common.ts";

const PERMISSION = "Account Settings Read";
const PER_PAGE = 1000;
const MAX_ENTRIES = 5000;
const MAX_VALUE_CHARS = 4000;
const ZERO_TRUST = /access|gateway|teams|zero.?trust|device|warp|tunnel|dlp|dex|cloudflared|magic|posture|identity.?provider|service.?token/i;

interface RawAudit {
	id?: string;
	when?: string;
	action?: { type?: string; result?: boolean };
	actor?: { email?: string; type?: string; ip?: string };
	resource?: { type?: string; id?: string };
	interface?: string;
	newValue?: unknown;
	oldValue?: unknown;
	newValueJson?: unknown;
	oldValueJson?: unknown;
}

const valueText = (v: unknown): string | null => {
	if (v === undefined || v === null || v === "") return null;
	const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
	return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}…` : s;
};

export function toAuditEntry(r: RawAudit): AuditEntry {
	const action = r.action?.type ?? "";
	const resourceType = r.resource?.type ?? "";
	return {
		id: r.id ?? `${r.when}-${action}`,
		when: r.when ?? "",
		actor: r.actor?.email ?? "",
		actorType: r.actor?.type ?? "",
		actorIp: r.actor?.ip ?? "",
		action,
		result: r.action?.result !== false,
		resourceType,
		resourceId: r.resource?.id ?? "",
		interface: r.interface ?? "",
		zeroTrust: ZERO_TRUST.test(`${resourceType} ${action}`),
		oldValue: valueText(r.oldValueJson ?? r.oldValue),
		newValue: valueText(r.newValueJson ?? r.newValue),
	};
}

export async function fetchChanges(token: string, accountId: string, rangeId: RangeId): Promise<ChangesResponse> {
	const { start, end } = rangeDates(rangeId);
	let truncated = false;
	const entries = await section(async () => {
		const out: AuditEntry[] = [];
		for (let page = 1; out.length < MAX_ENTRIES; page++) {
			const body = await cfGet<RawAudit[]>(token, `/accounts/${accountId}/audit_logs`, PERMISSION, {
				since: start.toISOString(),
				before: end.toISOString(),
				per_page: PER_PAGE,
				page,
				direction: "desc",
			});
			const items = Array.isArray(body.result) ? body.result : [];
			out.push(...items.map(toAuditEntry));
			if (items.length < PER_PAGE) return out;
		}
		truncated = true;
		return out.slice(0, MAX_ENTRIES);
	});
	return { range: rangeId, entries, truncated };
}
