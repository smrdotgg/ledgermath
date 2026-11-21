/**
 * The check of the data API's publishing, whole (ADR-0032), as a process of
 * its own, which the alarm (scripts/alarm.ts) starts and kills if it has not
 * finished within its budget:
 *
 *     bun scripts/check-api-publishing.ts --bucket NAME --now ISO-8601 --public-api-state STATE [--endpoint URL]
 *
 *   --bucket NAME            the API bucket (API_BUCKET); empty: unset, and nothing is read
 *   --now ISO-8601           the alarm's clock, which the age of v1/index.json is judged at
 *   --public-api-state STATE PUBLIC_API.state, which says what an unset API_BUCKET means
 *   --endpoint URL           a stand-in for S3, path-style; the tests use it
 *
 * Reads when v1/index.json was last written (scripts/lib/api-freshness.ts),
 * judges it, and prints the alarm's words for it as one line of JSON (an
 * ApiReport) on stdout; writes the line for the step's summary to
 * $GITHUB_STEP_SUMMARY when there is one, which may block, as a file may:
 * the alarm's kill bounds it. Whatever goes wrong in it is printed as the
 * report of a check that failed; it exits 0. Credentials come from the
 * environment, as aws-actions/configure-aws-credentials sets them.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { RUNS_REGION } from "../infra/runs/stages";
import { type ApiReport, apiReport, checkApiBucket, checkFailed } from "./lib/api-freshness";
import { S3ApiStore } from "./lib/api-upload";

async function report(): Promise<ApiReport> {
	const { values } = parseArgs({ options: { bucket: { type: "string" }, now: { type: "string" }, "public-api-state": { type: "string" }, endpoint: { type: "string" } } });
	const now = new Date(values.now ?? "");
	if (Number.isNaN(now.getTime())) throw new Error(`--now ${JSON.stringify(values.now)} is not a time`);
	const publicApiState = values["public-api-state"];
	if (publicApiState === undefined || publicApiState === "") throw new Error("--public-api-state is not given");
	const bucket = values.bucket ?? "";
	const endpoint = values.endpoint;
	const reader = bucket === "" ? null : new S3ApiStore(bucket, RUNS_REGION, endpoint === undefined ? {} : { endpoint });
	return apiReport(await checkApiBucket(reader), now, publicApiState);
}

if (import.meta.main) {
	let result: ApiReport;
	try {
		result = await report();
	} catch (error) {
		result = checkFailed(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
	}
	try {
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### The API bucket\n\n${result.summary}\n`);
	} catch (error) {
		console.error(`the API bucket's line could not be written to the step's summary (${error instanceof Error ? error.message : String(error)}); carrying on`);
	}
	console.log(JSON.stringify(result));
}
