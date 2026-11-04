import type { Finding, PostureResponse, Severity } from "../../shared/admin.ts";
import { cfGet, cfList, section } from "../cfapi.ts";
import { graphql } from "../graphql.ts";

const PERM = {
	apps: "Access: Apps and Policies Read",
	tokens: "Access: Service Tokens Read",
	org: "Access: Organizations, Identity Providers, and Groups Read",
	zt: "Zero Trust Read",
};

/* Minimal shapes of the API objects we read (only fields used by checks). */
interface Rule {
	include?: Record<string, unknown>[];
	exclude?: Record<string, unknown>[];
	require?: Record<string, unknown>[];
}
export interface AccessPolicy extends Rule {
	id?: string;
	name?: string;
	decision?: string;
}
export interface AccessApp {
	id: string;
	name?: string;
	domain?: string;
	type?: string;
	session_duration?: string;
	policies?: AccessPolicy[];
}
export interface ServiceToken {
	id: string;
	name?: string;
	expires_at?: string | null;
	last_seen_at?: string | null;
	created_at?: string | null;
}
export interface GatewayRule {
	id: string;
	name?: string;
	enabled?: boolean;
	action?: string;
	filters?: string[];
	traffic?: string;
	identity?: string;
	device_posture?: string;
	precedence?: number;
}
export interface GatewayConfig {
	settings?: {
		tls_decrypt?: { enabled?: boolean };
		activity_log?: { enabled?: boolean };
		antivirus?: { enabled_download_phase?: boolean; enabled_upload_phase?: boolean };
	};
}
export interface DeviceProfile {
	name?: string;
	policy_id?: string;
	default?: boolean;
	switch_locked?: boolean;
	auto_connect?: number;
	allow_mode_switch?: boolean;
	allowed_to_leave?: boolean;
	exclude?: { address?: string; host?: string }[];
	include?: { address?: string; host?: string }[];
}

export interface PostureInput {
	now: number;
	apps?: AccessApp[];
	org?: { session_duration?: string } | null;
	tokens?: ServiceToken[];
	rules?: GatewayRule[];
	ruleHits?: Map<string, number>;
	config?: GatewayConfig | null;
	profiles?: DeviceProfile[];
}

const WEIGHT: Record<Severity, number> = { high: 15, medium: 7, low: 2, info: 0 };
const DAY_MS = 86_400_000;

/** "24h", "30m", "720h" → hours. */
export function durationHours(d: string | undefined): number | null {
	if (!d) return null;
	let hours = 0;
	let matched = false;
	for (const [, n, unit] of d.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)) {
		matched = true;
		hours += Number(n) / (unit === "h" ? 1 : unit === "m" ? 60 : 3600);
	}
	return matched ? hours : null;
}

const has = (rules: Record<string, unknown>[] | undefined, key: string) => (rules ?? []).some((r) => r && Object.hasOwn(r, key));
const requiresMfa = (p: AccessPolicy) =>
	(p.require ?? []).some((r) => {
		const am = (r as { auth_method?: { auth_method?: string } }).auth_method?.auth_method;
		return am === "mfa" || am === "hwk" || am === "swk";
	});
const BROAD_RANGES = new Set(["0.0.0.0/0", "::/0", "0.0.0.0/1", "128.0.0.0/1"]);
const MATCH_ALL = /^\s*(any\(\s*\)|true)?\s*$/i;

export function computeFindings(input: PostureInput): Finding[] {
	const out: Finding[] = [];
	const add = (f: Omit<Finding, "id">, idPart: string) => out.push({ ...f, id: `${f.category}:${f.title}:${idPart}` });

	for (const app of input.apps ?? []) {
		const name = app.name || app.domain || app.id;
		const where = "Access → Applications";
		const policies = app.policies ?? [];
		if (["self_hosted", "saas", "ssh", "vnc", "rdp"].includes(app.type ?? "self_hosted") && policies.length === 0) {
			add({ severity: "info", category: "Access", title: "Application has no policies", detail: "Nobody can reach it until a policy is added; remove it if unused.", resource: name, fix: where }, app.id);
		}
		for (const p of policies) {
			if (p.decision === "bypass") {
				add({ severity: "high", category: "Access", title: "Bypass policy", detail: `Policy "${p.name ?? p.id}" lets matching requests through with no authentication or logging of identity.`, resource: name, fix: where }, `${app.id}:${p.id}`);
			}
			if (p.decision === "allow" && has(p.include, "everyone")) {
				add({ severity: "high", category: "Access", title: "Allows everyone", detail: `Policy "${p.name ?? p.id}" includes Everyone: any identity from any configured IdP (including one-time PIN) gets in.`, resource: name, fix: where }, `${app.id}:${p.id}`);
			}
		}
		const allows = policies.filter((p) => p.decision === "allow");
		if (allows.length && !allows.some(requiresMfa)) {
			add({ severity: "low", category: "Access", title: "No Access-enforced MFA", detail: "No allow policy requires an MFA authentication method. MFA may still be enforced by your IdP.", resource: name, fix: `${where} → policy → Require: Authentication method` }, app.id);
		}
		const hours = durationHours(app.session_duration);
		if (hours !== null && hours > 24) {
			add({ severity: hours > 168 ? "medium" : "low", category: "Access", title: "Long session duration", detail: `Sessions last ${app.session_duration}; revoked users keep access until the session expires.`, resource: name, fix: `${where} → Session duration` }, app.id);
		}
	}

	const orgHours = durationHours(input.org?.session_duration);
	if (orgHours !== null && orgHours > 24) {
		add({ severity: "low", category: "Access", title: "Long global session duration", detail: `The organization session lasts ${input.org!.session_duration}.`, resource: "Organization", fix: "Settings → Authentication → Global session timeout" }, "org");
	}

	for (const t of input.tokens ?? []) {
		const name = t.name || t.id;
		const where = "Access → Service credentials → Service tokens";
		const exp = t.expires_at ? Date.parse(t.expires_at) : NaN;
		if (Number.isFinite(exp)) {
			const days = (exp - input.now) / DAY_MS;
			if (days < 0) add({ severity: "medium", category: "Service tokens", title: "Expired service token", detail: `Expired ${Math.round(-days)} days ago; delete it if no longer needed.`, resource: name, fix: where }, t.id);
			else if (days < 30) add({ severity: "medium", category: "Service tokens", title: "Service token expiring soon", detail: `Expires in ${Math.round(days)} days; rotate it before integrations break.`, resource: name, fix: where }, t.id);
		}
		const seen = t.last_seen_at ? Date.parse(t.last_seen_at) : NaN;
		if (!Number.isFinite(seen) || (input.now - seen) / DAY_MS > 90) {
			add({ severity: "low", category: "Service tokens", title: "Unused service token", detail: Number.isFinite(seen) ? `Not used for ${Math.round((input.now - seen) / DAY_MS)} days.` : "Never used.", resource: name, fix: where }, t.id);
		}
	}

	const rules = [...(input.rules ?? [])].sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
	for (const r of rules) {
		const name = r.name || r.id;
		const where = "Gateway → Firewall policies";
		if (r.enabled === false) {
			add({ severity: "info", category: "Gateway", title: "Disabled rule", detail: "Disabled rules add clutter; delete them if no longer needed.", resource: name, fix: where }, r.id);
			continue;
		}
		if (input.ruleHits && !input.ruleHits.get(r.id)) {
			add({ severity: "low", category: "Gateway", title: "Rule never matched", detail: "No matches in the last 30 days. It may be shadowed by a higher rule or no longer needed.", resource: name, fix: where }, r.id);
		}
		const matchesAll = MATCH_ALL.test(r.traffic ?? "") && MATCH_ALL.test(r.identity ?? "") && MATCH_ALL.test(r.device_posture ?? "");
		if (matchesAll && (r.action === "allow" || r.action === "off")) {
			const shadowed = rules.filter((b) => b.enabled !== false && (b.precedence ?? 0) > (r.precedence ?? 0) && b.action === "block" && (b.filters ?? []).some((f) => (r.filters ?? []).includes(f)));
			if (shadowed.length) {
				add({ severity: "high", category: "Gateway", title: "Allow-all rule above block rules", detail: `This rule matches all traffic, so ${shadowed.length} later block rule(s) never apply (e.g. "${shadowed[0].name}").`, resource: name, fix: `${where} → reorder` }, r.id);
			}
		}
	}

	const s = input.config?.settings;
	if (input.config) {
		if (!s?.tls_decrypt?.enabled) add({ severity: "medium", category: "Gateway", title: "TLS inspection off", detail: "HTTP policies, DLP and antivirus can only see hostnames, not content, for HTTPS traffic.", resource: "Gateway settings", fix: "Settings → Network → TLS decryption" }, "tls");
		if (s?.activity_log && s.activity_log.enabled === false) add({ severity: "medium", category: "Gateway", title: "Activity logging off", detail: "Gateway isn't logging activity, which limits investigations.", resource: "Gateway settings", fix: "Settings → Network → Activity logging" }, "log");
		if (s?.antivirus && !s.antivirus.enabled_download_phase) add({ severity: "low", category: "Gateway", title: "Download antivirus scanning off", detail: "Files downloaded through Gateway aren't scanned for malware.", resource: "Gateway settings", fix: "Settings → Network → Anti-virus scanning" }, "av");
	}

	for (const p of input.profiles ?? []) {
		const name = p.default ? "Default device profile" : p.name || p.policy_id || "Device profile";
		const where = "Settings → WARP Client → Device settings";
		const id = p.policy_id ?? "default";
		if (p.switch_locked === false) add({ severity: "medium", category: "Devices", title: "Users can turn WARP off", detail: "The WARP switch isn't locked, so users can disconnect and bypass Gateway.", resource: name, fix: `${where} → Lock WARP switch` }, id);
		if (p.auto_connect === 0) add({ severity: "medium", category: "Devices", title: "Auto-connect disabled", detail: "WARP won't reconnect automatically after a user turns it off.", resource: name, fix: `${where} → Auto connect` }, id);
		if (p.allow_mode_switch) add({ severity: "low", category: "Devices", title: "Users can change WARP mode", detail: "Users can switch to a mode with less protection.", resource: name, fix: `${where} → Allow mode switch` }, id);
		if (p.allowed_to_leave) add({ severity: "low", category: "Devices", title: "Users can leave the organization", detail: "Users can log WARP out of your Zero Trust organization.", resource: name, fix: `${where} → Allow device to leave organization` }, id);
		const broad = (p.exclude ?? []).find((e) => e.address && BROAD_RANGES.has(e.address));
		if (broad) add({ severity: "high", category: "Devices", title: "Split tunnel excludes all traffic", detail: `Exclude list contains ${broad.address}, so traffic bypasses Gateway.`, resource: name, fix: `${where} → Split Tunnels` }, id);
	}

	const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
	return out.sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category));
}

export const scoreFindings = (findings: Finding[]) => Math.max(0, 100 - findings.reduce((s, f) => s + WEIGHT[f.severity], 0));

/** Gateway rule match counts over the last 30 days (DNS policies + network/HTTP rules). */
async function fetchRuleHits(token: string, accountId: string, now: number): Promise<Map<string, number>> {
	const end = new Date(now);
	const start = new Date(now - 30 * DAY_MS);
	const query = `query ($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
		dns: cf1GatewayDns1dGroups(filter: { datetime_geq: $s, datetime_lt: $e }, limit: 2000, orderBy: [sum_queries_DESC]) { sum { queries } dimensions { policyId } }
		net: cf1GatewayNetwork1dGroups(filter: { datetime_geq: $s, datetime_lt: $e }, limit: 2000, orderBy: [sum_requests_DESC]) { sum { requests } dimensions { ruleId } }
		http: gatewayL7RequestsAdaptiveGroups(filter: { datetime_geq: $s, datetime_lt: $e }, limit: 2000, orderBy: [count_DESC]) { count dimensions { ruleId } }
	} } }`;
	type Rows = { dns: { sum: { queries: number }; dimensions: { policyId: string } }[]; net: { sum: { requests: number }; dimensions: { ruleId: string } }[]; http: { count: number; dimensions: { ruleId: string } }[] };
	const { data } = await graphql<{ viewer: { accounts: Rows[] } }>(token, query, { a: accountId, s: start.toISOString(), e: end.toISOString() });
	const acct = data?.viewer.accounts[0];
	const hits = new Map<string, number>();
	const add = (id: string | undefined, n: number) => id && hits.set(id, (hits.get(id) ?? 0) + n);
	for (const r of acct?.dns ?? []) add(r.dimensions.policyId, r.sum.queries);
	for (const r of acct?.net ?? []) add(r.dimensions.ruleId, r.sum.requests);
	for (const r of acct?.http ?? []) add(r.dimensions.ruleId, r.count);
	return hits;
}

export async function fetchPosture(token: string, accountId: string): Promise<PostureResponse> {
	const base = `/accounts/${accountId}`;
	const now = Date.now();
	const [apps, org, tokens, rules, config, defaultProfile, customProfiles, ruleHits] = await Promise.all([
		section(() => cfList<AccessApp>(token, `${base}/access/apps`, PERM.apps)),
		section(async () => (await cfGet<{ session_duration?: string }>(token, `${base}/access/organizations`, PERM.org)).result ?? null),
		section(() => cfList<ServiceToken>(token, `${base}/access/service_tokens`, PERM.tokens)),
		section(() => cfList<GatewayRule>(token, `${base}/gateway/rules`, PERM.zt)),
		section(async () => (await cfGet<GatewayConfig>(token, `${base}/gateway/configuration`, PERM.zt)).result ?? null),
		section(async () => (await cfGet<DeviceProfile>(token, `${base}/devices/policy`, PERM.zt)).result ?? null),
		section(() => cfList<DeviceProfile>(token, `${base}/devices/policies`, PERM.zt)),
		section(() => fetchRuleHits(token, accountId, now)),
	]);
	const profiles = [
		...(defaultProfile.ok && defaultProfile.data ? [{ ...defaultProfile.data, default: true }] : []),
		...(customProfiles.ok ? customProfiles.data.filter((p) => !p.default) : []),
	];
	const hitMap = ruleHits.ok ? ruleHits.data : undefined;
	const findings = computeFindings({
		now,
		apps: apps.ok ? apps.data : undefined,
		org: org.ok ? org.data : undefined,
		tokens: tokens.ok ? tokens.data : undefined,
		rules: rules.ok ? rules.data : undefined,
		ruleHits: hitMap,
		config: config.ok ? config.data : undefined,
		profiles,
	});
	const status = (s: { ok: boolean; error?: string; missingPermission?: string }, count?: number) =>
		s.ok ? { ok: true, count } : { ok: false, error: (s as { error: string }).error, missingPermission: (s as { missingPermission?: string }).missingPermission };
	return {
		score: scoreFindings(findings),
		findings,
		sections: {
			"Access applications": status(apps, apps.ok ? apps.data.length : undefined),
			"Access organization": status(org),
			"Service tokens": status(tokens, tokens.ok ? tokens.data.length : undefined),
			"Gateway rules": status(rules, rules.ok ? rules.data.length : undefined),
			"Gateway settings": status(config),
			"Device profiles": status(defaultProfile.ok ? customProfiles : defaultProfile, profiles.length),
			"Rule match counts": status(ruleHits),
		},
		ruleHits: (rules.ok ? rules.data : []).map((r) => ({
			id: r.id,
			name: r.name ?? r.id,
			enabled: r.enabled !== false,
			action: r.action ?? "",
			filters: r.filters ?? [],
			hits: hitMap?.get(r.id) ?? 0,
		})),
	};
}
