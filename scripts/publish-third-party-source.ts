/**
 * Puts the third-party source packages that third-party/sources.lock.json
 * names into the Runs bucket, beside the binaries, each as a blob named by
 * its hash: blobs/sha256/<sha256>. The GNU C Library's source package is the
 * one there is today: every static benchmark binary contains parts of glibc,
 * and its licence (LGPL-2.1-or-later, section 6) asks that its source be
 * offered from the same place as the binaries.
 *
 *     bun scripts/publish-third-party-source.ts --bucket NAME [--region R] [--work DIR] [--dry-run]
 *     bun scripts/publish-third-party-source.ts --directory DIR [--work DIR] [--dry-run]
 *
 * For each entry of the lock:
 *   - when the bucket holds blobs/sha256/<sha256> at the entry's size, it does
 *     nothing (a blob is not read back, as box.sh treats blobs);
 *   - when it holds that key at another size, it stops, writing nothing;
 *   - otherwise it downloads the entry's url into --work (a new temporary
 *     directory by default), refuses bytes whose size or SHA-256 is not the
 *     entry's, uploads them, checks the object's size, and removes the download.
 * So a second run uploads nothing. --dry-run says what it would upload and
 * downloads nothing. --directory writes into a directory laid out like the
 * bucket instead, for trying it without AWS.
 *
 * Credentials for --bucket come from the environment (scripts/lib/bucket.ts)
 * and need s3:GetObject (for the size check) and s3:PutObject on blobs/*.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { RUNS_BUCKET_REGION } from "./lib/runs-repository";

export const SOURCES_LOCK = "third-party/sources.lock.json";

export interface SourceEntry {
	name: string;
	version: string;
	why: string;
	/** The binary package whose source this is, as `rpm -qa` names it. */
	binary_package: string;
	/** The file's name where it comes from. */
	file: string;
	url: string;
	bytes: number;
	sha256: string;
	content_type: string;
}

export interface SourcesLock {
	description: string;
	/** The image infra/runs/stack.ts pins, whose packages the binaries are built with. */
	image: { id: string; release: string };
	sources: SourceEntry[];
}

const STRING_FIELDS = ["name", "version", "why", "binary_package", "file", "url", "sha256", "content_type"] as const;

/** The lock, checked field by field; throws saying what is wrong. */
export function readSourcesLock(text: string): SourcesLock {
	const lock = JSON.parse(text) as Partial<SourcesLock>;
	const problems: string[] = [];
	if (typeof lock.description !== "string") problems.push("description is not a string");
	if (typeof lock.image?.id !== "string" || !/^ami-[0-9a-f]+$/.test(lock.image.id)) problems.push("image.id is not an AMI id");
	if (typeof lock.image?.release !== "string" || lock.image.release === "") problems.push("image.release is missing");
	if (!Array.isArray(lock.sources) || lock.sources.length === 0) problems.push("sources is not a list of entries");
	const seen = new Set<string>();
	for (const [index, entry] of (lock.sources ?? []).entries()) {
		const at = `sources[${index}]`;
		for (const field of STRING_FIELDS) {
			if (typeof entry[field] !== "string" || entry[field] === "") problems.push(`${at}.${field} is not a non-empty string`);
		}
		if (typeof entry.sha256 === "string" && !/^[0-9a-f]{64}$/.test(entry.sha256)) problems.push(`${at}.sha256 is not 64 hex digits`);
		if (typeof entry.url === "string" && !entry.url.startsWith("https://")) problems.push(`${at}.url is not https`);
		if (typeof entry.file === "string" && entry.file.includes("/")) problems.push(`${at}.file holds a slash`);
		if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) problems.push(`${at}.bytes is not a positive integer`);
		if (seen.has(entry.sha256)) problems.push(`${at} repeats the hash of an earlier entry`);
		seen.add(entry.sha256);
	}
	if (problems.length > 0) throw new Error(`${SOURCES_LOCK}: ${problems.join("; ")}`);
	return lock as SourcesLock;
}

export function blobKey(sha256: string): string {
	return `blobs/sha256/${sha256}`;
}

/** Where blobs are written: the Runs bucket, or a directory laid out like it. */
export interface BlobStore {
	readonly name: string;
	/** The object's size, or null when there is no such key. */
	size(key: string): Promise<number | null>;
	/** Writes the file at path under key. Never called for a key that exists. */
	put(key: string, path: string, contentType: string): Promise<void>;
}

export class S3BlobStore implements BlobStore {
	readonly name: string;
	private readonly client: Bun.S3Client;

	/** `options` adds to the bucket and region: an endpoint and keys, for a stand-in in tests. */
	constructor(bucket: string, region: string, options: Bun.S3Options = {}) {
		this.name = `s3://${bucket}`;
		this.client = new Bun.S3Client({ bucket, region, ...options });
	}

	async size(key: string): Promise<number | null> {
		if (!(await this.client.exists(key))) return null;
		return (await this.client.stat(key)).size;
	}

	async put(key: string, path: string, contentType: string): Promise<void> {
		await this.client.write(key, Bun.file(path), { type: contentType });
	}
}

export class DirectoryBlobStore implements BlobStore {
	readonly name: string;

	constructor(private readonly root: string) {
		this.name = root;
	}

	async size(key: string): Promise<number | null> {
		const path = join(this.root, key);
		return existsSync(path) ? statSync(path).size : null;
	}

	async put(key: string, path: string): Promise<void> {
		const target = join(this.root, key);
		mkdirSync(dirname(target), { recursive: true });
		const partial = `${target}.partial`;
		copyFileSync(path, partial, constants.COPYFILE_EXCL);
		if (existsSync(target)) {
			rmSync(partial);
			throw new Error(`${target} appeared while it was being written`);
		}
		renameSync(partial, target);
	}
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const REQUEST: RequestInit = {
	// The bytes as stored, so their hash is the one the lock records.
	headers: { "Accept-Encoding": "identity", "User-Agent": "ledgermath-third-party-source" },
};

/** Streams url to a new file at path, hashing it as it goes; returns its size and SHA-256. */
export async function downloadHashed(fetcher: Fetch, url: string, path: string): Promise<{ bytes: number; sha256: string }> {
	const response = await fetcher(url, REQUEST);
	if (!response.ok || response.body === null) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
	const encoding = response.headers.get("content-encoding");
	if (encoding !== null && encoding !== "identity") throw new Error(`GET ${url}: came with Content-Encoding ${encoding}, not the bytes as stored`);
	const hash = createHash("sha256");
	const descriptor = openSync(path, "wx", 0o644);
	let bytes = 0;
	try {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			let at = 0;
			while (at < value.length) {
				const count = writeSync(descriptor, value, at, value.length - at);
				if (count <= 0) throw new Error(`GET ${url}: a write to ${path} wrote nothing`);
				at += count;
			}
			hash.update(value);
			bytes += value.length;
		}
	} finally {
		closeSync(descriptor);
	}
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) !== bytes) throw new Error(`GET ${url}: received ${bytes} bytes, and Content-Length said ${declared}`);
	return { bytes, sha256: hash.digest("hex") };
}

export type Action = "present" | "uploaded" | "would upload";

export interface Published {
	name: string;
	key: string;
	action: Action;
}

export interface PublishOptions {
	fetcher: Fetch;
	/** Where downloads go; a new temporary directory, removed afterwards, when not given. */
	work?: string;
	dryRun?: boolean;
	log?: (line: string) => void;
}

/** Puts every entry of the lock the store lacks into it. Stops at the first problem. */
export async function publishSources(lock: SourcesLock, store: BlobStore, options: PublishOptions): Promise<Published[]> {
	const log = options.log ?? (() => {});
	const made = options.work === undefined;
	const work = options.work ?? mkdtempSync(join(tmpdir(), "ledgermath-third-party-"));
	mkdirSync(work, { recursive: true });
	const published: Published[] = [];
	try {
		for (const entry of lock.sources) {
			const key = blobKey(entry.sha256);
			const held = await store.size(key);
			if (held !== null) {
				if (held !== entry.bytes) {
					throw new Error(`${store.name}/${key} holds ${held} bytes, and ${entry.file} has ${entry.bytes}: a blob is never overwritten, so look at it by hand`);
				}
				log(`${entry.file}: ${store.name}/${key} is there, ${held} bytes`);
				published.push({ name: entry.name, key, action: "present" });
				continue;
			}
			if (options.dryRun) {
				log(`${entry.file}: would download ${entry.url} (${entry.bytes} bytes) and upload it to ${store.name}/${key}`);
				published.push({ name: entry.name, key, action: "would upload" });
				continue;
			}
			const path = join(work, entry.sha256);
			try {
				const got = await downloadHashed(options.fetcher, entry.url, path);
				if (got.bytes !== entry.bytes || got.sha256 !== entry.sha256) {
					throw new Error(`${entry.url} gave ${got.bytes} bytes with SHA-256 ${got.sha256}, and ${SOURCES_LOCK} pins ${entry.bytes} bytes with ${entry.sha256}`);
				}
				await store.put(key, path, entry.content_type);
				const after = await store.size(key);
				if (after !== entry.bytes) throw new Error(`${store.name}/${key} holds ${after ?? "nothing"} after the upload, not ${entry.bytes} bytes`);
				log(`${entry.file}: uploaded to ${store.name}/${key}, ${entry.bytes} bytes, SHA-256 ${entry.sha256}`);
				published.push({ name: entry.name, key, action: "uploaded" });
			} finally {
				rmSync(path, { force: true });
			}
		}
	} finally {
		if (made) rmSync(work, { recursive: true, force: true });
	}
	return published;
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			bucket: { type: "string" },
			region: { type: "string" },
			directory: { type: "string" },
			work: { type: "string" },
			lock: { type: "string" },
			"dry-run": { type: "boolean" },
		},
	});
	if ((values.bucket === undefined) === (values.directory === undefined)) {
		console.error("usage: bun scripts/publish-third-party-source.ts (--bucket NAME [--region R] | --directory DIR) [--work DIR] [--lock FILE] [--dry-run]");
		process.exit(2);
	}
	const lockPath = values.lock ?? join(import.meta.dir, "..", SOURCES_LOCK);
	try {
		const lock = readSourcesLock(readFileSync(lockPath, "utf8"));
		const store = values.bucket !== undefined ? new S3BlobStore(values.bucket, values.region ?? RUNS_BUCKET_REGION) : new DirectoryBlobStore(values.directory as string);
		const results = await publishSources(lock, store, { fetcher: fetch, work: values.work, dryRun: values["dry-run"], log: (line) => console.log(line) });
		const count = (action: string) => results.filter((result) => result.action === action).length;
		console.log(`${count("uploaded")} uploaded, ${count("present")} already there` + (values["dry-run"] ? `, ${count("would upload")} to upload (dry run)` : ""));
	} catch (error) {
		console.error(`publish-third-party-source: ${(error as Error).message}`);
		process.exit(1);
	}
}
