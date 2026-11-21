/**
 * Checks that the stage's API bucket holds exactly the data API's tree just
 * built (infra/runs/api-bucket.ts, ADR-0031), after scripts/upload-api.ts:
 *
 *     bun scripts/check-api-bucket.ts --tree DIR --bucket NAME [--region us-east-2] [--endpoint URL]
 *
 * (--endpoint: a stand-in for S3, path-style; the tests use it.)
 *
 * Every key of the bucket, under v1/ or anywhere else, is a file of the tree and every file of
 * the tree is there, each with the file's SHA-256 (the one S3 verified and
 * kept when it was written), its size, and the Content-Type and
 * Cache-Control treeObject gives it. A key the tree no longer has is a
 * problem, not something to delete: the upload never deletes, and a person
 * decides. Credentials come from the environment, as for the upload.
 *
 * Prints every problem and exits 1 when there is any; writes the outcome to
 * the step's summary ($GITHUB_STEP_SUMMARY) when there is one.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { RUNS_REGION } from "../infra/runs/stages";
import { checkBucket, readTree, S3ApiStore } from "./lib/api-upload";

const USAGE = "usage: bun scripts/check-api-bucket.ts --tree DIR --bucket NAME [--region R] [--endpoint URL]";
const SHOWN = 200;

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { tree: { type: "string" }, bucket: { type: "string" }, region: { type: "string" }, endpoint: { type: "string" } } });
	if (!values.tree || !values.bucket) {
		console.error(USAGE);
		process.exit(2);
	}
	const started = performance.now();
	const files = readTree(values.tree);
	const store = new S3ApiStore(values.bucket, values.region ?? RUNS_REGION, values.endpoint === undefined ? {} : { endpoint: values.endpoint });
	const problems = await checkBucket(store, files);
	const took = Math.round(performance.now() - started);
	const outcome =
		problems.length === 0
			? `${store.name} holds the data API's tree exactly: ${files.length} files, all under v1/ and nothing else, each with the tree's SHA-256, size, Content-Type and Cache-Control (${took} ms)`
			: `${store.name} does not hold the data API's tree exactly: ${problems.length} problem${problems.length === 1 ? "" : "s"} (${took} ms)`;
	if (process.env.GITHUB_STEP_SUMMARY) {
		const shown = problems.slice(0, 20).map((problem) => `- ${problem}`).join("\n");
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### The API bucket against the tree\n\n${outcome}\n${shown === "" ? "" : `\n${shown}\n`}`);
	}
	if (problems.length > 0) {
		for (const problem of problems.slice(0, SHOWN)) console.error(problem);
		if (problems.length > SHOWN) console.error(`and ${problems.length - SHOWN} more`);
		console.error(outcome);
		process.exit(1);
	}
	console.log(outcome);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
