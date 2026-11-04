/** Helpers for reading data from upstream services without trusting their size or freshness. */

export class ResponseTooLargeError extends Error {}

/** Parse a JSON response body, aborting once more than `maxBytes` have been read. */
export async function readJson<T>(res: Response, maxBytes: number): Promise<T> {
	const declared = Number(res.headers.get("Content-Length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await res.body?.cancel();
		throw new ResponseTooLargeError(`response declares ${declared} bytes (limit ${maxBytes})`);
	}
	if (!res.body) return JSON.parse("") as T;
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new ResponseTooLargeError(`response exceeded ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		bytes.set(c, offset);
		offset += c.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Cache a validated value (not the raw upstream response) in the colo's Cache API. Only data that
 * passed `loader`'s parsing and validation is stored, so an anomalous upstream body is never pinned.
 */
export async function cachedValue<T>(ctx: ExecutionContext | undefined, name: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
	const key = new Request(`https://api-cache.internal/__upstream/${name}`);
	const hit = await caches.default.match(key);
	if (hit) return (await hit.json()) as T;
	const value = await loader();
	const put = caches.default.put(key, Response.json(value, { headers: { "Cache-Control": `max-age=${ttlSeconds}` } }));
	if (ctx) ctx.waitUntil(put);
	else await put;
	return value;
}

/** Run async tasks with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			try {
				results[i] = { status: "fulfilled", value: await fn(items[i]) };
			} catch (reason) {
				results[i] = { status: "rejected", reason };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
