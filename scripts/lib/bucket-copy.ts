/**
 * Copies a -runs stage's bucket into another's, and checks the copy: what
 * scripts/copy-bucket.ts runs, from the development account's bucket to the
 * production account's (README, "Moving the schedule to the production
 * account").
 *
 * What is copied: every object under blobs/, runs/, boots/ and logs/, the
 * current version of each key (a GET without a version). Not source/: each
 * stage's deploy puts its own source archive there, and every archive a Run
 * names is also a blob.
 *
 * The copy only ever adds:
 *
 *   - Everything at both ends is listed first, and every object already at
 *     the destination is compared with the source's before anything is
 *     written: a blob by its key, which is the SHA-256 of its bytes, so by
 *     its size alone; any other object by its bytes. One that differs stops
 *     the copy, and nothing is written.
 *   - Each object is then read whole, checked (a blob's bytes must hash to
 *     its key; any other object's must have the MD5 the source's ETag gives,
 *     when the ETag has an MD5's shape), and looked for at the destination
 *     once more just before it is written: one that appeared meanwhile is
 *     compared as above, and never overwritten. It is written in one PUT
 *     with the source's Content-Type, then looked at: its size, its type and
 *     its ETag (the MD5 of what was sent) must be what was written.
 *   - Any problem stops the copy: no object is written after it, those being
 *     written finish, and the report says what was copied. Run again, it
 *     carries on from where it was: what is at the destination is compared,
 *     not copied. A second complete run copies nothing.
 *
 * The order keeps the destination as a box keeps a bucket: no Run file
 * before its blobs. Listed logs/, boots/, runs/, then blobs/ (the reverse of
 * a box's uploads, so every blob a listed Run names is listed too); copied
 * blobs/, then runs/, boots/ and logs/, each prefix only once the one before
 * it is done.
 *
 * Memory: at most `concurrency` objects are in flight, and at most
 * `memoryBytes` of their bytes are held at once; an object larger than that
 * is held alone. So what is held never exceeds the larger of memoryBytes and
 * the largest object.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { type BucketObject, describeS3Error, md5Of, type WritableBucket } from "./bucket";

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
	/** Already at the destination, and the same. */
	same: Tally;
	/** Written; in a dry run, what would be. */
	copied: Tally;
	/** The most bytes of objects held in memory at once. */
	peakBytesHeld: number;
}

export class CopyStopped extends Error {
	constructor(
		readonly problems: string[],
		readonly report: CopyReport,
	) {
		const wrote = report.copied.count === 0 ? "wrote nothing" : `had written ${report.copied.count} objects (${report.copied.bytes} bytes) and overwrote nothing`;
		super([`the copy stopped and ${wrote}: ${problems.length} problem${problems.length === 1 ? "" : "s"}`, ...problems.map((problem) => `  ${problem}`)].join("\n"));
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

function byKey(objects: readonly BucketObject[]): Map<string, BucketObject> {
	return new Map(objects.map((object) => [object.key, object]));
}

async function listAll(bucket: WritableBucket, delays: readonly number[]): Promise<Map<CopiedPrefix, BucketObject[]>> {
	const listed = new Map<CopiedPrefix, BucketObject[]>();
	for (const prefix of LIST_ORDER) listed.set(prefix, await attempt(`listing ${bucket.name}/${prefix}`, delays, () => bucket.list(prefix)));
	return listed;
}

/**
 * Whether an object at the destination is the source's: null when it is,
 * else the difference. A blob is its key's bytes, so only its size is
 * compared; any other object's bytes are fetched from both and compared.
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
	if (BLOB_KEY.test(key)) return null;
	const [ours, theirs] = await Promise.all([
		attempt(`reading ${source.name}/${key}`, delays, () => source.get(key)),
		attempt(`reading ${destination.name}/${key}`, delays, () => destination.get(key)),
	]);
	if (ours === null) return `${key}: gone from the source when read to compare`;
	if (theirs === null) return `${key}: gone from the destination when read to compare`;
	return Buffer.from(ours).equals(theirs) ? null : `${key}: the destination's bytes differ from the source's`;
}

/** Why the bytes read for an object are not what the source holds, or null. */
function readProblem(object: BucketObject, bytes: Uint8Array): string | null {
	if (bytes.length !== object.size) return `${object.key}: read ${bytes.length} bytes, but the source lists ${object.size}`;
	const blob = BLOB_KEY.exec(object.key)?.[1];
	if (blob !== undefined) {
		const actual = sha256Hex(bytes);
		return actual === blob ? null : `${object.key}: its bytes hash to ${actual}, not to its key`;
	}
	if (object.etag !== null && md5Of(bytes) !== object.etag) return `${object.key}: the bytes read do not have the MD5 the source's ETag gives`;
	return null;
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
		peakBytesHeld: 0,
	};
	const stop = (problems: string[]): never => {
		report.peakBytesHeld = budget.peak;
		throw new CopyStopped(problems, report);
	};

	// Every key under blobs/ must be a blob's, so its key can stand for its bytes.
	const misnamed = (sourceListed.get("blobs/") ?? []).filter((object) => !BLOB_KEY.test(object.key));
	if (misnamed.length > 0) stop(misnamed.map((object) => `${object.key}: under blobs/ but not named blobs/sha256/<hex>, so it cannot be checked by its hash`));

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
		const size = BLOB_KEY.test(object.key) ? 0 : 2 * object.size;
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
	progress(`${report.same.count} objects (${report.same.bytes} bytes) already at the destination, the same`);

	if (report.dryRun) {
		for (const prefix of COPIED_PREFIXES) for (const object of toCopy.get(prefix) ?? []) add(report.copied, object.size);
		report.peakBytesHeld = budget.peak;
		return report;
	}

	let stopping = false;
	const copyOne = async (object: BucketObject): Promise<void> => {
		await budget.take(object.size);
		try {
			const head = await attempt(`looking at ${source.name}/${object.key}`, delays, () => source.head(object.key));
			if (head === null) throw new Error(`${object.key}: gone from the source since it was listed`);
			if (head.size !== object.size) throw new Error(`${object.key}: ${head.size} bytes at the source now, ${object.size} when listed`);
			const bytes = await attempt(`reading ${source.name}/${object.key}`, delays, () => source.get(object.key));
			if (bytes === null) throw new Error(`${object.key}: gone from the source since it was listed`);
			const unread = readProblem(object, bytes);
			if (unread !== null) throw new Error(unread);

			// Looked for again just before it is written, and again on each retry,
			// so a PUT whose answer was lost is found rather than repeated.
			const outcome = await attempt(`writing ${destination.name}/${object.key}`, delays, async () => {
				const there = await destination.head(object.key);
				if (there !== null) {
					const differs = await difference(source, destination, object.key, object.size, there.size, delays);
					if (differs !== null) throw new Fatal(differs);
					return "same" as const;
				}
				if (stopping) return "skipped" as const;
				await destination.put(object.key, bytes, head.contentType);
				return "written" as const;
			});
			if (outcome === "same") add(report.same, object.size);
			if (outcome !== "written") return;

			const written = await attempt(`looking at ${destination.name}/${object.key}`, delays, () => destination.head(object.key));
			if (written === null) throw new Error(`${object.key}: not at the destination after it was written`);
			const wrong: string[] = [];
			if (written.size !== object.size) wrong.push(`${written.size} bytes, not ${object.size}`);
			if (written.contentType !== head.contentType) wrong.push(`Content-Type ${JSON.stringify(written.contentType)}, not ${JSON.stringify(head.contentType)}`);
			if (written.etag !== null && written.etag !== md5Of(bytes)) wrong.push("an ETag that is not the MD5 of the bytes sent");
			if (wrong.length > 0) throw new Error(`${object.key}: written, but the destination's object has ${wrong.join(", ")}`);
			add(report.copied, object.size);
			if (report.copied.count % 1000 === 0) progress(`${report.copied.count} objects (${report.copied.bytes} bytes) copied`);
		} catch (error) {
			stopping = true;
			problems.push(error instanceof Error ? error.message : String(error));
		} finally {
			budget.give(object.size);
		}
	};

	for (const prefix of COPIED_PREFIXES) {
		const objects = toCopy.get(prefix) ?? [];
		await inPool(objects, concurrency, () => stopping, copyOne);
		if (stopping) break;
		progress(`${prefix} done: ${objects.length} objects to copy, ${report.copied.count} copied so far`);
	}
	report.peakBytesHeld = budget.peak;
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
	concurrency?: number;
	memoryBytes?: number;
	retryDelaysMs?: readonly number[];
	progress?: (line: string) => void;
	/** Runs scripts/check-runs.ts on a directory; its exit status and output. */
	checkRuns?: (directory: string) => { status: number | null; output: string };
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
	problems: string[];
}

/** Runs scripts/check-runs.ts as its own process. */
export function checkRunsScript(directory: string): { status: number | null; output: string } {
	const script = resolve(import.meta.dir, "..", "check-runs.ts");
	const done = spawnSync(process.execPath, [script, directory], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	return { status: done.status, output: `${done.stdout ?? ""}${done.stderr ?? ""}` };
}

/** Every file under part/ of a directory, as keys with forward slashes; a symbolic link anywhere is refused. */
function filesUnder(root: string, part: string): string[] {
	const directory = join(root, part);
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => {
			if (entry.isSymbolicLink()) throw new Error(`${join(entry.parentPath, entry.name)} is a symbolic link; the verification reads through none`);
			return entry.isFile();
		})
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

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
 * boots/, written into checkDirectory.
 */
export async function verifyCopy(source: WritableBucket, destination: WritableBucket, options: VerifyOptions): Promise<VerifyReport> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	const progress = options.progress ?? (() => {});
	const budget = new ByteBudget(options.memoryBytes ?? DEFAULT_MEMORY_BYTES);
	const report: VerifyReport = { same: { count: 0, bytes: 0 }, onlyAtDestination: 0, repositoryFiles: 0, checkRuns: null, problems: [] };
	const problems = report.problems;
	const checkDirectory = options.checkDirectory;
	if (checkDirectory !== null) {
		if (existsSync(checkDirectory) && (!lstatSync(checkDirectory).isDirectory() || readdirSync(checkDirectory).length > 0)) {
			throw new Error(`${checkDirectory}: must be an empty directory, or not exist, so that it holds the destination's objects and nothing else`);
		}
		mkdirSync(checkDirectory, { recursive: true });
	}

	const sourceListed = await listAll(source, delays);
	const destinationListed = await listAll(destination, delays);
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
				if (!Buffer.from(ours).equals(theirs)) return void problems.push(`${object.key}: the destination's bytes differ from the source's`);
				add(report.same, object.size);
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
		const checked = (options.checkRuns ?? checkRunsScript)(checkDirectory);
		report.checkRuns = { passed: checked.status === 0, output: checked.output };
		if (checked.status !== 0) problems.push(`scripts/check-runs.ts ${checkDirectory} failed (exit ${checked.status ?? "without a status"})`);
	}
	problems.sort();
	return report;
}
