import { describe, expect, it } from "vitest";
import { computeFindings, durationHours, scoreFindings } from "./posture.ts";
import { compareVersions, outdatedChecker } from "./common.ts";
import { coloToIata, toMagicRows, toTunnelRows } from "./tunnels.ts";
import { appStatuses } from "./threats.ts";
import { toAuditEntry } from "./changes.ts";
import { toDeviceRows } from "./devices.ts";
import { groupKeys, roleFor } from "../rbac.ts";
import { BadRequestError, EMAIL_PARAM, parseParams } from "../http.ts";

const NOW = Date.UTC(2026, 10, 4);
const titles = (input: Parameters<typeof computeFindings>[0]) => computeFindings(input).map((f) => `${f.severity}:${f.title}`);

describe("posture findings", () => {
	it("parses durations", () => {
		expect(durationHours("24h")).toBe(24);
		expect(durationHours("30m")).toBe(0.5);
		expect(durationHours("720h")).toBe(720);
		expect(durationHours(undefined)).toBeNull();
	});

	it("flags risky Access policies and long sessions", () => {
		const t = titles({
			now: NOW,
			apps: [
				{ id: "a", name: "Wiki", type: "self_hosted", session_duration: "720h", policies: [{ id: "p", name: "all", decision: "allow", include: [{ everyone: {} }] }] },
				{ id: "b", name: "Legacy", type: "self_hosted", policies: [{ id: "q", decision: "bypass", include: [{ ip: { ip: "1.2.3.4/32" } }] }] },
				{ id: "c", name: "HR", type: "self_hosted", session_duration: "8h", policies: [{ id: "r", decision: "allow", include: [{ email_domain: { domain: "x.com" } }], require: [{ auth_method: { auth_method: "mfa" } }] }] },
			],
		});
		expect(t).toContain("high:Allows everyone");
		expect(t).toContain("high:Bypass policy");
		expect(t).toContain("medium:Long session duration");
		expect(t).toContain("low:No Access-enforced MFA");
		expect(t.filter((x) => x.includes("MFA"))).toHaveLength(1); // HR requires MFA
	});

	it("flags expiring, expired and unused service tokens", () => {
		const day = 86_400_000;
		const t = titles({
			now: NOW,
			tokens: [
				{ id: "1", name: "ci", expires_at: new Date(NOW + 10 * day).toISOString(), last_seen_at: new Date(NOW - day).toISOString() },
				{ id: "2", name: "old", expires_at: new Date(NOW - 5 * day).toISOString(), last_seen_at: null },
			],
		});
		expect(t).toEqual(expect.arrayContaining(["medium:Service token expiring soon", "medium:Expired service token", "low:Unused service token"]));
	});

	it("flags Gateway rule hygiene and settings", () => {
		const t = titles({
			now: NOW,
			rules: [
				{ id: "allow", name: "allow all", enabled: true, action: "allow", filters: ["dns"], traffic: "", precedence: 1 },
				{ id: "block", name: "block malware", enabled: true, action: "block", filters: ["dns"], traffic: 'any(dns.security_category[*] in {80})', precedence: 2 },
				{ id: "off", name: "old", enabled: false, action: "block", filters: ["http"], precedence: 3 },
			],
			ruleHits: new Map([["allow", 100]]),
			config: { settings: { tls_decrypt: { enabled: false }, activity_log: { enabled: true }, antivirus: { enabled_download_phase: false } } },
		});
		expect(t).toEqual(expect.arrayContaining(["high:Allow-all rule above block rules", "low:Rule never matched", "info:Disabled rule", "medium:TLS inspection off", "low:Download antivirus scanning off"]));
		expect(t).not.toContain("medium:Activity logging off");
	});

	it("flags weak device settings and scores findings", () => {
		const findings = computeFindings({
			now: NOW,
			profiles: [{ default: true, switch_locked: false, auto_connect: 0, allow_mode_switch: true, exclude: [{ address: "0.0.0.0/0" }] }],
		});
		expect(findings.map((f) => f.title)).toEqual(expect.arrayContaining(["Users can turn WARP off", "Auto-connect disabled", "Users can change WARP mode", "Split tunnel excludes all traffic"]));
		expect(findings[0].severity).toBe("high");
		expect(scoreFindings(findings)).toBe(100 - 15 - 7 - 7 - 2);
		expect(scoreFindings([])).toBe(100);
	});
});

describe("versions", () => {
	it("compares and flags outdated releases", () => {
		expect(compareVersions("2025.1.861.0", "2024.11.309.0")).toBeGreaterThan(0);
		const { latest, isOutdated } = outdatedChecker(["2025.4.1", "2025.3.2", "2025.2.0", "2024.11.9"]);
		expect(latest).toBe("2025.4.1");
		expect(isOutdated("2025.2.0")).toBe(false);
		expect(isOutdated("2024.11.9")).toBe(true);
		expect(isOutdated("")).toBe(false);
	});
});

describe("tunnels", () => {
	it("maps colo names and summarizes health", () => {
		expect(coloToIata("lhr01")).toBe("LHR");
		const magic = toMagicRows([
			{ count: 90, dimensions: { tunnelName: "HQ", siteName: "", edgeColoName: "sjc01", resultStatus: "ok" } },
			{ count: 10, dimensions: { tunnelName: "HQ", siteName: "", edgeColoName: "sjc01", resultStatus: "timeout" } },
			{ count: 10, dimensions: { tunnelName: "Branch", siteName: "", edgeColoName: "ord02", resultStatus: "timeout" } },
		]);
		expect(magic.map((m) => [m.name, m.status])).toEqual([["Branch", "down"], ["HQ", "degraded"]]);
		const { rows } = toTunnelRows([
			{ id: "1", name: "a", status: "healthy", connections: [{ colo_name: "lhr01", client_version: "2026.2.0" }] },
			{ id: "2", name: "b", status: "down", connections: [] },
		]);
		expect(rows[0].status).toBe("down");
		expect(rows[1].connectors[0].iata).toBe("LHR");
	});
});

describe("shadow IT", () => {
	it("attributes review status only from single-app rows", () => {
		const apps = appStatuses([
			{ ids: [1], statuses: ["unapproved"], requests: 10, bytesSent: 100, email: "a@x.com" },
			{ ids: [1], statuses: ["unapproved"], requests: 5, bytesSent: 0, email: "b@x.com" },
			{ ids: [1, 2], statuses: ["approved", "unapproved"], requests: 999, bytesSent: 999 },
		]);
		expect(apps.get(1)).toMatchObject({ status: "unapproved", requests: 15, bytesSent: 100 });
		expect(apps.get(1)!.users.size).toBe(2);
		expect(apps.has(2)).toBe(false);
	});
});

describe("audit entries and devices", () => {
	it("normalizes audit log entries and tags Zero Trust changes", () => {
		const e = toAuditEntry({ id: "1", when: "2026-11-01T10:00:00Z", action: { type: "update", result: true }, actor: { email: "a@x.com", type: "user" }, resource: { type: "access.app" }, newValueJson: { a: 1 } });
		expect(e).toMatchObject({ actor: "a@x.com", zeroTrust: true, result: true, oldValue: null });
		expect(e.newValue).toContain('"a": 1');
		expect(toAuditEntry({ action: { type: "login" }, resource: { type: "account" } }).zeroTrust).toBe(false);
	});

	it("computes stale and outdated devices", () => {
		const { rows } = toDeviceRows(
			[
				{ id: "1", name: "mac", version: "2025.4.1", last_seen: new Date(NOW - 40 * 86_400_000).toISOString(), user: { email: "a@x.com" } },
				{ id: "2", name: "pc", version: "2024.1.1", last_seen: new Date(NOW).toISOString() },
				{ id: "3", name: "gone", deleted: true },
				{ id: "4", name: "a", version: "2025.3.1", last_seen: new Date(NOW).toISOString() },
				{ id: "5", name: "b", version: "2025.2.1", last_seen: new Date(NOW).toISOString() },
			],
			NOW,
		);
		expect(rows).toHaveLength(4);
		expect(rows.find((r) => r.id === "1")).toMatchObject({ name: "mac", staleDays: 40, outdated: false });
		expect(rows.find((r) => r.id === "2")?.outdated).toBe(true);
		expect(rows[0].id).toBe("1"); // stalest first
	});
});

describe("roles", () => {
	it("grants admin only to configured groups, by name, email or id", () => {
		const identity = { email: "a@x.com", groups: [{ id: "G1", name: "Security Admins", email: "sec@x.com" }, "plain-group"] };
		expect([...groupKeys(identity)]).toEqual(expect.arrayContaining(["g1", "security admins", "sec@x.com", "plain-group"]));
		expect(roleFor(identity, "security admins")).toBe("admin");
		expect(roleFor(identity, " other , G1 ")).toBe("admin");
		expect(roleFor(identity, "plain-group")).toBe("admin");
		expect(roleFor(identity, "finance")).toBe("viewer");
		expect(roleFor(identity, "")).toBe("viewer");
		expect(roleFor(identity, undefined)).toBe("viewer");
	});
});

describe("pattern parameters", () => {
	const parse = (q: string) => parseParams(new URL(`https://x/api/user?${q}`), { email: EMAIL_PARAM });
	it("accepts emails and rejects anything else", () => {
		expect(parse("email=a.b%2Bc@example.com").params.email).toBe("a.b+c@example.com");
		for (const q of ["email=nope", "email=a@b", "email=%3Cscript%3E@x.com", `email=${"a".repeat(260)}@x.com`, "email=a@x.com&email=b@x.com"]) {
			expect(() => parse(q)).toThrow(BadRequestError);
		}
	});
});
