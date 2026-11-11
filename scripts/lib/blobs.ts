/**
 * Blobs by hash: from directories laid out as sha256/<hex> (such as
 * tests/samples/scheduled/blobs, or a cache), or from a bucket's blobs/sha256/,
 * kept in a local cache. Every blob is checked against its hash before it is
 * returned or cached.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FetchBlob } from "../../methods/run";
import type { Bucket } from "./bucket";

const HASH = /^sha256:([0-9a-f]{64})$/;

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

/** Fetches blobs/sha256/<hex> from the bucket, keeping each in cache/sha256/<hex> once checked. */
export function blobsFromBucket(bucket: Bucket, cache: string | null): FetchBlob {
	const local = cache === null ? null : blobsFromDirectories([cache]);
	return async (hash) => {
		const cached = local === null ? null : await local(hash);
		if (cached !== null) return cached;
		const key = `blobs/sha256/${hexOf(hash)}`;
		const bytes = await bucket.get(key);
		if (bytes === null) return null;
		checked(hash, bytes, `${bucket.name}/${key}`);
		if (cache !== null) {
			const directory = join(cache, "sha256");
			mkdirSync(directory, { recursive: true });
			const path = join(directory, hexOf(hash));
			writeFileSync(`${path}.tmp`, bytes);
			renameSync(`${path}.tmp`, path);
		}
		return bytes;
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
