/**
 * Blobs by hash: from directories laid out as sha256/<hex> (such as
 * tests/samples/scheduled/blobs, or a cache), from a bucket's blobs/sha256/,
 * or from a public address serving the same paths (the stage's CloudFront
 * distribution, infra/runs/public-blobs.ts), kept in a local cache. Every
 * blob is checked against its hash before it is returned or cached: from a
 * public address that is what makes its bytes trustworthy at all.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FetchBlob } from "../../methods/run";

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

export type HttpFetch = (url: string) => Promise<Response>;

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
 * per-address rate limit, or an address on AWS's reputation list), and any
 * other status is an error: both throw, rather than pass for a missing blob.
 * blobsFromBucket checks every blob's hash, so a wrong body is refused.
 */
export function publicBlobStore(base: string, options: PublicStoreOptions = {}): BlobStore {
	if (!/^https:\/\/[^/]/.test(base)) throw new Error(`${JSON.stringify(base)}: a public blob address starts with https://`);
	const root = base.replace(/\/+$/, "");
	const fetchUrl = options.fetch ?? ((url: string) => fetch(url));
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
			const response = await fetchUrl(url);
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
