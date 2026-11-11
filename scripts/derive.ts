/**
 * Runs the Methods over a directory of Runs and writes their Derivations:
 * Method series v1 (every Series, one number per Run) and Method requests v1
 * (the Series whose samples are requests, a latency distribution per phase).
 *
 *     bun scripts/derive.ts --runs DIR [--out FILE] [--requests-out FILE] [--blobs DIR]...
 *                           [--bucket NAME [--cache DIR]] [--records DIR] [--region R]
 *
 *   --runs DIR          holds runs/<yyyy>/<mm>/<dd>/<id>.json: a checkout of the Runs
 *                       repository, or a copy of the bucket
 *   --out FILE          Method series v1's Derivations
 *   --requests-out FILE Method requests v1's Derivations
 *   --blobs DIR         a directory of sha256/<hex> blobs, such as tests/samples/scheduled/blobs;
 *                       may be given more than once, and is looked in before the bucket
 *   --bucket NAME       fetch other blobs from the -runs stage's bucket (credentials from the
 *                       environment: see scripts/lib/bucket.ts)
 *   --cache DIR         keep the dump blobs fetched from the bucket here, as sha256/<hex>.
 *                       Stdout blobs are read from it if there, but never kept in it
 *   --records DIR       keep each stream's reduced record here, per Method
 *                       (methods/records.ts): a stream with a record for every Method
 *                       asked for is not fetched again
 *   --region R          the bucket's region (default us-east-2)
 *
 * At least one of --out and --requests-out. With --records, a stream that
 * lacks a record for any Method asked for is fetched once and reduced for
 * each, and one with a record for each is not fetched; without, each Method
 * reads every stream. The same Runs and blobs give the same bytes, records
 * kept or not, so a Derivation can be recomputed and compared with cmp.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { directoryRecords, keepRecords, type RecordStore, type ReduceCounts, type StreamReducer } from "../methods/records";
import * as requests from "../methods/requests/v1";
import { REQUESTS_RECORD } from "../methods/requests/v1/record";
import type { FetchBlob } from "../methods/run";
import * as series from "../methods/v1";
import { SERIES_RECORD } from "../methods/v1/record";
import { S3Bucket } from "./lib/bucket";
import { blobsFromBucket, blobsFromDirectories, firstOf } from "./lib/blobs";
import { readRunFiles } from "./lib/run-files";
import { RUNS_BUCKET_REGION } from "./lib/runs-repository";

const USAGE =
	"usage: bun scripts/derive.ts --runs DIR [--out FILE] [--requests-out FILE] [--blobs DIR]... " +
	"[--bucket NAME [--cache DIR]] [--records DIR] [--region R]";

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			runs: { type: "string" },
			out: { type: "string" },
			"requests-out": { type: "string" },
			blobs: { type: "string", multiple: true },
			bucket: { type: "string" },
			cache: { type: "string" },
			records: { type: "string" },
			region: { type: "string" },
		},
	});
	if (!values.runs || (!values.out && !values["requests-out"]) || (!values.blobs?.length && !values.bucket)) {
		console.error(USAGE);
		process.exit(2);
	}
	const blobSources: FetchBlob[] = [];
	const streamSources: FetchBlob[] = [];
	if (values.blobs?.length) {
		blobSources.push(blobsFromDirectories(values.blobs));
		streamSources.push(blobsFromDirectories(values.blobs));
	}
	if (values.bucket) {
		const bucket = new S3Bucket(values.bucket, values.region ?? RUNS_BUCKET_REGION);
		const cache = values.cache ?? null;
		blobSources.push(blobsFromBucket(bucket, cache));
		streamSources.push(blobsFromBucket(bucket, cache, { keep: false }));
	}
	const fetchBlob = firstOf(blobSources);
	const fetchStream = firstOf(streamSources);
	const records: RecordStore | null = values.records ? directoryRecords(values.records) : null;

	const files = readRunFiles(values.runs);
	const counts: ReduceCounts = { fetched: 0, kept: 0 };
	let gatherOptions: { records: RecordStore | null; fetchStream: FetchBlob } = { records: null, fetchStream };
	if (records !== null) {
		// One pass over the streams for every Method asked for, so that a stream
		// lacking a record is fetched once, not once per Method; each Method then
		// reads its records alone.
		const reducers: Array<StreamReducer<unknown>> = [];
		if (values.out) reducers.push(SERIES_RECORD as StreamReducer<unknown>);
		if (values["requests-out"]) reducers.push(REQUESTS_RECORD as StreamReducer<unknown>);
		const stdouts = files.flatMap((file) => {
			const record = file.record as { stdout?: unknown } | null;
			return typeof record?.stdout === "string" && /^sha256:[0-9a-f]{64}$/.test(record.stdout) ? [record.stdout] : [];
		});
		await keepRecords(stdouts, reducers, fetchStream, records, 16, counts);
		gatherOptions = {
			records,
			fetchStream: async (hash) => {
				throw new Error(`stream ${hash} has no record after the first pass`);
			},
		};
	}

	if (values.out) {
		const gathered = await series.gather(files, fetchBlob, gatherOptions);
		const derivations = series.derive(files, gathered);
		write(values.out, series.serialize(derivations));
		const counted = derivations.derivations.reduce((sum, d) => sum + d.points.filter((point) => point.counted).length, 0);
		console.log(
			`method ${derivations.method.name} v${derivations.method.version}: ${files.length} Run files, ` +
				`${derivations.derivations.length} Series, ${counted} counted Runs, ${files.length - derivations.unreadable.length - counted} failed, ` +
				`${derivations.unreadable.length} unreadable; ${gathered.blobs.size} dump blobs read -> ${values.out}`,
		);
	}
	if (values["requests-out"]) {
		const out = values["requests-out"];
		const gathered = await requests.gather(files, fetchBlob, gatherOptions);
		const derivations = requests.derive(files, gathered);
		write(out, requests.serialize(derivations));
		const points = derivations.derivations.flatMap((d) => d.points);
		const counted = points.filter((point) => point.counted);
		const succeeded = counted.reduce((sum, point) => sum + point.succeeded, 0);
		const failed = counted.reduce((sum, point) => sum + point.failed, 0);
		console.log(
			`method ${derivations.method.name} v${derivations.method.version}: ${files.length} Run files, ` +
				`${derivations.derivations.length} Series of requests, ${counted.length} counted Runs, ${points.length - counted.length} failed; ` +
				`${succeeded} requests succeeded, ${failed} failed; ${gathered.blobs.size} dump blobs read -> ${out}`,
		);
	}
	if (records !== null) console.log(`streams: ${counts.fetched} fetched and reduced, ${counts.kept} records read back from ${values.records}`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
