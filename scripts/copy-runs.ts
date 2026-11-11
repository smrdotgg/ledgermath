/**
 * The copy job: copies Run files and boot summaries from the bucket into a
 * checkout of the Runs repository, byte for byte, under the same paths
 * (runs/<yyyy>/<mm>/<dd>/<id>.json, boots/<yyyy>/<mm>/<dd>/<boot>.json).
 *
 *     bun scripts/copy-runs.ts --bucket NAME [--region R] REPOSITORY
 *     bun scripts/copy-runs.ts --from-directory DIR REPOSITORY
 *
 * It only ever adds files. A file the repository already holds is compared
 * with the bucket's (size, then the MD5 the bucket's ETag carries, or the
 * bytes when the ETag is not an MD5); if any differs, or a key under runs/ or
 * boots/ is not shaped like a Run file or boot summary, it stops loudly and
 * writes nothing. Run twice, the second run adds nothing. It does not commit:
 * the workflow does.
 *
 * Credentials for --bucket come from the environment (scripts/lib/bucket.ts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	constructor(readonly problems: string[]) {
		super(
			[
				`the copy job stopped and wrote nothing: ${problems.length} problem${problems.length === 1 ? "" : "s"}`,
				...problems.map((problem) => `  ${problem}`),
			].join("\n"),
		);
		this.name = "CopyRefused";
	}
}

async function sameAsBucket(bucket: Bucket, object: BucketObject, path: string): Promise<boolean> {
	if (statSync(path).size !== object.size) return false;
	const local = readFileSync(path);
	if (object.md5 !== null) return md5Of(local) === object.md5;
	const remote = await bucket.get(object.key);
	return remote !== null && Buffer.from(remote).equals(local);
}

export async function copyRuns(bucket: Bucket, repository: string): Promise<CopyResult> {
	const objects: BucketObject[] = [];
	for (const prefix of COPIED_PREFIXES) objects.push(...(await bucket.list(prefix)));
	objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

	const problems: string[] = [];
	const toAdd: BucketObject[] = [];
	let same = 0;
	for (const object of objects) {
		if (!KEY.test(object.key)) {
			problems.push(`${object.key}: not shaped like a Run file or boot summary, so not copied`);
			continue;
		}
		const path = join(repository, object.key);
		if (!existsSync(path)) toAdd.push(object);
		else if (await sameAsBucket(bucket, object, path)) same++;
		else problems.push(`${object.key}: the repository's file differs from the bucket's`);
	}
	if (problems.length > 0) throw new CopyRefused(problems);

	// Everything is fetched and checked before anything is written.
	const fetched: Array<{ key: string; bytes: Uint8Array }> = [];
	for (const object of toAdd) {
		const bytes = await bucket.get(object.key);
		if (bytes === null) problems.push(`${object.key}: listed, but gone when fetched`);
		else if (bytes.length !== object.size || (object.md5 !== null && md5Of(bytes) !== object.md5)) {
			problems.push(`${object.key}: what was fetched does not match the listing's size or MD5`);
		} else fetched.push({ key: object.key, bytes });
	}
	if (problems.length > 0) throw new CopyRefused(problems);

	for (const { key, bytes } of fetched) {
		const path = join(repository, key);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.tmp`, bytes);
		renameSync(`${path}.tmp`, path);
	}
	return { added: fetched.map(({ key }) => key), same };
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
