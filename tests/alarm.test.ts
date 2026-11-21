import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { TARGETS } from "../infra/runs/placement";
import { parseSchedule, type Schedule, type Target } from "../infra/runs/schedule";
import { compareText } from "../methods/run";
import {
	ALARM_MARKER,
	ALARM_TITLE,
	alarmState,
	alarmText,
	describeSeries,
	GitHubIssues,
	type IssueTracker,
	MAX_BODY_CHARS,
	newestPriceFile,
	type OpenAlarm,
	runAlarm,
	STATE_MARKER,
	STEP_SUMMARY_LIST_BYTES,
	type StalePrices,
	type StaleSeries,
	staleHash,
	staleList,
	stalePrices,
	staleSeries,
	stateOf,
	type WatchedSeries,
	watchedSeries,
} from "../scripts/alarm";
import { apiReport } from "../scripts/lib/api-freshness";
import { HandMade } from "./hand-made-runs";

// They make hand-made Runs and read files; on a loaded machine that can take far longer than bun's five-second default.
setDefaultTimeout(60_000);

/** The schedule the box runs. Only the first tests read it: it changes whenever a benchmark is added. */
const REAL_SCHEDULE = parseSchedule(JSON.parse(readFileSync(join(import.meta.dir, "..", "schedule.json"), "utf8")));
const C6I: Target = { instance_type: "c6i.8xlarge", vcpus: 32, zone: "us-east-2c", boots_utc: ["22:10"] };
const QUOTA = { limit: 64, reserved_outside_schedule: 4 };
/** The schedule the alarm's behaviour is tested on: one target, eight Series, four parameter sets under two builds. */
const SCHEDULE: Schedule = {
	vcpu_quota: QUOTA,
	targets: [C6I],
	benchmarks: [
		{
			name: "memory_read",
			builds: ["static", "dynamic"],
			samples: 10,
			timeout_seconds: 600,
			params: [
				{ size_bytes: 1073741824, threads: 1, path: "scalar" },
				{ size_bytes: 1073741824, threads: 1, path: "avx2" },
				{ size_bytes: 1073741824, threads: "all", path: "scalar" },
				{ size_bytes: 1073741824, threads: "all", path: "avx2" },
			],
		},
	],
};
const HOUR = 3_600_000;
/** When the schedule last changed, in the tests where that is long enough ago not to matter. */
const SETTLED = new Date("2026-10-01T00:00:00Z");

/** Issues in memory, as GitHub keeps them. */
class FakeIssues implements IssueTracker {
	readonly issues: Array<{ number: number; title: string; body: string; open: boolean; comments: string[] }> = [];

	async findOpen(marker: string): Promise<OpenAlarm | null> {
		const issue = this.issues.find((candidate) => candidate.open && candidate.body.includes(marker));
		if (issue === undefined) return null;
		const posts = [issue.body, ...issue.comments.filter((comment) => comment.includes(STATE_MARKER))];
		return { number: issue.number, lastPost: posts.at(-1) as string };
	}

	/** Every post, body first. */
	posts(): string[] {
		return this.issues.flatMap((issue) => [issue.body, ...issue.comments]);
	}

	async open(title: string, body: string): Promise<number> {
		const number = this.issues.length + 1;
		this.issues.push({ number, title, body, open: true, comments: [] });
		return number;
	}

	async comment(issue: number, body: string): Promise<void> {
		const found = this.issues.find((candidate) => candidate.number === issue);
		if (found === undefined) throw new Error(`no issue ${issue}`);
		found.comments.push(body);
	}
}

/** One Run of every Series the schedule runs on `target`, a minute apart from `startedAt`, as one boot of that target would leave. */
function oneBoot(made: HandMade, startedAt: string, schedule: Schedule = SCHEDULE, target: Target = schedule.targets[0] as Target): void {
	let minute = 0;
	for (const benchmark of schedule.benchmarks) {
		if (benchmark.instance_types !== undefined && !benchmark.instance_types.includes(target.instance_type)) continue;
		for (const params of benchmark.params) {
			for (const build of benchmark.builds) {
				const at = new Date(Date.parse(startedAt) + minute++ * 60_000).toISOString();
				made.run({ startedAt: at, benchmark: benchmark.name, params, build, instanceType: target.instance_type, zone: target.zone });
			}
		}
	}
}

describe("the watched Series", () => {
	test("are every parameter set and build of schedule.json, on every target the entry is for, the targets the stage launches", () => {
		const watched = watchedSeries(REAL_SCHEDULE);
		const planned = REAL_SCHEDULE.targets.reduce(
			(sum, target) =>
				sum +
				REAL_SCHEDULE.benchmarks
					.filter((b) => b.instance_types === undefined || b.instance_types.includes(target.instance_type))
					.reduce((inner, b) => inner + b.builds.length * b.params.length, 0),
			0,
		);
		expect(watched.length).toBe(planned);
		expect(REAL_SCHEDULE.targets).toEqual([...TARGETS]);
		expect(new Set(watched.map((series) => series.instanceType))).toEqual(new Set(TARGETS.map((target) => target.instance_type)));
		for (const series of watched) expect(series.zone).toBe("us-east-2c");
		for (const target of TARGETS) {
			const here = watched.filter((series) => series.instanceType === target.instance_type);
			expect(new Set(here.map((series) => series.benchmark))).toEqual(
				new Set(
					REAL_SCHEDULE.benchmarks
						.filter((b) => b.instance_types === undefined || b.instance_types.includes(target.instance_type))
						.map((b) => b.name),
				),
			);
		}
	});

	test("include http_get's five sets on each of the five targets", () => {
		const httpGet = watchedSeries(REAL_SCHEDULE).filter((series) => series.benchmark === "http_get");
		expect(httpGet.length).toBe(5 * TARGETS.length);
		for (const target of TARGETS) {
			const here = httpGet.filter((series) => series.instanceType === target.instance_type);
			expect(here.map((series) => [series.params.object_bytes, series.params.connection, series.build])).toEqual([
				[4096, "new", "static"],
				[4096, "reused", "static"],
				[131072, "new", "static"],
				[131072, "reused", "static"],
				[16777216, "new", "static"],
			]);
		}
	});

	test("are all kept fresh by one boot of schedule.json on each target", () => {
		const boots = new HandMade();
		for (const target of REAL_SCHEDULE.targets) oneBoot(boots, "2026-11-12T22:10:00Z", REAL_SCHEDULE, target);
		expect(staleSeries(watchedSeries(REAL_SCHEDULE), boots.files, new Date("2026-11-13T22:10:00Z"), SETTLED)).toEqual([]);
	});
});

describe("the watched Series across targets", () => {
	const M5: Target = { instance_type: "m5.large", vcpus: 2, zone: "us-east-2c", boots_utc: ["22:20"] };
	const schedule: Schedule = {
		vcpu_quota: QUOTA,
		targets: [C6I, M5],
		benchmarks: [
			{ name: "syscall", builds: ["static"], samples: 10, timeout_seconds: 120, params: [{ call: "getpid" }] },
			{ name: "mutex", builds: ["static"], samples: 10, timeout_seconds: 180, params: [{ threads: 1 }] },
			{ name: "mutex", builds: ["static"], samples: 10, timeout_seconds: 180, params: [{ threads: 2, placement: "distinct_cores" }], instance_types: ["c6i.8xlarge"] },
		],
	};
	const label = (series: { benchmark: string; params: Record<string, unknown>; instanceType: string }) =>
		`${series.benchmark} ${JSON.stringify(series.params)} ${series.instanceType}`;

	test("are each entry on every target it is for, and only those", () => {
		expect(watchedSeries(schedule).map(label)).toEqual([
			'syscall {"call":"getpid"} c6i.8xlarge',
			'mutex {"threads":1} c6i.8xlarge',
			'mutex {"threads":2,"placement":"distinct_cores"} c6i.8xlarge',
			'syscall {"call":"getpid"} m5.large',
			'mutex {"threads":1} m5.large',
		]);
	});

	test("one target's boots do not keep another's Series fresh, and a Series not for a type is never stale there", () => {
		const made = new HandMade();
		oneBoot(made, "2026-11-12T22:10:00Z", schedule, C6I);
		const now = new Date("2026-11-13T22:10:00Z");
		// m5.large has not booted: both of its Series are stale, and the c6i.8xlarge-only one is not listed for it.
		expect(staleSeries(watchedSeries(schedule), made.files, now, SETTLED).map(label)).toEqual(['syscall {"call":"getpid"} m5.large', 'mutex {"threads":1} m5.large']);
		oneBoot(made, "2026-11-12T22:20:00Z", schedule, M5);
		expect(staleSeries(watchedSeries(schedule), made.files, now, SETTLED)).toEqual([]);
	});
});

describe("the alarm", () => {
	const newest = "2026-11-12T22:10:00Z";
	const made = new HandMade();
	oneBoot(made, "2026-11-11T22:10:00Z");
	oneBoot(made, newest);
	// The newest Run's start: the last of the boot, seven minutes after its first.
	const newestStart = Date.parse(newest) + 7 * 60_000;
	const pass = (tracker: FakeIssues, at: number, copyFailed = false, runs = made.files) =>
		runAlarm({ schedule: SCHEDULE, runs, now: new Date(at), scheduleChangedAt: SETTLED, copyFailed, tracker });

	test("with the clock 49 hours past the newest Run, opens one issue listing every stale Series", async () => {
		const tracker = new FakeIssues();
		const outcome = await pass(tracker, newestStart + 49 * HOUR);
		expect(outcome.action).toBe("opened");
		expect(outcome.stale.length).toBe(8);
		expect(tracker.issues.length).toBe(1);
		const [issue] = tracker.issues;
		expect(issue?.title).toBe(ALARM_TITLE);
		expect(issue?.body.startsWith(`${ALARM_MARKER}\nChecked at`)).toBe(true);
		expect(issue?.body).toContain("8 watched Series have had no Run for more than 48 hours");
		expect(issue?.body).toContain("memory_read · size_bytes=1073741824 threads=all path=avx2 · static · c6i.8xlarge · us-east-2c");
		expect(issue?.body).toContain("https://github.com/smrdotgg/ledgermath-runs/blob/main/runs/2026/11/12/");
		expect(issue?.body).toContain("49.0 hours ago");
		expect(issue?.body).not.toContain("copy job failed");
		expect(stateOf(issue?.body ?? "")).toMatchObject({ copy_failed: false });
		expect(stateOf(issue?.body ?? "")?.stale_count).toBe(8);
		expect(stateOf(issue?.body ?? "")?.stale_hash).toBe(staleHash(outcome.stale.map(describeSeries)));
	});

	test("the next passes, with nothing changed, open no second issue and stay silent", async () => {
		const tracker = new FakeIssues();
		await pass(tracker, newestStart + 49 * HOUR);
		for (const hours of [55, 61, 67, 73]) {
			expect(await pass(tracker, newestStart + hours * HOUR)).toMatchObject({ action: "unchanged", issue: 1 });
		}
		expect(tracker.issues.length).toBe(1);
		expect(tracker.issues[0]?.comments).toEqual([]);
	});

	test("comments when the set of stale Series changes", async () => {
		const tracker = new FakeIssues();
		const partial = new HandMade();
		oneBoot(partial, "2026-11-10T22:10:00Z");
		// Only the static build ran later, so first the dynamic four are stale, then all eight.
		for (const params of SCHEDULE.benchmarks[0]?.params ?? []) partial.run({ startedAt: "2026-11-12T22:30:00Z", params, build: "static" });
		expect((await pass(tracker, Date.parse("2026-11-13T12:00:00Z"), false, partial.files)).stale.length).toBe(4);
		expect(await pass(tracker, Date.parse("2026-11-13T18:00:00Z"), false, partial.files)).toMatchObject({ action: "unchanged" });
		const grown = await pass(tracker, Date.parse("2026-11-14T23:00:00Z"), false, partial.files);
		expect(grown).toMatchObject({ action: "commented", issue: 1 });
		expect(grown.stale.length).toBe(8);
		expect(tracker.issues[0]?.comments.length).toBe(1);
		expect(tracker.issues[0]?.comments[0]).toContain("8 watched Series have had no Run");
	});

	test("a failed copy is said plainly at the top, and a change in it is worth a comment, once", async () => {
		const tracker = new FakeIssues();
		const at = newestStart + 49 * HOUR;
		const opened = await pass(tracker, at, true);
		expect(opened.action).toBe("opened");
		const body = tracker.issues[0]?.body ?? "";
		expect(body.split("\n")[1]).toStartWith("**The copy job failed on this pass.** The Runs repository may be behind the bucket");
		expect(body).toContain("Look at the copy job first.");

		expect(await pass(tracker, at + 6 * HOUR, true)).toMatchObject({ action: "unchanged" });
		// The copy works again, with the same stale Series: one comment, without the warning.
		expect(await pass(tracker, at + 12 * HOUR, false)).toMatchObject({ action: "commented" });
		expect(tracker.issues[0]?.comments.at(-1)).not.toContain("copy job failed");
		expect(await pass(tracker, at + 18 * HOUR, false)).toMatchObject({ action: "unchanged" });
		// And fails again.
		expect(await pass(tracker, at + 24 * HOUR, true)).toMatchObject({ action: "commented" });
		expect(tracker.issues[0]?.comments.at(-1)).toStartWith("**The copy job failed on this pass.**");
		expect(tracker.issues[0]?.comments.length).toBe(2);
		expect(tracker.issues.length).toBe(1);
	});

	test("says once that every Series has a Run again, so the next incident is not taken for the old one", async () => {
		const tracker = new FakeIssues();
		const runs = new HandMade();
		oneBoot(runs, "2026-11-12T22:10:00Z");
		await pass(tracker, Date.parse("2026-11-15T00:00:00Z"), false, runs.files);
		oneBoot(runs, "2026-11-15T22:10:00Z");
		const recovered = await pass(tracker, Date.parse("2026-11-15T23:00:00Z"), false, runs.files);
		expect(recovered).toMatchObject({ action: "commented", issue: 1, stale: [] });
		expect(tracker.issues[0]?.comments[0]).toContain("every watched Series has had a Run in the last 48 hours again");
		expect(await pass(tracker, Date.parse("2026-11-16T05:00:00Z"), false, runs.files)).toMatchObject({ action: "unchanged" });
		// The same eight go stale again: a new comment, not silence.
		const again = await pass(tracker, Date.parse("2026-11-18T00:00:00Z"), false, runs.files);
		expect(again).toMatchObject({ action: "commented", issue: 1 });
		expect(again.stale.length).toBe(8);
		expect(tracker.issues.length).toBe(1);
		expect(tracker.issues[0]?.comments.length).toBe(2);
	});

	test("opens a new issue once the old one is closed", async () => {
		const tracker = new FakeIssues();
		const now = newestStart + 49 * HOUR;
		await pass(tracker, now);
		(tracker.issues[0] as { open: boolean }).open = false;
		expect(await pass(tracker, now)).toMatchObject({ action: "opened", issue: 2 });
	});

	test("does nothing while every watched Series has a Run in the last 48 hours, even when the copy failed", async () => {
		const tracker = new FakeIssues();
		// The first Run of the newest boot is 48 hours old to the minute; it is not stale yet.
		expect((await pass(tracker, Date.parse(newest) + 48 * HOUR)).action).toBe("none");
		expect((await pass(tracker, Date.parse(newest) + 48 * HOUR, true)).action).toBe("none");
		expect(tracker.issues).toEqual([]);
	});

	test("lists only the Series that went stale, and one with no Run at all", async () => {
		const partial = new HandMade();
		oneBoot(partial, "2026-11-10T22:10:00Z");
		// A day later, only the static build ran.
		for (const params of SCHEDULE.benchmarks[0]?.params ?? []) {
			partial.run({ startedAt: "2026-11-12T22:30:00Z", params, build: "static" });
		}
		const schedule: Schedule = {
			...SCHEDULE,
			benchmarks: [
				...SCHEDULE.benchmarks,
				{ name: "memory_read", builds: ["static"], samples: 10, timeout_seconds: 600, params: [{ size_bytes: 4096, threads: 1, path: "scalar" }] },
			],
		};
		const stale = staleSeries(watchedSeries(schedule), partial.files, new Date("2026-11-13T12:00:00Z"), SETTLED);
		expect(stale.map((series) => [series.build, series.params.size_bytes, series.newest === null])).toEqual([
			["dynamic", 1073741824, false],
			["dynamic", 1073741824, false],
			["dynamic", 1073741824, false],
			["dynamic", 1073741824, false],
			["static", 4096, true],
		]);
	});

	test("does not watch a Series from a one-off launch on another instance type or zone", async () => {
		const oneOff = new HandMade();
		oneBoot(oneOff, "2026-11-12T22:10:00Z");
		// Long ago, by hand, on a smaller type, and on the stage's type in another zone.
		oneOff.run({ startedAt: "2026-11-01T10:00:00Z", instanceType: "c6i.large" });
		oneOff.run({ startedAt: "2026-11-01T11:00:00Z", zone: "us-east-2a", zoneId: "use2-az1" });
		const now = new Date("2026-11-13T22:10:00Z");
		expect(staleSeries(watchedSeries(SCHEDULE), oneOff.files, now, SETTLED)).toEqual([]);

		// And a Run elsewhere does not keep a watched Series fresh.
		const elsewhere = new HandMade();
		for (const params of SCHEDULE.benchmarks[0]?.params ?? []) {
			for (const build of SCHEDULE.benchmarks[0]?.builds ?? []) elsewhere.run({ startedAt: "2026-11-13T20:00:00Z", params, build, instanceType: "c6i.large" });
		}
		expect(staleSeries(watchedSeries(SCHEDULE), elsewhere.files, now, SETTLED).length).toBe(8);
	});
});

describe("a watched Series that has never had a Run", () => {
	// memory_read's eight Series ran on 2026-11-12; a new benchmark was added to
	// the schedule at 2026-11-13T09:00Z and has not run yet.
	const added: Schedule = {
		...SCHEDULE,
		benchmarks: [...SCHEDULE.benchmarks, { name: "syscall", builds: ["static"], samples: 10, timeout_seconds: 120, params: [{ call: "getpid" }] }],
	};
	const changedAt = new Date("2026-11-13T09:00:00Z");
	const made = new HandMade();
	oneBoot(made, "2026-11-12T22:10:00Z");
	const neverRun = (now: string) =>
		staleSeries(watchedSeries(added), made.files, new Date(now), changedAt).filter((series) => series.newest === null).map((series) => series.benchmark);

	test("is not stale while the schedule has been unchanged for 48 hours or less", () => {
		expect(neverRun("2026-11-13T09:00:00Z")).toEqual([]);
		expect(neverRun("2026-11-14T22:00:00Z")).toEqual([]);
		expect(neverRun("2026-11-15T09:00:00Z")).toEqual([]); // 48 hours to the minute
	});

	test("is stale once the schedule has been unchanged for more than 48 hours", () => {
		expect(neverRun("2026-11-15T09:00:01Z")).toEqual(["syscall"]);
		const stale = staleSeries(watchedSeries(added), made.files, new Date("2026-11-15T09:00:01Z"), changedAt);
		expect(stale.find((series) => series.benchmark === "syscall")).toMatchObject({ params: { call: "getpid" }, newest: null });
	});

	test("does not delay a Series that has had a Run: its newest Run's age is all that counts, however recent the change", () => {
		// The schedule changed an hour ago, and memory_read's Runs are 49 hours old.
		const stale = staleSeries(watchedSeries(added), made.files, new Date("2026-11-15T00:00:00Z"), new Date("2026-11-14T23:00:00Z"));
		expect(stale.map((series) => series.benchmark)).toEqual(Array(8).fill("memory_read"));
	});

	test("raises no alarm the moment it is merged, and one once its 48 hours are up", async () => {
		const tracker = new FakeIssues();
		const fresh = new HandMade();
		oneBoot(fresh, "2026-11-13T22:10:00Z");
		oneBoot(fresh, "2026-11-14T22:10:00Z");
		oneBoot(fresh, "2026-11-15T22:10:00Z");
		const pass = (now: string) => runAlarm({ schedule: added, runs: fresh.files, now: new Date(now), scheduleChangedAt: changedAt, copyFailed: false, tracker });
		expect(await pass("2026-11-13T12:00:00Z")).toMatchObject({ action: "none", stale: [] });
		const opened = await pass("2026-11-15T12:00:00Z");
		expect(opened).toMatchObject({ action: "opened", issue: 1 });
		expect(opened.stale.map(describeSeries)).toEqual(["syscall · call=getpid · static · c6i.8xlarge · us-east-2c"]);
		expect(tracker.issues[0]?.body).toContain("`syscall · call=getpid · static · c6i.8xlarge · us-east-2c`: no Run at all");
	});
});

describe("the price files", () => {
	const scratch = mkdtempSync(join(tmpdir(), "lm-alarm-prices-"));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));
	const priceFile = (repository: string, path: string, content: string): void => {
		mkdirSync(join(repository, path, ".."), { recursive: true });
		writeFileSync(join(repository, path), content);
	};

	test("the newest is the one fetched last; a file not named like a price file, or without a fetch time, is passed over", () => {
		const repository = join(scratch, "repository");
		expect(newestPriceFile(repository)).toBeNull();
		priceFile(repository, "prices/2026/11/10/aws.json", JSON.stringify({ fetched_at: "2026-11-10T03:17:00.000Z" }));
		priceFile(repository, "prices/2026/11/11/aws.json", JSON.stringify({ fetched_at: "2026-11-11T15:17:00.000Z" }));
		priceFile(repository, "prices/2026/11/12/aws.json", "not JSON");
		priceFile(repository, "prices/2026/11/13/aws.json", JSON.stringify({ fetched_at: "yesterday" }));
		priceFile(repository, "prices/2026/11/14/gcp.json", JSON.stringify({ fetched_at: "2026-11-14T03:17:00.000Z" }));
		const expected = { path: "prices/2026/11/11/aws.json", fetchedAt: "2026-11-11T15:17:00.000Z" };
		expect(newestPriceFile(repository)).toEqual(expected);
		expect(newestPriceFile(relative(process.cwd(), repository))).toEqual(expected);
		expect(newestPriceFile(`${repository}/`)).toEqual(expected);
	});

	test("are stale once the newest was fetched more than 48 hours ago, or, with none at all, once the workflow has existed that long", () => {
		const newest = { path: "prices/2026/11/11/aws.json", fetchedAt: "2026-11-11T03:17:00.000Z" };
		const fetched = Date.parse(newest.fetchedAt);
		expect(stalePrices(newest, new Date(fetched + 48 * HOUR), null)).toBeNull();
		expect(stalePrices(newest, new Date(fetched + 48 * HOUR + 1000), null)).toEqual({ newest, since: null });
		// However long ago the workflow was added, a recent file is what counts.
		expect(stalePrices(newest, new Date(fetched + HOUR), new Date("2026-01-01T00:00:00Z"))).toBeNull();
		const since = new Date("2026-11-12T10:00:00Z");
		expect(stalePrices(null, new Date(since.getTime() + 48 * HOUR), since)).toBeNull();
		expect(stalePrices(null, new Date(since.getTime() + 48 * HOUR + 1000), since)).toEqual({ newest: null, since: since.toISOString() });
		// Not known to exist: no file is not stale.
		expect(stalePrices(null, new Date("2030-01-01T00:00:00Z"), null)).toBeNull();
	});

	const made = new HandMade();
	for (const day of ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"]) oneBoot(made, `${day}T22:10:00Z`);
	const at = (iso: string): Date => new Date(iso);
	const file = (day: string) => ({ path: `prices/${day.replaceAll("-", "/")}/aws.json`, fetchedAt: `${day}T03:17:42.123Z` });

	test("alone stale, open the issue, saying the Series are fine; silent while nothing changes; said once when a new file arrives", async () => {
		const tracker = new FakeIssues();
		const pass = (now: string, newestPrices: ReturnType<typeof file> | null) =>
			runAlarm({ schedule: SCHEDULE, runs: made.files, now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, newestPrices, pricesSince: at("2026-11-01T00:00:00Z") });
		expect(await pass("2026-11-15T03:17:00Z", file("2026-11-13"))).toMatchObject({ action: "none", prices: null });
		const opened = await pass("2026-11-15T23:00:00Z", file("2026-11-13"));
		expect(opened).toMatchObject({ action: "opened", issue: 1, stale: [], prices: { newest: file("2026-11-13") } });
		const body = tracker.issues[0]?.body ?? "";
		expect(body).toContain("every watched Series has had a Run in the last 48 hours.");
		expect(body).toContain(
			"**No new price file for more than 48 hours.** The newest, [prices/2026/11/13/aws.json](https://github.com/smrdotgg/ledgermath-runs/blob/main/prices/2026/11/13/aws.json), was fetched at 2026-11-13T03:17:42.123Z, 67.7 hours ago.",
		);
		expect(stateOf(body)).toEqual({ stale_count: 0, stale_hash: staleHash([]), copy_failed: false, stale_prices: "prices/2026/11/13/aws.json" });
		expect(await pass("2026-11-16T05:00:00Z", file("2026-11-13"))).toMatchObject({ action: "unchanged" });
		const recovered = await pass("2026-11-16T23:00:00Z", file("2026-11-16"));
		expect(recovered).toMatchObject({ action: "commented", prices: null });
		expect(tracker.issues[0]?.comments[0]).toContain("every watched Series has had a Run in the last 48 hours again, and the newest price file is no more than 48 hours old.");
		expect(tracker.issues[0]?.comments[0]).not.toContain("No new price file");
		expect(stateOf(tracker.issues[0]?.comments[0] ?? "")).toEqual({ stale_count: 0, stale_hash: staleHash([]), copy_failed: false });
		expect(await pass("2026-11-17T05:00:00Z", file("2026-11-16"))).toMatchObject({ action: "unchanged" });
		expect(tracker.issues.length).toBe(1);
	});

	test("stale beside stale Series, say both in one post, and a change in either is one comment", async () => {
		const tracker = new FakeIssues();
		const runs = new HandMade();
		oneBoot(runs, "2026-11-12T22:10:00Z");
		const pass = (now: string, newestPrices: ReturnType<typeof file>) =>
			runAlarm({ schedule: SCHEDULE, runs: runs.files, now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, newestPrices, pricesSince: null });
		const opened = await pass("2026-11-15T12:00:00Z", file("2026-11-12"));
		expect(opened).toMatchObject({ action: "opened" });
		expect(opened.stale.length).toBe(8);
		expect(tracker.issues[0]?.body).toContain("8 watched Series have had no Run for more than 48 hours");
		expect(tracker.issues[0]?.body).toContain("No new price file for more than 48 hours");
		// Prices again, the Series still stale.
		expect(await pass("2026-11-15T18:00:00Z", file("2026-11-15"))).toMatchObject({ action: "commented", prices: null });
		expect(tracker.issues[0]?.comments[0]).toContain("8 watched Series have had no Run");
		expect(tracker.issues[0]?.comments[0]).toContain("The newest price file is no more than 48 hours old again.");
		expect(tracker.issues[0]?.comments[0]).not.toContain("No new price file");
		expect(await pass("2026-11-16T00:00:00Z", file("2026-11-15"))).toMatchObject({ action: "unchanged" });
	});

	test("with none at all, stay quiet until 48 hours after the prices workflow first existed, then say so", async () => {
		const tracker = new FakeIssues();
		const since = at("2026-11-14T09:00:00Z");
		const pass = (now: string) =>
			runAlarm({ schedule: SCHEDULE, runs: made.files, now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, newestPrices: null, pricesSince: since });
		expect(await pass("2026-11-16T09:00:00Z")).toMatchObject({ action: "none" });
		const opened = await pass("2026-11-16T09:00:01Z");
		expect(opened).toMatchObject({ action: "opened", prices: { newest: null, since: since.toISOString() } });
		expect(tracker.issues[0]?.body).toContain(
			"**No price file.** The Runs repository holds no price file at all, and the prices workflow has existed since 2026-11-14T09:00:00.000Z, more than 48 hours.",
		);
		expect(stateOf(tracker.issues[0]?.body ?? "")?.stale_prices).toBe("none");
		// Without knowing when the workflow first existed, no price file is not reported.
		const quiet = new FakeIssues();
		expect(
			await runAlarm({ schedule: SCHEDULE, runs: made.files, now: at("2026-11-16T12:00:00Z"), scheduleChangedAt: SETTLED, copyFailed: false, tracker: quiet }),
		).toMatchObject({ action: "none", prices: null });
	});

	test("an open issue whose last post is from before prices were watched gets no comment while the price files are fresh", async () => {
		const tracker = new FakeIssues();
		const runs = new HandMade();
		oneBoot(runs, "2026-11-12T22:10:00Z");
		const now = at("2026-11-15T12:00:00Z");
		const stale = staleSeries(watchedSeries(SCHEDULE), runs.files, now, SETTLED);
		const before = `${ALARM_MARKER}\nan older post\n${STATE_MARKER}${JSON.stringify({ stale: stale.map(describeSeries).sort(), copy_failed: false })} -->`;
		tracker.issues.push({ number: 1, title: "Stale Series: no Run for 48 hours", body: before, open: true, comments: [] });
		const outcome = await runAlarm({ schedule: SCHEDULE, runs: runs.files, now, scheduleChangedAt: SETTLED, copyFailed: false, tracker, newestPrices: file("2026-11-15"), pricesSince: null });
		expect(outcome).toMatchObject({ action: "unchanged", issue: 1 });
	});
});

describe("every post under GitHub's limit of 65,536 characters", () => {
	const NOW = new Date("2026-11-21T16:00:00Z");
	const OLD = "2026-11-19T01:00:00.000Z";
	const ID = "01a1dd67-a680-7a77-8758-308276605aac";
	/** n stale Series, each with a newest Run at a real-length address: the real schedule's, or more, made up. */
	function staleOf(n: number): StaleSeries[] {
		const real = watchedSeries(REAL_SCHEDULE);
		const made: Schedule = {
			vcpu_quota: QUOTA,
			targets: [C6I],
			benchmarks: [{ name: "memory_read_random", builds: ["static"], samples: 10, timeout_seconds: 600, params: Array.from({ length: Math.max(0, n - real.length) }, (_, i) => ({ size_bytes: 1073741824 + i, threads: "all", path: "avx512-nontemporal" })) }],
		};
		return [...real, ...watchedSeries(made)].slice(0, n).map((series) => ({ ...series, newest: { id: ID, startedAt: OLD, path: `runs/2026/11/19/${ID}.json` } }));
	}
	const bucket = apiReport({ kind: "published", last_modified: OLD, run: 44852356733 }, "ledgermath-production-runs-apibucketbucket-wvtsemfo", NOW, "off");
	const prices: StalePrices = { newest: { path: "prices/2026/11/13/aws.json", fetchedAt: "2026-11-13T03:17:42.123Z" }, since: null };
	const RUN_URL = "https://github.com/smrdotgg/ledgermath/actions/runs/44900000000";

	test("141, 187 and 1,000 stale Series, with and without the bucket and price findings: every body fits, keeps both findings and the counts, lists a sorted prefix, says how many more and where, and its marker reads back", () => {
		expect(watchedSeries(REAL_SCHEDULE).length).toBeGreaterThanOrEqual(187);
		for (const n of [141, 187, 1_000]) {
			const stale = staleOf(n);
			const sorted = stale.map(describeSeries).sort(compareText);
			for (const [withApi, withPrices, copyFailed] of [
				[false, false, false],
				[true, false, false],
				[false, true, false],
				[true, true, true],
			] as const) {
				const text = alarmText({ stale, now: NOW, copyFailed, api: withApi ? bucket : null, prices: withPrices ? prices : null, fullListAt: RUN_URL });
				const body = `${ALARM_MARKER}\n${text}`;
				const label = { n, withApi, withPrices, copyFailed };
				expect({ ...label, fits: body.length <= MAX_BODY_CHARS }).toEqual({ ...label, fits: true });
				expect(text).toContain(`${n} watched Series have had no Run for more than 48 hours.`);
				if (withApi) expect(text).toContain("**The data API has not been published for 63.0 hours.**");
				if (withPrices) expect(text).toContain("**No new price file for more than 48 hours.**");
				const shown = text.split("\n").filter((line) => line.startsWith("- `")).map((line) => (line.match(/^- `([^`]*)`/) as RegExpMatchArray)[1] as string);
				expect(shown).toEqual(sorted.slice(0, shown.length));
				const more = text.split("\n").find((line) => line.startsWith("- … and "));
				if (shown.length < n) {
					expect(more).toBe(
						`- … and ${n - shown.length} more watched Series not shown, to keep this post under GitHub's limit: the log of [the run that wrote this](${RUN_URL}) lists every one, and its step summary lists them up to its size limit.`,
					);
				}
				else expect(more).toBeUndefined();
				expect(stateOf(body)).toEqual(alarmState(stale, copyFailed, withPrices ? prices : null, withApi ? bucket.state : null));
				expect(stateOf(body)?.stale_count).toBe(n);
			}
		}
		// Listed whole, 187 Series take more than the budget even with the short marker (on main, whose marker listed every one
		// again, the body was longer still, and GitHub refused it): so the 187 above were cut, not merely short.
		const uncut = `${ALARM_MARKER}\n${alarmText({ stale: staleOf(187), now: NOW, copyFailed: false, budget: Number.POSITIVE_INFINITY })}`;
		expect(uncut.length).toBeGreaterThan(MAX_BODY_CHARS);
	});

	test("a repeat pass with the same stale Series stays quiet, however many are not shown; a change in one that is not shown is a change", async () => {
		const many: Schedule = {
			vcpu_quota: QUOTA,
			targets: [C6I],
			benchmarks: [{ name: "memory_read_random", builds: ["static"], samples: 10, timeout_seconds: 600, params: Array.from({ length: 1_000 }, (_, i) => ({ size_bytes: 1073741824 + i, threads: "all", path: "avx512-nontemporal" })) }],
		};
		const tracker = new FakeIssues();
		const pass = (runs: HandMade["files"]) => runAlarm({ schedule: many, runs, now: NOW, scheduleChangedAt: SETTLED, copyFailed: false, tracker });
		const opened = await pass([]);
		expect(opened).toMatchObject({ action: "opened" });
		expect((tracker.issues[0]?.body.length ?? 0) <= MAX_BODY_CHARS).toBe(true);
		expect(tracker.issues[0]?.body).toContain("more watched Series not shown");
		expect(await pass([])).toMatchObject({ action: "unchanged" });
		// The last Series in the sorted list, far below what the post shows, gets a Run.
		const last = watchedSeries(many).sort((a, b) => compareText(describeSeries(a), describeSeries(b))).at(-1) as WatchedSeries;
		expect(tracker.issues[0]?.body).not.toContain(describeSeries(last));
		const made = new HandMade();
		made.run({ startedAt: "2026-11-21T10:00:00Z", benchmark: last.benchmark, params: last.params, build: last.build, instanceType: last.instanceType, zone: last.zone });
		const changed = await pass(made.files);
		expect(changed).toMatchObject({ action: "commented" });
		expect(changed.stale.length).toBe(999);
		expect((tracker.issues[0]?.comments[0]?.length ?? 0) <= MAX_BODY_CHARS).toBe(true);
		expect(await pass(made.files)).toMatchObject({ action: "unchanged" });
	});

	test("the step summary lists every stale Series, under its own limit, cut with a count past it", () => {
		const all = staleList(staleOf(1_000), NOW);
		expect(all.split("\n").filter((line) => line.startsWith("- `")).length).toBe(1_000);
		expect(Buffer.byteLength(all)).toBeLessThan(STEP_SUMMARY_LIST_BYTES);
		const huge = staleList(staleOf(10_000), NOW);
		expect(Buffer.byteLength(huge)).toBeLessThanOrEqual(STEP_SUMMARY_LIST_BYTES);
		expect(huge).toMatch(/- … and [0-9]+ more: the log lists every one\.\n$/);
	});

	test("a body over the limit is never sent: refused before GitHub sees it, loudly", async () => {
		const sent: string[] = [];
		const tracker: IssueTracker = { findOpen: async () => null, open: async (_, body) => (sent.push(body), 1), comment: async () => {} };
		await expect(runAlarm({ schedule: SCHEDULE, runs: [], now: NOW, scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: { ...bucket, raised: "x".repeat(70_000) } })).rejects.toThrow(
			"over MAX_BODY_CHARS",
		);
		expect(sent).toEqual([]);
	});
});

describe("GitHub's side", () => {
	test("a post GitHub refuses (422) throws, naming the answer, and is sent once", async () => {
		const calls: string[] = [];
		const github = new GitHubIssues("smrdotgg/ledgermath", "a-token", async (url, init) => {
			calls.push(`${init.method} ${url}`);
			return new Response('{"message":"Validation Failed","errors":[{"field":"body","code":"custom","message":"body is too long (maximum is 65536 characters)"}]}', { status: 422 });
		});
		await expect(github.open("t", "b")).rejects.toThrow("422");
		expect(calls).toHaveLength(1);
	});

	test("finds the open alarm issue by its marker across pages, skipping pull requests, and its newest alarm post", async () => {
		const calls: Array<{ method: string; url: string; body?: string }> = [];
		const issues = [
			Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: i === 5 ? ALARM_MARKER : "something else", pull_request: i === 5 ? {} : undefined })),
			[{ number: 101, body: `${ALARM_MARKER}\nstale ${STATE_MARKER}{"stale":["a"],"copy_failed":false} -->` }],
		];
		const comments = [
			Array.from({ length: 100 }, (_, i) => ({ body: i === 40 ? `later ${STATE_MARKER}{"stale":["a","b"],"copy_failed":true} -->` : "a person's comment" })),
			[{ body: "a person's comment, after the alarm's" }],
		];
		const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
			calls.push({ method: init.method ?? "GET", url, body: init.body as string | undefined });
			if (init.method === "GET") {
				const page = Number(new URL(url).searchParams.get("page"));
				return Response.json((url.includes("/comments") ? comments : issues)[page - 1] ?? []);
			}
			return Response.json({ number: 7 });
		};
		const github = new GitHubIssues("smrdotgg/ledgermath", "a-token", fetcher);
		const open = await github.findOpen(ALARM_MARKER);
		expect(open?.number).toBe(101);
		// A post from before the count and hash, which listed the stale Series, reads as the same state.
		expect(stateOf(open?.lastPost ?? "")).toEqual({ stale_count: 2, stale_hash: staleHash(["a", "b"]), copy_failed: true });
		// Two sets whose descriptions joined by newlines read the same hash differently: the hash is of their JSON.
		expect(["a", "b"].join("\n")).toBe(["a\nb"].join("\n"));
		expect(staleHash(["a", "b"])).not.toBe(staleHash(["a\nb"]));
		expect(staleHash(["b", "a"])).toBe(staleHash(["a", "b"]));
		await github.comment(101, "still stale");
		expect(await github.open("t", "b")).toBe(7);
		expect(calls.map((call) => `${call.method} ${call.url.replace("https://api.github.com", "")}`)).toEqual([
			"GET /repos/smrdotgg/ledgermath/issues?state=open&per_page=100&page=1",
			"GET /repos/smrdotgg/ledgermath/issues?state=open&per_page=100&page=2",
			"GET /repos/smrdotgg/ledgermath/issues/101/comments?per_page=100&page=1",
			"GET /repos/smrdotgg/ledgermath/issues/101/comments?per_page=100&page=2",
			"POST /repos/smrdotgg/ledgermath/issues/101/comments",
			"POST /repos/smrdotgg/ledgermath/issues",
		]);
		expect(JSON.parse(calls[4]?.body ?? "{}")).toEqual({ body: "still stale" });
	});

	test("says what GitHub answered when a call fails", async () => {
		const github = new GitHubIssues("smrdotgg/ledgermath", "a-token", async () => new Response("Resource not accessible by integration", { status: 403 }));
		expect(github.open("t", "b")).rejects.toThrow("403 Resource not accessible by integration");
	});
});
