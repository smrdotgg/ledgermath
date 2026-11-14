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
 *   - when the bucket holds blobs/sha256/<sha256>, it reads the object whole
 *     and hashes it: the lock's size and SHA-256 make it "already there", and
 *     anything else stops the script, changing nothing;
 *   - otherwise it downloads the entry's url into a new directory of its own
 *     under --work (the system's temporary directory by default), refuses
 *     bytes whose size or SHA-256 is not the entry's, and creates the object
 *     with a write that only succeeds if the key does not exist (S3's
 *     If-None-Match: *; in a directory, an exclusive create). When the key
 *     appeared meanwhile, the write is refused and what is there is checked as
 *     above. Either way the object is then read back and hashed.
 * It never overwrites or deletes an object, and removes only the directory it
 * made for its download. A second run uploads nothing. --dry-run checks what
 * is there and says what it would upload, downloading nothing from the url.
 * --directory writes into a directory laid out like the bucket instead, for
 * trying it without AWS, and refuses a symbolic link anywhere on the path.
 *
 * Its last line says whether every source package of the lock is now in the
 * bucket with the bytes the lock pins.
 *
 * --bucket takes credentials from the environment (AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN; scripts/lib/bucket.ts says how)
 * and needs, on the bucket: s3:GetObject on blobs/* (to read objects back),
 * s3:PutObject on blobs/* (to create them), and s3:ListBucket on the bucket,
 * without which S3 answers a HEAD for a missing key with 403 instead of 404
 * and the script stops at the first entry it has to upload.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { addFile, RUNS_BUCKET_REGION, symlinkOnPath } from "./lib/runs-repository";
import { amzDate, encodeUriPath, signV4 } from "./lib/sigv4";

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

/** What an object holds: how many bytes, and their SHA-256. */
export interface Held {
	bytes: number;
	sha256: string;
}

/** Where blobs are written: the Runs bucket, or a directory laid out like it. Nothing in it is ever replaced. */
export interface BlobStore {
	readonly name: string;
	/** The object's bytes counted and hashed, read whole; null when there is no such key. */
	read(key: string): Promise<Held | null>;
	/** Creates key from the file at path only if key does not exist: "created", or "exists" when it did. */
	create(key: string, path: string, entry: SourceEntry): Promise<"created" | "exists">;
}

export type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

/** The credentials Bun's S3 client would read: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and, if set, AWS_SESSION_TOKEN. */
export function credentialsFromEnvironment(environment: Record<string, string | undefined> = process.env): Credentials {
	const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken } = environment;
	if (!accessKeyId || !secretAccessKey) {
		throw new Error('no AWS credentials in the environment: run eval "$(aws configure export-credentials --format env)" first');
	}
	return { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined };
}

export interface S3StoreOptions {
	/** https://s3.<region>.amazonaws.com by default; a stand-in's address in tests. Path-style addressing either way. */
	endpoint?: string;
	credentials?: Credentials;
	/** For the conditional PUT; fetch by default. */
	fetcher?: Fetch;
	now?: () => Date;
}

export class S3BlobStore implements BlobStore {
	readonly name: string;
	private readonly client: Bun.S3Client;
	private readonly endpoint: string;
	private readonly credentials: Credentials;
	private readonly fetcher: Fetch;
	private readonly now: () => Date;

	constructor(
		private readonly bucket: string,
		private readonly region: string,
		options: S3StoreOptions = {},
	) {
		this.name = `s3://${bucket}`;
		this.endpoint = (options.endpoint ?? `https://s3.${region}.amazonaws.com`).replace(/\/+$/, "");
		this.credentials = options.credentials ?? credentialsFromEnvironment();
		this.fetcher = options.fetcher ?? fetch;
		this.now = options.now ?? (() => new Date());
		this.client = new Bun.S3Client({ bucket, region, endpoint: this.endpoint, ...this.credentials });
	}

	async read(key: string): Promise<Held | null> {
		let exists: boolean;
		try {
			exists = await this.client.exists(key);
		} catch (error) {
			throw new Error(
				`HEAD ${this.name}/${key} failed (${(error as Error).message}). Reading needs s3:GetObject; telling a missing key from a refused one needs s3:ListBucket on the bucket, without which S3 answers 403 for a missing key`,
			);
		}
		if (!exists) return null;
		const hash = createHash("sha256");
		let bytes = 0;
		for await (const chunk of this.client.file(key).stream()) {
			hash.update(chunk);
			bytes += chunk.length;
		}
		return { bytes, sha256: hash.digest("hex") };
	}

	/**
	 * One PutObject with If-None-Match: *, signed here with SigV4 (Bun's client
	 * cannot send that header). The payload's SHA-256 is signed too, so S3
	 * refuses a body that is not the bytes checked. 200: created; 412: the key
	 * exists, nothing written; 409 (a delete raced the write): tried again, at
	 * most three times in all.
	 */
	async create(key: string, path: string, entry: SourceEntry): Promise<"created" | "exists"> {
		const canonicalUri = `/${encodeUriPath(this.bucket)}/${encodeUriPath(key)}`;
		const url = new URL(`${this.endpoint}${canonicalUri}`);
		for (let attempt = 1; ; attempt++) {
			const date = amzDate(this.now());
			const headers: Array<[string, string]> = [
				["host", url.host],
				["content-type", entry.content_type],
				["if-none-match", "*"],
				["x-amz-content-sha256", entry.sha256],
				["x-amz-date", date],
			];
			if (this.credentials.sessionToken) headers.push(["x-amz-security-token", this.credentials.sessionToken]);
			const signed = signV4({
				method: "PUT",
				canonicalUri,
				canonicalQuery: "",
				headers,
				payloadSha256: entry.sha256,
				amzDate: date,
				region: this.region,
				service: "s3",
				accessKeyId: this.credentials.accessKeyId,
				secretAccessKey: this.credentials.secretAccessKey,
			});
			const sent = Object.fromEntries(headers.filter(([name]) => name !== "host"));
			sent.authorization = signed.authorization;
			const response = await this.fetcher(url, { method: "PUT", headers: sent, body: Bun.file(path) });
			if (response.status === 200) return "created";
			if (response.status === 412) return "exists";
			const detail = (await response.text()).slice(0, 600);
			if (response.status === 409 && attempt < 3) continue;
			throw new Error(`PUT ${this.name}/${key} (If-None-Match: *): ${response.status} ${response.statusText} ${detail}`.trim());
		}
	}
}

/** A directory laid out like the bucket. Refuses a symbolic link anywhere on a key's path, the root included. */
export class DirectoryBlobStore implements BlobStore {
	readonly name: string;

	constructor(private readonly root: string) {
		this.name = root;
	}

	private refuseLinks(key: string): void {
		const link = symlinkOnPath(this.root, key);
		if (link !== null) throw new Error(`${this.root}: ${link} is a symbolic link, which this store does not follow`);
	}

	async read(key: string): Promise<Held | null> {
		this.refuseLinks(key);
		const path = join(this.root, key);
		if (!existsSync(path)) return null;
		if (!lstatSync(path).isFile()) throw new Error(`${path} is not a plain file`);
		const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const hash = createHash("sha256");
		let bytes = 0;
		try {
			const buffer = Buffer.alloc(1 << 20);
			for (let count = readSync(descriptor, buffer); count > 0; count = readSync(descriptor, buffer)) {
				hash.update(buffer.subarray(0, count));
				bytes += count;
			}
		} finally {
			closeSync(descriptor);
		}
		return { bytes, sha256: hash.digest("hex") };
	}

	async create(key: string, path: string): Promise<"created" | "exists"> {
		if (lstatSync(this.root, { throwIfNoEntry: false }) === undefined) mkdirSync(this.root, { recursive: true });
		this.refuseLinks(key);
		// addFile creates exclusively, refuses anything but plain directories on
		// the way, and gives the file its name with link(), which fails rather
		// than replace a file that appeared meanwhile.
		return addFile(this.root, key, new Uint8Array(readFileSync(path))) === "added" ? "created" : "exists";
	}
}

const REQUEST: RequestInit = {
	// The bytes as stored, so their hash is the one the lock records.
	headers: { "Accept-Encoding": "identity", "User-Agent": "ledgermath-third-party-source" },
};

/** Streams url to a new file at path (which must not exist), hashing it as it goes; returns its size and SHA-256. */
export async function downloadHashed(fetcher: Fetch, url: string, path: string): Promise<Held> {
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

export type Action = "present" | "appeared" | "uploaded" | "would upload";

export interface Published {
	name: string;
	key: string;
	/** present: there before, checked; appeared: created by another writer while this one downloaded, checked; uploaded: created here, checked. */
	action: Action;
}

export interface PublishOptions {
	fetcher: Fetch;
	/** The directory under which each run makes, and afterwards removes, a directory of its own for downloads. */
	work?: string;
	dryRun?: boolean;
	log?: (line: string) => void;
}

/** Stops unless held is exactly the entry's bytes. */
function check(store: BlobStore, key: string, entry: SourceEntry, held: Held | null, when: string): void {
	if (held === null) throw new Error(`${store.name}/${key} is not there ${when}`);
	if (held.bytes !== entry.bytes || held.sha256 !== entry.sha256) {
		throw new Error(
			`${store.name}/${key} holds ${held.bytes} bytes with SHA-256 ${held.sha256} ${when}, not the ${entry.bytes} bytes with SHA-256 ${entry.sha256} that ${SOURCES_LOCK} pins for ${entry.file}. Nothing was written there; look at it by hand`,
		);
	}
}

/** Puts every entry of the lock the store lacks into it, and checks every one's bytes. Stops at the first problem. */
export async function publishSources(lock: SourcesLock, store: BlobStore, options: PublishOptions): Promise<Published[]> {
	const log = options.log ?? (() => {});
	const published: Published[] = [];
	let run: string | null = null;
	try {
		for (const entry of lock.sources) {
			const key = blobKey(entry.sha256);
			const held = await store.read(key);
			if (held !== null) {
				check(store, key, entry, held, "already");
				log(`${entry.file}: ${store.name}/${key} is there, ${held.bytes} bytes with the SHA-256 the lock pins`);
				published.push({ name: entry.name, key, action: "present" });
				continue;
			}
			if (options.dryRun) {
				log(`${entry.file}: would download ${entry.url} (${entry.bytes} bytes) and create ${store.name}/${key}`);
				published.push({ name: entry.name, key, action: "would upload" });
				continue;
			}
			if (run === null) {
				const base = options.work ?? tmpdir();
				mkdirSync(base, { recursive: true });
				run = mkdtempSync(join(base, "ledgermath-third-party-"));
			}
			const path = join(run, entry.sha256);
			const got = await downloadHashed(options.fetcher, entry.url, path);
			if (got.bytes !== entry.bytes || got.sha256 !== entry.sha256) {
				throw new Error(`${entry.url} gave ${got.bytes} bytes with SHA-256 ${got.sha256}, and ${SOURCES_LOCK} pins ${entry.bytes} bytes with ${entry.sha256}`);
			}
			const outcome = await store.create(key, path, entry);
			rmSync(path);
			check(store, key, entry, await store.read(key), outcome === "created" ? "after the upload" : "(it appeared during the download)");
			if (outcome === "created") {
				log(`${entry.file}: created ${store.name}/${key}, ${entry.bytes} bytes, and read it back: SHA-256 ${entry.sha256}`);
				published.push({ name: entry.name, key, action: "uploaded" });
			} else {
				log(`${entry.file}: ${store.name}/${key} appeared during the download, so nothing was written; it holds the bytes the lock pins`);
				published.push({ name: entry.name, key, action: "appeared" });
			}
		}
	} finally {
		if (run !== null) rmSync(run, { recursive: true, force: true });
	}
	return published;
}

/** The last line of the script's output: whether every source package of the lock is in the store with the right bytes. */
export function verdict(lock: SourcesLock, storeName: string, results: Published[] | null): string {
	const total = lock.sources.length;
	if (results === null) {
		return `NOT VERIFIED: the script stopped (above), so it is not shown that every source package of ${SOURCES_LOCK} is in ${storeName} with the bytes the lock pins.`;
	}
	const missing = results.filter((result) => result.action === "would upload").length;
	if (missing > 0) {
		return `NOT YET: ${total - missing} of the ${total} source packages of ${SOURCES_LOCK} are in ${storeName}, ${missing} not (dry run: nothing was uploaded).`;
	}
	return `VERIFIED: every source package of ${SOURCES_LOCK} (${total} of ${total}) is in ${storeName}, read back whole with the size and SHA-256 the lock pins.`;
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
	const storeName = values.bucket !== undefined ? `s3://${values.bucket}` : (values.directory as string);
	let lock: SourcesLock;
	try {
		lock = readSourcesLock(readFileSync(lockPath, "utf8"));
	} catch (error) {
		console.error(`publish-third-party-source: ${(error as Error).message}`);
		process.exit(1);
	}
	let results: Published[] | null = null;
	try {
		const store = values.bucket !== undefined ? new S3BlobStore(values.bucket, values.region ?? RUNS_BUCKET_REGION) : new DirectoryBlobStore(values.directory as string);
		results = await publishSources(lock, store, { fetcher: fetch, work: values.work, dryRun: values["dry-run"], log: (line) => console.log(line) });
	} catch (error) {
		console.error(`publish-third-party-source: ${(error as Error).message}`);
	}
	console.log(verdict(lock, storeName, results));
	process.exit(results === null ? 1 : 0);
}
