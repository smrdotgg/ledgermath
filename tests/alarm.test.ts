import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TARGETS } from "../infra/runs/placement";
import { parseSchedule, type Schedule, type Target } from "../infra/runs/schedule";
import {
	ALARM_MARKER,
	ALARM_TITLE,
	GitHubIssues,
	type IssueTracker,
	type OpenAlarm,
	runAlarm,
	STATE_MARKER,
	staleSeries,
	stateOf,
	watchedSeries,
} from "../scripts/alarm";
import { HandMade } from "./hand-made-runs";

/** The schedule the box runs. Only the first tests read it: it changes whenever a benchmark is added. */
const REAL_SCHEDULE = parseSchedule(JSON.parse(readFileSync(join(import.meta.dir, "..", "schedule.json"), "utf8")));
const C6I: Target = { instance_type: "c6i.8xlarge", zone: "us-east-2c", boots_utc: ["22:10"] };
/** The schedule the alarm's behaviour is tested on: one target, eight Series, four parameter sets under two builds. */
const SCHEDULE: Schedule = {
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

	test("are all kept fresh by one boot of schedule.json on each target", () => {
		const boots = new HandMade();
		for (const target of REAL_SCHEDULE.targets) oneBoot(boots, "2026-11-12T22:10:00Z", REAL_SCHEDULE, target);
		expect(staleSeries(watchedSeries(REAL_SCHEDULE), boots.files, new Date("2026-11-13T22:10:00Z"))).toEqual([]);
	});
});

describe("the watched Series across targets", () => {
	const M5: Target = { instance_type: "m5.large", zone: "us-east-2c", boots_utc: ["22:20"] };
	const schedule: Schedule = {
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
		expect(staleSeries(watchedSeries(schedule), made.files, now).map(label)).toEqual(['syscall {"call":"getpid"} m5.large', 'mutex {"threads":1} m5.large']);
		oneBoot(made, "2026-11-12T22:20:00Z", schedule, M5);
		expect(staleSeries(watchedSeries(schedule), made.files, now)).toEqual([]);
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
		runAlarm({ schedule: SCHEDULE, runs, now: new Date(at), copyFailed, tracker });

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
		expect(stateOf(issue?.body ?? "")?.stale.length).toBe(8);
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
		const stale = staleSeries(watchedSeries(schedule), partial.files, new Date("2026-11-13T12:00:00Z"));
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
		expect(staleSeries(watchedSeries(SCHEDULE), oneOff.files, now)).toEqual([]);

		// And a Run elsewhere does not keep a watched Series fresh.
		const elsewhere = new HandMade();
		for (const params of SCHEDULE.benchmarks[0]?.params ?? []) {
			for (const build of SCHEDULE.benchmarks[0]?.builds ?? []) elsewhere.run({ startedAt: "2026-11-13T20:00:00Z", params, build, instanceType: "c6i.large" });
		}
		expect(staleSeries(watchedSeries(SCHEDULE), elsewhere.files, now).length).toBe(8);
	});
});

describe("GitHub's side", () => {
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
		expect(stateOf(open?.lastPost ?? "")).toEqual({ stale: ["a", "b"], copy_failed: true });
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
