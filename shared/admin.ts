/** Contracts for the security/admin reports (Worker ↔ UI). */
import type { RangeId } from "./types.ts";

export type Role = "admin" | "viewer";

export interface MeResponse {
	email: string;
	role: Role;
	/** True when ADMIN_GROUPS is not configured (so nobody is an admin yet). */
	adminGroupsConfigured: boolean;
}

/** The signed-in viewer's own session: identity, how they reach the dashboard, and the account. */
export interface SessionResponse {
	viewer: { email: string; role: Role };
	identity: Section<{
		idp: string;
		groups: { id: string; name: string }[];
		warp: boolean;
		gateway: boolean;
		deviceId: string | null;
		authenticatedAt: string | null;
		country: string | null;
		posture: { name: string; type: string; success: boolean }[];
	} | null>;
	connection: {
		ip: string | null;
		colo: string | null;
		coloCity: string | null;
		coloCountry: string | null;
		/** km from the client's geolocated position to the POP. */
		distanceKm: number | null;
		city: string | null;
		region: string | null;
		country: string | null;
		asn: number | null;
		asOrganization: string | null;
		rttMs: number | null;
		httpProtocol: string | null;
		tlsVersion: string | null;
	};
	account: Section<{ id: string; name: string; type: string | null; createdOn: string | null; teamDomain: string | null; teamName: string | null }>;
	dashboard: { version: string; hostname: string };
}

/** One report section: data, or why it couldn't load (e.g. a missing token permission). */
export type Section<T> = { ok: true; data: T } | { ok: false; missingPermission?: string; error: string };

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
	id: string;
	severity: Severity;
	category: "Access" | "Gateway" | "Devices" | "Service tokens";
	title: string;
	detail: string;
	resource: string;
	/** Where to fix it in the Cloudflare One dashboard. */
	fix: string;
}

export interface PostureResponse {
	score: number;
	findings: Finding[];
	/** Checks that couldn't run, with the reason. */
	sections: Record<string, { ok: boolean; error?: string; missingPermission?: string; count?: number }>;
	ruleHits: { id: string; name: string; enabled: boolean; action: string; filters: string[]; hits: number }[];
}

export interface CountRow {
	key: string;
	label: string;
	success: number;
	failure: number;
}

export interface IdentityResponse {
	range: RangeId;
	totals: { success: number; failure: number; users: number };
	byCountry: CountRow[];
	byIdp: CountRow[];
	byApp: (CountRow & { domain?: string })[];
	daily: { date: string; success: number; failure: number }[];
	/** Admin only. */
	users?: Section<{ email: string; name: string; success: number; failure: number; lastLogin: string | null; seats: string[]; devices: number; inactiveDays: number | null }[]>;
	unusedApps?: Section<{ id: string; name: string; domain: string }[]>;
	seats?: Section<{ access: number; gateway: number; inactive30d: number }>;
}

export interface DeviceRow {
	id: string;
	name: string;
	user: string;
	os: string;
	osVersion: string;
	clientVersion: string;
	lastSeen: string | null;
	staleDays: number | null;
	outdated: boolean;
}

export interface DevicesResponse {
	devices: Section<DeviceRow[]>;
	latestClientVersion: string | null;
	postureRules: Section<{ id: string; name: string; type: string }[]>;
}

export interface TunnelRow {
	id: string;
	name: string;
	kind: "cloudflared" | "magic-wan";
	status: string;
	/** Magic WAN: one entry per Cloudflare data center running health checks, with its own status. */
	connectors: { colo: string; iata: string; version: string; openedAt: string | null; originIp?: string; status?: string; checks?: number; failureRate?: number }[];
	outdated: boolean;
	/** Magic WAN: share of failed health checks in the last 24h. */
	failureRate?: number;
	checks?: number;
}

export interface TunnelsResponse {
	cloudflared: Section<TunnelRow[]>;
	magicWan: Section<TunnelRow[]>;
	latestConnectorVersion: string | null;
}

export interface ThreatsResponse {
	range: RangeId;
	securityCategories: Section<{ id: number; name: string; queries: number }[]>;
	shadowIt: Section<{ id: number; name: string; status: string; requests: number; bytesSent: number; users?: number }[]>;
	dlp: Section<{ host: string; app: string; matches: number; user?: string }[]>;
	malware: Section<{ host: string; avBlocked: number; sandboxBlocked: number; user?: string }[]>;
	/** Admin only: users with the most security-category blocks. */
	targetedUsers?: Section<{ email: string; queries: number }[]>;
}

export interface AuditEntry {
	id: string;
	when: string;
	actor: string;
	actorType: string;
	actorIp: string;
	action: string;
	result: boolean;
	resourceType: string;
	resourceId: string;
	interface: string;
	zeroTrust: boolean;
	oldValue: string | null;
	newValue: string | null;
}

export interface ChangesResponse {
	range: RangeId;
	entries: Section<AuditEntry[]>;
	truncated: boolean;
}

export interface UserSummary {
	email: string;
	name: string;
}

export interface UserDetailResponse {
	email: string;
	range: RangeId;
	profile: Section<{ name: string; lastLogin: string | null; seats: string[]; createdAt: string | null } | null>;
	devices: Section<DeviceRow[]>;
	logins: Section<{ country: string; app: string; idp: string; success: number; failure: number }[]>;
	dns: Section<{ queries: number; blocked: number; byDecision: { decision: string; queries: number }[]; pops: { colo: string; queries: number }[]; countries: { country: string; queries: number }[]; blockedCategories: { id: number; queries: number }[] }>;
	http: Section<{ requests: number; dlpMatches: number; avBlocked: number; isolated: number; topHosts: { host: string; requests: number }[] }>;
	network: Section<{ sessions: number; blocked: number }>;
}
