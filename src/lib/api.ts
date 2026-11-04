import { useEffect, useState } from "react";
import type { ApiError } from "../../shared/types.ts";

export async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url);
	const body = (await res.json()) as T | ApiError;
	if (!res.ok) throw new Error((body as ApiError).error ?? `HTTP ${res.status}`);
	return body as T;
}

// One in-flight/settled request per URL for the session; failures are evicted so they can be retried.
const cache = new Map<string, Promise<unknown>>();

export function cachedJson<T>(url: string): Promise<T> {
	let pending = cache.get(url) as Promise<T> | undefined;
	if (!pending) {
		pending = getJson<T>(url);
		pending.catch(() => cache.delete(url));
		cache.set(url, pending);
	}
	return pending;
}

/** Fetch JSON for `url` (null = skip). `loading` is true until the response for the current URL arrives. */
export function useApi<T>(url: string | null): { data?: T; error?: string; loading: boolean } {
	const [state, setState] = useState<{ url: string; data?: T; error?: string } | null>(null);
	useEffect(() => {
		if (!url) return;
		let cancelled = false;
		cachedJson<T>(url).then(
			(data) => !cancelled && setState({ url, data }),
			(e: Error) => !cancelled && setState({ url, error: e.message }),
		);
		return () => {
			cancelled = true;
		};
	}, [url]);
	const current = state?.url === url ? state : undefined;
	return { data: current?.data, error: current?.error, loading: !!url && !current };
}
