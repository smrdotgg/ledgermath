/**
 * Runs the Methods over a directory of Runs and writes their Derivations:
 * Method series v1 (every Series, one number per Run) and Method requests v1
 * (the Series whose samples are requests, a latency distribution per phase).
 *
 *     bun scripts/derive.ts --runs DIR [--out FILE] [--requests-out FILE] [--blobs DIR]...
 *                           [--bucket NAME | --blobs-url URL [--blobs-per-second N]] [--cache DIR] [--records DIR]
 *                           [--region R]
 *
 *   --runs DIR          holds runs/<yyyy>/<mm>/<dd>/<id>.json: a checkout of the Runs
 *                       repository, or a copy of the bucket
 *   --out FILE          Method series v1's Derivations
 *   --requests-out FILE Method requests v1's Derivations
 *   --blobs DIR         a directory of sha256/<hex> blobs, such as tests/samples/scheduled/blobs;
 *                       may be given more than once, and is looked in before the bucket
 *   --bucket NAME       fetch other blobs from the -runs stage's bucket (credentials from the
 *                       environment: see scripts/lib/bucket.ts), at most 16 at once; a read
 *                       that fails for a reason that may pass (no answer, a throttling or
 *                       5xx answer, one the client cannot read) is made again, up to 8
 *                       tries with a growing pause, each logged with why (scripts/lib/blobs.ts,
 *                       retryingStore); a blob that is not there is not tried again
 *   --blobs-url URL     or from the public address serving the bucket's blobs/sha256/
 *                       (https://<distribution>.cloudfront.net; no credentials); a redirect
 *                       is refused, never followed
 *   --blobs-per-second N  start at most N requests a second there (default 4, under the
 *                       distribution's per-address rate limit)
 *   --cache DIR         keep the dump blobs fetched from the bucket here, as sha256/<hex>.
 *                       Stdout blobs are read from it if there, but never kept in it
 *   --records DIR       keep each stream's reduced record here, per Method
 *                       (methods/records.ts): a stream with a record for every Method
 *                       asked for is not fetched again. Records made by other code
 *                       for a Method asked for (DIR/<method>-v<version>-<another
 *                       digest>), which are never read, are removed
 *   --region R          the bucket's region (default us-east-2)
 *
 * At least one of --out and --requests-out. With --records, a stream that
 * lacks a record for any Method asked for is fetched once and reduced for
 * each, and one with a record for each is not fetched; without, each Method
 * reads every stream. Only a Run file that validates against the Run schema
 * is asked for its stream; any other is listed as unreadable by each Method.
 * The same Runs and blobs give the same bytes, records kept or not, so a
 * Derivation can be recomputed and compared with cmp.
 *
 * Each Method runs on its own: when one fails, the other's Derivations are
 * still written, and in place of the failed one's goes a note saying why
 * (scripts/lib/method-failure.ts: page/requests-derivations.failed.json for
 * page/requests-derivations.json), which the page shows. The exit code is
 * then 1, so the failure is seen; 0 when every Method asked for succeeded.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { directoryRecords, keepRecords, type RecordStore, type ReduceCounts, type StreamReducer } from "../methods/records";
import * as requests from "../methods/requests/v1";
import { REQUESTS_RECORD } from "../methods/requests/v1/record";
import type { FetchBlob } from "../methods/run";
import * as series from "../methods/v1";
import { SERIES_RECORD } from "../methods/v1/record";
import { S3Bucket } from "./lib/bucket";
import { type BlobStore, blobsFromBucket, blobsFromDirectories, firstOf, publicBlobStore, retryingStore } from "./lib/blobs";
import { failurePath, methodFailure } from "./lib/method-failure";
import { readRunFiles } from "./lib/run-files";
import { RUNS_BUCKET_REGION } from "./lib/runs-repository";

const USAGE =
	"usage: bun scripts/derive.ts --runs DIR [--out FILE] [--requests-out FILE] [--blobs DIR]... " +
	"[--bucket NAME | --blobs-url URL [--blobs-per-second N]] [--cache DIR] [--records DIR] [--region R]";

/** Streams read at once by the first pass, and reads from the bucket in flight at once, at most. */
const READS_IN_FLIGHT = 16;

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/**
 * Runs one Method and writes its Derivations, or, when it throws, the note
 * saying why in their place. Returns whether it succeeded.
 */
async function runMethod(method: { name: string; version: number }, out: string, make: () => Promise<{ text: string; summary: string }>): Promise<boolean> {
	try {
		const { text, summary } = await make();
		write(out, text);
		rmSync(failurePath(out), { force: true });
		console.log(summary);
		return true;
	} catch (error) {
		if (existsSync(out)) rmSync(out);
		const failure = methodFailure(method, error);
		write(failurePath(out), `${JSON.stringify(failure, null, 2)}\n`);
		console.error(`method ${method.name} v${method.version} failed, and wrote no Derivations: ${failure.error} -> ${failurePath(out)}`);
		return false;
	}
}

/**
 * Removes, from a directory of records, every directory of a Method asked for
 * that is not its current key: records made by other code, which no key of
 * this code names, so the cache that keeps the directory does not grow with
 * every change to the code. Returns their names.
 */
function removeOtherCode(directory: string, keys: ReadonlyArray<string | null>): string[] {
	if (!existsSync(directory)) return [];
	const removed: string[] = [];
	for (const key of keys) {
		if (key === null) continue;
		const prefix = key.replace(/[0-9a-f]{16}$/, "");
		for (const name of readdirSync(directory)) {
			if (name.startsWith(prefix) && name !== key) {
				rmSync(join(directory, name), { recursive: true, force: true });
				removed.push(name);
			}
		}
	}
	return removed.sort();
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			runs: { type: "string" },
			out: { type: "string" },
			"requests-out": { type: "string" },
			blobs: { type: "string", multiple: true },
			bucket: { type: "string" },
			"blobs-url": { type: "string" },
			"blobs-per-second": { type: "string" },
			cache: { type: "string" },
			records: { type: "string" },
			region: { type: "string" },
		},
	});
	if (
		!values.runs ||
		(!values.out && !values["requests-out"]) ||
		(!values.blobs?.length && !values.bucket && !values["blobs-url"]) ||
		(values.bucket && values["blobs-url"]) ||
		(values["blobs-per-second"] !== undefined && (!values["blobs-url"] || !(Number(values["blobs-per-second"]) > 0)))
	) {
		console.error(USAGE);
		process.exit(2);
	}
	const blobSources: FetchBlob[] = [];
	const streamSources: FetchBlob[] = [];
	if (values.blobs?.length) {
		blobSources.push(blobsFromDirectories(values.blobs));
		streamSources.push(blobsFromDirectories(values.blobs));
	}
	// A read from the bucket that fails for a reason that may pass is made again
	// (scripts/lib/blobs.ts, retryingStore), each try logged with the client's
	// code, and no more than READS_IN_FLIGHT are made at once.
	const bucket = values.bucket ? retryingStore(new S3Bucket(values.bucket, values.region ?? RUNS_BUCKET_REGION), { inFlight: READS_IN_FLIGHT }) : null;
	const store: BlobStore | null =
		bucket ??
		(values["blobs-url"] ? publicBlobStore(values["blobs-url"], values["blobs-per-second"] === undefined ? {} : { perSecond: Number(values["blobs-per-second"]) }) : null);
	if (store !== null) {
		const cache = values.cache ?? null;
		blobSources.push(blobsFromBucket(store, cache));
		streamSources.push(blobsFromBucket(store, cache, { keep: false }));
	}
	const fetchBlob = firstOf(blobSources);
	const fetchStream = firstOf(streamSources);
	const records: RecordStore | null = values.records ? directoryRecords(values.records) : null;

	const files = readRunFiles(values.runs);
	const counts: ReduceCounts = { fetched: 0, kept: 0 };
	if (records !== null) {
		// One pass over the streams for every Method asked for, so that a stream
		// lacking a record is fetched once, not once per Method. Only Run files
		// that validate are asked for their streams. Should the pass fail, each
		// Method below reads what it still lacks itself, and fails on its own.
		const reducers: Array<StreamReducer<unknown>> = [];
		if (values.out) reducers.push(SERIES_RECORD as StreamReducer<unknown>);
		if (values["requests-out"]) reducers.push(REQUESTS_RECORD as StreamReducer<unknown>);
		const stdouts = series.readRuns(files).runs.map(({ run }) => run.stdout);
		try {
			await keepRecords(stdouts, reducers, fetchStream, records, READS_IN_FLIGHT, counts);
		} catch (error) {
			console.error(`reading every stream once for every Method stopped (${error instanceof Error ? error.message : String(error)}); each Method reads what it lacks itself`);
		}
	}
	const gatherOptions = { records, fetchStream };

	let ok = true;
	if (values.out) {
		const out = values.out;
		ok =
			(await runMethod(series.METHOD, out, async () => {
				const gathered = await series.gather(files, fetchBlob, gatherOptions);
				const derivations = series.derive(files, gathered);
				const counted = derivations.derivations.reduce((sum, d) => sum + d.points.filter((point) => point.counted).length, 0);
				return {
					text: series.serialize(derivations),
					summary:
						`method ${derivations.method.name} v${derivations.method.version}: ${files.length} Run files, ` +
						`${derivations.derivations.length} Series, ${counted} counted Runs, ${files.length - derivations.unreadable.length - counted} failed, ` +
						`${derivations.unreadable.length} unreadable; ${gathered.blobs.size} dump blobs read -> ${out}`,
				};
			})) && ok;
	}
	if (values["requests-out"]) {
		const out = values["requests-out"];
		ok =
			(await runMethod(requests.METHOD, out, async () => {
				const gathered = await requests.gather(files, fetchBlob, gatherOptions);
				const derivations = requests.derive(files, gathered);
				const points = derivations.derivations.flatMap((d) => d.points);
				const counted = points.filter((point) => point.counted);
				const succeeded = counted.reduce((sum, point) => sum + point.succeeded, 0);
				const failed = counted.reduce((sum, point) => sum + point.failed, 0);
				return {
					text: requests.serialize(derivations),
					summary:
						`method ${derivations.method.name} v${derivations.method.version}: ${files.length} Run files, ` +
						`${derivations.derivations.length} Series of requests, ${counted.length} counted Runs, ${points.length - counted.length} failed; ` +
						`${succeeded} requests succeeded, ${failed} failed; ${derivations.unreadable.length} unreadable; ${gathered.blobs.size} dump blobs read -> ${out}`,
				};
			})) && ok;
	}
	if (bucket !== null && bucket.retried() > 0) console.log(`reads from ${bucket.name} made again after a failure that may pass: ${bucket.retried()} (each is logged above, with why)`);
	if (records !== null) {
		console.log(`streams: ${counts.fetched} fetched and reduced, ${counts.kept} records read back from ${values.records}`);
		const removed = removeOtherCode(values.records as string, [values.out ? SERIES_RECORD.key : null, values["requests-out"] ? REQUESTS_RECORD.key : null]);
		if (removed.length > 0) console.log(`removed the records of other code, never read: ${removed.join(", ")}`);
	}
	if (!ok) process.exit(1);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
