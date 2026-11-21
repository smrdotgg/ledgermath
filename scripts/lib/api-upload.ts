/**
 * The data API's tree, checked, into the API bucket (infra/runs/api-bucket.ts,
 * ADR-0031), and back out again to check it:
 *
 *   - readTree: every file of a tree scripts/build-api.ts wrote, with its key
 *     (its path, which is where it is served), its SHA-256, and the headers
 *     its object carries (treeObject), refusing a file of no known kind;
 *   - uploadTree: first lists the whole bucket, and writes nothing at all if
 *     it holds a key the tree does not (UnexpectedKeys: the upload never
 *     deletes, so a person decides, README "The API bucket"); then writes only
 *     what differs from the bucket, by content hash and by headers, read with
 *     one HEAD per file (S3 gives back the SHA-256 it verified when the object
 *     was written), in UPLOAD_PHASES' order, each phase whole before the next
 *     starts, so no file a reader can reach links down to one that is not
 *     there yet; and stops at a failed write, naming its phase and key
 *     (UploadStopped), starting no later phase. Every object it writes
 *     records the run that wrote it, and it refuses a bucket that a later run
 *     wrote to (OlderTree); and when it succeeds, the table of contents
 *     records its run even if nothing else changed (STAMP_KEY);
 *   - checkBucket: the whole bucket holds exactly the tree's files, each with
 *     the tree's SHA-256 and the headers treeObject gives it, and, given the
 *     run that uploaded it, the table of contents records that run;
 *   - S3ApiStore.lastWritten: when an object was last written, by S3's own
 *     clock, and the run it records: what the alarm reads of the table of
 *     contents to tell whether publishing has stopped
 *     (scripts/lib/api-freshness.ts).
 *
 * A month file changes in place, at the same key: when an upload stops after
 * the month files and before the Series files, a Series file still lists the
 * month's previous sha256 while the month's address gives the new bytes, and
 * no cache expiry repairs it. The next upload that runs does, by itself: the
 * month files are then the bucket's already, and only the Series files, the
 * list and the table of contents are written. Readers check a month file
 * against the sha256 its Series file lists (README, "The data API").
 *
 * Requests are signed here with SigV4 (scripts/lib/sigv4.ts), path-style, as
 * scripts/lib/s3-create.ts signs its own, because Bun's S3 client can neither
 * send Cache-Control or a SHA-256 checksum nor read them back. A PUT sends
 * the body's SHA-256 twice: signed (x-amz-content-sha256), so S3 refuses
 * other bytes, and as x-amz-checksum-sha256, which S3 also verifies and then
 * keeps with the object; a HEAD with x-amz-checksum-mode: ENABLED returns it.
 * The listing goes through Bun's client (scripts/lib/bucket.ts).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { TREE_PREFIX, treeObject, UPLOAD_PHASES } from "../../infra/runs/api-bucket";
import { S3Bucket } from "./bucket";
import { credentialsFromEnvironment, type Fetch, hasDotSegment, type S3Credentials } from "./s3-create";
import { amzDate, encodeUriPath, sha256Hex, signV4 } from "./sigv4";

export interface TreeFile {
	/** Its path in the tree, which is its key in the bucket and its address under the host. */
	key: string;
	bytes: Uint8Array;
	/** Hex. */
	sha256: string;
	kind: string;
	phase: number;
	contentType: string;
	cacheControl: string;
}

/** Every file of the tree in `directory` (which holds v1/), in key order. Throws for anything that is not a file of a known kind. */
export function readTree(directory: string): TreeFile[] {
	const files: TreeFile[] = [];
	for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name);
		if (entry.isDirectory()) continue;
		const key = relative(directory, path).split(sep).join("/");
		if (!entry.isFile()) throw new Error(`${path}: not a plain file (a link?); the tree holds files only`);
		if (!key.startsWith(TREE_PREFIX)) throw new Error(`${key}: outside ${TREE_PREFIX}, so not a file of the data API's tree`);
		const bytes = new Uint8Array(readFileSync(path));
		const object = treeObject(key);
		files.push({ key, bytes, sha256: sha256Hex(bytes), ...object });
	}
	if (files.length === 0) throw new Error(`${directory} holds no file: not a tree scripts/build-api.ts wrote`);
	return files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** What a HEAD of an object says, or null when there is no such key. */
export interface StoredObject {
	size: number;
	/** Hex; null when S3 holds no SHA-256 for it (written without one). */
	sha256: string | null;
	contentType: string | null;
	cacheControl: string | null;
	/** The workflow run whose upload wrote it (RUN_METADATA); null when it carries none. */
	run: number | null;
}

/**
 * The object metadata every write carries: the id of the GitHub Actions run
 * whose upload wrote it. Run ids grow with time, and a run run again keeps its
 * id, so the largest id in the bucket names the latest run that wrote to it:
 * an upload from an earlier run is refused (OlderTree).
 */
export const RUN_METADATA = "x-amz-meta-ledgermath-run";

/**
 * The object on which every upload that succeeds leaves its run, even when it
 * had nothing else to write: the table of contents, a key every tree has. When
 * the upload did not rewrite it, its last act is to write it again, the same
 * bytes and headers, with this run in RUN_METADATA (the stamp). Without it, a
 * run that published a tree identical to the bucket's would leave no trace,
 * and a retry of an earlier run, its tree older, would not be refused.
 */
export const STAMP_KEY = `${TREE_PREFIX}index.json`;

/** A run id as GitHub gives it, or what an upload by hand passes: a positive whole number. */
export function parseRun(value: string | null | undefined): number | null {
	if (value === null || value === undefined || !/^[1-9][0-9]*$/.test(value)) return null;
	const run = Number(value);
	return Number.isSafeInteger(run) ? run : null;
}

/** When an object was last written, by S3's own clock, and the run its metadata records. */
export interface WrittenAt {
	/** Its Last-Modified: set by S3 as the object is written, never by the writer. */
	lastModified: Date;
	/** The run its RUN_METADATA records; null when it records none. */
	run: number | null;
}

/**
 * S3 gave an answer other than the one asked for, or none: its HTTP status
 * (null when no answer came) and S3's error code, or one of ours, NoAnswer
 * or NoCredentials, in its place.
 */
export class S3Refused extends Error {
	constructor(
		readonly status: number | null,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "S3Refused";
	}
}

/** The API bucket, as the upload and the check see it. */
export interface ApiStore {
	readonly name: string;
	head(key: string): Promise<StoredObject | null>;
	/** Writes the file, recording `run` as the run that wrote it. */
	put(file: TreeFile, run: number): Promise<void>;
	/** Every key under the prefix. */
	list(prefix: string): Promise<string[]>;
}

export interface S3ApiStoreOptions {
	/** The keys to use, asked for before every request; without it, the environment's. */
	credentials?: () => S3Credentials;
	/** Another endpoint than AWS's: a stand-in for S3 in the tests. */
	endpoint?: string;
	fetcher?: Fetch;
	now?: () => Date;
}

/** The SHA-256 of nothing, for the signed requests without a body. */
const EMPTY_SHA256 = sha256Hex(new Uint8Array());

function xmlElement(body: string, name: string): string | null {
	return new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? null;
}

/** A hex SHA-256 as S3's x-amz-checksum-sha256 carries it, in base64; and back. */
export function checksumHeader(hex: string): string {
	return Buffer.from(hex, "hex").toString("base64");
}
export function checksumHex(header: string): string | null {
	const bytes = Buffer.from(header, "base64");
	return bytes.length === 32 && bytes.toString("base64") === header ? bytes.toString("hex") : null;
}

export class S3ApiStore implements ApiStore {
	readonly name: string;
	private readonly endpoint: string;

	constructor(
		private readonly bucket: string,
		private readonly region: string,
		private readonly options: S3ApiStoreOptions = {},
	) {
		this.name = `s3://${bucket}`;
		this.endpoint = (options.endpoint ?? `https://s3.${region}.amazonaws.com`).replace(/\/+$/, "");
	}

	private credentials(): S3Credentials {
		return this.options.credentials?.() ?? credentialsFromEnvironment();
	}

	private async send(method: "GET" | "HEAD" | "PUT", key: string, extra: Array<[string, string]>, payloadSha256: string, body?: Uint8Array): Promise<Response> {
		if (hasDotSegment(key)) throw new Error(`${key}: a key with a "." or ".." segment cannot be sent by name`);
		const canonicalUri = `/${encodeUriPath(this.bucket)}/${encodeUriPath(key)}`;
		const url = new URL(`${this.endpoint}${canonicalUri}`);
		const date = amzDate((this.options.now ?? (() => new Date()))());
		const credentials = this.credentials();
		const headers: Array<[string, string]> = [["host", url.host], ...extra, ["x-amz-content-sha256", payloadSha256], ["x-amz-date", date]];
		if (credentials.sessionToken) headers.push(["x-amz-security-token", credentials.sessionToken]);
		const signed = signV4({
			method,
			canonicalUri,
			canonicalQuery: "",
			headers,
			payloadSha256,
			amzDate: date,
			region: this.region,
			service: "s3",
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
		});
		const sent: Record<string, string> = Object.fromEntries(headers.filter(([name]) => name !== "host"));
		sent.authorization = signed.authorization;
		return (this.options.fetcher ?? fetch)(url, { method, headers: sent, ...(body === undefined ? {} : { body }) });
	}

	async head(key: string): Promise<StoredObject | null> {
		const response = await this.send("HEAD", key, [["x-amz-checksum-mode", "ENABLED"]], EMPTY_SHA256);
		await response.arrayBuffer().catch(() => undefined);
		if (response.status === 404) return null;
		if (response.status !== 200) {
			throw new Error(`HEAD ${this.name}/${key} answered ${response.status}${response.status === 403 ? " (the role may not read it: is API_BUCKET this stage's apiBucket output, and the stage deployed with it?)" : ""}`);
		}
		const length = Number(response.headers.get("content-length"));
		const checksum = response.headers.get("x-amz-checksum-sha256");
		return {
			size: Number.isSafeInteger(length) ? length : -1,
			sha256: checksum === null ? null : checksumHex(checksum),
			contentType: response.headers.get("content-type"),
			cacheControl: response.headers.get("cache-control"),
			run: parseRun(response.headers.get(RUN_METADATA)),
		};
	}

	/**
	 * When `key` was last written, and by which run: one GET. Not a HEAD,
	 * because a HEAD's 404 has no body, so a missing key and a missing bucket
	 * would look alike. Null when the bucket holds no such key (404 NoSuchKey,
	 * which S3 answers only to a requester that may list the bucket; to
	 * another it answers 403). Throws S3Refused for any other answer, or none.
	 */
	async lastWritten(key: string): Promise<WrittenAt | null> {
		try {
			this.credentials();
		} catch (error) {
			throw new S3Refused(null, "NoCredentials", error instanceof Error ? error.message : String(error));
		}
		let response: Response;
		try {
			response = await this.send("GET", key, [], EMPTY_SHA256);
		} catch (error) {
			throw new S3Refused(null, "NoAnswer", `GET ${this.name}/${key}: no answer (${error instanceof Error ? error.message : String(error)})`);
		}
		if (response.status === 200) {
			await response.arrayBuffer().catch(() => undefined);
			const header = response.headers.get("last-modified");
			const at = header === null ? Number.NaN : Date.parse(header);
			if (Number.isNaN(at)) throw new S3Refused(200, "NoLastModified", `GET ${this.name}/${key} answered 200 with no Last-Modified that is a date: ${JSON.stringify(header)}`);
			return { lastModified: new Date(at), run: parseRun(response.headers.get(RUN_METADATA)) };
		}
		const text = await response.text().catch(() => "");
		const code = xmlElement(text, "Code") ?? `HTTP${response.status}`;
		if (response.status === 404 && code === "NoSuchKey") return null;
		const said = xmlElement(text, "Message") ?? "";
		throw new S3Refused(response.status, code, `GET ${this.name}/${key} answered ${response.status} ${code}${said === "" ? "" : `: ${said}`}`);
	}

	async put(file: TreeFile, run: number): Promise<void> {
		if (parseRun(String(run)) === null) throw new Error(`${run} is not a run id: a positive whole number`);
		const response = await this.send(
			"PUT",
			file.key,
			[
				["cache-control", file.cacheControl],
				["content-type", file.contentType],
				["x-amz-checksum-sha256", checksumHeader(file.sha256)],
				[RUN_METADATA, String(run)],
			],
			file.sha256,
			file.bytes,
		);
		const text = await response.text().catch(() => "");
		if (response.status === 200) return;
		const code = xmlElement(text, "Code") ?? "no error code";
		const message = xmlElement(text, "Message") ?? "";
		throw new Error(`PUT ${this.name}/${file.key} answered ${response.status}, ${code}${message === "" ? "" : `: ${message}`}`);
	}

	async list(prefix: string): Promise<string[]> {
		const lister = new S3Bucket(this.bucket, this.region, {
			credentials: () => this.credentials(),
			...(this.options.endpoint === undefined ? {} : { endpoint: this.options.endpoint }),
		});
		return (await lister.list(prefix)).map((object) => object.key);
	}
}

/** Runs `work` on every item, at most `limit` at once; waits for all, then throws the first failure, if any. */
export async function inParallel<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const failures: unknown[] = [];
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const item = items[next++] as T;
			try {
				await work(item);
			} catch (error) {
				failures.push(error);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	if (failures.length > 0) throw failures[0];
}

/** Why a file must be written, or null when the bucket already holds it as it would be written. */
export function writeReason(file: TreeFile, stored: StoredObject | null): string | null {
	if (stored === null) return "new";
	if (stored.sha256 === null) return "no SHA-256 stored with the object";
	if (stored.sha256 !== file.sha256) return "content changed";
	if (stored.contentType !== file.contentType || stored.cacheControl !== file.cacheControl) return "headers changed";
	return null;
}

export interface PhaseReport {
	phase: string;
	written: string[];
	unchanged: number;
	/** In a preflight, what would be written; empty otherwise. */
	wouldWrite: string[];
}

export interface UploadReport {
	phases: PhaseReport[];
	/** Why each written file was written (or, in a preflight, would be). */
	reasons: Map<string, string>;
	/** The latest run that wrote anything the bucket holds of the tree, before this upload; null when none says. */
	newestRunBefore: number | null;
	/** Whether STAMP_KEY was written again, unchanged, only to record this run (or, in a preflight, would be). */
	stamped: boolean;
}

export interface UploadOptions {
	/** The id of the workflow run uploading (GITHUB_RUN_ID): recorded on every object written, and an upload from an earlier run than the bucket's newest is refused. */
	run: number;
	/** Check the bucket and say what would be written, and write nothing. */
	preflight?: boolean;
	/** Requests at once. */
	concurrency?: number;
	/** Told of each file as it is written, in order of completion. */
	onWrite?: (file: TreeFile) => void;
}

/**
 * The bucket holds an object written by a later run than this one: this
 * tree is older than what is published, and writing it would put older files
 * over newer. Nothing was written. It happens when an older run's publish
 * job is run again by hand after a newer run published.
 */
export class OlderTree extends Error {
	constructor(
		readonly bucket: string,
		readonly run: number,
		readonly newest: number,
		readonly key: string,
	) {
		super(`${bucket} holds ${key} as written by run ${newest}, later than this run, ${run}: this tree is older than what is published, so nothing was uploaded`);
		this.name = "OlderTree";
	}
}

/**
 * The bucket holds keys the tree does not have. Nothing was written: the
 * upload never deletes, and publishing a table of contents that no longer
 * lists a file the bucket still serves would leave the bucket unequal to the
 * tree for good, every later run failing the same way. A person decides
 * whether each key goes (README, "The API bucket", "A key the tree does not
 * have").
 */
export class UnexpectedKeys extends Error {
	constructor(
		readonly bucket: string,
		readonly keys: readonly string[],
	) {
		super(
			`${bucket} holds ${keys.length} key${keys.length === 1 ? "" : "s"} the tree does not have, so nothing was uploaded (the upload deletes nothing; README, "The API bucket", "A key the tree does not have"): ${keys.join(", ")}`,
		);
		this.name = "UnexpectedKeys";
	}
}

/**
 * A write failed. The phases before `phase` were written whole; in `phase`,
 * the writes that succeeded are `written`, the ones that failed `failed`; no
 * later phase was started. The bucket may now hold month files of this round
 * beside Series files of the round before, whose sha256 no longer match them:
 * the next upload that runs writes what is still missing and repairs it.
 */
export class UploadStopped extends Error {
	constructor(
		readonly bucket: string,
		readonly phase: number,
		readonly written: readonly string[],
		readonly failed: ReadonlyArray<{ key: string; error: string }>,
		readonly before: readonly PhaseReport[],
	) {
		const first = failed[0];
		super(
			`the upload to ${bucket} stopped in phase ${phase + 1} of ${UPLOAD_PHASES.length}, ${UPLOAD_PHASES[phase]}: ${failed.length} write${failed.length === 1 ? "" : "s"} failed` +
				`${first === undefined ? "" : `, the first ${first.key}: ${first.error}`}; ${written.length} of that phase written, no later phase started. ` +
				"Until the next upload succeeds, a Series file may list a month file's previous sha256 while its address gives the new bytes; the next run repairs it.",
		);
		this.name = "UploadStopped";
	}
}

/**
 * Every file of the tree is in the bucket, as written, but the stamp failed:
 * the bucket does not yet record that this run published, so a retry of an
 * earlier run's publish job would not be refused by it. The next upload that
 * succeeds records its own run.
 */
export class NotStamped extends Error {
	constructor(
		readonly bucket: string,
		readonly run: number,
		readonly reason: string,
		readonly phases: readonly PhaseReport[],
	) {
		super(`every file of the tree is in ${bucket}, but recording run ${run} on ${STAMP_KEY} failed: ${reason}. Until an upload succeeds, the bucket does not record that run ${run} published`);
		this.name = "NotStamped";
	}
}

/** The keys the bucket holds and the tree does not, in key order. */
export function unexpectedKeys(listed: readonly string[], files: readonly TreeFile[]): string[] {
	const expected = new Set(files.map((file) => file.key));
	return listed.filter((key) => !expected.has(key)).sort();
}

/**
 * Writes to the store the files of the tree that it does not hold as they
 * would be written: a phase at a time, in UPLOAD_PHASES' order, each phase
 * whole before the next begins. First, before any write or HEAD, it lists the
 * whole bucket and throws UnexpectedKeys, having written nothing, if the
 * bucket holds a key the tree does not. Then the HEADs: if any object was
 * written by a later run than options.run, it throws OlderTree, having
 * written nothing. With options.preflight it stops there, and says what it
 * would write. A failed write stops the upload once the writes of its phase
 * have settled, with UploadStopped, and no later phase starts. When every
 * phase is written, and STAMP_KEY was not rewritten and does not record this
 * run already, its last act is the stamp: STAMP_KEY written again, unchanged,
 * with this run (NotStamped if that fails). So the bucket's latest run is
 * this one after any upload that succeeds, whether or not a byte changed.
 * Never deletes.
 */
export async function uploadTree(store: ApiStore, files: readonly TreeFile[], options: UploadOptions): Promise<UploadReport> {
	const { run } = options;
	if (parseRun(String(run)) === null) throw new Error(`${run} is not a run id: a positive whole number (GITHUB_RUN_ID)`);
	const stampFile = files.find((file) => file.key === STAMP_KEY);
	if (stampFile === undefined) throw new Error(`the tree has no ${STAMP_KEY}, on which every upload records its run: not a tree scripts/build-api.ts wrote, so nothing was uploaded`);
	const concurrency = options.concurrency ?? 8;
	const extra = unexpectedKeys(await store.list(""), files);
	if (extra.length > 0) throw new UnexpectedKeys(store.name, extra);
	const reasons = new Map<string, string>();
	let newest: { run: number; key: string } | null = null;
	let stampRun: number | null = null;
	await inParallel(files, concurrency, async (file) => {
		const stored = await store.head(file.key);
		if (stored?.run != null && (newest === null || stored.run > newest.run)) newest = { run: stored.run, key: file.key };
		if (file.key === STAMP_KEY) stampRun = stored?.run ?? null;
		const reason = writeReason(file, stored);
		if (reason !== null) reasons.set(file.key, reason);
	});
	const latest = newest as { run: number; key: string } | null;
	if (latest !== null && latest.run > run) throw new OlderTree(store.name, run, latest.run, latest.key);
	// Written in its phase, it records this run already; otherwise the stamp does, unless it says this run (this run's retry).
	const stamp = !reasons.has(STAMP_KEY) && (stampRun as number | null) !== run;
	const phases: PhaseReport[] = [];
	for (const [index, phase] of UPLOAD_PHASES.entries()) {
		const ofPhase = files.filter((file) => file.phase === index);
		const toWrite = ofPhase.filter((file) => reasons.has(file.key));
		if (options.preflight === true) {
			phases.push({ phase, written: [], unchanged: ofPhase.length - toWrite.length, wouldWrite: toWrite.map((file) => file.key) });
			continue;
		}
		const written: string[] = [];
		const failed: Array<{ key: string; error: string }> = [];
		await inParallel(toWrite, concurrency, async (file) => {
			try {
				await store.put(file, run);
			} catch (error) {
				failed.push({ key: file.key, error: error instanceof Error ? error.message : String(error) });
				return;
			}
			written.push(file.key);
			options.onWrite?.(file);
		});
		if (failed.length > 0) throw new UploadStopped(store.name, index, written.sort(), failed.sort((a, b) => (a.key < b.key ? -1 : 1)), phases);
		phases.push({ phase, written: written.sort(), unchanged: ofPhase.length - toWrite.length, wouldWrite: [] });
	}
	if (stamp && options.preflight !== true) {
		try {
			await store.put(stampFile, run);
		} catch (error) {
			throw new NotStamped(store.name, run, error instanceof Error ? error.message : String(error), phases);
		}
	}
	return { phases, reasons, newestRunBefore: latest?.run ?? null, stamped: stamp };
}

/**
 * What differs between the whole store and the tree: a file missing, a key
 * the tree does not have (under v1/ or anywhere else), a SHA-256 other than
 * the file's, or headers other than treeObject gives. With options.run, the
 * run that just uploaded it, also: STAMP_KEY recording another run, or any
 * object a later one. Empty when the store holds the tree exactly.
 */
export async function checkBucket(store: ApiStore, files: readonly TreeFile[], options: { concurrency?: number; run?: number } = {}): Promise<string[]> {
	const problems: string[] = [];
	const listed = new Set(await store.list(""));
	const expected = new Set(files.map((file) => file.key));
	for (const key of [...listed].sort()) {
		if (!expected.has(key)) problems.push(`${store.name}/${key}: in the bucket, not in the tree (the upload deletes nothing: a person decides whether it goes)`);
	}
	await inParallel(files, options.concurrency ?? 8, async (file) => {
		if (!listed.has(file.key)) {
			problems.push(`${store.name}/${file.key}: in the tree, not in the bucket`);
			return;
		}
		const stored = await store.head(file.key);
		if (stored === null) {
			problems.push(`${store.name}/${file.key}: listed, but a HEAD finds no object`);
			return;
		}
		if (stored.sha256 !== file.sha256) problems.push(`${store.name}/${file.key}: SHA-256 ${stored.sha256 ?? "not stored"}, and the tree's is ${file.sha256}`);
		if (stored.size !== file.bytes.length) problems.push(`${store.name}/${file.key}: ${stored.size} bytes, and the tree's file has ${file.bytes.length}`);
		if (stored.contentType !== file.contentType) problems.push(`${store.name}/${file.key}: Content-Type ${JSON.stringify(stored.contentType)}, not ${JSON.stringify(file.contentType)}`);
		if (stored.cacheControl !== file.cacheControl) problems.push(`${store.name}/${file.key}: Cache-Control ${JSON.stringify(stored.cacheControl)}, not ${JSON.stringify(file.cacheControl)}`);
		const { run } = options;
		if (run === undefined) return;
		if (file.key === STAMP_KEY && stored.run !== run) problems.push(`${store.name}/${file.key}: records run ${stored.run ?? "none"}, not this run, ${run}, which uploaded the tree`);
		else if (stored.run !== null && stored.run > run) problems.push(`${store.name}/${file.key}: records run ${stored.run}, later than this run, ${run}`);
	});
	return problems.sort();
}
