// Checks what a scenario of scripts/box-in-container/run.sh should have left in
// the stubbed bucket, the box's exit status and its shutdown calls.
//
//   bun scripts/box-in-container/expect.ts <scenario> <bucket dir> <exit status> <run.sh OUT>

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { checkBucketDirectory, type RunRecord } from "../check-runs";

interface BootSummary {
	runs: Array<{ id: string }>;
	not_run: unknown[];
	build_failures: unknown[];
	stopped_by?: number;
}

const ROOT = resolve(import.meta.dir, "..", "..");
const args = process.argv.slice(2);
if (args.length !== 4) {
	console.error("usage: expect.ts <scenario> <bucket dir> <exit status> <run.sh OUT>");
	process.exit(2);
}
const [scenario, bucket, statusText, out] = args as [string, string, string, string];

const problems: string[] = [];
const expect = (holds: boolean, message: string): void => {
	if (!holds) problems.push(message);
};

function filesUnder(part: string, suffix: string): string[] {
	const directory = join(bucket, part);
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
		.map((entry) => join(entry.parentPath, entry.name));
}
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const status = Number(statusText);
const runs = filesUnder("runs", ".json").map((path) => readJson<RunRecord>(path));
const boots = filesUnder("boots", ".json").map((path) => readJson<BootSummary>(path));
const logs = filesUnder("logs", ".log");
const log = logs[0] ? readFileSync(logs[0], "utf8") : "";
const putsPath = join(out, "calls", "puts.log");
const puts = existsSync(putsPath) ? readFileSync(putsPath, "utf8").trim().split("\n") : [];
const blobPuts = puts.filter((key) => key.startsWith("blobs/"));
const powerPath = join(out, "calls", "power.log");
const power = existsSync(powerPath) ? readFileSync(powerPath, "utf8").trim().split("\n") : [];
const schedule = readJson<{ benchmarks: Array<{ name: string; builds: string[]; params: unknown[] }> }>(join(ROOT, "schedule.json"));
const planned = schedule.benchmarks.reduce((sum, b) => sum + b.builds.length * b.params.length, 0);
const executionKey = (benchmark: unknown, build: unknown, params: unknown): string => JSON.stringify([benchmark, build, params]);

// Every scenario: the timer first, a shutdown last, and the log in the bucket.
expect(power[0]?.startsWith("shutdown -h +45") === true, "the 45-minute timer was not the first thing set");
expect(power.at(-1) === "shutdown -h now", "the box did not shut down at the end");
expect(logs.length === 1, `expected one log in the bucket, found ${logs.length}`);

function everyRunChecksOut(): void {
	const result = checkBucketDirectory(bucket, { blobs: true });
	for (const problem of result.problems) problems.push(`check-runs: ${problem}`);
}

// The whole schedule ran: one Run of every benchmark, build and parameter set it
// names, each exiting 0. check-runs holds the stream of every Run that exited 0
// to check-events.py, so together they say every execution worked.
function everyExecutionRanOnceAndExitedZero(): void {
	const seen = new Map<string, number>();
	for (const run of runs) {
		const key = executionKey(run.benchmark, (run.binary as { build?: unknown } | undefined)?.build, run.params);
		seen.set(key, (seen.get(key) ?? 0) + 1);
		expect(
			"code" in run.exit && run.exit.code === 0 && run.exit.runner_signal === undefined,
			`run ${run.id} (${key}) exited ${JSON.stringify(run.exit)}`,
		);
	}
	for (const benchmark of schedule.benchmarks) {
		for (const build of benchmark.builds) {
			for (const params of benchmark.params) {
				const key = executionKey(benchmark.name, build, params);
				expect(seen.get(key) === 1, `${seen.get(key) ?? 0} Runs of ${key}, expected 1`);
			}
		}
	}
}

const interrupted = runs.filter((run) => run.exit.runner_signal !== undefined);
const boot = boots[0];

switch (scenario) {
	case "ok": {
		expect(status === 0, `exit status ${status}, expected 0`);
		everyRunChecksOut();
		everyExecutionRanOnceAndExitedZero();
		expect(runs.length === planned, `${runs.length} Runs, expected ${planned}`);
		expect(boots.length === 1, `${boots.length} boot summaries, expected 1`);
		expect(boot?.stopped_by === undefined && boot?.not_run.length === 0, "the boot summary says it was stopped");
		expect(interrupted.length === 0, "a Run says the runner was told to stop");
		break;
	}
	case "terminated":
	case "shutdown":
	case "budget": {
		if (scenario === "budget") {
			expect(status === 124, `exit status ${status}, expected 124 (the budget ran out)`);
			expect(log.includes("the time budget ran out"), "the log does not say the time budget ran out");
		} else {
			expect(status !== 0, "exit status 0, expected a failure");
		}
		everyRunChecksOut();
		expect(boots.length === 1, `${boots.length} boot summaries, expected 1`);
		expect(boot?.stopped_by === 15, `the boot summary's stopped_by is ${boot?.stopped_by}, expected 15`);
		expect((boot?.not_run.length ?? 0) > 0, "the boot summary lists nothing as not run");
		expect(
			(boot?.runs.length ?? 0) + (boot?.not_run.length ?? 0) + (boot?.build_failures.length ?? 0) === planned,
			"the boot summary's runs and not_run do not add up to the schedule",
		);
		expect(runs.length === (boot?.runs.length ?? -1), "the bucket's Runs are not the boot summary's");
		const last = [...runs].sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1);
		if (scenario === "budget") {
			// The TERM may land in a dump between executions; then no Run was in flight.
			expect(interrupted.length <= 1, `${interrupted.length} Runs say the runner was told to stop`);
		} else {
			expect(interrupted.length === 1, `${interrupted.length} Runs say the runner was told to stop, expected 1`);
		}
		for (const run of interrupted) {
			expect(run === last, "the Run the runner was told to stop in is not the last one");
			expect(run.exit.runner_signal === 15, `runner_signal is ${run.exit.runner_signal}, expected 15`);
			expect("signal" in run.exit, "the interrupted binary did not end by a signal");
		}
		break;
	}
	case "blobs-rejected": {
		expect(status !== 0, "exit status 0, expected a failure");
		expect(runs.length === 0, `${runs.length} Runs were published although their blobs were refused`);
		expect(boots.length === 0, `${boots.length} boot summaries were published although their blobs were refused`);
		expect(log.includes("UPLOAD FAILED: blobs/"), "the log does not say the blobs failed to upload");
		expect(log.includes("attempt 3 of 3 failed"), "the log does not show three attempts");
		break;
	}
	case "blobs-flaky": {
		expect(status === 0, `exit status ${status}, expected 0`);
		expect(log.includes("attempt 1 of 3 failed"), "the log does not show the failed first attempt");
		expect(new Set(blobPuts).size === blobPuts.length, "the retry uploaded again blobs the first attempt had put in");
		everyRunChecksOut();
		everyExecutionRanOnceAndExitedZero();
		expect(runs.length === planned, `${runs.length} Runs, expected ${planned}`);
		expect(boots.length === 1, `${boots.length} boot summaries, expected 1`);
		break;
	}
	case "blobs-present": {
		expect(status === 0, `exit status ${status}, expected 0`);
		everyRunChecksOut();
		everyExecutionRanOnceAndExitedZero();
		expect(runs.length === planned, `${runs.length} Runs, expected ${planned}`);
		const seeded = readFileSync(join(out, "seeded"), "utf8").trim().split("\n");
		for (const key of seeded) expect(!puts.includes(key), `${key} was in the bucket already and was uploaded again`);
		expect(blobPuts.length > 0, "no blob was uploaded at all");
		break;
	}
	default:
		problems.push(`unknown scenario ${scenario}`);
}

for (const problem of problems) console.error(`FAIL ${scenario}: ${problem}`);
if (problems.length > 0) process.exit(1);
const stoppedIn = interrupted[0] ? `; stopped in run ${interrupted[0].id}, exit ${JSON.stringify(interrupted[0].exit)}` : "";
console.log(
	`ok ${scenario}: exit status ${status}, ${runs.length} Runs, ${boot?.not_run.length ?? 0} not run${stoppedIn}`,
);
