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
	});
	const body = (await res.json().catch(() => null)) as { success?: boolean; result?: Category[]; errors?: { message: string }[] } | null;
	if (!res.ok || !body?.success || !body.result) {
		const detail = body?.errors?.map((e) => e.message).join("; ");
		throw new Error(`Gateway categories API returned HTTP ${res.status}${detail ? `: ${detail}` : ""} (token needs Zero Trust: Read)`);
	}
	const names: Record<number, string> = {};
	const walk = (cats: Category[]) => {
		for (const c of cats) {
			names[c.id] = c.name;
			if (c.subcategories) walk(c.subcategories);
		}
	};
	walk(body.result);
	return names;
}
