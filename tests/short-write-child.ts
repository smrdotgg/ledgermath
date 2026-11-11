/**
 * Run by tests/short-write.test.ts in a child process whose file-size limit
 * (ulimit -f) is smaller than the file it adds to the Runs repository, so the
 * write of that file comes up short. Prints one line of JSON: what the caller
 * returned, or the error it threw.
 *
 *     bun tests/short-write-child.ts prices REPOSITORY WORK SOURCES
 *     bun tests/short-write-child.ts copy BUCKET_DIRECTORY REPOSITORY
 *
 * prices: the price fetch, with the offer files served from SOURCES/<offer code>.json
 * under their versioned URLs (they must be smaller than the limit; the price
 * file it makes is larger). copy: the copy job, from a directory laid out like
 * the bucket.
 */

import { join } from "node:path";

import { parseSchedule } from "../infra/runs/schedule";
import { copyRuns } from "../scripts/copy-runs";
import { fetchPrices } from "../scripts/fetch-prices";
import { DirectoryBucket } from "../scripts/lib/bucket";
import type { OfferCode } from "../scripts/lib/price-rules";
import { FETCHED_AT, fakeFetch, MEASURED, sourceUrl, VERSIONS } from "./prices-fixtures";

async function main(): Promise<unknown> {
	const [mode, ...paths] = process.argv.slice(2);
	if (mode === "prices") {
		const [repository, work, sources] = paths as [string, string, string];
		const routes = Object.fromEntries((Object.keys(VERSIONS) as OfferCode[]).map((code) => [sourceUrl(code), { file: join(sources, `${code}.json`) }]));
		const schedule = parseSchedule({
			vcpu_quota: { limit: 64, reserved_outside_schedule: 4 },
			targets: MEASURED.instance_types.map((type, i) => ({ instance_type: type, vcpus: 2, zone: "us-east-2c", boots_utc: [`0${i}:10`] })),
			benchmarks: [{ name: "syscall", builds: ["static"], samples: 10, timeout_seconds: 120, params: [{ call: "getpid" }] }],
		});
		const result = await fetchPrices({ repository, work, schedule, now: FETCHED_AT, fetcher: fakeFetch(routes).fetch, log: () => {} });
		return { outcome: result.outcome, path: result.path };
	}
	if (mode === "copy") {
		const [bucket, repository] = paths as [string, string];
		return copyRuns(new DirectoryBucket(bucket), repository);
	}
	throw new Error(`unknown mode ${mode}`);
}

main().then(
	(result) => console.log(JSON.stringify({ result })),
	(error: unknown) => console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })),
);
