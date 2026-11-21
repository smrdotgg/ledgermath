/**
 * The check of the data API's publishing, whole (ADR-0032), as a process of
 * its own, which the alarm (scripts/alarm.ts) starts, in a process group of
 * its own, with only CHILD_ENVIRONMENT, and kills, group and all, if it has
 * not finished within its budget:
 *
 *     bun scripts/check-api-publishing.ts --bucket NAME --now ISO-8601 --public-api-state STATE [--endpoint URL]
 *
 *   --bucket NAME            the API bucket (API_BUCKET); empty: unset, and nothing is read
 *   --now ISO-8601           the alarm's clock, which the line for the step summary is judged at
 *   --public-api-state STATE PUBLIC_API.state, which says what an unset API_BUCKET means
 *   --endpoint URL           a stand-in for S3, path-style; the tests use it
 *
 * Reads when v1/index.json was last written, in the Region every -runs stage
 * is in (RUNS_REGION), and prints what it read as one line of JSON from a
 * closed set (CheckResult, scripts/lib/api-freshness.ts): no words. What S3
 * said goes to stderr, which the alarm copies to the job's log. Writes the
 * line for the step's summary to $GITHUB_STEP_SUMMARY when there is one,
 * which may block, as a file may: the alarm's kill bounds it. Exits 0 with a
 * result, 2 when its arguments are wrong. Credentials come from the
 * environment, as aws-actions/configure-aws-credentials sets them.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { RUNS_REGION } from "../infra/runs/stages";
import { apiReport, checkApiBucket } from "./lib/api-freshness";
import { S3ApiStore } from "./lib/api-upload";

if (import.meta.main) {
	const { values } = parseArgs({ options: { bucket: { type: "string" }, now: { type: "string" }, "public-api-state": { type: "string" }, endpoint: { type: "string" } } });
	const now = new Date(values.now ?? "");
	const publicApiState = values["public-api-state"] ?? "";
	if (Number.isNaN(now.getTime()) || publicApiState === "") {
		console.error("usage: bun scripts/check-api-publishing.ts --bucket NAME --now ISO-8601 --public-api-state STATE [--endpoint URL]");
		process.exit(2);
	}
	const bucket = values.bucket ?? "";
	const endpoint = values.endpoint;
	const reader = bucket === "" ? null : new S3ApiStore(bucket, RUNS_REGION, endpoint === undefined ? {} : { endpoint });
	const result = await checkApiBucket(reader, { log: (line) => console.error(line) });
	try {
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### The API bucket\n\n${apiReport(result, bucket, now, publicApiState).summary}\n`);
	} catch (error) {
		console.error(`the API bucket's line could not be written to the step's summary (${error instanceof Error ? error.message : String(error)}); carrying on`);
	}
	console.log(JSON.stringify(result));
}
