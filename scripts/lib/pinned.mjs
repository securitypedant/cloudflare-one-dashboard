// Fetch a third-party build input and check it against a recorded SHA-256 (scripts/data-sources.lock.json).
// Upstream data changes over time; a mismatch stops the generator until you review the new data and
// re-run with --update, so changed inputs never slip into the bundle unnoticed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const LOCK = new URL("../data-sources.lock.json", import.meta.url);
const update = process.argv.includes("--update");
const MAX_BYTES = 64 * 1024 * 1024;

const readLock = () => (existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : {});

/** Returns the response body as a Buffer after verifying (or, with --update, recording) its hash. */
export async function fetchPinned(url, init) {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	const body = Buffer.from(await res.arrayBuffer());
	if (body.byteLength > MAX_BYTES) throw new Error(`${url}: ${body.byteLength} bytes exceeds ${MAX_BYTES}`);
	const sha256 = createHash("sha256").update(body).digest("hex");
	const lock = readLock();
	const pinned = lock[url]?.sha256;
	if (pinned && pinned !== sha256 && !update) {
		throw new Error(
			`${url} changed upstream (expected sha256 ${pinned}, got ${sha256}).\n` +
				`Review the new data, then re-run with --update to accept it.`,
		);
	}
	if (!pinned || update) {
		lock[url] = { sha256, bytes: body.byteLength, fetched: new Date().toISOString().slice(0, 10) };
		writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
		console.log(`pinned ${url} sha256=${sha256}`);
	}
	return body;
}

export const fetchPinnedText = async (url, init) => (await fetchPinned(url, init)).toString("utf8");
export const fetchPinnedJson = async (url, init) => JSON.parse(await fetchPinnedText(url, init));
