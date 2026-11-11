/**
 * Runs Method version 1 over a directory of Runs and writes its Derivations.
 *
 *     bun scripts/derive.ts --runs DIR --out FILE [--blobs DIR]... [--bucket NAME [--cache DIR]]
 *
 *   --runs DIR      holds runs/<yyyy>/<mm>/<dd>/<id>.json: a checkout of the Runs
 *                   repository, or a copy of the bucket
 *   --blobs DIR     a directory of sha256/<hex> blobs, such as tests/samples/scheduled/blobs;
 *                   may be given more than once, and is looked in before the bucket
 *   --bucket NAME   fetch other blobs from the -runs stage's bucket (credentials from the
 *                   environment: see scripts/lib/bucket.ts)
 *   --cache DIR     keep blobs fetched from the bucket here, as sha256/<hex>
 *   --region R      the bucket's region (default us-east-2)
 *
 * The same Runs and blobs give the same bytes, so a Derivation can be
 * recomputed and compared with cmp.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { derive, gather, serialize } from "../methods/v1";
import { S3Bucket } from "./lib/bucket";
import { blobsFromBucket, blobsFromDirectories, firstOf } from "./lib/blobs";
import { readRunFiles } from "./lib/run-files";
import { RUNS_BUCKET_REGION } from "./lib/runs-repository";

const USAGE = "usage: bun scripts/derive.ts --runs DIR --out FILE [--blobs DIR]... [--bucket NAME [--cache DIR]] [--region R]";

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			runs: { type: "string" },
			out: { type: "string" },
			blobs: { type: "string", multiple: true },
			bucket: { type: "string" },
			cache: { type: "string" },
			region: { type: "string" },
		},
	});
	if (!values.runs || !values.out || (!values.blobs?.length && !values.bucket)) {
		console.error(USAGE);
		process.exit(2);
	}
	const sources = [];
	if (values.blobs?.length) sources.push(blobsFromDirectories(values.blobs));
	if (values.bucket) {
		sources.push(blobsFromBucket(new S3Bucket(values.bucket, values.region ?? RUNS_BUCKET_REGION), values.cache ?? null));
	}

	const files = readRunFiles(values.runs);
	const gathered = await gather(files, firstOf(sources));
	const derivations = derive(files, gathered);
	mkdirSync(dirname(values.out), { recursive: true });
	writeFileSync(values.out, serialize(derivations));

	const counted = derivations.derivations.reduce((sum, d) => sum + d.points.filter((point) => point.counted).length, 0);
	console.log(
		`method ${derivations.method.name} v${derivations.method.version}: ${files.length} Run files, ` +
			`${derivations.derivations.length} Series, ${counted} counted Runs, ${files.length - derivations.unreadable.length - counted} failed, ` +
			`${derivations.unreadable.length} unreadable; ${gathered.blobs.size + gathered.streams.size} blobs read -> ${values.out}`,
	);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
