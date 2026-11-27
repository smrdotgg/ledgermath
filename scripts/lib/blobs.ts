/**
 * Blobs by hash: from directories laid out as sha256/<hex> (such as
 * tests/samples/scheduled/blobs, or a cache), from a bucket's blobs/sha256/,
 * or from a public address serving the same paths (the stage's CloudFront
 * distribution, infra/runs/public-blobs.ts), kept in a local cache. Every
 * blob is checked against its hash before it is returned or cached: from a
 * public address that is what makes its bytes trustworthy at all. A store
 * can be made to try a read again when it fails for a reason that may pass
 * (retryingStore), as scripts/derive.ts does with the bucket.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FetchBlob } from "../../methods/run";
import { describeS3Error } from "./bucket";

const HASH = /^sha256:([0-9a-f]{64})$/;
const BLOB_KEY = /^blobs\/sha256\/[0-9a-f]{64}$/;

function hexOf(hash: string): string {
	const hex = HASH.exec(hash)?.[1];
	if (hex === undefined) throw new Error(`${JSON.stringify(hash)} is not a sha256:<hex> hash`);
	return hex;
}

function checked(hash: string, bytes: Uint8Array, where: string): Uint8Array {
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== hexOf(hash)) throw new Error(`${where}: its bytes hash to sha256:${actual}, not ${hash}`);
	return bytes;
}

/** Looks in each directory in turn for sha256/<hex>. */
export function blobsFromDirectories(directories: readonly string[]): FetchBlob {
	return async (hash) => {
		const hex = hexOf(hash);
		for (const directory of directories) {
			const path = join(directory, "sha256", hex);
			if (existsSync(path)) return checked(hash, new Uint8Array(readFileSync(path)), path);
		}
		return null;
	};
}

/** Where blobsFromBucket reads blobs/sha256/<hex>: a bucket (scripts/lib/bucket.ts), or a public address. */
export interface BlobStore {
	/** What it is, for messages. */
	readonly name: string;
	/** An object's bytes, or null when there is no such key. */
	get(key: string): Promise<Uint8Array | null>;
}

/**
 * Fetches blobs/sha256/<hex> from the store, looking in cache/sha256/<hex>
 * first, and keeping each fetched blob there once checked, unless `keep` is
 * false (for stdout blobs, of which a Method keeps a reduced record instead).
 */
export function blobsFromBucket(bucket: BlobStore, cache: string | null, options: { keep?: boolean } = {}): FetchBlob {
	const keep = options.keep ?? true;
	const local = cache === null ? null : blobsFromDirectories([cache]);
	return async (hash) => {
		const cached = local === null ? null : await local(hash);
		if (cached !== null) return cached;
		const key = `blobs/sha256/${hexOf(hash)}`;
		const bytes = await bucket.get(key);
		if (bytes === null) return null;
		checked(hash, bytes, `${bucket.name}/${key}`);
		if (cache !== null && keep) {
			const directory = join(cache, "sha256");
			mkdirSync(directory, { recursive: true });
			const path = join(directory, hexOf(hash));
			writeFileSync(`${path}.tmp`, bytes);
			renameSync(`${path}.tmp`, path);
		}
		return bytes;
	};
}

/**
 * The pace a reader of a public address keeps unless told otherwise: 4
 * requests a second, 1,200 in any 5 minutes, under the distribution's limit
 * of 1,500 per address per 5 minutes (RATE_LIMIT in
 * infra/runs/public-blobs.ts), however many fetches are in flight.
 */
export const PUBLIC_REQUESTS_PER_SECOND = 4;

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PublicStoreOptions {
	fetch?: HttpFetch;
	/** Requests started per second, at most; Infinity for no pacing. */
	perSecond?: number;
	/** For tests: the clock and the wait the pacing uses. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/** S3's answer, through the distribution, for a key it does not hold: the distribution may not list the bucket, so S3 says 403, not 404. */
const S3_ACCESS_DENIED = /<Code>AccessDenied<\/Code>/;

/**
 * blobs/sha256/<hex> under a public base address, such as
 * https://d111111abcdef8.cloudfront.net. 404, or S3's 403 AccessDenied, is
 * "no such blob" (null). Any other 403 is a refusal (the distribution's
 * per-address rate limit or its ceiling on all requests, or an address on
 * AWS's reputation list), and any other status is an error: both throw,
 * rather than pass for a missing blob. A redirect is never followed: the
 * reader contacts the host it was given and no other, so a 3xx throws,
 * naming both addresses. blobsFromBucket checks every blob's hash, so a
 * wrong body is refused.
 */
export function publicBlobStore(base: string, options: PublicStoreOptions = {}): BlobStore {
	if (!/^https:\/\/[^/]/.test(base)) throw new Error(`${JSON.stringify(base)}: a public blob address starts with https://`);
	const root = base.replace(/\/+$/, "");
	const fetchUrl: HttpFetch = options.fetch ?? ((url, init) => fetch(url, init));
	const perSecond = options.perSecond ?? PUBLIC_REQUESTS_PER_SECOND;
	if (!(perSecond > 0)) throw new Error(`perSecond must be above 0, not ${perSecond}`);
	const interval = Number.isFinite(perSecond) ? 1000 / perSecond : 0;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	let next = -Infinity;
	// Each request takes the next free start time, interval after the one
	// before, so concurrent fetches are spaced too.
	const turn = async (): Promise<void> => {
		const at = Math.max(now(), next);
		next = at + interval;
		const wait = at - now();
		if (wait > 0) await sleep(wait);
	};
	return {
		name: root,
		async get(key) {
			if (!BLOB_KEY.test(key)) throw new Error(`${root}: serves blobs/sha256/<hex> only, not ${JSON.stringify(key)}`);
			const url = `${root}/${key}`;
			await turn();
			const response = await fetchUrl(url, { redirect: "manual" });
			if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect" || response.redirected) {
				const location = response.headers.get("location");
				await response.body?.cancel();
				throw new Error(`${url}: HTTP ${response.status} redirect to ${location === null ? "(no Location header)" : location}; refused, a blob is read only from the address given`);
			}
			if (response.ok) return new Uint8Array(await response.arrayBuffer());
			const body = await response.text();
			if (response.status === 404) return null;
			if (response.status === 403 && S3_ACCESS_DENIED.test(body)) return null;
			if (response.status === 403) {
				throw new Error(`${url}: HTTP 403, refused by the distribution (its per-address rate limit, or an address AWS lists as bad); slow down and try again later`);
			}
			throw new Error(`${url}: HTTP ${response.status}`);
		},
	};
}

/**
 * Bun's S3 client's words for a request it got no readable answer to: the
 * connection was refused, closed, reset or timed out (the error's code is then
 * the client's own name for it: ConnectionClosed, ConnectionRefused…), or S3,
 * or something in front of it, answered an error with an empty body (code
 * UnknownError). An error answer S3 writes itself has S3's code and words.
 */
export const NO_READABLE_ANSWER = "an unexpected error has occurred";

/**
 * S3's codes for an answer that may pass, which S3 asks to be tried again
 * (500 InternalError, 503 ServiceUnavailable and SlowDown, 400
 * RequestTimeout), and the client's code for an error answer it could not read
 * as S3's (an empty body, or a page from something in front of S3: a 502).
 */
const MAY_PASS_CODES: ReadonlySet<string> = new Set(["InternalError", "ServiceUnavailable", "SlowDown", "RequestTimeout", "UnknownError"]);
/** A connection that failed, as Node and Bun name it in an error's code. */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
	"ConnectionClosed",
	"ConnectionRefused",
	"ConnectionReset",
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"EPIPE",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"Timeout",
]);

/**
 * Whether a failed read may succeed if it is made again: no answer, or an
 * answer S3 gives for a load or a fault of its own. Not an answer about the
 * request itself (AccessDenied, InvalidAccessKeyId, ExpiredToken…), which
 * would be the same every time. A blob that is not there is no failure at
 * all: the store answers null.
 */
export function mayPass(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (message === NO_READABLE_ANSWER) return true;
	return typeof code === "string" && (MAY_PASS_CODES.has(code) || CONNECTION_CODES.has(code));
}

export interface RetryOptions {
	/** Tries in all, the first among them (default 8). */
	tries?: number;
	/** The pause before the second try, in ms (default 500), doubled before each later one up to maxPause (default 8,000). */
	firstPause?: number;
	maxPause?: number;
	/** Reads in flight at once, at most, however many are asked for (default 16); one waiting out its pause is not in flight. */
	inFlight?: number;
	/** For tests: the wait, and a number in [0, 1) that sets each pause between half and all of its length. */
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	/** Told of each failed try that will be made again. */
	log?: (line: string) => void;
}

/**
 * A store whose reads survive a failure that may pass (mayPass): such a read
 * is made again, up to `tries` times in all, after a pause that doubles each
 * time (0.5, 1, 2, 4, 8, 8 and 8 seconds by default, each drawn between half
 * and all of that, so reads that failed together do not all come back
 * together), and never more than `inFlight` reads at once. A read that keeps
 * failing, or fails for a reason that would not pass, throws, naming the key,
 * the error's code and words, and how many tries were made. A blob that is
 * not there (null) is answered at once, never tried again: the caller fails on
 * it plainly, as before.
 */
export function retryingStore(store: BlobStore, options: RetryOptions = {}): BlobStore & { readonly retried: () => number } {
	const tries = options.tries ?? 8;
	const firstPause = options.firstPause ?? 500;
	const maxPause = options.maxPause ?? 8_000;
	const limit = options.inFlight ?? 16;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	const random = options.random ?? Math.random;
	const log = options.log ?? ((line: string) => console.error(line));
	if (!(tries >= 1) || !(limit >= 1)) throw new Error(`tries and inFlight must be at least 1, not ${tries} and ${limit}`);
	let inFlight = 0;
	const waiting: Array<() => void> = [];
	let retried = 0;
	const slot = async (): Promise<void> => {
		if (inFlight < limit) {
			inFlight++;
			return;
		}
		await new Promise<void>((resolve) => waiting.push(resolve));
	};
	const release = (): void => {
		const next = waiting.shift();
		if (next === undefined) inFlight--;
		else next(); // the slot passes to the next read waiting
	};
	return {
		name: store.name,
		retried: () => retried,
		async get(key) {
			for (let attempt = 1; ; attempt++) {
				await slot();
				let failure: unknown;
				try {
					return await store.get(key);
				} catch (error) {
					failure = error;
				} finally {
					release();
				}
				// The error's code and words, never a URL: the client's code is the only
				// place it says why a request got no readable answer.
				const why = describeS3Error(failure);
				if (!mayPass(failure)) throw new Error(`${store.name}/${key}: ${why} (not tried again: an answer about the request itself)`, { cause: failure });
				if (attempt >= tries) throw new Error(`${store.name}/${key}: ${why}, on each of ${tries} tries`, { cause: failure });
				const pause = Math.min(maxPause, firstPause * 2 ** (attempt - 1));
				const wait = Math.round(pause / 2 + (random() * pause) / 2);
				retried++;
				log(`${store.name}/${key}: ${why}; try ${attempt + 1} of ${tries} in ${wait} ms`);
				await sleep(wait);
			}
		},
	};
}

/** Tries each source in turn. */
export function firstOf(sources: readonly FetchBlob[]): FetchBlob {
	return async (hash) => {
		for (const source of sources) {
			const bytes = await source(hash);
			if (bytes !== null) return bytes;
		}
		return null;
	};
}
