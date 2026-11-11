// Checks what a scenario of scripts/box-in-container/run.sh should have left in
// the stubbed bucket, the box's exit status and its shutdown calls.
//
//   bun scripts/box-in-container/expect.ts <scenario> <bucket dir> <exit status> <run.sh OUT>

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appliesTo, type Schedule } from "../../infra/runs/schedule";
import { checkBucketDirectory, type RunRecord } from "../check-runs";

interface Execution {
	benchmark: string;
	build: string;
	params: unknown;
}

interface BootSummary {
	provider: { instance_type?: string | null };
	runs: Array<{ id: string }>;
	not_run: unknown[];
	build_failures: unknown[];
	left_out: Array<Execution & { instance_types: string[] }>;
	stopped_by?: number;
}

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
const logs = filesUnder("logs", ".log");
const log = logs[0] ? readFileSync(logs[0], "utf8") : "";
const putsPath = join(out, "calls", "puts.log");
const puts = existsSync(putsPath) ? readFileSync(putsPath, "utf8").trim().split("\n") : [];
const blobPuts = puts.filter((key) => key.startsWith("blobs/"));
const powerPath = join(out, "calls", "power.log");
const power = existsSync(powerPath) ? readFileSync(powerPath, "utf8").trim().split("\n") : [];
// The schedule.json the box booted with, which run.sh saved.
const schedule = readJson<Schedule>(join(out, "schedule.json"));
const executionKey = (benchmark: unknown, build: unknown, params: unknown): string => JSON.stringify([benchmark, build, params]);
const boots = filesUnder("boots", ".json").map((path) => readJson<BootSummary>(path));
const boot = boots[0];
// The executions the schedule names for the type the box said it was, and the
// ones for other types, which it leaves out.
const instanceType = boot?.provider.instance_type ?? null;
const executions = (forThisType: boolean): Execution[] =>
	schedule.benchmarks
		.filter((entry) => appliesTo(entry, instanceType) === forThisType)
		.flatMap((entry) => entry.params.flatMap((params) => entry.builds.map((build) => ({ benchmark: entry.name, build, params }))));
const scheduled = executions(true);
const others = executions(false);
const planned = scheduled.length;

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
	for (const { benchmark, build, params } of scheduled) {
		const key = executionKey(benchmark, build, params);
		expect(seen.get(key) === 1, `${seen.get(key) ?? 0} Runs of ${key}, expected 1`);
	}
}

// The boot summary lists every execution of an entry for other types under
// left_out, in the schedule's order, and nothing else.
function everyOtherExecutionLeftOut(): void {
	const listed = (boot?.left_out ?? []).map((execution) => executionKey(execution.benchmark, execution.build, execution.params));
	const expected = others.map((execution) => executionKey(execution.benchmark, execution.build, execution.params));
	expect(
		JSON.stringify(listed) === JSON.stringify(expected),
		`the boot summary leaves out ${JSON.stringify(listed)}, expected ${JSON.stringify(expected)}`,
	);
}

// Every mutex Run that exited 0 says where its threads ran: one CPU each, on
// distinct cores or on one core as its placement asks; one cpu_pair event per
// thread after the first; and every thread in mutex_threads.
function mutexRunsSayWhereTheyRan(): void {
	for (const run of runs) {
		if (run.benchmark !== "mutex" || !("code" in run.exit) || run.exit.code !== 0) continue;
		const params = run.params as { threads: number; placement: string };
		const label = `mutex run ${run.id} ${JSON.stringify(params)}`;
		const observed: Record<string, unknown> = Object.assign(
			{},
			...run.events.filter((event) => event.event === "observed").map((event) => event.values as Record<string, unknown>),
		);
		const cpus = String(observed.cpus).split(",");
		const packages = String(observed.package_ids).split(",");
		const cores = String(observed.core_ids)
			.split(",")
			.map((core, index) => `${packages[index]}/${core}`);
		expect(
			observed.threads_used === params.threads && new Set(cpus).size === params.threads && cores.length === params.threads,
			`${label}: observed ${JSON.stringify(observed)}`,
		);
		if (params.placement === "distinct_cores") expect(new Set(cores).size === params.threads, `${label}: its threads share a core (${cores})`);
		if (params.placement === "smt_siblings") expect(new Set(cores).size === 1, `${label}: its threads are on more than one core (${cores})`);
		const pairs = run.events.filter((event) => event.event === "cpu_pair").length;
		expect(pairs === params.threads - 1, `${label}: ${pairs} cpu_pair events, expected ${params.threads - 1}`);
		const threads = run.events.find((event) => event.event === "mutex_threads")?.threads;
		expect(Array.isArray(threads) && threads.length === params.threads, `${label}: mutex_threads does not list its ${params.threads} threads`);
	}
}

const interrupted = runs.filter((run) => run.exit.runner_signal !== undefined);

switch (scenario) {
	case "ok": {
		expect(status === 0, `exit status ${status}, expected 0`);
		everyRunChecksOut();
		everyExecutionRanOnceAndExitedZero();
		everyOtherExecutionLeftOut();
		mutexRunsSayWhereTheyRan();
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
		everyOtherExecutionLeftOut();
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
	case "instance-types": {
		expect(status === 0, `exit status ${status}, expected 0`);
		expect(instanceType === "m5.large", `the boot summary says the box is ${instanceType}, expected the fake IMDS's m5.large`);
		for (const run of runs) {
			const type = (run.provider as { instance_type?: unknown }).instance_type;
			expect(type === "m5.large", `run ${run.id} says it ran on ${String(type)}`);
		}
		everyRunChecksOut();
		everyExecutionRanOnceAndExitedZero();
		everyOtherExecutionLeftOut();
		mutexRunsSayWhereTheyRan();
		expect(
			runs.some((run) => run.benchmark === "mutex" && (run.params as { threads?: unknown }).threads === 2),
			"no two-thread mutex Run, which the scenario's schedule names for an m5.large",
		);
		expect(runs.length === planned && planned > 0, `${runs.length} Runs, expected ${planned}`);
		expect(others.length > 0, "the schedule leaves nothing out on this type, so the scenario shows nothing");
		expect(boot?.not_run.length === 0 && boot?.build_failures.length === 0, "the boot summary lists executions not run or builds that failed");
		// Each benchmark that ran was built once per build, however many entries
		// name it; one only for other types was not built at all.
		for (const entry of schedule.benchmarks) {
			for (const build of entry.builds) {
				const built = log.split("\n").filter((line) => line.includes(`ledgermath-run: built ${entry.name} ${build} `)).length;
				const wanted = schedule.benchmarks.some((other) => other.name === entry.name && other.builds.includes(build) && appliesTo(other, instanceType)) ? 1 : 0;
				expect(built === wanted, `${entry.name} ${build} was built ${built} times, expected ${wanted}`);
			}
		}
		break;
	}
	default:
		problems.push(`unknown scenario ${scenario}`);
}

for (const problem of problems) console.error(`FAIL ${scenario}: ${problem}`);
if (problems.length > 0) process.exit(1);
const stoppedIn = interrupted[0] ? `; stopped in run ${interrupted[0].id}, exit ${JSON.stringify(interrupted[0].exit)}` : "";
console.log(
	`ok ${scenario}: exit status ${status}, ${runs.length} Runs, ${boot?.not_run.length ?? 0} not run, ${boot?.left_out?.length ?? 0} left out for other instance types${stoppedIn}`,
);
