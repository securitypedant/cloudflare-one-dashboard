import { readJson } from "./upstream.ts";

/** Cloudflare REST API client for account configuration reads (Zero Trust, Access, Tunnels, audit logs). */

const API = "https://api.cloudflare.com/client/v4";
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 20;

/** The token lacks a permission; `permission` is the token permission to add. */
export class PermissionError extends Error {
	readonly permission: string;
	constructor(permission: string) {
		super(`API token is missing permission: ${permission}`);
		this.permission = permission;
	}
}

export class ApiRequestError extends Error {}

interface Envelope<T> {
	success?: boolean;
	result?: T;
	errors?: { code?: number; message?: string }[];
	result_info?: { page?: number; total_pages?: number; count?: number; total_count?: number; cursor?: string };
}

/** GET one API path. `permission` names the token permission needed, for a helpful error if it's missing. */
export async function cfGet<T>(token: string, path: string, permission: string, params: Record<string, string | number> = {}): Promise<Envelope<T>> {
	const url = new URL(`${API}${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	const body = await readJson<Envelope<T>>(res, MAX_BYTES).catch(() => null);
	if (res.status === 403 || (res.status === 401 && body?.errors?.some((e) => e.code === 10000))) throw new PermissionError(permission);
	if (!res.ok || !body?.success) {
		const detail = body?.errors?.map((e) => e.message).join("; ");
		throw new ApiRequestError(`GET ${path} returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
	}
	return body;
}

/** GET all pages of a list endpoint (page/per_page pagination), capped at MAX_PAGES. */
export async function cfList<T>(token: string, path: string, permission: string, params: Record<string, string | number> = {}, perPage = 100): Promise<T[]> {
	const out: T[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const body = await cfGet<T[]>(token, path, permission, { ...params, page, per_page: perPage });
		const items = Array.isArray(body.result) ? body.result : [];
		out.push(...items);
		const totalPages = body.result_info?.total_pages;
		if (items.length < perPage || (totalPages !== undefined && page >= totalPages)) break;
	}
	return out;
}

/** Run a section loader and turn a missing permission into a reportable result instead of failing the page. */
export async function section<T>(load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; missingPermission?: string; error: string }> {
	try {
		return { ok: true, data: await load() };
	} catch (err) {
		if (err instanceof PermissionError) return { ok: false, missingPermission: err.permission, error: `Add "${err.permission}" to the API token to see this section.` };
		console.error(JSON.stringify({ msg: "section failed", error: err instanceof Error ? err.message : String(err) }));
		return { ok: false, error: "Could not load this section. Check the Worker logs." };
	}
}
