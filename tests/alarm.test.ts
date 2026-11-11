import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PLACEMENT, PLACEMENTS } from "../infra/runs/placement";
import {
	ALARM_MARKER,
	ALARM_TITLE,
	GitHubIssues,
	type IssueTracker,
	runAlarm,
	type Schedule,
	staleSeries,
	watchedSeries,
} from "../scripts/alarm";
import { HandMade } from "./hand-made-runs";

const SCHEDULE = JSON.parse(readFileSync(join(import.meta.dir, "..", "schedule.json"), "utf8")) as Schedule;
const HOUR = 3_600_000;

/** Issues in memory, as GitHub keeps them. */
class FakeIssues implements IssueTracker {
	readonly issues: Array<{ number: number; title: string; body: string; open: boolean; comments: string[] }> = [];

	async findOpen(marker: string): Promise<number | null> {
		return this.issues.find((issue) => issue.open && issue.body.includes(marker))?.number ?? null;
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

/** One Run of every watched Series at `startedAt`, on the stage's instance type and zone. */
function oneBoot(made: HandMade, startedAt: string): void {
	let minute = 0;
	for (const benchmark of SCHEDULE.benchmarks) {
		for (const params of benchmark.params) {
			for (const build of benchmark.builds) {
				const at = new Date(Date.parse(startedAt) + minute++ * 60_000).toISOString();
				made.run({ startedAt: at, params, build, instanceType: PLACEMENT.instanceType, zone: PLACEMENT.zone });
			}
		}
	}
}

describe("the watched Series", () => {
	test("are every parameter set and build of schedule.json, on the instance type and zone the stage launches", () => {
		const watched = watchedSeries(SCHEDULE, PLACEMENTS);
		expect(watched.length).toBe(8);
		for (const series of watched) {
			expect(series.instanceType).toBe("c6i.8xlarge");
			expect(series.zone).toBe("us-east-2c");
		}
	});
});

describe("the alarm", () => {
	const newest = "2026-11-12T22:10:00Z";
	const made = new HandMade();
	oneBoot(made, "2026-11-11T22:10:00Z");
	oneBoot(made, newest);
	// The newest Run's start: the last of the boot, seven minutes after its first.
	const newestStart = Date.parse(newest) + 7 * 60_000;

	test("with the clock 49 hours past the newest Run, opens one issue listing every stale Series", async () => {
		const tracker = new FakeIssues();
		const now = new Date(newestStart + 49 * HOUR);
		const outcome = await runAlarm({ schedule: SCHEDULE, placements: PLACEMENTS, runs: made.files, now, tracker });
		expect(outcome.action).toBe("opened");
		expect(outcome.stale.length).toBe(8);
		expect(tracker.issues.length).toBe(1);
		const [issue] = tracker.issues;
		expect(issue?.title).toBe(ALARM_TITLE);
		expect(issue?.body.startsWith(ALARM_MARKER)).toBe(true);
		expect(issue?.body).toContain("8 watched Series have had no Run for more than 48 hours");
		expect(issue?.body).toContain("memory_read · size_bytes=1073741824 threads=all path=avx2 · static · c6i.8xlarge · us-east-2c");
		expect(issue?.body).toContain("https://github.com/smrdotgg/ledgermath-runs/blob/main/runs/2026/11/12/");
		expect(issue?.body).toContain("49.0 hours ago");

		// The next pass comments on the open issue instead of opening a second.
		const later = await runAlarm({ schedule: SCHEDULE, placements: PLACEMENTS, runs: made.files, now: new Date(now.getTime() + 6 * HOUR), tracker });
		expect(later).toMatchObject({ action: "commented", issue: 1 });
		expect(tracker.issues.length).toBe(1);
		expect(tracker.issues[0]?.comments.length).toBe(1);
		expect(tracker.issues[0]?.comments[0]).toContain("55.0 hours ago");
	});

	test("opens a new issue once the old one is closed", async () => {
		const tracker = new FakeIssues();
		const now = new Date(newestStart + 49 * HOUR);
		await runAlarm({ schedule: SCHEDULE, placements: PLACEMENTS, runs: made.files, now, tracker });
		(tracker.issues[0] as { open: boolean }).open = false;
		const outcome = await runAlarm({ schedule: SCHEDULE, placements: PLACEMENTS, runs: made.files, now, tracker });
		expect(outcome).toMatchObject({ action: "opened", issue: 2 });
	});

	test("does nothing while every watched Series has a Run in the last 48 hours", async () => {
		const tracker = new FakeIssues();
		// The first Run of the newest boot is 48 hours old to the minute; it is not stale yet.
		const outcome = await runAlarm({ schedule: SCHEDULE, placements: PLACEMENTS, runs: made.files, now: new Date(Date.parse(newest) + 48 * HOUR), tracker });
		expect(outcome.action).toBe("none");
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
			benchmarks: [...SCHEDULE.benchmarks, { name: "memory_read", builds: ["static"], params: [{ size_bytes: 4096, threads: 1, path: "scalar" }] }],
		};
		const stale = staleSeries(watchedSeries(schedule, PLACEMENTS), partial.files, new Date("2026-11-13T12:00:00Z"));
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
		expect(staleSeries(watchedSeries(SCHEDULE, PLACEMENTS), oneOff.files, now)).toEqual([]);

		// And a Run elsewhere does not keep a watched Series fresh.
		const elsewhere = new HandMade();
		for (const params of SCHEDULE.benchmarks[0]?.params ?? []) {
			for (const build of SCHEDULE.benchmarks[0]?.builds ?? []) elsewhere.run({ startedAt: "2026-11-13T20:00:00Z", params, build, instanceType: "c6i.large" });
		}
		expect(staleSeries(watchedSeries(SCHEDULE, PLACEMENTS), elsewhere.files, now).length).toBe(8);
	});
});

describe("GitHub's side", () => {
	test("finds the open alarm issue by its marker across pages, skipping pull requests, then comments", async () => {
		const calls: Array<{ method: string; url: string; body?: string }> = [];
		const pages = [
			Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: i === 5 ? ALARM_MARKER : "something else", pull_request: i === 5 ? {} : undefined })),
			[{ number: 101, body: `${ALARM_MARKER}\nstale` }],
		];
		const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
			calls.push({ method: init.method ?? "GET", url, body: init.body as string | undefined });
			if (init.method === "GET") {
				const page = Number(new URL(url).searchParams.get("page"));
				return Response.json(pages[page - 1] ?? []);
			}
			return Response.json({ number: 7 });
		};
		const github = new GitHubIssues("smrdotgg/ledgermath", "a-token", fetcher);
		expect(await github.findOpen(ALARM_MARKER)).toBe(101);
		await github.comment(101, "still stale");
		expect(await github.open("t", "b")).toBe(7);
		expect(calls.map((call) => `${call.method} ${call.url.replace("https://api.github.com", "")}`)).toEqual([
			"GET /repos/smrdotgg/ledgermath/issues?state=open&per_page=100&page=1",
			"GET /repos/smrdotgg/ledgermath/issues?state=open&per_page=100&page=2",
			"POST /repos/smrdotgg/ledgermath/issues/101/comments",
			"POST /repos/smrdotgg/ledgermath/issues",
		]);
		expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({ body: "still stale" });
	});

	test("says what GitHub answered when a call fails", async () => {
		const github = new GitHubIssues("smrdotgg/ledgermath", "a-token", async () => new Response("Resource not accessible by integration", { status: 403 }));
		expect(github.open("t", "b")).rejects.toThrow("403 Resource not accessible by integration");
	});
});
