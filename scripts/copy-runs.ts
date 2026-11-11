/**
 * The copy job: copies Run files and boot summaries from the bucket into a
 * checkout of the Runs repository, byte for byte, under the same paths
 * (runs/<yyyy>/<mm>/<dd>/<id>.json, boots/<yyyy>/<mm>/<dd>/<boot>.json).
 *
 *     bun scripts/copy-runs.ts --bucket NAME [--region R] REPOSITORY
 *     bun scripts/copy-runs.ts --from-directory DIR REPOSITORY
 *
 * It only ever adds files, and stops loudly rather than change one:
 *
 *   - A file the repository already holds must be the bucket's, byte for byte.
 *     An ETag that matches the file's MD5 shows it is; an ETag that does not
 *     shows nothing (under SSE-KMS it is not an MD5), so then the object is
 *     downloaded and the bytes compared. A file whose bytes differ stops the job.
 *   - A key under runs/ or boots/ not shaped like a Run file or boot summary
 *     stops the job.
 *   - No path from the repository directory down to a file may pass through a
 *     symbolic link: one stops the job.
 *   Each of these is checked for every key before anything is written.
 *   - Each new file is written under an unpredictable temporary name, created
 *     exclusively, then linked to its name, which fails rather than replace a
 *     file that appeared there meanwhile; that stops the job too.
 *
 * Run twice, the second run adds nothing. It does not commit: the workflow does.
 * Credentials for --bucket come from the environment (scripts/lib/bucket.ts).
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, type Stats, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { type Bucket, type BucketObject, DirectoryBucket, md5Of, S3Bucket } from "./lib/bucket";
import { RUNS_BUCKET_REGION } from "./lib/runs-repository";

/** What is copied, and the only shape a key under those prefixes may have. */
export const COPIED_PREFIXES = ["runs/", "boots/"] as const;
const KEY = /^(runs|boots)\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/[0-9A-Za-z][0-9A-Za-z_.-]*\.json$/;

export interface CopyResult {
	/** Keys written, in key order. */
	added: string[];
	/** Keys the repository already held, the same as the bucket's. */
	same: number;
}

export class CopyRefused extends Error {
	constructor(
		readonly problems: string[],
		/** Files added before the job stopped; none unless a file appeared while it wrote. */
		readonly added: string[] = [],
	) {
		const what =
			added.length === 0
				? "wrote nothing"
				: `had added ${added.length} file${added.length === 1 ? "" : "s"} (${added.join(", ")}) and overwrote nothing`;
		super(
			[
				`the copy job stopped and ${what}: ${problems.length} problem${problems.length === 1 ? "" : "s"}`,
				...problems.map((problem) => `  ${problem}`),
			].join("\n"),
		);
		this.name = "CopyRefused";
	}
}

function lstatOrNull(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** The first of the repository directory and the components of key under it that is a symbolic link, or null. */
export function symlinkOnPath(repository: string, key: string): string | null {
	if (lstatOrNull(repository)?.isSymbolicLink()) return repository;
	let path = repository;
	let shown = "";
	for (const part of key.split("/")) {
		path = join(path, part);
		shown = shown === "" ? part : `${shown}/${part}`;
		const stat = lstatOrNull(path);
		if (stat === null) return null; // nothing below a missing component exists
		if (stat.isSymbolicLink()) return shown;
	}
	return null;
}

type Comparison = "same" | "differs" | "gone";

async function compareWithBucket(bucket: Bucket, object: BucketObject, path: string): Promise<Comparison> {
	const local = readFileSync(path);
	if (local.length !== object.size) return "differs";
	// A matching ETag shows the bytes are the object's; a different one shows nothing.
	if (object.etag !== null && md5Of(local) === object.etag) return "same";
	const remote = await bucket.get(object.key);
	if (remote === null) return "gone";
	return Buffer.from(remote).equals(local) ? "same" : "differs";
}

/**
 * Creates repository/key holding bytes, and never replaces anything: the
 * directories on the way must be plain directories, the bytes go to a fresh
 * temporary file opened with O_EXCL under a random name, and link() gives it
 * its name, failing if a file of that name appeared meanwhile.
 */
function addFile(repository: string, key: string, bytes: Uint8Array): "added" | "appeared" {
	const parts = key.split("/");
	const name = parts.pop() as string;
	let directory = repository;
	let shown = "";
	for (const part of parts) {
		directory = join(directory, part);
		shown = shown === "" ? part : `${shown}/${part}`;
		try {
			mkdirSync(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (!lstatSync(directory).isDirectory()) throw new Error(`${key}: ${shown} is not a plain directory`);
	}
	const temporary = join(directory, `.${name}.${randomBytes(12).toString("hex")}.partial`);
	const descriptor = openSync(temporary, "wx", 0o644);
	try {
		try {
			writeSync(descriptor, bytes);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		linkSync(temporary, join(directory, name));
		return "added";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "appeared";
		throw error;
	} finally {
		unlinkSync(temporary);
	}
}

export async function copyRuns(bucket: Bucket, repository: string): Promise<CopyResult> {
	const objects: BucketObject[] = [];
	for (const prefix of COPIED_PREFIXES) objects.push(...(await bucket.list(prefix)));
	objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

	const problems: string[] = [];
	const shaped = objects.filter((object) => {
		if (KEY.test(object.key)) return true;
		problems.push(`${object.key}: not shaped like a Run file or boot summary, so not copied`);
		return false;
	});
	for (const object of shaped) {
		const link = symlinkOnPath(repository, object.key);
		if (link !== null) problems.push(`${object.key}: ${link} is a symbolic link; the copy job reads and writes through none`);
	}
	if (problems.length > 0) throw new CopyRefused(problems);

	const toAdd: BucketObject[] = [];
	let same = 0;
	for (const object of shaped) {
		const path = join(repository, object.key);
		if (lstatOrNull(path) === null) {
			toAdd.push(object);
			continue;
		}
		const comparison = await compareWithBucket(bucket, object, path);
		if (comparison === "same") same++;
		else if (comparison === "gone") problems.push(`${object.key}: listed, but gone when fetched to compare`);
		else problems.push(`${object.key}: the repository's file differs from the bucket's`);
	}
	if (problems.length > 0) throw new CopyRefused(problems);

	// Everything is fetched and checked before anything is written.
	const fetched: Array<{ key: string; bytes: Uint8Array }> = [];
	for (const object of toAdd) {
		const bytes = await bucket.get(object.key);
		if (bytes === null) problems.push(`${object.key}: listed, but gone when fetched`);
		else if (bytes.length !== object.size) problems.push(`${object.key}: fetched ${bytes.length} bytes, but the listing says ${object.size}`);
		else fetched.push({ key: object.key, bytes });
	}
	if (problems.length > 0) throw new CopyRefused(problems);

	const added: string[] = [];
	for (const { key, bytes } of fetched) {
		let outcome: "added" | "appeared";
		try {
			outcome = addFile(repository, key, bytes);
		} catch (error) {
			throw new CopyRefused([error instanceof Error ? error.message : String(error)], added);
		}
		if (outcome === "appeared") {
			throw new CopyRefused([`${key}: a file of that name appeared in the repository while the copy ran; it was left as it is`], added);
		}
		added.push(key);
	}
	return { added, same };
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		options: { bucket: { type: "string" }, region: { type: "string" }, "from-directory": { type: "string" } },
		allowPositionals: true,
	});
	const [repository] = positionals;
	if (!repository || positionals.length !== 1 || Boolean(values.bucket) === Boolean(values["from-directory"])) {
		console.error("usage: bun scripts/copy-runs.ts (--bucket NAME [--region R] | --from-directory DIR) REPOSITORY");
		process.exit(2);
	}
	const bucket: Bucket = values.bucket
		? new S3Bucket(values.bucket, values.region ?? RUNS_BUCKET_REGION)
		: new DirectoryBucket(values["from-directory"] as string);
	const result = await copyRuns(bucket, repository);
	for (const key of result.added) console.log(`added ${key}`);
	console.log(`${result.added.length} added, ${result.same} already held and the same, from ${bucket.name}`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
