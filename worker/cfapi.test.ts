import { afterEach, describe, expect, it, vi } from "vitest";
import { cfList, PermissionError } from "./cfapi.ts";

const ok = (result: unknown[], result_info?: object) => new Response(JSON.stringify({ success: true, result, ...(result_info ? { result_info } : {}) }));

describe("cfList", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("pages with per_page=100 until a short page", async () => {
		const urls: URL[] = [];
		vi.stubGlobal("fetch", async (u: URL) => {
			urls.push(u);
			const page = Number(u.searchParams.get("page"));
			return ok(Array.from({ length: page === 1 ? 100 : 7 }, (_, i) => ({ id: `${page}-${i}` })), { page, per_page: 100 });
		});
		const items = await cfList<{ id: string }>("t", "/accounts/a/devices", "Zero Trust Read");
		expect(items).toHaveLength(107);
		expect(urls.map((u) => u.searchParams.get("per_page"))).toEqual(["100", "100"]);
	});

	it("stops after one request when the endpoint returns no pagination info", async () => {
		const fetchSpy = vi.fn(async () => ok(Array.from({ length: 150 }, (_, i) => ({ id: i }))));
		vi.stubGlobal("fetch", fetchSpy);
		expect(await cfList("t", "/accounts/a/gateway/app_types", "Zero Trust Read")).toHaveLength(150);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("reports a missing permission on 403", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 }));
		await expect(cfList("t", "/accounts/a/devices", "Zero Trust Read")).rejects.toBeInstanceOf(PermissionError);
	});
});
