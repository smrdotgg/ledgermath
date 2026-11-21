/**
 * The alarm's watch on the data API's publishing (scripts/lib/api-freshness.ts,
 * scripts/alarm.ts): judged by when the API bucket's table of contents was
 * last written, by S3's clock, against the runs workflow's schedule; read
 * through S3ApiStore from a stand-in for S3 (tests/s3-standin.ts) with a key
 * that may only read, as the first job's role reads, within a time budget;
 * worked out whole in one guarded piece (watchApiBucket), so that the stale
 * Series and price files are judged as before whatever it does; raised in the
 * alarm's issue, by its rule of writing only when something changed.
 */

import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { treeObject } from "../infra/runs/api-bucket";
import type { Schedule } from "../infra/runs/schedule";
import {
	ACTIONS_RUN_URL,
	ALARM_MARKER,
	ALARM_TITLE,
	type AlarmOutcome,
	type ApiReport,
	type ApiWatchSteps,
	apiAlarmState,
	apiSummary,
	DRILL_BUCKET,
	describeSeries,
	type IssueTracker,
	type OpenAlarm,
	runAlarm,
	STATE_MARKER,
	stateOf,
	watchApiBucket,
} from "../scripts/alarm";
import {
	type ApiBucketCheck,
	ATTEMPT_MS,
	checkApiBucket,
	cronTimes,
	isStale,
	judgedThrough,
	MISSED_TO_RAISE,
	missedRuns,
	ownSlot,
	PUBLISH_GRACE_MS,
	READ_BUDGET_MS,
	RETRY_WAITS_MS,
	RUNS_SCHEDULE_UTC,
	type ReadOptions,
	scheduledStarts,
} from "../scripts/lib/api-freshness";
import { S3ApiStore, STAMP_KEY, type TreeFile } from "../scripts/lib/api-upload";
import { credentialsFromEnvironment } from "../scripts/lib/s3-create";
import { sha256Hex } from "../scripts/lib/sigv4";
import { S3Standin } from "./s3-standin";

// A local server, and child processes in the last tests.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "api-freshness-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BUCKET = "ledgermath-production-runs-apibucketbucket-abcdefgh";
/** The publish job's key: may read and write the bucket. */
const WRITER = "AKIAPUBLISHEXAMPLE00";
/** The first job's key, for the alarm: may only read it. */
const READER = "AKIAALARMEXAMPLE0000";
/** A key the bucket grants nothing. */
const STRANGER = "AKIASTRANGEREXAMPLE0";
const RUN = 44_852_356_733;
const SETTLED = new Date("2026-10-01T00:00:00Z");

const TARGET = { instance_type: "c6i.8xlarge", vcpus: 32, zone: "us-east-2c", boots_utc: ["22:10"] };
const QUOTA = { limit: 64, reserved_outside_schedule: 4 };
/** No watched Series and no price file: only the API bucket can be raised. */
const SCHEDULE: Schedule = { vcpu_quota: QUOTA, targets: [TARGET], benchmarks: [] };
/** One watched Series that has never had a Run: the existing alarm opens an issue for it. */
const STALE_SCHEDULE: Schedule = { vcpu_quota: QUOTA, targets: [TARGET], benchmarks: [{ name: "syscall", builds: ["static"], samples: 10, timeout_seconds: 120, params: [{ call: "getpid" }] }] };

/** Issues in memory, as GitHub keeps them. */
class FakeIssues implements IssueTracker {
	readonly issues: Array<{ number: number; title: string; body: string; open: boolean; comments: string[] }> = [];

	async findOpen(marker: string): Promise<OpenAlarm | null> {
		const issue = this.issues.find((candidate) => candidate.open && candidate.body.includes(marker));
		if (issue === undefined) return null;
		const posts = [issue.body, ...issue.comments.filter((comment) => comment.includes(STATE_MARKER))];
		return { number: issue.number, lastPost: posts.at(-1) as string };
	}

	async open(title: string, body: string): Promise<number> {
		const number = this.issues.length + 1;
		this.issues.push({ number, title, body, open: true, comments: [] });
		return number;
	}

	async comment(issue: number, body: string): Promise<void> {
		this.issues.find((candidate) => candidate.number === issue)?.comments.push(body);
	}

	/** Every post, body first. */
	posts(): string[] {
		return this.issues.flatMap((issue) => [issue.body, ...issue.comments]);
	}
}

const at = (iso: string): Date => new Date(iso);
const iso = (dates: Date[]): string[] => dates.map((date) => date.toISOString());
/** What a job started by hand at `now` judges through. */
const byHand = (now: string): Date => judgedThrough(at(now), null);
/** The report watchApiBucket makes of a finding, with the real judgement and words, and nothing written. */
const reportOf = (check: ApiBucketCheck, now: string, publicApiState = "off", drill = false): Promise<ApiReport> =>
	watchApiBucket({ reader: () => null, now: at(now), publicApiState, drill, steps: { read: async () => check, write: () => {} } });

describe("the schedule a publish is expected by", () => {
	test("is the runs workflow's: 00:00, 06:00, 12:00, 18:00 and 22:40 UTC (tests/runs-workflow.test.ts holds it to the crons)", () => {
		expect([...RUNS_SCHEDULE_UTC]).toEqual(["00:00", "06:00", "12:00", "18:00", "22:40"]);
		expect([...cronTimes("40 22 * * *"), ...cronTimes("0 */6 * * *")].sort()).toEqual([...RUNS_SCHEDULE_UTC]);
		expect(() => cronTimes("0 0 1 * *")).toThrow("not a daily cron");
		expect(() => cronTimes("0 25 * * *")).toThrow("out of range");
	});

	test("lists every scheduled start after one time and up to another, across days and months", () => {
		expect(iso(scheduledStarts(at("2026-11-30T17:00:00Z"), at("2026-12-01T06:00:00Z")))).toEqual([
			"2026-11-30T18:00:00.000Z",
			"2026-11-30T22:40:00.000Z",
			"2026-12-01T00:00:00.000Z",
			"2026-12-01T06:00:00.000Z",
		]);
		expect(iso(scheduledStarts(at("2026-11-21T06:00:00Z"), at("2026-11-21T12:00:00Z")))).toEqual(["2026-11-21T12:00:00.000Z"]);
		expect(scheduledStarts(at("2026-11-21T12:00:00Z"), at("2026-11-21T06:00:00Z"))).toEqual([]);
		expect(scheduledStarts(at("2026-11-21T00:00:01Z"), at("2026-11-21T05:59:59Z"))).toEqual([]);
		expect(scheduledStarts(at("2026-11-01T00:00:00Z"), at("2026-12-01T00:00:00Z")).length).toBe(30 * 5);
	});

	test("a scheduled run's own slot is the latest time of its cron at or before its job started; a run started by hand has none", () => {
		expect(ownSlot("0 */6 * * *", at("2026-11-22T01:00:00Z"))?.toISOString()).toBe("2026-11-22T00:00:00.000Z");
		expect(ownSlot("40 22 * * *", at("2026-11-22T00:05:00Z"))?.toISOString()).toBe("2026-11-21T22:40:00.000Z");
		expect(ownSlot("40 22 * * *", at("2026-11-21T22:44:00Z"))?.toISOString()).toBe("2026-11-21T22:40:00.000Z");
		expect(ownSlot("", at("2026-11-22T01:00:00Z"))).toBeNull();
	});

	test("a job judges only slots whose publish should have finished an hour before it started, and never its own slot or a later one", () => {
		const published = at("2026-11-21T00:04:00Z");
		expect(PUBLISH_GRACE_MS).toBe(HOUR);
		// The 06:00 run's job, a few minutes after 06:00: its own slot is not judged.
		expect(missedRuns(published, judgedThrough(at("2026-11-21T06:03:00Z"), at("2026-11-21T06:00:00Z")))).toEqual([]);
		// Started by hand an hour after 06:00 with nothing new: the 06:00 slot has elapsed.
		expect(iso(missedRuns(published, byHand("2026-11-21T07:00:00Z")))).toEqual(["2026-11-21T06:00:00.000Z"]);
		expect(missedRuns(published, byHand("2026-11-21T06:59:59Z"))).toEqual([]);
		// The 22:40 slot is judged by the 00:00 run's job: 80 minutes is more than its hour.
		const midnight = at("2026-11-22T00:03:00Z");
		expect(iso(missedRuns(at("2026-11-21T18:04:00Z"), judgedThrough(midnight, ownSlot("0 */6 * * *", midnight))))).toEqual(["2026-11-21T22:40:00.000Z"]);
	});

	test("counterexample (a): the 22:40 run fails and the midnight job starts an hour late: its alarm, at 01:01, counts one slot, not its own", () => {
		const started = at("2026-11-22T01:00:00Z");
		const missed = missedRuns(at("2026-11-21T18:02:00Z"), judgedThrough(started, ownSlot("0 */6 * * *", started)));
		expect(iso(missed)).toEqual(["2026-11-21T22:40:00.000Z"]);
		expect(missed.length).toBeLessThan(MISSED_TO_RAISE);
	});

	test("counterexample (b): the 22:40 and midnight runs fail, but a run started by hand publishes at 23:50: the 06:00 job counts one slot, since the bucket was written at 23:50", () => {
		const started = at("2026-11-22T06:03:00Z");
		const missed = missedRuns(at("2026-11-21T23:50:00Z"), judgedThrough(started, ownSlot("0 */6 * * *", started)));
		expect(iso(missed)).toEqual(["2026-11-22T00:00:00.000Z"]);
		expect(missed.length).toBeLessThan(MISSED_TO_RAISE);
	});

	/** A seeded random number in [0, 1), so the simulations below are the same every time. */
	function random(seed: number): () => number {
		let state = seed >>> 0;
		return () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	interface SimRun {
		/** Its scheduled slot; null for a run started by hand. */
		slot: Date | null;
		start: Date;
		fails: boolean;
	}

	/** The scheduled runs of three days from 2026-11-21, each late by late(index), one at a time (the group runs), failing as `fails` says. */
	function scheduledRuns(late: (index: number) => number, fails: ReadonlySet<number>): SimRun[] {
		const slots = scheduledStarts(at("2026-11-20T23:00:00Z"), at("2026-11-23T23:00:00Z"));
		let previous = 0;
		return slots.map((slot, index) => {
			const start = Math.max(slot.getTime() + late(index), previous + 2 * MINUTE);
			previous = start;
			return { slot, start: new Date(start), fails: fails.has(index) };
		});
	}

	/**
	 * Every run in order of start: its job starts, its alarm judges the slots
	 * it may (its own excluded, by the cron that started it), and then, unless
	 * it fails, it publishes two minutes later. The 22:40 run before day one
	 * published.
	 */
	function simulate(runs: SimRun[]): Array<SimRun & { counted: number; raised: boolean }> {
		let published = at("2026-11-20T22:42:00Z");
		return [...runs]
			.sort((a, b) => a.start.getTime() - b.start.getTime())
			.map((run) => {
				const cron = run.slot === null ? "" : run.slot.toISOString().slice(11, 16) === "22:40" ? "40 22 * * *" : "0 */6 * * *";
				const own = ownSlot(cron, run.start);
				if (run.slot !== null) expect(own?.toISOString()).toBe(run.slot.toISOString());
				const counted = missedRuns(published, judgedThrough(run.start, own)).length;
				if (!run.fails) published = new Date(run.start.getTime() + 2 * MINUTE);
				return { ...run, counted, raised: counted >= MISSED_TO_RAISE };
			});
	}

	const raisedAt = (results: ReturnType<typeof simulate>): number[] =>
		results.filter((result) => result.slot !== null).flatMap((result, index) => (result.raised ? [index] : []));

	test("one failed scheduled run never raises a scheduled run's alarm: runs late by any amount up to 79 minutes, past the hour included", () => {
		for (let seed = 1; seed <= 8; seed++) {
			const draw = random(seed);
			const lateness = Array.from({ length: 20 }, () => Math.floor(draw() * 80) * MINUTE);
			for (let failed = 0; failed < 13; failed++) {
				const results = simulate(scheduledRuns((index) => lateness[index] as number, new Set([failed])));
				expect({ seed, failed, raisedAt: raisedAt(results) }).toEqual({ seed, failed, raisedAt: [] });
			}
		}
		for (const late of [61 * MINUTE, 75 * MINUTE, 79 * MINUTE]) {
			for (let failed = 0; failed < 13; failed++) expect({ late, failed, raisedAt: raisedAt(simulate(scheduledRuns(() => late, new Set([failed])))) }).toEqual({ late, failed, raisedAt: [] });
		}
	});

	test("with runs started by hand between the slots, publishing, and runs under an hour late, one failed run raises no alarm at all, by hand or scheduled", () => {
		for (let seed = 1; seed <= 8; seed++) {
			const draw = random(100 + seed);
			const lateness = Array.from({ length: 20 }, () => Math.floor(draw() * 59) * MINUTE);
			for (let failed = 0; failed < 13; failed++) {
				const scheduled = scheduledRuns((index) => lateness[index] as number, new Set([failed]));
				// A run by hand in a few of the gaps, at a random point between two slots' runs.
				const byHandRuns: SimRun[] = scheduled.slice(0, -1).flatMap((run, index) => {
					if (draw() < 0.6) return [];
					const next = scheduled[index + 1] as SimRun;
					const start = run.start.getTime() + 3 * MINUTE + draw() * (next.start.getTime() - run.start.getTime() - 6 * MINUTE);
					return start > run.start.getTime() + 3 * MINUTE ? [{ slot: null, start: new Date(start), fails: false }] : [];
				});
				const results = simulate([...scheduled, ...byHandRuns]);
				expect({ seed, failed, raised: results.filter((result) => result.raised).length }).toEqual({ seed, failed, raised: 0 });
			}
		}
	});

	test("two failed scheduled runs in a row, with nothing published between, always raise the alarm of the run after them, however late it starts, and no earlier one", () => {
		// Up to 77 minutes late, so each publish lands before the next slot, 80 minutes after 22:40 at the least. A publish that lands
		// after the next slot (the 22:40 run starting 79 minutes late) is the bucket written after that slot, which then does not count:
		// the count is of slots elapsed since the bucket was last written (README, "The alarm").
		for (let seed = 1; seed <= 8; seed++) {
			const draw = random(200 + seed);
			const lateness = Array.from({ length: 20 }, () => Math.floor(draw() * 78) * MINUTE);
			for (let first = 0; first < 12; first++) {
				const results = simulate(scheduledRuns((index) => lateness[index] as number, new Set([first, first + 1])));
				expect({ seed, first, raisedAt: raisedAt(results) }).toEqual({ seed, first, raisedAt: [first + 2] });
			}
		}
		// Publishing that stays stopped stays raised, up to the alarm of the first run that publishes again (its alarm comes first).
		expect(raisedAt(simulate(scheduledRuns(() => 4 * MINUTE, new Set([3, 4, 5, 6, 7, 8, 9]))))).toEqual([5, 6, 7, 8, 9, 10]);
	});

	test("a very late start: the 22:40 run, 79 minutes late, publishes after midnight's slot, so if midnight and 06:00 then fail, the 12:00 job counts one slot, and the 18:00 job raises", () => {
		const results = simulate(scheduledRuns((index) => (index === 4 ? 79 * MINUTE : 3 * MINUTE), new Set([5, 6])));
		expect(results[4]?.start.toISOString()).toBe("2026-11-21T23:59:00.000Z");
		expect(results[7]).toMatchObject({ counted: 1, raised: false });
		expect(raisedAt(simulate(scheduledRuns((index) => (index === 4 ? 79 * MINUTE : 3 * MINUTE), new Set([5, 6, 7]))))).toEqual([8]);
	});

	test("a publish by hand between two failed runs starts the count again: counterexample (b), simulated", () => {
		// Runs 4 and 5 are 22:40 and 00:00 of 2026-11-21 to 22; a run by hand publishes at 23:50 between them.
		const scheduled = scheduledRuns(() => 3 * MINUTE, new Set([4, 5]));
		expect(scheduled[4]?.slot?.toISOString()).toBe("2026-11-21T22:40:00.000Z");
		const results = simulate([...scheduled, { slot: null, start: at("2026-11-21T23:48:00Z"), fails: false }]);
		const six = results.find((result) => result.slot?.toISOString() === "2026-11-22T06:00:00.000Z");
		expect(six).toMatchObject({ counted: 1, raised: false });
		expect(raisedAt(results)).toEqual([]);
	});

	test("a published bucket is stale only from the second elapsed slot", () => {
		const published = (missed: string[]): ApiBucketCheck => ({ kind: "published", bucket: BUCKET, lastModified: "2026-11-21T00:04:00.000Z", run: RUN, missed });
		expect(isStale(published([]))).toBe(false);
		expect(isStale(published(["2026-11-21T06:00:00.000Z"]))).toBe(false);
		expect(isStale(published(["2026-11-21T06:00:00.000Z", "2026-11-21T12:00:00.000Z"]))).toBe(true);
		expect(isStale({ kind: "empty", bucket: BUCKET })).toBe(false);
	});
});

/** The table of contents, as the upload writes it. */
function indexFile(text = '{"schema":"https://api.ledgermath.com/v1/schemas/index.schema.json"}'): TreeFile {
	const bytes = new TextEncoder().encode(text);
	return { key: STAMP_KEY, bytes, sha256: sha256Hex(bytes), ...treeObject(STAMP_KEY) };
}

/** A body that sends `first` and then nothing more, never ending. */
const stalling = (first: string): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(first));
		},
	});
/** A body that sends a byte every 50 ms, for ever. */
const trickling = (): ReadableStream<Uint8Array> =>
	new ReadableStream({
		async pull(controller) {
			await Bun.sleep(50);
			controller.enqueue(new TextEncoder().encode("<"));
		},
	});
const OBJECT_HEADERS = { "content-type": "application/json", "last-modified": new Date("2026-11-21T01:49:48Z").toUTCString(), "x-amz-meta-ledgermath-run": String(RUN) };

describe("the API bucket, read from a stand-in for S3", () => {
	let standin: S3Standin;
	let publisher: S3ApiStore;
	/** The alarm's view: the first job's key, which may only read. */
	const alarmView = (bucket = BUCKET, keyId = READER) =>
		new S3ApiStore(bucket, "us-east-2", { endpoint: standin.url, errorBodyMs: 100, credentials: () => ({ accessKeyId: keyId, secretAccessKey: "secret", sessionToken: "token" }) });
	/** The publish job's upload ending at `when`: its last act writes the table of contents, recording its run. */
	const publish = async (when: string, run: number) => {
		standin.now = () => at(when);
		await publisher.put(indexFile(`{"run":${run}}`), run);
	};
	const noSleep = async () => {};
	/** Small budgets, so the worst cases take a second. */
	const FAST: ReadOptions = { budgetMs: 1_200, attemptMs: 300, waitsMs: [50, 100] };

	beforeEach(() => {
		standin = new S3Standin();
		standin.start();
		standin.bucket(BUCKET, { writers: [WRITER], readers: [READER] });
		publisher = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: WRITER, secretAccessKey: "secret", sessionToken: "token" }) });
	});
	afterEach(() => standin.stop());

	test("a fresh bucket: when its table of contents was last written, by S3's clock, and the run it records; nothing missed; one GET with the read-only key", async () => {
		await publish("2026-11-21T01:49:48Z", RUN);
		const before = standin.requests.length;
		const check = await checkApiBucket(alarmView(), byHand("2026-11-21T06:04:00Z"));
		expect(check).toEqual({ kind: "published", bucket: `s3://${BUCKET}`, lastModified: "2026-11-21T01:49:48.000Z", run: RUN, missed: [] });
		expect(standin.requests.slice(before)).toEqual([{ method: "GET", bucket: BUCKET, key: STAMP_KEY, keyId: READER, ifNoneMatch: null }]);
		expect(apiAlarmState(check, "off")).toBeNull();
	});

	test("a stale bucket: the scheduled slots since it was last written that the job may judge", async () => {
		await publish("2026-11-21T01:49:48Z", RUN);
		const oneMissed = await checkApiBucket(alarmView(), byHand("2026-11-21T12:04:00Z"));
		expect(oneMissed).toMatchObject({ kind: "published", missed: ["2026-11-21T06:00:00.000Z"] });
		expect(apiAlarmState(oneMissed, "off")).toBeNull();
		const twoMissed = await checkApiBucket(alarmView(), byHand("2026-11-21T18:04:00Z"));
		expect(twoMissed).toMatchObject({ kind: "published", missed: ["2026-11-21T06:00:00.000Z", "2026-11-21T12:00:00.000Z"] });
		expect(apiAlarmState(twoMissed, "off")).toBe("stale since 2026-11-21T01:49:48.000Z");
	});

	test("an empty bucket, with the variable set: no table of contents, raised at once", async () => {
		const check = await checkApiBucket(alarmView(), byHand("2026-11-21T06:04:00Z"));
		expect(check).toEqual({ kind: "empty", bucket: `s3://${BUCKET}` });
		expect(apiAlarmState(check, "off")).toBe("empty");
	});

	test("an unreadable bucket, raised at once, never thrown: refused, missing (not taken for empty: a GET, not a HEAD), no credentials", async () => {
		const refused = await checkApiBucket(alarmView(BUCKET, STRANGER), byHand("2026-11-21T06:04:00Z"), { sleep: noSleep });
		expect(refused).toMatchObject({ kind: "unreadable", code: "403 AccessDenied", attempts: 1 });
		expect((refused as { reason: string }).reason).toBe(`GET s3://${BUCKET}/v1/index.json answered 403 AccessDenied: Access Denied`);
		expect(apiAlarmState(refused, "off")).toBe("unreadable: 403 AccessDenied");
		expect(await checkApiBucket(alarmView("ledgermath-no-such-bucket"), byHand("2026-11-21T06:04:00Z"), { sleep: noSleep })).toMatchObject({
			kind: "unreadable",
			code: "404 NoSuchBucket",
			attempts: 1,
		});
		const keyless = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => credentialsFromEnvironment({}) });
		expect(await checkApiBucket(keyless, byHand("2026-11-21T06:04:00Z"), { sleep: noSleep })).toMatchObject({ kind: "unreadable", code: "NoCredentials", attempts: 1 });
	});

	test("a 5xx or no answer is tried again, three times in all, waiting 1 then 2 seconds; one that passes on a later try is no finding", async () => {
		expect([...RETRY_WAITS_MS]).toEqual([1_000, 2_000]);
		await publish("2026-11-21T01:49:48Z", RUN);
		let failures = 2;
		standin.fault = (request) => (request.method === "GET" && failures-- > 0 ? new Response("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>", { status: 500 }) : undefined);
		const waits: number[] = [];
		const sleep = async (ms: number) => {
			waits.push(ms);
		};
		expect(await checkApiBucket(alarmView(), byHand("2026-11-21T06:04:00Z"), { sleep })).toMatchObject({ kind: "published", run: RUN, missed: [] });
		expect(waits).toEqual([1_000, 2_000]);
		failures = 5;
		waits.length = 0;
		expect(await checkApiBucket(alarmView(), byHand("2026-11-21T06:04:00Z"), { sleep })).toMatchObject({ kind: "unreadable", code: "500 InternalError", attempts: 3 });
		expect(waits).toEqual([1_000, 2_000]);
		const closed = new S3ApiStore(BUCKET, "us-east-2", { endpoint: "http://127.0.0.1:9", credentials: () => ({ accessKeyId: READER, secretAccessKey: "secret" }) });
		expect(await checkApiBucket(closed, byHand("2026-11-21T06:04:00Z"), { sleep: noSleep })).toMatchObject({ kind: "unreadable", code: "NoAnswer", attempts: 3 });
	});

	test("the budget: 20 seconds in all, 5 a try, so three tries and their waits fit", () => {
		expect(READ_BUDGET_MS).toBe(20_000);
		expect(ATTEMPT_MS).toBe(5_000);
		expect(3 * ATTEMPT_MS + RETRY_WAITS_MS.reduce((sum, wait) => sum + wait, 0)).toBeLessThanOrEqual(READ_BUDGET_MS);
	});

	test("a 200 whose body stalls after its headers is read from its headers alone, at once: its body is never waited for", async () => {
		standin.fault = (request) => (request.method === "GET" ? new Response(stalling("{"), { headers: OBJECT_HEADERS }) : undefined);
		const started = performance.now();
		expect(await checkApiBucket(alarmView(), byHand("2026-11-21T06:04:00Z"))).toMatchObject({ kind: "published", lastModified: "2026-11-21T01:49:48.000Z", run: RUN });
		expect(performance.now() - started).toBeLessThan(ATTEMPT_MS / 2);
		standin.fault = (request) => (request.method === "GET" ? new Response(trickling(), { headers: OBJECT_HEADERS }) : undefined);
		const again = performance.now();
		expect(await checkApiBucket(alarmView(), byHand("2026-11-21T06:04:00Z"))).toMatchObject({ kind: "published", run: RUN });
		expect(performance.now() - again).toBeLessThan(ATTEMPT_MS / 2);
	});

	test("an error's text is cut to what can be quoted: one line, no backticks, 300 characters at most", async () => {
		const message = "`run this`\n".repeat(150);
		standin.fault = (request) => (request.method === "GET" ? new Response(`<Error><Code>AccessDenied</Code><Message>${message}</Message></Error>`, { status: 403 }) : undefined);
		const check = await checkApiBucket(alarmView(), byHand("2026-11-21T06:04:00Z"), { sleep: noSleep });
		expect(check.kind).toBe("unreadable");
		const reason = (check as { reason: string }).reason;
		expect(reason).not.toMatch(/[`\n]/);
		// S3's message is cut to 300 characters, after the request it answered.
		expect(reason.length).toBeLessThanOrEqual(`GET s3://${BUCKET}/v1/index.json answered 403 AccessDenied: `.length + 300);
		const report = await reportOf(check, "2026-11-21T06:04:00Z");
		expect(report.raised).not.toContain("`run this`");
		// And the issue quotes at most 300 characters of the whole reason.
		expect(report.raised).toContain(`${reason.slice(0, 299)}…`);
		// An error body larger than what is read is cut where the reading stopped.
		standin.fault = (request) => (request.method === "GET" ? new Response(`<Error><Code>AccessDenied</Code><Message>${"x".repeat(100_000)}</Message></Error>`, { status: 403 }) : undefined);
		expect(await checkApiBucket(alarmView(), byHand("2026-11-21T06:04:00Z"), { sleep: noSleep })).toMatchObject({ kind: "unreadable", code: "403 AccessDenied" });
	});

	describe("within its budget, after which the existing alarm's own verdict comes out as before", () => {
		/** The whole pass, as the script runs it: the check, then the existing alarm on one stale Series. */
		const wholePass = async (): Promise<{ elapsed: number; report: ApiReport; outcome: AlarmOutcome; tracker: FakeIssues }> => {
			const tracker = new FakeIssues();
			const started = performance.now();
			const report = await watchApiBucket({ reader: () => alarmView(), now: at("2026-11-21T06:04:00Z"), publicApiState: "off", readOptions: FAST, steps: { write: () => {} } });
			const outcome = await runAlarm({ schedule: STALE_SCHEDULE, runs: [], now: at("2026-11-21T06:04:00Z"), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: report });
			return { elapsed: performance.now() - started, report, outcome, tracker };
		};
		const verdictStands = (done: Awaited<ReturnType<typeof wholePass>>, code: string) => {
			expect(done.elapsed).toBeLessThan((FAST.budgetMs as number) + 800);
			expect(done.report.state).toBe(`unreadable: ${code}`);
			expect(done.outcome).toMatchObject({ action: "opened", issue: 1 });
			expect(done.outcome.stale.map(describeSeries)).toEqual(["syscall · call=getpid · static · c6i.8xlarge · us-east-2c"]);
			expect(done.tracker.issues[0]?.body).toContain("1 watched Series has had no Run for more than 48 hours.");
		};

		test("an error whose body stalls after its headers", async () => {
			standin.fault = (request) => (request.method === "GET" ? new Response(stalling("<Error><Code>Inter"), { status: 500 }) : undefined);
			verdictStands(await wholePass(), "500 HTTP500");
		});

		test("no answer at all", async () => {
			standin.fault = (request) => (request.method === "GET" ? new Promise<Response>(() => {}) : undefined);
			verdictStands(await wholePass(), "Timeout");
		});

		test("an error whose body trickles", async () => {
			standin.fault = (request) => (request.method === "GET" ? new Response(trickling(), { status: 503 }) : undefined);
			verdictStands(await wholePass(), "503 HTTP503");
		});
	});

	describe("guarded whole: a throw at any stage of the check is a line in the alarm's words, and the stale Series and price files are judged as on main", () => {
		const NOW = "2026-11-21T06:04:00Z";
		/** The existing alarm on one stale Series, with this report of the bucket, or none (as on main, where the bucket was not watched). */
		const verdict = async (api: ApiReport | null) => {
			const tracker = new FakeIssues();
			const outcome = await runAlarm({ schedule: STALE_SCHEDULE, runs: [], now: at(NOW), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api });
			return { outcome, post: tracker.posts()[0] ?? "" };
		};
		const boom = (stage: string) => () => {
			throw new Error(`injected at the ${stage} stage`);
		};
		const stages: Array<[string, Partial<ApiWatchSteps>]> = [
			["read", { read: async () => boom("read")() }],
			["judge", { judge: boom("judge") }],
			["summarize", { summarize: boom("summarize") }],
			["text", { text: boom("text") }],
		];

		for (const [stage, steps] of stages) {
			test(`a throw in the ${stage} stage`, async () => {
				await publish("2026-11-21T01:49:48Z", RUN);
				const report = await watchApiBucket({ reader: () => alarmView(), now: at(NOW), publicApiState: "off", steps: { write: () => {}, ...steps } });
				expect(report.state).toBe("check failed");
				expect(report.raised).toContain(`**The check of the API bucket failed**, so whether the data API is being published cannot be told: Error: injected at the ${stage} stage.`);
				const main = await verdict(null);
				const ours = await verdict(report);
				expect({ action: ours.outcome.action, stale: ours.outcome.stale, prices: ours.outcome.prices }).toEqual({
					action: main.outcome.action,
					stale: main.outcome.stale,
					prices: main.outcome.prices,
				});
				for (const line of main.post.split("\n").slice(0, -1)) expect(ours.post).toContain(line);
				expect(stateOf(ours.post)).toEqual({ ...(stateOf(main.post) as NonNullable<ReturnType<typeof stateOf>>), stale_api: "check failed" });
			});
		}

		test("a throw making the reader, an unreadable job start, and a thrown thing with no words", async () => {
			const failing = [
				await watchApiBucket({ reader: () => boom("reader")(), now: at(NOW), publicApiState: "off", steps: { write: () => {} } }),
				await watchApiBucket({ reader: () => alarmView(), now: at(NOW), jobStartedAt: "yesterday", publicApiState: "off", steps: { write: () => {} } }),
				await watchApiBucket({ reader: () => alarmView(), now: at(NOW), cron: "every day", publicApiState: "off", steps: { write: () => {} } }),
				await watchApiBucket({
					reader: () => alarmView(),
					now: at(NOW),
					publicApiState: "off",
					steps: {
						judge: () => {
							throw {
								toString() {
									throw new Error("no words");
								},
							};
						},
						write: () => {},
					},
				}),
			];
			for (const report of failing) expect(report.state).toBe("check failed");
			expect(failing[3]?.raised).toContain("something was thrown that cannot be put in words");
			const main = await verdict(null);
			for (const report of failing) expect((await verdict(report)).outcome.stale).toEqual(main.outcome.stale);
		});

		test("a step summary that cannot be written is warned of and passed over: the report is the real one", async () => {
			await publish("2026-11-21T01:49:48Z", RUN);
			const report = await watchApiBucket({ reader: () => alarmView(), now: at(NOW), publicApiState: "off", steps: { write: boom("write") } });
			expect(report.state).toBeNull();
			expect(report.summary).toContain("last written at 2026-11-21T01:49:48.000Z");
			const main = await verdict(null);
			const ours = await verdict(report);
			expect(ours.outcome.action).toBe(main.outcome.action);
			expect(stateOf(ours.post)).toEqual(stateOf(main.post));
		});
	});

	describe("in the alarm's issue", () => {
		const pass = async (tracker: FakeIssues, now: string, api: ApiReport | null) =>
			runAlarm({ schedule: SCHEDULE, runs: [], now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api });
		/** What a job started by hand at `now` reports of the bucket. */
		const read = (now: string, reader = () => alarmView()) => watchApiBucket({ reader, now: at(now), publicApiState: "off", readOptions: { sleep: noSleep }, steps: { write: () => {} } });

		test("raises a stale bucket once, stays silent while nothing changes, and says once that it is published again", async () => {
			const tracker = new FakeIssues();
			await publish("2026-11-21T01:49:48Z", RUN);
			// The 06:00 run published nothing: one slot elapsed, nothing said.
			expect(await pass(tracker, "2026-11-21T12:04:00Z", await read("2026-11-21T12:04:00Z"))).toMatchObject({ action: "none", api: null });
			// Nor the 12:00 run: two.
			const opened = await pass(tracker, "2026-11-21T18:04:00Z", await read("2026-11-21T18:04:00Z"));
			expect(opened).toMatchObject({ action: "opened", issue: 1, api: "stale since 2026-11-21T01:49:48.000Z" });
			const issue = tracker.issues[0];
			expect(issue?.title).toBe(ALARM_TITLE);
			expect(issue?.body.startsWith(`${ALARM_MARKER}\nChecked at 2026-11-21T18:04:00.000Z: every watched Series has had a Run in the last 48 hours.`)).toBe(true);
			expect(issue?.body).toContain(
				`**The data API has not been published for 2 scheduled slots.** In \`s3://${BUCKET}\`, \`v1/index.json\` was last written at 2026-11-21T01:49:48.000Z, 16.2 hours ago, by run [${RUN}](${ACTIONS_RUN_URL}${RUN}), and nothing has published since: not the runs scheduled at 2026-11-21 06:00 UTC, 2026-11-21 12:00 UTC, each given 1 hour.`,
			);
			expect(stateOf(issue?.body ?? "")).toEqual({ stale: [], copy_failed: false, stale_api: "stale since 2026-11-21T01:49:48.000Z" });
			expect(await pass(tracker, "2026-11-21T22:44:00Z", await read("2026-11-21T22:44:00Z"))).toMatchObject({ action: "unchanged", issue: 1 });
			expect(await pass(tracker, "2026-11-22T00:04:00Z", await read("2026-11-22T00:04:00Z"))).toMatchObject({ action: "unchanged", issue: 1 });
			await publish("2026-11-22T00:05:10Z", RUN + 1000);
			expect(await pass(tracker, "2026-11-22T06:04:00Z", await read("2026-11-22T06:04:00Z"))).toMatchObject({ action: "commented", issue: 1, api: null });
			expect(tracker.issues[0]?.comments[0]).toContain(
				`every watched Series has had a Run in the last 48 hours again, and the data API was last published at 2026-11-22T00:05:10.000Z, by run [${RUN + 1000}](${ACTIONS_RUN_URL}${RUN + 1000}).`,
			);
			expect(stateOf(tracker.issues[0]?.comments[0] ?? "")).toEqual({ stale: [], copy_failed: false });
			expect(await pass(tracker, "2026-11-22T12:04:00Z", await read("2026-11-22T12:04:00Z"))).toMatchObject({ action: "unchanged" });
			expect(tracker.issues.length).toBe(1);
			expect(tracker.issues[0]?.comments.length).toBe(1);
		});

		test("a fresh bucket, and one elapsed slot, raise nothing", async () => {
			const tracker = new FakeIssues();
			await publish("2026-11-21T00:04:30Z", RUN);
			expect(await pass(tracker, "2026-11-21T06:04:00Z", await read("2026-11-21T06:04:00Z"))).toMatchObject({ action: "none", api: null });
			expect(await pass(tracker, "2026-11-21T12:04:00Z", await read("2026-11-21T12:04:00Z"))).toMatchObject({ action: "none", api: null });
			expect(tracker.issues).toEqual([]);
		});

		test("an empty bucket and an unreadable one are raised at once, each in its own words, and a change from one to the other is one comment", async () => {
			const tracker = new FakeIssues();
			expect(await pass(tracker, "2026-11-21T06:04:00Z", await read("2026-11-21T06:04:00Z"))).toMatchObject({ action: "opened", api: "empty" });
			expect(tracker.issues[0]?.body).toContain(`**The API bucket holds no table of contents.** \`API_BUCKET\` names \`s3://${BUCKET}\`, which holds no \`v1/index.json\``);
			const stranger = () => alarmView(BUCKET, STRANGER);
			expect(await pass(tracker, "2026-11-21T12:04:00Z", await read("2026-11-21T12:04:00Z", stranger))).toMatchObject({ action: "commented", api: "unreadable: 403 AccessDenied" });
			expect(tracker.issues[0]?.comments[0]).toContain(
				`**The API bucket could not be read**, so whether the data API is being published cannot be told. GET s3://${BUCKET}/v1/index.json answered 403 AccessDenied: Access Denied.`,
			);
			expect(await pass(tracker, "2026-11-21T18:04:00Z", await read("2026-11-21T18:04:00Z", stranger))).toMatchObject({ action: "unchanged" });
			await publish("2026-11-21T18:05:00Z", RUN + 2000);
			expect(await pass(tracker, "2026-11-21T22:44:00Z", await read("2026-11-21T22:44:00Z"))).toMatchObject({ action: "commented", api: null });
			expect(tracker.issues[0]?.comments[1]).toContain("and the data API was last published at 2026-11-21T18:05:00.000Z");
		});

		test("with API_BUCKET unset, nothing is raised while PUBLIC_API is off; and when a raised bucket's variable is unset, it says once that the bucket is no longer watched", async () => {
			const tracker = new FakeIssues();
			expect(await watchApiBucket({ reader: () => null, now: at("2026-11-21T06:04:00Z"), publicApiState: "off", steps: { write: () => {} } })).toMatchObject({ state: null, watched: false });
			expect(standin.requests).toEqual([]);
			expect(await pass(tracker, "2026-11-21T06:04:00Z", await reportOf({ kind: "unset" }, "2026-11-21T06:04:00Z"))).toMatchObject({ action: "none", api: null });
			expect(tracker.issues).toEqual([]);
			await pass(tracker, "2026-11-21T12:04:00Z", await read("2026-11-21T12:04:00Z"));
			expect(tracker.issues[0]?.body).toContain("holds no table of contents");
			expect(await pass(tracker, "2026-11-21T18:04:00Z", await reportOf({ kind: "unset" }, "2026-11-21T18:04:00Z"))).toMatchObject({ action: "commented", api: null });
			expect(tracker.issues[0]?.comments[0]).toContain("every watched Series has had a Run in the last 48 hours again, and `API_BUCKET` is unset, so the API bucket is not watched.");
		});

		test("with API_BUCKET unset, the alarm is raised in any other state of PUBLIC_API: serving is on, so a missing bucket name means publishing has stopped", async () => {
			for (const state of ["dark", "closed", "on"]) {
				const tracker = new FakeIssues();
				expect(apiAlarmState({ kind: "unset" }, state)).toBe(`unset while PUBLIC_API is ${state}`);
				expect(await pass(tracker, "2026-11-21T06:04:00Z", await reportOf({ kind: "unset" }, "2026-11-21T06:04:00Z", state))).toMatchObject({ action: "opened", api: `unset while PUBLIC_API is ${state}` });
				expect(tracker.issues[0]?.body).toContain(`**\`API_BUCKET\` is unset while \`PUBLIC_API\` is \`${state}\`.** The \`publish\` job is skipped, so nothing is published`);
			}
		});

		test("an open issue whose last post is from before the bucket was watched gets no comment while the bucket is fresh", async () => {
			const tracker = new FakeIssues();
			tracker.issues.push({ number: 1, title: "Stale: no Run, or no price file, for 48 hours", body: `${ALARM_MARKER}\nolder\n${STATE_MARKER}{"stale":[],"copy_failed":true} -->`, open: true, comments: [] });
			await publish("2026-11-21T00:04:30Z", RUN);
			expect(await pass(tracker, "2026-11-21T06:04:00Z", await read("2026-11-21T06:04:00Z"))).toMatchObject({ action: "commented" });
			expect(tracker.issues[0]?.comments[0]).toContain("and the data API was last published at 2026-11-21T00:04:30.000Z");
			expect(await pass(tracker, "2026-11-21T12:04:00Z", await read("2026-11-21T12:04:00Z"))).toMatchObject({ action: "unchanged" });
		});

		test("a stale bucket beside stale Series is said in the same post, and its recovery while they stay stale is said once", async () => {
			const tracker = new FakeIssues();
			const both = (now: string, api: ApiReport) => runAlarm({ schedule: STALE_SCHEDULE, runs: [], now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api });
			await publish("2026-11-21T01:49:48Z", RUN);
			const opened = await both("2026-11-21T18:04:00Z", await read("2026-11-21T18:04:00Z"));
			expect(opened.stale.length).toBe(1);
			expect(tracker.issues[0]?.body).toContain("1 watched Series has had no Run for more than 48 hours.");
			expect(tracker.issues[0]?.body).toContain("**The data API has not been published for 2 scheduled slots.**");
			await publish("2026-11-21T18:05:00Z", RUN + 3000);
			expect(await both("2026-11-21T22:44:00Z", await read("2026-11-21T22:44:00Z"))).toMatchObject({ action: "commented", api: null });
			expect(tracker.issues[0]?.comments[0]).toContain(`The data API is published again: it was last published at 2026-11-21T18:05:00.000Z, by run [${RUN + 3000}]`);
			expect(tracker.issues[0]?.comments[0]).not.toContain("has not been published");
		});

		test("a drill reads a name no bucket can have and says it is a drill; the next ordinary run clears it with the one usual comment", async () => {
			const tracker = new FakeIssues();
			await publish("2026-11-21T01:49:48Z", RUN);
			const drill = await watchApiBucket({
				reader: () => alarmView(DRILL_BUCKET),
				now: at("2026-11-21T03:00:00Z"),
				publicApiState: "off",
				drill: true,
				readOptions: { sleep: noSleep },
				steps: { write: () => {} },
			});
			expect(drill.state).toBe("drill, unreadable: 404 NoSuchBucket");
			expect(drill.summary).toStartWith("drill: ");
			expect(standin.requests.at(-1)).toMatchObject({ method: "GET", bucket: DRILL_BUCKET, key: STAMP_KEY });
			expect(await pass(tracker, "2026-11-21T03:00:00Z", drill)).toMatchObject({ action: "opened", api: "drill, unreadable: 404 NoSuchBucket" });
			expect(tracker.issues[0]?.body).toContain(`**This is a drill.** The workflow was started by hand with \`alarm_drill\`, so the alarm read \`s3://${DRILL_BUCKET}\``);
			expect(tracker.issues[0]?.body).toContain("This run's `publish` job used the real `API_BUCKET`.");
			expect(await pass(tracker, "2026-11-21T06:04:00Z", await read("2026-11-21T06:04:00Z"))).toMatchObject({ action: "commented", api: null });
			expect(tracker.issues[0]?.comments).toHaveLength(1);
			expect(tracker.issues[0]?.comments[0]).toContain("and the data API was last published at 2026-11-21T01:49:48.000Z");
			expect(await pass(tracker, "2026-11-21T12:04:00Z", await read("2026-11-21T12:04:00Z"))).toMatchObject({ action: "unchanged" });
		});
	});
});

describe("the script, as the first job runs it", () => {
	let standin: S3Standin;
	beforeEach(() => {
		standin = new S3Standin();
		standin.start();
		standin.bucket(BUCKET, { writers: [WRITER], readers: [READER] });
	});
	afterEach(() => standin.stop());

	/** The alarm, posting nothing, with no price file watched and the read-only key in its environment. `stale` makes every watched Series stale (no Run, schedule long settled). */
	const alarm = async (now: string, extra: string[], options: { stale?: boolean; summary?: "file" | "directory" } = {}) => {
		const directory = mkdtempSync(join(scratch, "script-"));
		const runs = join(directory, "ledgermath-runs");
		mkdirSync(runs);
		let summary = join(directory, "summary.md");
		if (options.summary === "directory") {
			summary = join(directory, "summary-is-a-directory");
			mkdirSync(summary);
		} else writeFileSync(summary, "");
		const changed = options.stale === true ? SETTLED.toISOString() : now;
		const child = Bun.spawn(
			["bun", join(ROOT, "scripts", "alarm.ts"), "--runs", runs, "--copy", "succeeded", "--schedule-changed-at", changed, "--now", now, "--dry-run", "--api-endpoint", standin.url, ...extra],
			{
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AWS_ACCESS_KEY_ID: READER, AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "token", GITHUB_STEP_SUMMARY: summary },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { exitCode, stdout, stderr, summary: options.summary === "directory" ? "" : readFileSync(summary, "utf8") };
	};
	const staleLines = (stdout: string): string[] => stdout.split("\n").filter((line) => line.startsWith("stale: "));

	test("with API_BUCKET unset, says so in the step summary and reads nothing", async () => {
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", ""]);
		expect(done.stderr).toBe("");
		expect(done.exitCode).toBe(0);
		expect(standin.requests).toEqual([]);
		// Whether it is raised depends on PUBLIC_API, which the script reads as committed; no test but the release gate may
		// depend on that (tests/public-blobs.test.ts), so both cases are held above, each with its state given.
		expect(done.summary).toStartWith("### The API bucket\n\nAPI_BUCKET is unset");
		expect(apiSummary({ kind: "unset" }, at("2026-11-21T06:04:00Z"), "off")).toBe("API_BUCKET is unset: the API bucket is not read and nothing is raised for it (the publish job is skipped too)");
		expect(apiSummary({ kind: "unset" }, at("2026-11-21T06:04:00Z"), "on")).toBe("API_BUCKET is unset while PUBLIC_API is on: nothing is published, and that is raised");
	});

	test("with a fresh bucket, says when it was last written and by which run, and raises nothing; a scheduled job judges by when it started and its cron", async () => {
		standin.now = () => at("2026-11-21T01:49:48Z");
		const publisher = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: WRITER, secretAccessKey: "secret" }) });
		await publisher.put(indexFile(), RUN);
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET, "--job-started-at", "2026-11-21T06:03:00Z", "--cron", "0 */6 * * *"]);
		expect(done.stderr).toBe("");
		expect(done.exitCode).toBe(0);
		expect(done.summary).toContain(
			`s3://${BUCKET}: v1/index.json last written at 2026-11-21T01:49:48.000Z (4.2 hours ago), by run ${RUN}; 0 scheduled slots since that this job judges, and 2 raise the alarm: not raised`,
		);
		expect(done.stdout).not.toContain("would open");
	});

	test("with a bucket it cannot read, exits 0 all the same, and raises it in the alarm's words", async () => {
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", "ledgermath-no-such-bucket"]);
		expect(done.stderr).toBe("");
		expect(done.exitCode).toBe(0);
		expect(done.summary).toContain("s3://ledgermath-no-such-bucket could not be read (1 try): GET s3://ledgermath-no-such-bucket/v1/index.json answered 404 NoSuchBucket");
		expect(done.stdout).toContain("--dry-run: would open");
		expect(done.stdout).toContain("**The API bucket could not be read**");
	});

	test("a step summary that is a directory: warned of, and the stale Series verdict and exit code are those of the alarm without the bucket", async () => {
		const main = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", ""], { stale: true });
		expect(main.exitCode).toBe(0);
		expect(staleLines(main.stdout).length).toBeGreaterThan(0);
		const ours = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET], { stale: true, summary: "directory" });
		expect(ours.exitCode).toBe(main.exitCode);
		expect(ours.stderr).toContain("could not be written to the step's summary");
		expect(staleLines(ours.stdout)).toEqual(staleLines(main.stdout));
		expect(ours.stdout).toContain("--dry-run: would open");
		expect(ours.stdout).toContain("watched Series have had no Run for more than 48 hours.");
	});

	test("a 200 whose body stalls: the script reads its headers, finishes at once, and gives the stale Series verdict", async () => {
		standin.fault = (request) => (request.method === "GET" ? new Response(stalling("{"), { headers: OBJECT_HEADERS }) : undefined);
		const started = performance.now();
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET], { stale: true });
		expect(performance.now() - started).toBeLessThan(ATTEMPT_MS + 5_000);
		expect(done.exitCode).toBe(0);
		expect(done.stdout).toContain(`v1/index.json last written at 2026-11-21T01:49:48.000Z`);
		expect(staleLines(done.stdout).length).toBeGreaterThan(0);
	});

	test("--drill yes reads the drill's name, not API_BUCKET, and says it is a drill", async () => {
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET, "--drill", "yes"]);
		expect(done.exitCode).toBe(0);
		expect(standin.requests.map((request) => request.bucket)).toEqual([DRILL_BUCKET]);
		expect(done.summary).toContain(`drill: s3://${DRILL_BUCKET} could not be read`);
		expect(done.stdout).toContain("**This is a drill.**");
		const ordinary = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET, "--drill", "no"]);
		expect(ordinary.stdout).not.toContain("This is a drill");
		expect(standin.requests.at(-1)?.bucket).toBe(BUCKET);
	});
});
