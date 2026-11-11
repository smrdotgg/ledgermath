// Checks what a scenario of scripts/box-in-container/run.sh should have left in
// the stubbed bucket, the box's exit status and its shutdown calls.
//
//   bun scripts/box-in-container/expect.ts <scenario> <bucket dir> <exit status> <run.sh OUT>

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appliesTo, type Schedule } from "../../infra/runs/schedule";
import { readStream } from "../../methods/run";
import { checkDiskRuns } from "../check-disk-runs";
import { checkBucketDirectory, readTarGz, type RunRecord } from "../check-runs";
import { filesUnder as everyFileUnder, findSecrets } from "../lib/secret-search";

interface Execution {
	benchmark: string;
	build: string;
	params: unknown;
}

interface BootSummary {
	provider: { instance_type?: string | null };
	runs: Array<{ id: string }>;
	not_run: Array<Execution & { reason?: string }>;
	build_failures: Array<{ benchmark: string; build: string; message: string }>;
	services?: Record<string, Record<string, string>>;
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
/** A Run's events: its stdout blob's lines, as every reader reads them. */
const eventsOf = (run: RunRecord) => readStream(readFileSync(join(bucket, "blobs", "sha256", run.stdout.replace("sha256:", "")))).events;
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
			...eventsOf(run).filter((event) => event.event === "observed").map((event) => event.values as Record<string, unknown>),
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
		const pairs = eventsOf(run).filter((event) => event.event === "cpu_pair").length;
		expect(pairs === params.threads - 1, `${label}: ${pairs} cpu_pair events, expected ${params.threads - 1}`);
		const threads = eventsOf(run).find((event) => event.event === "mutex_threads")?.threads;
		expect(Array.isArray(threads) && threads.length === params.threads, `${label}: mutex_threads does not list its ${params.threads} threads`);
	}
}

// Every disk Run says which disk it measured, and its dump proves it
// (scripts/check-disk-runs.ts). Here the root volume's disk directory is a
// tmpfs of the container's own, so its Runs find no block device: accepted
// here, and only here (acceptNoDevice); everything else is checked as on a box.
function diskRunsTieToTheirDumps(): void {
	const { problems: diskProblems } = checkDiskRuns(bucket, { acceptNoDevice: true });
	for (const problem of diskProblems) problems.push(`check-disk-runs: ${problem}`);
	expect(runs.some((run) => String(run.benchmark).startsWith("disk_")), "no disk Run, though the schedule names disk benchmarks");
}

// The container has no device node of this machine's disks, so provision.py
// must have prepared none, whatever it found in /sys, and said why; and the
// root volume's Fixture was made.
function provisionPreparedNothing(): void {
	const run = runs[0];
	if (!run) return;
	const index = readJson<{ sections: Record<string, string> }>(join(bucket, "blobs", "sha256", run.environment.before.replace("sha256:", "")));
	const hash = index.sections.provision;
	expect(hash !== undefined, "the dump has no provision section");
	if (hash === undefined) return;
	const section = readJson<Record<string, string | null>>(join(bucket, "blobs", "sha256", hash.replace("sha256:", "")));
	const text = Object.values(section)[0];
	expect(typeof text === "string", "the provision section holds no record");
	if (typeof text !== "string") return;
	const record = JSON.parse(text) as {
		state?: string;
		decisions: Array<{ what: string; action: string }>;
		steps: Array<{ command: string[] }>;
		fixtures: Array<{ disk: string; made: boolean }>;
	};
	const store = record.decisions.find((decision) => decision.what === "instance_store");
	expect(store !== undefined && store.action !== "prepare", `provision.py's instance-store decision is ${JSON.stringify(store)}, expected none or refuse`);
	expect(!record.steps.some((step) => step.command[0] === "mkfs.xfs" || step.command[0] === "mount"), "provision.py ran mkfs.xfs or mount in the container");
	expect(record.state === "done" || record.state === "failed", `the provision record's state is ${String(record.state)}, expected done, or failed for the refusal`);
	expect(record.fixtures.some((fixture) => fixture.disk === "root_volume" && fixture.made), "the root volume's Fixture was not made");
}

// ---- http_get against the stand-in for S3 ----

/** The keys the aws stand-in's `sts assume-role` hands out (scripts/box-in-container/aws). */
function standinKeys(): Record<string, string> {
	const stub = readFileSync(join(import.meta.dir, "aws"), "utf8");
	const line = /^STANDIN_KEYS = (\{.*\})$/m.exec(stub)?.[1];
	if (line === undefined) throw new Error("scripts/box-in-container/aws has no STANDIN_KEYS line");
	return JSON.parse(line) as Record<string, string>;
}

const blobJson = <T>(hash: string): T => readJson<T>(join(bucket, "blobs", "sha256", hash.replace("sha256:", "")));
const httpGetRuns = (): RunRecord[] => runs.filter((run) => run.benchmark === "http_get");

// Each http_get Run says which Service inputs it was given: the stand-in's
// endpoint and the Region, and the keys by name; no other Run names a Service.
function httpGetRunsSayTheirService(): void {
	const endpoint = readFileSync(join(out, "fixtures-endpoint"), "utf8").trim();
	for (const run of runs) {
		if (run.benchmark !== "http_get") {
			expect(run.service === undefined, `run ${run.id} (${run.benchmark}) names a Service`);
			continue;
		}
		expect(
			JSON.stringify(run.service) ===
				JSON.stringify({
					name: "s3_fixtures",
					inputs: { endpoint, region: "us-east-2" },
					secret_inputs: ["aws_access_key_id", "aws_secret_access_key", "aws_session_token"],
				}),
			`http_get run ${run.id}'s service is ${JSON.stringify(run.service)}`,
		);
	}
}

// The keys reached the binary: every request the stand-in received was signed
// with the stand-in key ID and carried its session token.
function standinGotTheKeys(): void {
	const keys = standinKeys();
	const path = join(out, "standin", "requests.ndjson");
	const requests = existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as { target: string; headers: Array<[string, string]> })
		: [];
	const header = (request: (typeof requests)[number], name: string): string | undefined =>
		request.headers.find(([key]) => key.toLowerCase() === name)?.[1];
	const wanted = schedule.benchmarks
		.filter((entry) => entry.name === "http_get")
		.reduce((sum, entry) => sum + entry.params.length * (entry.samples + 1), 0);
	expect(requests.length === wanted, `the stand-in received ${requests.length} requests, expected ${wanted} (each set's samples and its warmup)`);
	for (const request of requests) {
		expect(header(request, "x-amz-security-token") === keys.SessionToken, `a request for ${request.target} did not carry the stand-in session token`);
		expect(
			(header(request, "authorization") ?? "").startsWith(`AWS4-HMAC-SHA256 Credential=${keys.AccessKeyId}/`),
			`a request for ${request.target} was not signed with the stand-in key ID`,
		);
	}
}

// No key is in anything the box wrote: the bucket (Runs, blobs, boot summary,
// log; not AWS-LC's archive, which the deploy put there), the box's work
// directory and log, and the aws command lines. Of the source tree the box
// unpacked, what it was given as it was given is left out (this stand-in's
// own file holds the keys); what it built there is searched.
function noKeyAnywhere(): void {
	const keys = standinKeys();
	const tls = join(bucket, readFileSync(join(out, "tls-archive"), "utf8").trim());
	const [archive] = filesUnder("source", ".tar.gz");
	const given = archive ? readTarGz(readFileSync(archive)) : new Map<string, Buffer>();
	const src = join(out, "box-work", "ledgermath", "src");
	const written = everyFileUnder(join(out, "box-work")).filter((path) => {
		if (!path.startsWith(`${src}/`)) return true;
		const original = given.get(path.slice(src.length + 1));
		return original === undefined || !original.equals(readFileSync(path));
	});
	expect(given.size > 0 && written.some((path) => path.startsWith(`${src}/benchmarks/`)), "the box's builds under its source tree were not searched");
	const found = findSecrets(
		[...everyFileUnder(bucket).filter((path) => path !== tls), ...written, join(out, "console.log"), join(out, "calls", "sts.log")],
		{ aws_access_key_id: keys.AccessKeyId as string, aws_secret_access_key: keys.SecretAccessKey as string, aws_session_token: keys.SessionToken as string },
	);
	for (const { path, secret, form } of found) problems.push(`${path} holds ${secret} (as ${JSON.stringify(form)})`);
	expect(existsSync(join(out, "box-work", "ledgermath", "out")), "the box's work directory was not copied out, so it was not searched");
}

// Around every Run the dump holds the network's settings and counters; once
// per boot, the path to S3 from the EC2 API (or why it was not taken).
function networkSectionsAroundEveryRun(): void {
	for (const run of runs) {
		for (const hash of [run.environment.before, run.environment.after]) {
			const sections = blobJson<{ sections: Record<string, string> }>(hash).sections;
			for (const name of ["network", "net_counters", "ec2_route_tables", "ec2_vpc_endpoints"]) {
				expect(sections[name] !== undefined, `run ${run.id}'s dump ${hash} has no ${name} section`);
			}
			const counters = sections.net_counters ? blobJson<Record<string, unknown>>(sections.net_counters) : {};
			expect(Object.keys(counters).some((key) => key.startsWith("$ ethtool -S")), `run ${run.id}'s net_counters has no ethtool -S`);
		}
	}
}

function printHttpGetSizes(): void {
	for (const run of httpGetRuns()) {
		const day = run.started_at.slice(0, 10).replaceAll("-", "/");
		const size = readFileSync(join(bucket, "runs", day, `${run.id}.json`)).length;
		const stdout = readFileSync(join(bucket, "blobs", "sha256", run.stdout.replace("sha256:", ""))).length;
		const params = run.params as { object_bytes: number; connection: string };
		console.log(`size ${params.object_bytes} ${params.connection}: Run file ${size} B, stdout ${stdout} B, ${eventsOf(run).length} events`);
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
		diskRunsTieToTheirDumps();
		provisionPreparedNothing();
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
		provisionPreparedNothing();
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
	case "http-get": {
		expect(status === 0, `exit status ${status}, expected 0`);
		everyRunChecksOut();
		everyExecutionRanOnceAndExitedZero();
		expect(runs.length === planned, `${runs.length} Runs, expected ${planned}`);
		expect(httpGetRuns().length === 5, `${httpGetRuns().length} http_get Runs, expected 5`);
		httpGetRunsSayTheirService();
		standinGotTheKeys();
		noKeyAnywhere();
		networkSectionsAroundEveryRun();
		expect(typeof boot?.services?.s3_fixtures?.expires_at === "string", "the boot summary does not say until when the keys hold");
		expect(log.includes("AWS-LC's source archive is"), "the log does not say AWS-LC's archive was fetched and checked");
		expect(boot?.not_run.length === 0 && boot?.build_failures.length === 0, "the boot summary lists executions not run or builds that failed");
		printHttpGetSizes();
		break;
	}
	case "http-get-no-archive": {
		expect(status === 1, `exit status ${status}, expected 1 (a build failed)`);
		everyRunChecksOut();
		expect(log.includes("could not fetch AWS-LC's source archive"), "the log does not say AWS-LC's archive could not be fetched");
		const failures = boot?.build_failures ?? [];
		expect(failures.length === 1 && failures[0]?.benchmark === "http_get" && failures[0]?.build === "static", `build failures: ${JSON.stringify(failures)}`);
		expect((failures[0]?.message ?? "").includes("no source archive"), "http_get's build failure does not say it had no source archive");
		expect(httpGetRuns().length === 0, "an http_get Run exists, though it did not build");
		const others = scheduled.filter((execution) => execution.benchmark !== "http_get");
		expect(runs.length === others.length && runs.every((run) => "code" in run.exit && run.exit.code === 0), "every other execution did not run once and exit 0");
		expect(!existsSync(join(out, "calls", "sts.log")), "assume-role was asked for, though nothing could use the keys");
		noKeyAnywhere();
		break;
	}
	case "http-get-refused": {
		expect(status === 1, `exit status ${status}, expected 1 (executions not run)`);
		everyRunChecksOut();
		expect(log.includes("ledgermath-run: built http_get static "), "http_get did not build");
		const httpGet = scheduled.filter((execution) => execution.benchmark === "http_get");
		const notRun = boot?.not_run ?? [];
		expect(
			JSON.stringify(notRun.map((execution) => executionKey(execution.benchmark, execution.build, execution.params))) ===
				JSON.stringify(httpGet.map((execution) => executionKey(execution.benchmark, execution.build, execution.params))),
			`not_run is ${JSON.stringify(notRun)}`,
		);
		for (const execution of notRun) expect((execution.reason ?? "").includes("AccessDenied"), `not_run's reason is ${execution.reason}`);
		expect(typeof boot?.services?.s3_fixtures?.failed === "string", "the boot summary does not say the keys could not be had");
		expect(httpGetRuns().length === 0, "an http_get Run exists, though it had no keys");
		expect(runs.length === scheduled.length - httpGet.length, `${runs.length} Runs, expected ${scheduled.length - httpGet.length}`);
		noKeyAnywhere();
		break;
	}
	case "build-tools-refused": {
		// The tools only http_get needs could not be installed: the box goes on,
		// http_get alone fails to build, and everything else runs.
		expect(status === 1, `exit status ${status}, expected 1 (a build failed)`);
		expect(log.includes("Error: Unable to find a match: cmake"), "the log does not show dnf refusing cmake");
		expect(log.includes("http_get will not build"), "the log does not say http_get will not build");
		expect(boots.length === 1, `${boots.length} boot summaries, expected 1`);
		everyRunChecksOut();
		const failures = boot?.build_failures ?? [];
		expect(failures.length === 1 && failures[0]?.benchmark === "http_get" && failures[0]?.build === "static", `build failures: ${JSON.stringify(failures)}`);
		expect((failures[0]?.message ?? "").includes("cmake is not installed"), "http_get's build failure does not say cmake is missing");
		expect(httpGetRuns().length === 0, "an http_get Run exists, though it did not build");
		const others = scheduled.filter((execution) => execution.benchmark !== "http_get");
		expect(others.length > 0 && runs.length === others.length && runs.every((run) => "code" in run.exit && run.exit.code === 0), "every other execution did not run once and exit 0");
		expect(!existsSync(join(out, "calls", "sts.log")), "assume-role was asked for, though nothing could use the keys");
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
