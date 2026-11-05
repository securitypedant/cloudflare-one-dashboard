import { readJson } from "./upstream.ts";

interface Category {
	id: number;
	name: string;
	subcategories?: Category[];
}

/**
 * Gateway content/security category names (id → name, including subcategories).
 * Needs the API token to have Account → Zero Trust → Read.
 */
export async function fetchCategories(token: string, accountId: string): Promise<Record<number, string>> {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/categories`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	const body = await readJson<{ success?: boolean; result?: Category[]; errors?: { message: string }[] }>(res, 2 * 1024 * 1024).catch(() => null);
	if (!res.ok || !body?.success || !body.result) {
		const detail = body?.errors?.map((e) => e.message).join("; ");
		throw new Error(`Gateway categories API returned HTTP ${res.status}${detail ? `: ${detail}` : ""} (token needs Zero Trust: Read)`);
	}
	return flattenCategories(body.result);
}

const MAX_DEPTH = 4;
const MAX_NODES = 5000;

/** Iterative, bounded walk of the category tree (depth ≤ MAX_DEPTH, ≤ MAX_NODES entries); malformed nodes are skipped. */
export function flattenCategories(root: unknown): Record<number, string> {
	const names: Record<number, string> = {};
	const stack: { nodes: unknown; depth: number }[] = [{ nodes: root, depth: 0 }];
	let count = 0;
	while (stack.length) {
		const { nodes, depth } = stack.pop()!;
		if (!Array.isArray(nodes) || depth > MAX_DEPTH) continue;
		for (const c of nodes as Partial<Category>[]) {
			if (++count > MAX_NODES) return names;
			if (typeof c?.id === "number" && typeof c.name === "string") names[c.id] = c.name.slice(0, 100);
			if (c?.subcategories) stack.push({ nodes: c.subcategories, depth: depth + 1 });
		}
	}
	return names;
}
