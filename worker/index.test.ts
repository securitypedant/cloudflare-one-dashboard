import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index.ts";

const env = {
	ALLOW_UNAUTHENTICATED: "true",
	CLOUDFLARE_API_TOKEN: "test-token",
	CLOUDFLARE_ACCOUNT_ID: "acct",
	ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
	ACCESS_AUD: "aud",
} as unknown as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const call = (path: string, host = "localhost") => worker.fetch(new Request(`http://${host}${path}`) as Request<unknown, IncomingRequestCfProperties>, env, ctx);

describe("route error handling", () => {
	beforeEach(() => {
		vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
	});
	afterEach(() => vi.unstubAllGlobals());

	it("maps upstream failures inside cached routes to fixed error codes (not a raw exception)", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ success: false, errors: [{ message: "secret upstream detail" }] }), { status: 500 }));
		const res = await call("/api/categories");
		expect(res.status).toBe(502);
		const body = (await res.json()) as { code: string; error: string };
		expect(body.code).toBe("upstream_error");
		expect(JSON.stringify(body)).not.toContain("secret upstream detail");
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("requires a valid Access token outside localhost, even with the dev bypass set", async () => {
		const res = await call("/api/pops", "dash.example.com");
		expect(res.status).toBe(401);
		expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
	});

	it("rejects unknown parameters before doing any work", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const res = await call("/api/categories?cb=1");
		expect(res.status).toBe(400);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
