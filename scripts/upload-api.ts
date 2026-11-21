/**
 * Uploads the data API's tree, once scripts/check-api.ts has passed it, to the
 * stage's private API bucket (infra/runs/api-bucket.ts, ADR-0031):
 *
 *     bun scripts/upload-api.ts --tree DIR --bucket NAME --run ID [--preflight] [--region us-east-2] [--endpoint URL]
 *
 *   --tree DIR      the tree scripts/build-api.ts wrote and scripts/check-api.ts checked (it holds v1/)
 *   --bucket NAME   the stage's apiBucket output (the runs workflow's repository variable API_BUCKET)
 *   --run ID        the GitHub Actions run whose tree this is (GITHUB_RUN_ID); an upload by hand
 *                   passes the id of the run whose artifact api it uploads
 *   --preflight     check the bucket and say what would be written; write nothing
 *   --region R      the bucket's Region (default us-east-2, every -runs stage's)
 *   --endpoint URL  a stand-in for S3, path-style; the tests use it
 *
 * First lists the whole bucket: if it holds a key the tree does not (under
 * v1/ or anywhere else), it writes nothing, names each such key, and exits 1
 * (README, "The API bucket", "A key the tree does not have"). Then one HEAD
 * per file: if any object was written by a later run than --run (each write
 * records its run in the object's metadata), the tree is older than what is
 * published, and it writes nothing and exits 1. With --preflight it stops
 * there. Then writes
 * only the files the bucket does not already hold with the same SHA-256 and
 * headers (one HEAD per file tells), in five phases, each whole before the
 * next: schemas; month files and price files; Series files; the list; the
 * table of contents (UPLOAD_PHASES). Then, if the table of contents was not
 * rewritten and does not record --run already, writes it again, unchanged,
 * with --run (the stamp, STAMP_KEY), so the bucket records that this run
 * published even when nothing else changed. Deletes nothing. Each object
 * carries its Content-Type and Cache-Control (treeObject) and the run that
 * wrote it, and S3 verifies its SHA-256 as it is written and keeps it. Credentials come from the environment
 * (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), as
 * aws-actions/configure-aws-credentials sets them. scripts/check-api-bucket.ts
 * then checks what the bucket holds.
 *
 * A failed write stops the upload in its phase, starts no later one, and
 * exits 1, naming the phase and each key that failed: the run fails, visibly.
 * The bucket may then hold month files of this round beside Series files of
 * the round before; the next run's upload writes what is still missing, and
 * so repairs it, by itself.
 *
 * Writes what it did, or why it stopped, to the step's summary
 * ($GITHUB_STEP_SUMMARY) when there is one.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { UPLOAD_PHASES } from "../infra/runs/api-bucket";
import { RUNS_REGION } from "../infra/runs/stages";
import { NotStamped, OlderTree, parseRun, readTree, S3ApiStore, STAMP_KEY, UnexpectedKeys, UploadStopped, uploadTree } from "./lib/api-upload";

const USAGE = "usage: bun scripts/upload-api.ts --tree DIR --bucket NAME --run ID [--preflight] [--region R] [--endpoint URL]";

function toSummary(heading: string, text: string): void {
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${heading}\n\n${text}\n`);
}

/** What the summary says when the upload stopped, and why. */
export function stoppedSummary(error: unknown): string | null {
	if (error instanceof OlderTree) {
		return [
			`**Not uploaded: ${error.bucket} holds \`${error.key}\` as written by run ${error.newest}, later than this run, ${error.run}.** This tree is older than what is published, so nothing was written.`,
			"This happens when an older run's publish job is run again after a newer run published: there is nothing to do, the newer tree stays.",
		].join("\n");
	}
	if (error instanceof UnexpectedKeys) {
		return [
			`**Not uploaded: ${error.bucket} holds ${error.keys.length} key${error.keys.length === 1 ? "" : "s"} the tree does not have.** Nothing was written, so the published table of contents and list are those of the last upload that succeeded.`,
			"The upload deletes nothing. Decide for each key whether it goes, as the README says (\"The API bucket\", \"A key the tree does not have\"):",
			"",
			...error.keys.map((key) => `- \`${key}\``),
		].join("\n");
	}
	if (error instanceof UploadStopped) {
		return [
			`**The upload stopped in phase ${error.phase + 1} of ${UPLOAD_PHASES.length}, ${UPLOAD_PHASES[error.phase]}.** No later phase was started.`,
			"",
			...error.before.map((phase, index) => `- phase ${index + 1}, ${phase.phase}: ${phase.written.length} written, ${phase.unchanged} unchanged`),
			`- phase ${error.phase + 1}, ${UPLOAD_PHASES[error.phase]}: ${error.written.length} written, ${error.failed.length} failed:`,
			...error.failed.map((failure) => `  - \`${failure.key}\`: ${failure.error}`),
			"",
			"Until an upload succeeds, a Series file may list a month file's previous sha256 while the month's address gives the new bytes (readers check the sha256: README, \"The data API\"). The next run's upload writes what is still missing and repairs it.",
		].join("\n");
	}
	if (error instanceof NotStamped) {
		return [
			`**Every file of the tree is in ${error.bucket}, but recording run ${error.run} on \`${STAMP_KEY}\` failed:** ${error.reason}`,
			"",
			...error.phases.map((phase, index) => `- phase ${index + 1}, ${phase.phase}: ${phase.written.length} written, ${phase.unchanged} unchanged`),
			"",
			"Until an upload succeeds, the bucket does not record that this run published, so a retry of an earlier run's publish job would not be refused. Run this job again, or let the next run publish.",
		].join("\n");
	}
	return null;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { tree: { type: "string" }, bucket: { type: "string" }, run: { type: "string" }, preflight: { type: "boolean" }, region: { type: "string" }, endpoint: { type: "string" } },
	});
	const run = parseRun(values.run);
	if (!values.tree || !values.bucket || run === null) {
		console.error(USAGE);
		process.exit(2);
	}
	const preflight = values.preflight === true;
	const heading = preflight ? "### The API bucket, checked before the upload" : "### The data API's files to the API bucket";
	const started = performance.now();
	const files = readTree(values.tree);
	const store = new S3ApiStore(values.bucket, values.region ?? RUNS_REGION, values.endpoint === undefined ? {} : { endpoint: values.endpoint });
	let report: Awaited<ReturnType<typeof uploadTree>>;
	try {
		report = await uploadTree(store, files, { run, preflight });
	} catch (error) {
		const summary = stoppedSummary(error);
		if (summary !== null) toSummary(heading, summary);
		throw error;
	}
	const took = Math.round(performance.now() - started);
	const before = report.newestRunBefore === null ? "no object of it says which run wrote it" : `the latest run to write to it was ${report.newestRunBefore}`;
	if (preflight) {
		const lines = report.phases.map((phase, index) => `phase ${index + 1}, ${phase.phase}: ${phase.wouldWrite.length} to write, ${phase.unchanged} unchanged`);
		const total = report.phases.reduce((sum, phase) => sum + phase.wouldWrite.length, 0);
		const stamp = report.stamped ? `, then ${STAMP_KEY} again, unchanged, to record this run` : "";
		const summary = `${store.name} holds nothing the tree lacks, and ${before} (this is run ${run}): ${total} of ${files.length} files to write${stamp}, nothing written, in ${took} ms`;
		for (const line of lines) console.log(line);
		console.log(summary);
		toSummary(heading, `${summary}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
		return;
	}
	const lines = report.phases.map((phase, index) => `phase ${index + 1}, ${phase.phase}: ${phase.written.length} written, ${phase.unchanged} unchanged`);
	const byReason = new Map<string, number>();
	for (const reason of report.reasons.values()) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
	const why = [...byReason].map(([reason, count]) => `${count} ${reason}`).join(", ");
	const total = report.phases.reduce((sum, phase) => sum + phase.written.length, 0);
	const stamp = report.stamped ? `, and ${STAMP_KEY} written again, unchanged, to record this run` : "";
	const summary = `data API v1 to ${store.name}: ${files.length} files, ${total} written${why === "" ? "" : ` (${why})`} by run ${run}${stamp}, nothing deleted, in ${took} ms`;
	for (const line of lines) console.log(line);
	console.log(summary);
	toSummary(heading, `${summary}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
