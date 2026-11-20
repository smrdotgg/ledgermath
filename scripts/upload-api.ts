/**
 * Uploads the data API's tree, once scripts/check-api.ts has passed it, to the
 * stage's private API bucket (infra/runs/api-bucket.ts, ADR-0031):
 *
 *     bun scripts/upload-api.ts --tree DIR --bucket NAME [--region us-east-2] [--endpoint URL]
 *
 *   --tree DIR      the tree scripts/build-api.ts wrote and scripts/check-api.ts checked (it holds v1/)
 *   --bucket NAME   the stage's apiBucket output (the runs workflow's repository variable API_BUCKET)
 *   --region R      the bucket's Region (default us-east-2, every -runs stage's)
 *   --endpoint URL  a stand-in for S3, path-style; the tests use it
 *
 * Writes only the files the bucket does not already hold with the same
 * SHA-256 and headers (one HEAD per file tells), in five phases, each whole
 * before the next: schemas; month files and price files; Series files; the
 * list; the table of contents (UPLOAD_PHASES). Deletes nothing. Each object carries its
 * Content-Type and Cache-Control (treeObject), and S3 verifies its SHA-256 as
 * it is written and keeps it. Credentials come from the environment
 * (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), as
 * aws-actions/configure-aws-credentials sets them. scripts/check-api-bucket.ts
 * then checks what the bucket holds.
 *
 * Writes what it did to the step's summary ($GITHUB_STEP_SUMMARY) when there
 * is one. Exits 1 when a request fails; the phases after it are not started.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { RUNS_REGION } from "../infra/runs/stages";
import { readTree, S3ApiStore, uploadTree } from "./lib/api-upload";

const USAGE = "usage: bun scripts/upload-api.ts --tree DIR --bucket NAME [--region R] [--endpoint URL]";

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { tree: { type: "string" }, bucket: { type: "string" }, region: { type: "string" }, endpoint: { type: "string" } } });
	if (!values.tree || !values.bucket) {
		console.error(USAGE);
		process.exit(2);
	}
	const started = performance.now();
	const files = readTree(values.tree);
	const store = new S3ApiStore(values.bucket, values.region ?? RUNS_REGION, values.endpoint === undefined ? {} : { endpoint: values.endpoint });
	const report = await uploadTree(store, files);
	const lines = report.phases.map(
		(phase, index) => `phase ${index + 1}, ${phase.phase}: ${phase.written.length} written, ${phase.unchanged} unchanged`,
	);
	const byReason = new Map<string, number>();
	for (const reason of report.reasons.values()) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
	const why = [...byReason].map(([reason, count]) => `${count} ${reason}`).join(", ");
	const total = report.phases.reduce((sum, phase) => sum + phase.written.length, 0);
	const summary = `data API v1 to ${store.name}: ${files.length} files, ${total} written${why === "" ? "" : ` (${why})`}, nothing deleted, in ${Math.round(performance.now() - started)} ms`;
	for (const line of lines) console.log(line);
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### The data API's files to the API bucket\n\n${summary}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
