/**
 * Copies one -runs stage's bucket into another's, across two accounts, and
 * checks the copy (scripts/lib/bucket-copy.ts says exactly how):
 *
 *     bun scripts/copy-bucket.ts copy   FROM TO [--dry-run]
 *     bun scripts/copy-bucket.ts verify FROM TO --runs-repository DIR (--check-dir DIR | --no-check-runs)
 *
 *     FROM = --from-bucket NAME --from-profile PROFILE
 *     TO   = --to-bucket NAME --to-profile PROFILE
 *     [--region us-east-2] [--concurrency 16] [--memory-mib 256]
 *
 * copy: every object under blobs/, runs/, boots/ and logs/ of FROM that TO
 * lacks, read with FROM's profile and written with TO's. It only ever adds;
 * an object TO already holds is compared, and one that differs stops it
 * before anything is written. Stopped, it can be run again and carries on; a
 * second complete run copies nothing. --dry-run lists and compares, and says
 * what it would copy, writing nothing.
 *
 * verify: reads only. Every object of FROM under those prefixes is in TO with
 * the same bytes; every file under runs/ and boots/ of the Runs repository is
 * in TO with the same bytes; and scripts/check-runs.ts passes on TO's blobs/,
 * runs/ and boots/, written into --check-dir (an empty or new directory,
 * about as large as the bucket). --no-check-runs leaves that last check out,
 * and the verification is then reported as incomplete.
 *
 * Each profile's keys come from `aws configure export-credentials --profile`,
 * are held in memory only, and are never printed (scripts/lib/aws-credentials.ts).
 * --endpoint points both at a stand-in for S3; the tests use it.
 *
 * Exit status 0 when it did all it was asked and found nothing wrong, 1 when
 * it stopped or found a problem, 2 on bad usage.
 */

import { parseArgs } from "node:util";

import { RUNS_REGION } from "../infra/runs/stages";
import { profileCredentials } from "./lib/aws-credentials";
import { describeS3Error, S3Bucket } from "./lib/bucket";
import { type CopyReport, CopyStopped, copyBucket, COPIED_PREFIXES, verifyCopy } from "./lib/bucket-copy";

const USAGE = [
	"usage: bun scripts/copy-bucket.ts copy   --from-bucket NAME --from-profile PROFILE --to-bucket NAME --to-profile PROFILE [--dry-run]",
	"       bun scripts/copy-bucket.ts verify --from-bucket NAME --from-profile PROFILE --to-bucket NAME --to-profile PROFILE",
	"                                         --runs-repository DIR (--check-dir DIR | --no-check-runs)",
	"       either: [--region us-east-2] [--concurrency 16] [--memory-mib 256]",
].join("\n");

const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;

function printCopyReport(report: CopyReport, seconds: number): void {
	for (const prefix of COPIED_PREFIXES) {
		const listed = report.listed[prefix];
		console.log(`  source ${prefix.padEnd(7)} ${String(listed.count).padStart(7)} objects  ${mb(listed.bytes).padStart(10)}`);
	}
	console.log(`  already at the destination, the same: ${report.same.count} objects, ${mb(report.same.bytes)}`);
	console.log(`  ${report.dryRun ? "would copy" : "copied"}: ${report.copied.count} objects, ${mb(report.copied.bytes)} (${report.copied.bytes} bytes)`);
	console.log(`  most held in memory at once: ${mb(report.peakBytesHeld)}; ${seconds.toFixed(1)} s`);
}

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		options: {
			"from-bucket": { type: "string" },
			"from-profile": { type: "string" },
			"to-bucket": { type: "string" },
			"to-profile": { type: "string" },
			region: { type: "string" },
			endpoint: { type: "string" },
			concurrency: { type: "string" },
			"memory-mib": { type: "string" },
			"dry-run": { type: "boolean" },
			"runs-repository": { type: "string" },
			"check-dir": { type: "string" },
			"no-check-runs": { type: "boolean" },
		},
		allowPositionals: true,
	});
	const [command] = positionals;
	const fromBucket = values["from-bucket"];
	const fromProfile = values["from-profile"];
	const toBucket = values["to-bucket"];
	const toProfile = values["to-profile"];
	const concurrency = Number(values.concurrency ?? "16");
	const memoryMib = Number(values["memory-mib"] ?? "256");
	const usable =
		positionals.length === 1 &&
		(command === "copy" || command === "verify") &&
		fromBucket !== undefined &&
		fromProfile !== undefined &&
		toBucket !== undefined &&
		toProfile !== undefined &&
		Number.isInteger(concurrency) &&
		concurrency >= 1 &&
		Number.isInteger(memoryMib) &&
		memoryMib >= 1 &&
		(command === "copy"
			? values["runs-repository"] === undefined && values["check-dir"] === undefined && values["no-check-runs"] === undefined
			: values["dry-run"] === undefined &&
				values["runs-repository"] !== undefined &&
				(values["check-dir"] === undefined) !== (values["no-check-runs"] === undefined));
	if (!usable) {
		console.error(USAGE);
		return 2;
	}
	if (fromBucket === toBucket && values.endpoint === undefined) {
		console.error(`the source and the destination are the same bucket, ${fromBucket}`);
		return 2;
	}

	const region = values.region ?? RUNS_REGION;
	const endpoint = values.endpoint === undefined ? {} : { endpoint: values.endpoint };
	const source = new S3Bucket(fromBucket as string, region, { credentials: profileCredentials(fromProfile as string), ...endpoint });
	const destination = new S3Bucket(toBucket as string, region, { credentials: profileCredentials(toProfile as string), ...endpoint });
	const options = { concurrency, memoryBytes: memoryMib * 1024 * 1024, progress: (line: string) => console.log(`  ${line}`) };
	const started = performance.now();
	const seconds = (): number => (performance.now() - started) / 1000;

	if (command === "copy") {
		console.log(`${values["dry-run"] ? "dry run: " : ""}${source.name} (profile ${fromProfile}) -> ${destination.name} (profile ${toProfile})`);
		try {
			const report = await copyBucket(source, destination, { ...options, dryRun: values["dry-run"] === true });
			printCopyReport(report, seconds());
			return 0;
		} catch (error) {
			if (!(error instanceof CopyStopped)) throw error;
			console.error(error.message);
			printCopyReport(error.report, seconds());
			return 1;
		}
	}

	console.log(`verifying ${destination.name} (profile ${toProfile}) against ${source.name} (profile ${fromProfile})`);
	const checkDirectory = values["check-dir"] ?? null;
	const report = await verifyCopy(source, destination, { ...options, runsRepository: values["runs-repository"] as string, checkDirectory });
	console.log(`  source objects at the destination, the same bytes: ${report.same.count} (${mb(report.same.bytes)})`);
	console.log(`  objects at the destination only: ${report.onlyAtDestination}`);
	console.log(`  files of the Runs repository at the destination, the same bytes: ${report.repositoryFiles}`);
	if (report.checkRuns === null) console.log("  scripts/check-runs.ts: not run (--no-check-runs): THE VERIFICATION IS INCOMPLETE");
	else {
		console.log(`  scripts/check-runs.ts ${checkDirectory}: ${report.checkRuns.passed ? "passed" : "FAILED"}`);
		for (const line of report.checkRuns.output.trimEnd().split("\n").slice(-15)) console.log(`    ${line}`);
	}
	for (const problem of report.problems) console.error(`PROBLEM: ${problem}`);
	console.log(`${report.problems.length === 0 ? "the copy checks out" : `${report.problems.length} problem(s)`}; ${seconds().toFixed(1)} s`);
	return report.problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	main().then(
		(status) => process.exit(status),
		(error: unknown) => {
			console.error(describeS3Error(error));
			process.exit(1);
		},
	);
}
