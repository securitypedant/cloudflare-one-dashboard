import type { SessionResponse } from "../shared/admin.ts";
import { distanceKm } from "../shared/geo.ts";
import { DASHBOARD_VERSION } from "../shared/version.ts";
import { accessToken } from "./access.ts";
import { cfGet, section } from "./cfapi.ts";
import { fetchPops } from "./pops.ts";
import { fetchIdentity, identityHost, type Viewer } from "./rbac.ts";
import { cachedValue } from "./upstream.ts";

/** Fields of request.cf used here (Cloudflare's view of the client connection). */
interface CfProps {
	colo?: string;
	city?: string;
	region?: string;
	country?: string;
	asn?: number;
	asOrganization?: string;
	clientTcpRtt?: number;
	httpProtocol?: string;
	tlsVersion?: string;
	latitude?: string;
	longitude?: string;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The viewer's own session. Never cached across users: identity and connection are per request. */
export async function fetchSession(request: Request, env: Env, ctx: ExecutionContext, viewer: Viewer, url: URL): Promise<SessionResponse> {
	const cf = ((request as Request & { cf?: CfProps }).cf ?? {}) as CfProps;
	const pops = await fetchPops(ctx).catch(() => []);
	const pop = cf.colo ? pops.find((p) => p.iata === cf.colo) : undefined;
	const lat = Number(cf.latitude);
	const lon = Number(cf.longitude);
	const token = accessToken(request);
	const host = identityHost(url.hostname, env.DASHBOARD_HOSTNAME);

	const identity = await section(async () => {
		if (!token || !host) return null;
		const id = await fetchIdentity(host, token);
		return {
			idp: id.idp?.type ?? "unknown",
			groups: (id.groups ?? []).map((g) => (typeof g === "string" ? { id: g, name: g } : { id: g.id ?? "", name: g.name ?? g.email ?? g.id ?? "" })),
			warp: id.is_warp === true,
			gateway: id.is_gateway === true,
			deviceId: id.device_id ?? null,
			authenticatedAt: id.iat ? new Date(id.iat * 1000).toISOString() : null,
			country: id.geo?.country ?? null,
			posture: id.posture ?? [],
		};
	});

	const account = await section(async () => {
		if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) throw new Error("API token not configured");
		const token = env.CLOUDFLARE_API_TOKEN;
		const id = env.CLOUDFLARE_ACCOUNT_ID;
		return cachedValue(ctx, `account-${id}-v1`, 3600, async () => {
			const acct = (await cfGet<{ id?: string; name?: string; type?: string; created_on?: string }>(token, `/accounts/${id}`, "Account Settings Read")).result ?? {};
			const org = await cfGet<{ auth_domain?: string; name?: string }>(token, `/accounts/${id}/access/organizations`, "Access: Organizations, Identity Providers, and Groups Read")
				.then((r) => r.result ?? {})
				.catch(() => ({}) as { auth_domain?: string; name?: string });
			return {
				id,
				name: acct.name ?? id,
				type: acct.type ?? null,
				createdOn: acct.created_on ?? null,
				teamDomain: org.auth_domain ?? env.ACCESS_TEAM_DOMAIN ?? null,
				teamName: org.name ?? null,
			};
		});
	});

	return {
		viewer,
		identity,
		connection: {
			ip: str(request.headers.get("CF-Connecting-IP")),
			colo: str(cf.colo),
			coloCity: pop?.city ?? null,
			coloCountry: pop?.country ?? null,
			distanceKm: pop && Number.isFinite(lat) && Number.isFinite(lon) ? distanceKm(lon, lat, pop.lon, pop.lat) : null,
			city: str(cf.city),
			region: str(cf.region),
			country: str(cf.country),
			asn: typeof cf.asn === "number" ? cf.asn : null,
			asOrganization: str(cf.asOrganization),
			rttMs: typeof cf.clientTcpRtt === "number" ? cf.clientTcpRtt : null,
			httpProtocol: str(cf.httpProtocol),
			tlsVersion: str(cf.tlsVersion),
		},
		account,
		dashboard: { version: DASHBOARD_VERSION, hostname: url.hostname },
	};
}
