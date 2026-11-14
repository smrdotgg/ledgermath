/**
 * Copies a -runs stage's bucket into another's, and checks the copy: what
 * scripts/copy-bucket.ts runs, from the development account's bucket to the
 * production account's for the move, and back for a rollback (README,
 * "Moving the schedule to the production account").
 *
 * What is copied: every object under blobs/, runs/, boots/ and logs/, the
 * current version of each key (a GET without a version). Not source/: each
 * stage's deploy puts its own source archive there, and every archive a Run
 * names is also a blob. A key with a "." or ".." segment cannot be requested
 * by its name (the URL resolves it away), so one stops the copy before
 * anything is written.
 *
 * The copy only ever adds:
 *
 *   - Everything at both ends is listed first, and every object already at
 *     the destination is read there and compared before anything is
 *     written: a blob's bytes there must hash to its key, the SHA-256 of the
 *     source's bytes (the source's copy is not read); any other object is
 *     read at both ends and compared byte for byte. One that differs stops
 *     the copy, and nothing is written.
 *   - Each object to copy is then looked at in the source (its size and ETag
 *     must still be the listed ones), read whole and checked: a blob's bytes
 *     must hash to its key; any other object's must have the MD5 its ETag
 *     gives, and when they do not (an ETag is the MD5 of the bytes only for
 *     an object written in one part with SSE-S3 or no encryption, which the
 *     copy cannot tell), it is read a second time and the two reads must be
 *     the same. It is written in one PUT with If-None-Match: * and the
 *     source's Content-Type (scripts/lib/s3-create.ts), so S3 writes it only
 *     if the key does not exist: nothing is ever replaced. When S3 answers
 *     that the key exists (412) or is being written (409), the destination's
 *     object is read and compared with the bytes read from the source: the
 *     same counts as already there, other bytes stop the copy. A written
 *     object is then looked at: its size and type must be what was written,
 *     and its bytes the ones sent (by its ETag when that is their MD5, else
 *     read back).
 *   - Any problem stops the copy: no object is started after it, those being
 *     written finish. The report counts as written every object whose PUT S3
 *     acknowledged, whatever was found after; names every key a PUT went for
 *     without an answer that says whether it was written, unless a later PUT
 *     S3 acknowledged, or a comparison with the destination, settled it (a
 *     later refusal does not: the earlier PUT may have written it); and says
 *     "wrote nothing" only when no PUT was sent. Run again, it carries on from
 *     where it was: what is at the destination is compared, not copied. A
 *     second complete run copies nothing.
 *
 * The order keeps the destination as a box keeps a bucket: no Run file
 * before its blobs. Listed logs/, boots/, runs/, then blobs/ (the reverse of
 * a box's uploads, so every blob a listed Run names is listed too); copied
 * blobs/, then runs/, boots/ and logs/, each prefix only once the one before
 * it is done.
 *
 * Memory: at most `concurrency` objects are in flight, and at most
 * `memoryBytes` of their bytes are counted as held at once, each object being
 * counted twice when two copies of it may be held (its bytes and a second
 * read to compare with them; a blob already at the destination, read there
 * alone, once); an object counted at more than that is held alone. So what is
 * counted never exceeds the larger of memoryBytes and twice the largest
 * object. It is a count of the objects' bytes, not of the process's memory.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { type BucketObject, describeS3Error, md5Of, type WritableBucket } from "./bucket";
import { CreateRefused, hasDotSegment } from "./s3-create";

/** Copied in this order. */
export const COPIED_PREFIXES = ["blobs/", "runs/", "boots/", "logs/"] as const;
export type CopiedPrefix = (typeof COPIED_PREFIXES)[number];

/** Listed in this order: the reverse of a box's uploads. */
const LIST_ORDER: readonly CopiedPrefix[] = ["logs/", "boots/", "runs/", "blobs/"];

const BLOB_KEY = /^blobs\/sha256\/([0-9a-f]{64})$/;

export interface Tally {
	count: number;
	bytes: number;
}

const tally = (objects: readonly { size: number }[]): Tally => ({ count: objects.length, bytes: objects.reduce((sum, object) => sum + object.size, 0) });
const add = (into: Tally, size: number): void => {
	into.count += 1;
	into.bytes += size;
};

export interface CopyReport {
	dryRun: boolean;
	/** What the source holds under each prefix. */
	listed: Record<CopiedPrefix, Tally>;
	/**
	 * At the destination already, read there and found the same: a blob,
	 * whose bytes there hash to its key; any other object, whose bytes there
	 * equal the source's.
	 */
	same: Tally;
	/** Written: every object whose PUT S3 acknowledged. In a dry run, what would be written. */
	copied: Tally;
	/** PUTs sent, answered or not. */
	putsSent: number;
	/**
	 * Keys a PUT was sent for without an answer that says whether S3 wrote it
	 * (no answer, or a 5xx), and that nothing settled since (a PUT S3
	 * acknowledged, or a comparison with the object at the destination): they
	 * may be at the destination, or not.
	 */
	unknown: string[];
	/** The most bytes of objects counted as held at once (each object twice when a second copy of it may be read). */
	peakBytesHeld: number;
}

/** What a report says was written, for the message of a stopped copy. */
export function writtenSummary(report: CopyReport): string {
	if (report.putsSent === 0) return "wrote nothing";
	const unknown = report.unknown.length === 0 ? "" : `; whether ${report.unknown.length} more ${report.unknown.length === 1 ? "was" : "were"} written is not known: ${report.unknown.join(", ")}`;
	return `had written ${report.copied.count} objects (${report.copied.bytes} bytes), replacing none${unknown}`;
}

export class CopyStopped extends Error {
	constructor(
		readonly problems: string[],
		readonly report: CopyReport,
	) {
		super(
			[`the copy stopped and ${writtenSummary(report)}: ${problems.length} problem${problems.length === 1 ? "" : "s"}`, ...problems.map((problem) => `  ${problem}`)].join("\n"),
		);
		this.name = "CopyStopped";
	}
}

export interface CopyOptions {
	dryRun?: boolean;
	/** Objects in flight at once; 16 by default. */
	concurrency?: number;
	/** Bytes of objects held at once; 256 MiB by default. */
	memoryBytes?: number;
	/** Waits before each retry of a request that failed; 1 s and 4 s by default. */
	retryDelaysMs?: readonly number[];
	/** Called with lines of progress. */
	progress?: (line: string) => void;
}

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
const DEFAULT_RETRY_DELAYS_MS = [1000, 4000] as const;

/** Counts bytes held, letting an object in only when it fits; one larger than the limit waits to be alone. */
class ByteBudget {
	private reserved = 0;
	private held = 0;
	peak = 0;
	private readonly queue: Array<{ reserve: number; size: number; grant: () => void }> = [];

	constructor(private readonly limit: number) {}

	async take(size: number): Promise<void> {
		await new Promise<void>((grant) => {
			this.queue.push({ reserve: Math.min(size, this.limit), size, grant });
			this.pump();
		});
	}

	give(size: number): void {
		this.reserved -= Math.min(size, this.limit);
		this.held -= size;
		this.pump();
	}

	private pump(): void {
		while (this.queue.length > 0) {
			const next = this.queue[0] as { reserve: number; size: number; grant: () => void };
			if (this.reserved + next.reserve > this.limit) return;
			this.queue.shift();
			this.reserved += next.reserve;
			this.held += next.size;
			this.peak = Math.max(this.peak, this.held);
			next.grant();
		}
	}
}

/** Runs work over items, at most `concurrency` at once, starting no new item once stop() is true. */
async function inPool<T>(items: readonly T[], concurrency: number, stop: () => boolean, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length && !stop()) {
			const item = items[next++] as T;
			await work(item);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A difference found while writing: not worth a retry. */
class Fatal extends Error {}

/** A request, tried again after each delay when it throws, unless what it threw is Fatal. */
async function attempt<T>(what: string, delays: readonly number[], request: () => Promise<T>): Promise<T> {
	for (let tries = 0; ; tries++) {
		try {
			return await request();
		} catch (error) {
			if (error instanceof Fatal) throw error;
			if (tries >= delays.length) throw new Error(`${what}: ${describeS3Error(error)} (tried ${tries + 1} times)`);
			await sleep(delays[tries] as number);
		}
	}
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);

function byKey(objects: readonly BucketObject[]): Map<string, BucketObject> {
	return new Map(objects.map((object) => [object.key, object]));
}

async function listAll(bucket: WritableBucket, delays: readonly number[]): Promise<Map<CopiedPrefix, BucketObject[]>> {
	const listed = new Map<CopiedPrefix, BucketObject[]>();
	for (const prefix of LIST_ORDER) listed.set(prefix, await attempt(`listing ${bucket.name}/${prefix}`, delays, () => bucket.list(prefix)));
	return listed;
}

/** Why a listed key cannot be copied by its name, or null. */
function unrequestable(key: string): string | null {
	return hasDotSegment(key) ? `${key}: has a "." or ".." segment, which a request's URL resolves away, so it cannot be read or written by its name; copy it by hand` : null;
}

/**
 * Whether an object the destination already holds is the source's: null when
 * it is, else the difference. A blob is read at the destination only, and its
 * bytes there must hash to its key; any other object is read at both ends and
 * compared byte for byte.
 */
async function difference(
	source: WritableBucket,
	destination: WritableBucket,
	key: string,
	sourceSize: number,
	destinationSize: number,
	delays: readonly number[],
): Promise<string | null> {
	if (sourceSize !== destinationSize) return `${key}: ${destinationSize} bytes at the destination, ${sourceSize} at the source`;
	const blob = BLOB_KEY.exec(key)?.[1];
	if (blob !== undefined) {
		const theirs = await attempt(`reading ${destination.name}/${key}`, delays, () => destination.get(key));
		if (theirs === null) return `${key}: gone from the destination when read to compare`;
		return sha256Hex(theirs) === blob ? null : `${key}: the destination's bytes do not hash to its key`;
	}
	const [ours, theirs] = await Promise.all([
		attempt(`reading ${source.name}/${key}`, delays, () => source.get(key)),
		attempt(`reading ${destination.name}/${key}`, delays, () => destination.get(key)),
	]);
	if (ours === null) return `${key}: gone from the source when read to compare`;
	if (theirs === null) return `${key}: gone from the destination when read to compare`;
	return sameBytes(ours, theirs) ? null : `${key}: the destination's bytes differ from the source's`;
}

/**
 * A source object's bytes, read whole and checked: as many as listed; a
 * blob's must hash to its key; any other object's must have the MD5 its ETag
 * gives, or else be read again with the same bytes (the ETag of an object
 * written in parts, or encrypted with SSE-KMS or SSE-C, is not an MD5).
 */
async function readSource(source: WritableBucket, object: BucketObject, delays: readonly number[]): Promise<Uint8Array> {
	const read = async (): Promise<Uint8Array> => {
		const bytes = await attempt(`reading ${source.name}/${object.key}`, delays, () => source.get(object.key));
		if (bytes === null) throw new Error(`${object.key}: gone from the source since it was listed`);
		if (bytes.length !== object.size) throw new Error(`${object.key}: read ${bytes.length} bytes, but the source lists ${object.size}`);
		return bytes;
	};
	const bytes = await read();
	const blob = BLOB_KEY.exec(object.key)?.[1];
	if (blob !== undefined) {
		const actual = sha256Hex(bytes);
		if (actual !== blob) throw new Error(`${object.key}: its bytes hash to ${actual}, not to its key`);
		return bytes;
	}
	if (object.etag !== null && md5Of(bytes) === object.etag) return bytes;
	if (!sameBytes(await read(), bytes)) throw new Error(`${object.key}: two reads of the source gave different bytes (and its ETag is not the MD5 of either)`);
	return bytes;
}

export async function copyBucket(source: WritableBucket, destination: WritableBucket, options: CopyOptions = {}): Promise<CopyReport> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	const progress = options.progress ?? (() => {});
	const budget = new ByteBudget(options.memoryBytes ?? DEFAULT_MEMORY_BYTES);

	const sourceListed = await listAll(source, delays);
	const destinationListed = await listAll(destination, delays);
	const report: CopyReport = {
		dryRun: options.dryRun ?? false,
		listed: Object.fromEntries(COPIED_PREFIXES.map((prefix) => [prefix, tally(sourceListed.get(prefix) ?? [])])) as Record<CopiedPrefix, Tally>,
		same: { count: 0, bytes: 0 },
		copied: { count: 0, bytes: 0 },
		putsSent: 0,
		unknown: [],
		peakBytesHeld: 0,
	};
	const stop = (problems: string[]): never => {
		report.peakBytesHeld = budget.peak;
		throw new CopyStopped(problems, report);
	};

	// Every key under blobs/ must be a blob's, so its key can stand for its
	// bytes; every key must be one a request can name.
	const sourceAll = COPIED_PREFIXES.flatMap((prefix) => sourceListed.get(prefix) ?? []);
	const refused = [
		...(sourceListed.get("blobs/") ?? [])
			.filter((object) => !BLOB_KEY.test(object.key))
			.map((object) => `${object.key}: under blobs/ but not named blobs/sha256/<hex>, so it cannot be checked by its hash`),
		...sourceAll.map((object) => unrequestable(object.key)).filter((why): why is string => why !== null),
	];
	if (refused.length > 0) stop(refused);

	// What the destination already holds is compared before anything is written.
	const problems: string[] = [];
	const toCopy = new Map<CopiedPrefix, BucketObject[]>();
	const held: Array<{ object: BucketObject; there: BucketObject }> = [];
	for (const prefix of COPIED_PREFIXES) {
		const there = byKey(destinationListed.get(prefix) ?? []);
		const missing: BucketObject[] = [];
		for (const object of sourceListed.get(prefix) ?? []) {
			const found = there.get(object.key);
			if (found === undefined) missing.push(object);
			else held.push({ object, there: found });
		}
		toCopy.set(prefix, missing);
	}
	await inPool(held, concurrency, () => false, async ({ object, there }) => {
		const size = BLOB_KEY.test(object.key) ? object.size : 2 * object.size;
		await budget.take(size);
		try {
			const differs = await difference(source, destination, object.key, object.size, there.size, delays);
			if (differs === null) add(report.same, object.size);
			else problems.push(differs);
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		} finally {
			budget.give(size);
		}
	});
	if (problems.length > 0) stop(problems.sort());
	progress(`${report.same.count} objects (${report.same.bytes} bytes) already at the destination, read there and the same`);

	if (report.dryRun) {
		for (const prefix of COPIED_PREFIXES) for (const object of toCopy.get(prefix) ?? []) add(report.copied, object.size);
		report.peakBytesHeld = budget.peak;
		return report;
	}

	let stopping = false;
	const copyOne = async (object: BucketObject): Promise<void> => {
		// Its bytes, and at times a second copy to compare them with: a second read
		// of the source, the destination's object after a 412, or a read back.
		const counted = 2 * object.size;
		await budget.take(counted);
		let sent = false;
		// Whether a PUT of this key may have written it, with nothing since that
		// says whether it did: from the first PUT without such an answer (none
		// came, or a 5xx) until a PUT S3 acknowledges, or the object at the
		// destination is read and compared. A later refusal (a 403, say) settles
		// nothing: the earlier PUT may have written the object all the same.
		let unsettled = false;
		try {
			const head = await attempt(`looking at ${source.name}/${object.key}`, delays, () => source.head(object.key));
			if (head === null) throw new Error(`${object.key}: gone from the source since it was listed`);
			if (head.size !== object.size) throw new Error(`${object.key}: ${head.size} bytes at the source now, ${object.size} when listed`);
			if (head.etag !== object.etag) throw new Error(`${object.key}: changed at the source since it was listed (its ETag is not the listed one)`);
			const bytes = await readSource(source, object, delays);

			// A PUT that only creates. Tried again when it fails; one whose answer
			// was lost is refused the second time (412) and found the same.
			const outcome = await attempt(`writing ${destination.name}/${object.key}`, delays, async () => {
				if (stopping && !sent) return "skipped" as const;
				sent = true;
				report.putsSent += 1;
				let answer: Awaited<ReturnType<WritableBucket["create"]>>;
				try {
					answer = await destination.create(object.key, bytes, head.contentType);
				} catch (error) {
					if (!(error instanceof CreateRefused && error.status < 500)) unsettled = true;
					throw error;
				}
				if (answer === "created") {
					unsettled = false;
					return "written" as const;
				}
				const theirs = await destination.get(object.key);
				if (theirs === null) throw new Error(`S3 answered ${answer === "exists" ? "412, the key exists" : "409, a write is in progress"}, and there is no object to read yet`);
				// Compared: the object there is the source's, or another's that no PUT of ours wrote.
				unsettled = false;
				if (sameBytes(theirs, bytes)) return "same" as const;
				throw new Fatal(`${object.key}: appeared at the destination while it was being copied, with other bytes than the source's; it was not replaced`);
			});
			if (outcome === "same") add(report.same, object.size);
			if (outcome !== "written") return;
			add(report.copied, object.size);
			if (report.copied.count % 1000 === 0) progress(`${report.copied.count} objects (${report.copied.bytes} bytes) copied`);

			const written = await attempt(`looking at ${destination.name}/${object.key} after writing it`, delays, () => destination.head(object.key));
			if (written === null) throw new Error(`${object.key}: written (S3 acknowledged it), but not at the destination when looked at`);
			const wrong: string[] = [];
			if (written.size !== object.size) wrong.push(`${written.size} bytes, not ${object.size}`);
			if (written.contentType !== head.contentType) wrong.push(`Content-Type ${JSON.stringify(written.contentType)}, not ${JSON.stringify(head.contentType)}`);
			if (written.etag === null || written.etag !== md5Of(bytes)) {
				const back = await attempt(`reading ${destination.name}/${object.key} back`, delays, () => destination.get(object.key));
				if (back === null || !sameBytes(back, bytes)) wrong.push("other bytes than were sent");
			}
			if (wrong.length > 0) throw new Error(`${object.key}: written (S3 acknowledged it), but the destination's object has ${wrong.join(", ")}`);
		} catch (error) {
			stopping = true;
			if (unsettled) report.unknown.push(object.key);
			problems.push(error instanceof Error ? error.message : String(error));
		} finally {
			budget.give(counted);
		}
	};

	for (const prefix of COPIED_PREFIXES) {
		const objects = toCopy.get(prefix) ?? [];
		await inPool(objects, concurrency, () => stopping, copyOne);
		if (stopping) break;
		progress(`${prefix} done: ${objects.length} objects to copy, ${report.copied.count} copied so far`);
	}
	report.peakBytesHeld = budget.peak;
	report.unknown.sort();
	if (problems.length > 0) stop(problems);
	return report;
}

// ---------------------------------------------------------------- verify

export interface VerifyOptions {
	/** A checkout of the Runs repository: its runs/ and boots/ must be at the destination, byte for byte. */
	runsRepository: string;
	/**
	 * Where the destination's blobs/, runs/ and boots/ are written as they are
	 * compared, for scripts/check-runs.ts to check; null to leave that out (the
	 * verification is then incomplete, and says so).
	 */
	checkDirectory: string | null;
	/**
	 * Where the source's blobs/, runs/ and boots/ are written as they are
	 * compared (only with a checkDirectory). When check-runs.ts fails on the
	 * destination's, and the copy has no other problem, it is run on these
	 * too, and its failing on the destination is no problem as long as every
	 * file it fails on there it also fails on here: a Run kept as it was
	 * recorded, which does not validate at either end. Null or absent:
	 * check-runs.ts must pass on the destination's.
	 */
	sourceCheckDirectory?: string | null;
	concurrency?: number;
	memoryBytes?: number;
	retryDelaysMs?: readonly number[];
	progress?: (line: string) => void;
	/** Runs scripts/check-runs.ts on a directory (checkRunsScript). */
	checkRuns?: (directory: string) => CheckRunsOutcome;
}

/** What scripts/check-runs.ts said of a directory. */
export interface CheckRunsOutcome {
	status: number | null;
	output: string;
	/** What it wrote with --result: how many Run files it read, and the files its problems are about. Null when it wrote nothing. */
	result: { runs: number; failing: string[] } | null;
}

export interface VerifyReport {
	/** Source objects found at the destination with the same bytes. */
	same: Tally;
	/** Objects only at the destination: its own deploy's, or boxes' since the cutover. */
	onlyAtDestination: number;
	/** Files of the Runs repository found at the destination with the same bytes. */
	repositoryFiles: number;
	/** scripts/check-runs.ts's verdict on the copy of the destination: null when it was not run. */
	checkRuns: { passed: boolean; output: string } | null;
	/** Its verdict on the copy of the source (sourceCheckDirectory), run when it failed on the destination's: null when it was not run. */
	sourceCheckRuns: { passed: boolean; output: string } | null;
	/**
	 * The files check-runs.ts failed on in the destination's objects when each
	 * of them is one it failed on in the source's too, so that its failing is
	 * no problem; empty otherwise.
	 */
	failingAsAtSource: string[];
	problems: string[];
}

/** Runs scripts/check-runs.ts as its own process, with `args` before the directory, and reads what it wrote with --result. */
export function checkRunsScript(directory: string, args: readonly string[] = []): CheckRunsOutcome {
	const script = resolve(import.meta.dir, "..", "check-runs.ts");
	const scratch = mkdtempSync(join(tmpdir(), "check-runs-result-"));
	try {
		const resultFile = join(scratch, "result.json");
		const done = spawnSync(process.execPath, [script, ...args, "--result", resultFile, directory], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
		const result = existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, "utf8")) as { runs: number; failing: string[] }) : null;
		return { status: done.status, output: `${done.stdout ?? ""}${done.stderr ?? ""}`, result };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Refuses a path that is not a checkout of the Runs repository: one without a
 * runs/ and a boots/ directory of its own (a typo, say) would otherwise be
 * read as a repository with no files, and nothing of it compared.
 */
function checkRunsRepository(root: string): void {
	for (const part of ["runs", "boots"]) {
		const found = lstatSync(join(root, part), { throwIfNoEntry: false });
		if (found === undefined || !found.isDirectory()) {
			throw new Error(`${root}: has no ${part}/ directory, so it is not a checkout of the Runs repository (--runs-repository)`);
		}
	}
}

/** Every file under part/ of a checkout of the Runs repository, as keys with forward slashes; a symbolic link anywhere is refused. */
function filesUnder(root: string, part: string): string[] {
	const directory = join(root, part);
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => {
			if (entry.isSymbolicLink()) throw new Error(`${join(entry.parentPath, entry.name)} is a symbolic link; the verification reads through none`);
			return entry.isFile();
		})
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

/** Refuses a directory to write objects into unless it is empty or does not exist; then makes it. */
function emptyDirectory(directory: string, holds: string): void {
	if (existsSync(directory) && (!lstatSync(directory).isDirectory() || readdirSync(directory).length > 0)) {
		throw new Error(`${directory}: must be an empty directory, or not exist, so that it holds ${holds} and nothing else`);
	}
	mkdirSync(directory, { recursive: true });
}

const within = (inner: string, outer: string): boolean => resolve(inner) === resolve(outer) || resolve(inner).startsWith(`${resolve(outer)}${sep}`);

function writeInto(directory: string, key: string, bytes: Uint8Array): void {
	const path = join(directory, ...key.split("/"));
	if (!resolve(path).startsWith(`${resolve(directory)}${sep}`)) throw new Error(`${key}: would be written outside ${directory}`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, bytes);
	renameSync(`${path}.tmp`, path);
}

/**
 * Checks a copy, reading only: every object of the source under the copied
 * prefixes is at the destination with the same bytes (both read and compared;
 * a blob's bytes, at both ends, must hash to its key); every Run file and boot
 * summary in the Runs repository is at the destination with the same bytes;
 * and scripts/check-runs.ts passes on the destination's blobs/, runs/ and
 * boots/, written into checkDirectory. With a sourceCheckDirectory, the
 * source's are written there too, and check-runs.ts may fail on the
 * destination's as long as the copy has no other problem and every file it
 * fails on there, it fails on in the source's as well. A Runs repository
 * without runs/ and boots/ is refused before anything is read, and a key with
 * a "." or ".." segment, which cannot be read by its name, is a problem.
 */
export async function verifyCopy(source: WritableBucket, destination: WritableBucket, options: VerifyOptions): Promise<VerifyReport> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	const progress = options.progress ?? (() => {});
	const budget = new ByteBudget(options.memoryBytes ?? DEFAULT_MEMORY_BYTES);
	const report: VerifyReport = {
		same: { count: 0, bytes: 0 },
		onlyAtDestination: 0,
		repositoryFiles: 0,
		checkRuns: null,
		sourceCheckRuns: null,
		failingAsAtSource: [],
		problems: [],
	};
	const problems = report.problems;
	const checkDirectory = options.checkDirectory;
	const sourceCheckDirectory = options.sourceCheckDirectory ?? null;
	checkRunsRepository(options.runsRepository);
	if (sourceCheckDirectory !== null) {
		if (checkDirectory === null) throw new Error("a directory for the source's objects needs one for the destination's (--source-check-dir needs --check-dir)");
		if (within(sourceCheckDirectory, checkDirectory) || within(checkDirectory, sourceCheckDirectory)) {
			throw new Error(`${sourceCheckDirectory} and ${checkDirectory}: the source's objects and the destination's need two directories, neither inside the other`);
		}
	}
	if (checkDirectory !== null) emptyDirectory(checkDirectory, "the destination's objects");
	if (sourceCheckDirectory !== null) emptyDirectory(sourceCheckDirectory, "the source's objects");

	const sourceListed = await listAll(source, delays);
	const destinationListed = await listAll(destination, delays);
	// A key a request cannot name is reported, and left out of what is read.
	const requestable = (objects: BucketObject[], where: string): BucketObject[] =>
		objects.filter((object) => {
			const why = unrequestable(object.key);
			if (why !== null) problems.push(`${why} (${where})`);
			return why === null;
		});
	for (const [prefix, objects] of sourceListed) sourceListed.set(prefix, requestable(objects, "in the source"));
	for (const [prefix, objects] of destinationListed) destinationListed.set(prefix, requestable(objects, "at the destination"));
	const sourceKeys = new Set([...sourceListed.values()].flat().map((object) => object.key));
	const destinationAll = [...destinationListed.values()].flat();
	const destinationByKey = byKey(destinationAll);
	report.onlyAtDestination = destinationAll.filter((object) => !sourceKeys.has(object.key)).length;

	const keep = (key: string): boolean => checkDirectory !== null && !key.startsWith("logs/");
	const compareOne = async (object: BucketObject): Promise<void> => {
		const there = destinationByKey.get(object.key);
		if (there === undefined) {
			if (sourceKeys.has(object.key)) problems.push(`${object.key}: in the source, not at the destination`);
			return;
		}
		const inSource = sourceKeys.has(object.key);
		const size = inSource ? 2 * object.size : object.size;
		await budget.take(size);
		try {
			const theirs = await attempt(`reading ${destination.name}/${object.key}`, delays, () => destination.get(object.key));
			if (theirs === null) return void problems.push(`${object.key}: listed at the destination, gone when read`);
			const blob = BLOB_KEY.exec(object.key)?.[1];
			if (blob !== undefined && sha256Hex(theirs) !== blob) return void problems.push(`${object.key}: the destination's bytes do not hash to its key`);
			if (inSource) {
				const ours = await attempt(`reading ${source.name}/${object.key}`, delays, () => source.get(object.key));
				if (ours === null) return void problems.push(`${object.key}: listed at the source, gone when read`);
				if (!sameBytes(ours, theirs)) return void problems.push(`${object.key}: the destination's bytes differ from the source's`);
				add(report.same, object.size);
				if (sourceCheckDirectory !== null && keep(object.key)) writeInto(sourceCheckDirectory, object.key, ours);
			}
			if (keep(object.key)) writeInto(checkDirectory as string, object.key, theirs);
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		} finally {
			budget.give(size);
		}
	};
	// The source's objects, then (for the check of the Runs) the destination's own.
	const sourceObjects = COPIED_PREFIXES.flatMap((prefix) => sourceListed.get(prefix) ?? []);
	await inPool(sourceObjects, concurrency, () => false, compareOne);
	progress(`${report.same.count} of ${sourceObjects.length} source objects (${report.same.bytes} bytes) at the destination with the same bytes`);
	const destinationOnly = destinationAll.filter((object) => !sourceKeys.has(object.key) && keep(object.key));
	await inPool(destinationOnly, concurrency, () => false, compareOne);

	// The Runs repository's files, against the destination.
	const repositoryKeys = [...filesUnder(options.runsRepository, "runs"), ...filesUnder(options.runsRepository, "boots")];
	await inPool(repositoryKeys, concurrency, () => false, async (key) => {
		const there = destinationByKey.get(key);
		if (there === undefined) return void problems.push(`${key}: in the Runs repository, not at the destination`);
		const local = readFileSync(join(options.runsRepository, ...key.split("/")));
		if (local.length !== there.size) return void problems.push(`${key}: ${local.length} bytes in the Runs repository, ${there.size} at the destination`);
		try {
			const theirs = await attempt(`reading ${destination.name}/${key}`, delays, () => destination.get(key));
			if (theirs === null) problems.push(`${key}: listed at the destination, gone when read`);
			else if (!local.equals(theirs)) problems.push(`${key}: the Runs repository's file differs from the destination's`);
			else report.repositoryFiles += 1;
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	});
	progress(`${report.repositoryFiles} of ${repositoryKeys.length} files of the Runs repository at the destination with the same bytes`);

	if (checkDirectory !== null) {
		const checkRuns = options.checkRuns ?? ((directory: string) => checkRunsScript(directory));
		const checked = checkRuns(checkDirectory);
		report.checkRuns = { passed: checked.status === 0, output: checked.output };
		const failed = `scripts/check-runs.ts ${checkDirectory} failed (exit ${checked.status ?? "without a status"})`;
		if (checked.status !== 0 && sourceCheckDirectory === null) problems.push(failed);
		else if (checked.status !== 0 && problems.length > 0) {
			// The source's directory lacks what was not compared: no fair comparison.
			problems.push(`${failed}; not compared with the source's objects, as the copy has other problems`);
		} else if (checked.status !== 0 && sourceCheckDirectory !== null) {
			const atSource = checkRuns(sourceCheckDirectory);
			report.sourceCheckRuns = { passed: atSource.status === 0, output: atSource.output };
			const here = checked.result;
			const there = atSource.result;
			if (here === null || there === null) {
				problems.push(`${failed}, and which files it failed on, here or in the source's objects (${sourceCheckDirectory}), it did not say`);
			} else if (here.runs === 0 || here.failing.length === 0) {
				// It failed for a reason that is no file's (no Run file at all): nothing to compare.
				problems.push(`${failed}, and not on any file it named`);
			} else {
				const failingThere = new Set(there.failing);
				const onlyHere = here.failing.filter((file) => !failingThere.has(file));
				if (onlyHere.length > 0) {
					problems.push(`${failed} on ${onlyHere.length} file${onlyHere.length === 1 ? "" : "s"} it does not fail on in the source's objects (${sourceCheckDirectory}): ${onlyHere.join(", ")}`);
				} else {
					report.failingAsAtSource = here.failing;
				}
			}
		}
	}
	problems.sort();
	return report;
}
