const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export interface GraphQLErrorEntry {
	message: string;
	path?: (string | number)[];
}

export interface GraphQLResult<T> {
	data: T | null;
	errors: GraphQLErrorEntry[];
}

export class GraphQLError extends Error {}

/** Throws on transport/auth failures; returns partial data alongside field-level errors. */
export async function graphql<T>(
	token: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<GraphQLResult<T>> {
	const res = await fetch(GRAPHQL_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			// Budget per queried account instead of per token/user (which is shared with every other use of that credential).
			// https://developers.cloudflare.com/analytics/graphql-api/account-based-rate-limiting/
			"X-Rate-Limit-Type": "account-based",
		},
		body: JSON.stringify({ query, variables }),
	});
	const body = (await res.json().catch(() => null)) as { data?: T | null; errors?: GraphQLErrorEntry[] | null } | null;
	const errors = body?.errors ?? [];
	if (!res.ok) {
		const detail = errors.map((e) => e.message).join("; ");
		throw new GraphQLError(`GraphQL API returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
	}
	if (!body?.data) {
		throw new GraphQLError(errors.map((e) => e.message).join("; ") || "GraphQL API returned no data");
	}
	return { data: body.data, errors };
}
