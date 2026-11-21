/**
 * The alarm's watch on the data API's publishing (scripts/lib/api-freshness.ts,
 * scripts/alarm.ts): judged by when the API bucket's table of contents was
 * last written, by S3's clock, against the runs workflow's schedule; read
 * through S3ApiStore from a stand-in for S3 (tests/s3-standin.ts) with a key
 * that may only read, as the first job's role reads; raised in the alarm's
 * issue, by its rule of writing only when something changed.
 */

import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { treeObject } from "../infra/runs/api-bucket";
import type { Schedule } from "../infra/runs/schedule";
import { ACTIONS_RUN_URL, ALARM_MARKER, ALARM_TITLE, apiAlarmState, apiSummary, type IssueTracker, type OpenAlarm, runAlarm, STATE_MARKER, stateOf } from "../scripts/alarm";
import {
	type ApiBucketCheck,
	checkApiBucket,
	isStale,
	MISSED_TO_RAISE,
	missedRuns,
	PUBLISH_GRACE_MS,
	RUNS_SCHEDULE_UTC,
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

/** No watched Series and no price file: only the API bucket can be raised. */
const SCHEDULE: Schedule = { vcpu_quota: { limit: 64, reserved_outside_schedule: 4 }, targets: [{ instance_type: "c6i.8xlarge", vcpus: 32, zone: "us-east-2c", boots_utc: ["22:10"] }], benchmarks: [] };

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
}

const at = (iso: string): Date => new Date(iso);
const iso = (dates: Date[]): string[] => dates.map((date) => date.toISOString());

describe("the schedule a publish is expected by", () => {
	test("is the runs workflow's: 00:00, 06:00, 12:00, 18:00 and 22:40 UTC (tests/runs-workflow.test.ts holds it to the crons)", () => {
		expect([...RUNS_SCHEDULE_UTC]).toEqual(["00:00", "06:00", "12:00", "18:00", "22:40"]);
	});

	test("lists every scheduled start after one time and up to another, across days and months", () => {
		expect(iso(scheduledStarts(at("2026-11-30T17:00:00Z"), at("2026-12-01T06:00:00Z")))).toEqual([
			"2026-11-30T18:00:00.000Z",
			"2026-11-30T22:40:00.000Z",
			"2026-12-01T00:00:00.000Z",
			"2026-12-01T06:00:00.000Z",
		]);
		// After, not at: a publish at a scheduled time is after nothing of that time.
		expect(iso(scheduledStarts(at("2026-11-21T06:00:00Z"), at("2026-11-21T12:00:00Z")))).toEqual(["2026-11-21T12:00:00.000Z"]);
		expect(scheduledStarts(at("2026-11-21T12:00:00Z"), at("2026-11-21T06:00:00Z"))).toEqual([]);
		expect(scheduledStarts(at("2026-11-21T00:00:01Z"), at("2026-11-21T05:59:59Z"))).toEqual([]);
		expect(scheduledStarts(at("2026-11-01T00:00:00Z"), at("2026-12-01T00:00:00Z")).length).toBe(30 * 5);
	});

	test("counts a scheduled run as missed only once its hour is up, so a run's own time does not count against it at its own alarm", () => {
		const published = at("2026-11-21T00:04:00Z");
		// The 06:00 run's alarm, a few minutes after 06:00, before its own publish.
		expect(missedRuns(published, at("2026-11-21T06:04:00Z"))).toEqual([]);
		// An hour after 06:00 with nothing new, the 06:00 run has missed.
		expect(iso(missedRuns(published, at("2026-11-21T07:00:00Z")))).toEqual(["2026-11-21T06:00:00.000Z"]);
		expect(missedRuns(published, at("2026-11-21T06:59:59Z"))).toEqual([]);
		expect(PUBLISH_GRACE_MS).toBe(HOUR);
		// The 22:40 run is due by the 00:00 run's alarm: 80 minutes is more than its hour.
		expect(iso(missedRuns(at("2026-11-21T18:04:00Z"), at("2026-11-22T00:04:00Z")))).toEqual(["2026-11-21T22:40:00.000Z"]);
	});

	/**
	 * Every scheduled run of three days in turn; each run's alarm comes `late`
	 * after its scheduled time and before its publish, which (unless the run
	 * fails) comes a minute after. Returns, for each run, whether its alarm
	 * raised the bucket.
	 */
	function simulate(fails: ReadonlySet<number>, late: number): boolean[] {
		const starts = scheduledStarts(at("2026-11-20T23:00:00Z"), at("2026-11-23T23:00:00Z"));
		// The run before, at 22:40, published.
		let published = new Date(at("2026-11-20T22:40:00Z").getTime() + late + MINUTE);
		return starts.map((start, index) => {
			const alarm = new Date(start.getTime() + late);
			const raised = missedRuns(published, alarm).length >= MISSED_TO_RAISE;
			if (!fails.has(index)) published = new Date(alarm.getTime() + MINUTE);
			return raised;
		});
	}

	test("one failed run never raises the alarm, whichever it is, and however late the runs start, up to 50 minutes", () => {
		for (const late of [4 * MINUTE, 30 * MINUTE, 50 * MINUTE]) {
			for (let failed = 0; failed < 10; failed++) {
				expect({ late, failed, raised: simulate(new Set([failed]), late).some(Boolean) }).toEqual({ late, failed, raised: false });
			}
		}
	});

	test("two failed in a row always raise it, at the alarm of the run after them; the run after that clears it once it publishes", () => {
		for (const late of [4 * MINUTE, 30 * MINUTE, 50 * MINUTE]) {
			for (let first = 0; first < 10; first++) {
				const raised = simulate(new Set([first, first + 1]), late);
				expect({ late, first, raisedAt: raised.flatMap((yes, index) => (yes ? [index] : [])) }).toEqual({ late, first, raisedAt: [first + 2] });
			}
		}
		// Publishing that stays stopped stays raised.
		const stopped = simulate(new Set([3, 4, 5, 6, 7, 8, 9]), 4 * MINUTE);
		expect(stopped.slice(5, 10)).toEqual([true, true, true, true, true]);
	});

	test("a published bucket is stale only from the second missed run", () => {
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

describe("the API bucket, read from a stand-in for S3", () => {
	let standin: S3Standin;
	let publisher: S3ApiStore;
	/** The alarm's view: the first job's key, which may only read. */
	const alarmView = (bucket = BUCKET, keyId = READER) =>
		new S3ApiStore(bucket, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: keyId, secretAccessKey: "secret", sessionToken: "token" }) });
	/** The publish job's upload ending at `when`: its last act writes the table of contents, recording its run. */
	const publish = async (when: string, run: number) => {
		standin.now = () => at(when);
		await publisher.put(indexFile(`{"run":${run}}`), run);
	};
	const noSleep = async () => {};

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
		const check = await checkApiBucket(alarmView(), at("2026-11-21T06:04:00Z"));
		expect(check).toEqual({ kind: "published", bucket: `s3://${BUCKET}`, lastModified: "2026-11-21T01:49:48.000Z", run: RUN, missed: [] });
		expect(standin.requests.slice(before)).toEqual([{ method: "GET", bucket: BUCKET, key: STAMP_KEY, keyId: READER, ifNoneMatch: null }]);
		expect(apiAlarmState(check, "off")).toBeNull();
	});

	test("a stale bucket: the scheduled runs since it was last written whose hour is up", async () => {
		await publish("2026-11-21T01:49:48Z", RUN);
		const oneMissed = await checkApiBucket(alarmView(), at("2026-11-21T12:04:00Z"));
		expect(oneMissed).toMatchObject({ kind: "published", missed: ["2026-11-21T06:00:00.000Z"] });
		expect(apiAlarmState(oneMissed, "off")).toBeNull();
		const twoMissed = await checkApiBucket(alarmView(), at("2026-11-21T18:04:00Z"));
		expect(twoMissed).toMatchObject({ kind: "published", missed: ["2026-11-21T06:00:00.000Z", "2026-11-21T12:00:00.000Z"] });
		expect(apiAlarmState(twoMissed, "off")).toBe("stale since 2026-11-21T01:49:48.000Z");
	});

	test("an empty bucket, with the variable set: no table of contents, raised at once", async () => {
		const check = await checkApiBucket(alarmView(), at("2026-11-21T06:04:00Z"));
		expect(check).toEqual({ kind: "empty", bucket: `s3://${BUCKET}` });
		expect(apiAlarmState(check, "off")).toBe("empty");
	});

	test("an unreadable bucket, raised at once, never thrown: refused, missing (not taken for empty: a GET, not a HEAD), no credentials", async () => {
		const refused = await checkApiBucket(alarmView(BUCKET, STRANGER), at("2026-11-21T06:04:00Z"), { sleep: noSleep });
		expect(refused).toMatchObject({ kind: "unreadable", code: "403 AccessDenied", attempts: 1 });
		expect((refused as { reason: string }).reason).toBe(`GET s3://${BUCKET}/v1/index.json answered 403 AccessDenied: Access Denied`);
		expect(apiAlarmState(refused, "off")).toBe("unreadable: 403 AccessDenied");

		const missing = await checkApiBucket(alarmView("ledgermath-no-such-bucket"), at("2026-11-21T06:04:00Z"), { sleep: noSleep });
		expect(missing).toMatchObject({ kind: "unreadable", code: "404 NoSuchBucket", attempts: 1 });

		const keyless = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => credentialsFromEnvironment({}) });
		const noKeys = await checkApiBucket(keyless, at("2026-11-21T06:04:00Z"), { sleep: noSleep });
		expect(noKeys).toMatchObject({ kind: "unreadable", code: "NoCredentials", attempts: 1 });
	});

	test("a 5xx or no answer is tried again, three times in all, waiting 2 then 4 seconds; one that passes on a later try is no finding", async () => {
		await publish("2026-11-21T01:49:48Z", RUN);
		let failures = 2;
		standin.fault = (request) => (request.method === "GET" && failures-- > 0 ? new Response("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>", { status: 500 }) : undefined);
		const waits: number[] = [];
		const sleep = async (ms: number) => {
			waits.push(ms);
		};
		expect(await checkApiBucket(alarmView(), at("2026-11-21T06:04:00Z"), { sleep })).toMatchObject({ kind: "published", run: RUN, missed: [] });
		expect(waits).toEqual([2_000, 4_000]);

		failures = 5;
		waits.length = 0;
		const down = await checkApiBucket(alarmView(), at("2026-11-21T06:04:00Z"), { sleep });
		expect(down).toMatchObject({ kind: "unreadable", code: "500 InternalError", attempts: 3 });
		expect(waits).toEqual([2_000, 4_000]);

		const closed = new S3ApiStore(BUCKET, "us-east-2", { endpoint: "http://127.0.0.1:9", credentials: () => ({ accessKeyId: READER, secretAccessKey: "secret" }) });
		expect(await checkApiBucket(closed, at("2026-11-21T06:04:00Z"), { sleep: noSleep })).toMatchObject({ kind: "unreadable", code: "NoAnswer", attempts: 3 });
	});

	test("the variable unset: nothing read, nothing raised while PUBLIC_API is off; raised in any other state, since readers are then served a tree nobody publishes", async () => {
		const check = await checkApiBucket(null, at("2026-11-21T06:04:00Z"));
		expect(check).toEqual({ kind: "unset" });
		expect(standin.requests).toEqual([]);
		expect(apiAlarmState(check, "off")).toBeNull();
		for (const state of ["dark", "closed", "on"]) expect(apiAlarmState(check, state)).toBe(`unset while PUBLIC_API is ${state}`);
	});

	describe("in the alarm's issue", () => {
		const pass = async (tracker: FakeIssues, now: string, api: ApiBucketCheck | null, publicApiState = "off") =>
			runAlarm({ schedule: SCHEDULE, runs: [], now: at(now), scheduleChangedAt: at("2026-10-01T00:00:00Z"), copyFailed: false, tracker, api, publicApiState });
		const read = (now: string) => checkApiBucket(alarmView(), at(now), { sleep: noSleep });

		test("raises a stale bucket once, stays silent while nothing changes, and says once that it is published again", async () => {
			const tracker = new FakeIssues();
			await publish("2026-11-21T01:49:48Z", RUN);
			// The 06:00 run published nothing: one missed, nothing said.
			expect(await pass(tracker, "2026-11-21T12:04:00Z", await read("2026-11-21T12:04:00Z"))).toMatchObject({ action: "none", api: null });
			// Nor the 12:00 run: two in a row.
			const opened = await pass(tracker, "2026-11-21T18:04:00Z", await read("2026-11-21T18:04:00Z"));
			expect(opened).toMatchObject({ action: "opened", issue: 1, api: "stale since 2026-11-21T01:49:48.000Z" });
			const issue = tracker.issues[0];
			expect(issue?.title).toBe(ALARM_TITLE);
			expect(issue?.body.startsWith(`${ALARM_MARKER}\nChecked at 2026-11-21T18:04:00.000Z: every watched Series has had a Run in the last 48 hours.`)).toBe(true);
			expect(issue?.body).toContain(
				`**The data API has not been published for 2 scheduled runs in a row.** In \`s3://${BUCKET}\`, \`v1/index.json\` was last written at 2026-11-21T01:49:48.000Z, 16.2 hours ago, by run [${RUN}](${ACTIONS_RUN_URL}${RUN}), and no run since has published: not the runs scheduled at 2026-11-21 06:00 UTC, 2026-11-21 12:00 UTC, each given 1 hour.`,
			);
			expect(issue?.body).toContain("Look at the `publish` job of the latest runs (Actions, `runs`): failed, skipped (its first job failed, or `API_BUCKET` was unset), cancelled, or not there at all.");
			expect(stateOf(issue?.body ?? "")).toEqual({ stale: [], copy_failed: false, stale_api: "stale since 2026-11-21T01:49:48.000Z" });
			// The 18:00 and 22:40 runs miss too: the same bucket, as stale as before, so nothing new to say.
			expect(await pass(tracker, "2026-11-21T22:44:00Z", await read("2026-11-21T22:44:00Z"))).toMatchObject({ action: "unchanged", issue: 1 });
			expect(await pass(tracker, "2026-11-22T00:04:00Z", await read("2026-11-22T00:04:00Z"))).toMatchObject({ action: "unchanged", issue: 1 });
			// The 00:00 run publishes; the 06:00 run's alarm finds it so and says so, once.
			await publish("2026-11-22T00:05:10Z", RUN + 1000);
			const cleared = await pass(tracker, "2026-11-22T06:04:00Z", await read("2026-11-22T06:04:00Z"));
			expect(cleared).toMatchObject({ action: "commented", issue: 1, api: null });
			expect(tracker.issues[0]?.comments[0]).toContain(
				`every watched Series has had a Run in the last 48 hours again, and the data API was last published at 2026-11-22T00:05:10.000Z, by run [${RUN + 1000}](${ACTIONS_RUN_URL}${RUN + 1000}).`,
			);
			expect(stateOf(tracker.issues[0]?.comments[0] ?? "")).toEqual({ stale: [], copy_failed: false });
			expect(await pass(tracker, "2026-11-22T12:04:00Z", await read("2026-11-22T12:04:00Z"))).toMatchObject({ action: "unchanged" });
			expect(tracker.issues.length).toBe(1);
			expect(tracker.issues[0]?.comments.length).toBe(1);
		});

		test("a fresh bucket, and one missed run, raise nothing", async () => {
			const tracker = new FakeIssues();
			await publish("2026-11-21T00:04:30Z", RUN);
			expect(await pass(tracker, "2026-11-21T06:04:00Z", await read("2026-11-21T06:04:00Z"))).toMatchObject({ action: "none", api: null });
			expect(await pass(tracker, "2026-11-21T12:04:00Z", await read("2026-11-21T12:04:00Z"))).toMatchObject({ action: "none", api: null });
			expect(tracker.issues).toEqual([]);
		});

		test("an empty bucket and an unreadable one are raised at once, each in its own words, and a change from one to the other is one comment", async () => {
			const tracker = new FakeIssues();
			const empty = await pass(tracker, "2026-11-21T06:04:00Z", await read("2026-11-21T06:04:00Z"));
			expect(empty).toMatchObject({ action: "opened", api: "empty" });
			expect(tracker.issues[0]?.body).toContain(`**The API bucket holds no table of contents.** \`API_BUCKET\` names \`s3://${BUCKET}\`, which holds no \`v1/index.json\``);
			expect(tracker.issues[0]?.body).toContain("If `API_BUCKET` was set since the last run, this is expected");
			const unreadable = await pass(tracker, "2026-11-21T12:04:00Z", await checkApiBucket(alarmView(BUCKET, STRANGER), at("2026-11-21T12:04:00Z"), { sleep: noSleep }));
			expect(unreadable).toMatchObject({ action: "commented", api: "unreadable: 403 AccessDenied" });
			expect(tracker.issues[0]?.comments[0]).toContain(
				`**The API bucket could not be read**, so whether the data API is being published cannot be told. GET s3://${BUCKET}/v1/index.json answered 403 AccessDenied: Access Denied.`,
			);
			expect(await pass(tracker, "2026-11-21T18:04:00Z", await checkApiBucket(alarmView(BUCKET, STRANGER), at("2026-11-21T18:04:00Z"), { sleep: noSleep }))).toMatchObject({
				action: "unchanged",
			});
			// The first publish lands: the next pass says the data API is published.
			await publish("2026-11-21T18:05:00Z", RUN + 2000);
			expect(await pass(tracker, "2026-11-21T22:44:00Z", await read("2026-11-21T22:44:00Z"))).toMatchObject({ action: "commented", api: null });
			expect(tracker.issues[0]?.comments[1]).toContain("and the data API was last published at 2026-11-21T18:05:00.000Z");
		});

		test("the variable unset raises nothing while PUBLIC_API is off; and when a raised bucket's variable is unset, says once that it is no longer watched", async () => {
			const tracker = new FakeIssues();
			expect(await pass(tracker, "2026-11-21T06:04:00Z", { kind: "unset" })).toMatchObject({ action: "none", api: null });
			expect(tracker.issues).toEqual([]);
			await pass(tracker, "2026-11-21T12:04:00Z", await read("2026-11-21T12:04:00Z"));
			expect(tracker.issues[0]?.body).toContain("holds no table of contents");
			expect(await pass(tracker, "2026-11-21T18:04:00Z", { kind: "unset" })).toMatchObject({ action: "commented", api: null });
			expect(tracker.issues[0]?.comments[0]).toContain("every watched Series has had a Run in the last 48 hours again, and `API_BUCKET` is unset, so the API bucket is not watched.");
		});

		test("the variable unset while PUBLIC_API serves is raised", async () => {
			const tracker = new FakeIssues();
			expect(await pass(tracker, "2026-11-21T06:04:00Z", { kind: "unset" }, "on")).toMatchObject({ action: "opened", api: "unset while PUBLIC_API is on" });
			expect(tracker.issues[0]?.body).toContain("**`API_BUCKET` is unset while `PUBLIC_API` is `on`.** The `publish` job is skipped, so nothing is published");
		});

		test("an open issue whose last post is from before the bucket was watched gets no comment while the bucket is fresh", async () => {
			const tracker = new FakeIssues();
			tracker.issues.push({ number: 1, title: "Stale: no Run, or no price file, for 48 hours", body: `${ALARM_MARKER}\nolder\n${STATE_MARKER}{"stale":[],"copy_failed":true} -->`, open: true, comments: [] });
			await publish("2026-11-21T00:04:30Z", RUN);
			expect(await pass(tracker, "2026-11-21T06:04:00Z", await read("2026-11-21T06:04:00Z"))).toMatchObject({ action: "commented" });
			// The copy changed (failed to succeeded) and nothing else: one comment, which says the bucket is fine; then silence.
			expect(tracker.issues[0]?.comments[0]).toContain("and the data API was last published at 2026-11-21T00:04:30.000Z");
			expect(await pass(tracker, "2026-11-21T12:04:00Z", await read("2026-11-21T12:04:00Z"))).toMatchObject({ action: "unchanged" });
		});

		test("a stale bucket beside stale Series is said in the same post, and its recovery while they stay stale is said once", async () => {
			const tracker = new FakeIssues();
			const schedule: Schedule = { ...SCHEDULE, benchmarks: [{ name: "syscall", builds: ["static"], samples: 10, timeout_seconds: 120, params: [{ call: "getpid" }] }] };
			const both = (now: string, api: ApiBucketCheck) =>
				runAlarm({ schedule, runs: [], now: at(now), scheduleChangedAt: at("2026-10-01T00:00:00Z"), copyFailed: false, tracker, api, publicApiState: "off" });
			await publish("2026-11-21T01:49:48Z", RUN);
			const opened = await both("2026-11-21T18:04:00Z", await read("2026-11-21T18:04:00Z"));
			expect(opened.stale.length).toBe(1);
			expect(tracker.issues[0]?.body).toContain("1 watched Series has had no Run for more than 48 hours.");
			expect(tracker.issues[0]?.body).toContain("**The data API has not been published for 2 scheduled runs in a row.**");
			await publish("2026-11-21T18:05:00Z", RUN + 3000);
			expect(await both("2026-11-21T22:44:00Z", await read("2026-11-21T22:44:00Z"))).toMatchObject({ action: "commented", api: null });
			expect(tracker.issues[0]?.comments[0]).toContain(`The data API is published again: it was last published at 2026-11-21T18:05:00.000Z, by run [${RUN + 3000}]`);
			expect(tracker.issues[0]?.comments[0]).not.toContain("has not been published");
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

	/** The alarm, posting nothing, with no watched Series stale and no price file watched, and the read-only key in its environment. */
	const alarm = async (now: string, extra: string[]): Promise<{ exitCode: number; stdout: string; stderr: string; summary: string }> => {
		const directory = mkdtempSync(join(scratch, "script-"));
		const runs = join(directory, "ledgermath-runs");
		mkdirSync(runs);
		const summary = join(directory, "summary.md");
		writeFileSync(summary, "");
		const child = Bun.spawn(
			["bun", join(ROOT, "scripts", "alarm.ts"), "--runs", runs, "--copy", "succeeded", "--schedule-changed-at", now, "--now", now, "--dry-run", "--api-endpoint", standin.url, ...extra],
			{
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AWS_ACCESS_KEY_ID: READER, AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "token", GITHUB_STEP_SUMMARY: summary },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { exitCode, stdout, stderr, summary: readFileSync(summary, "utf8") };
	};

	test("with API_BUCKET unset, says so in the step summary and reads nothing", async () => {
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", ""]);
		expect(done.stderr).toBe("");
		expect(done.exitCode).toBe(0);
		expect(standin.requests).toEqual([]);
		// Whether it is raised depends on PUBLIC_API, which the script reads as committed; no test but the release gate may
		// depend on that (tests/public-blobs.test.ts), so the two cases are held above, each with its state given.
		expect(done.summary).toStartWith("### The API bucket\n\nAPI_BUCKET is unset");
		expect(apiSummary({ kind: "unset" }, at("2026-11-21T06:04:00Z"), "off")).toBe(
			"API_BUCKET is unset: the API bucket is not read and nothing is raised for it (the publish job is skipped too)",
		);
		expect(apiSummary({ kind: "unset" }, at("2026-11-21T06:04:00Z"), "on")).toBe("API_BUCKET is unset while PUBLIC_API is on: nothing is published, and that is raised");
	});

	test("with a fresh bucket, says when it was last written and by which run, and raises nothing", async () => {
		standin.now = () => at("2026-11-21T01:49:48Z");
		const publisher = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: WRITER, secretAccessKey: "secret" }) });
		await publisher.put(indexFile(), RUN);
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET]);
		expect(done.stderr).toBe("");
		expect(done.exitCode).toBe(0);
		expect(done.summary).toContain(
			`s3://${BUCKET}: v1/index.json last written at 2026-11-21T01:49:48.000Z (4.2 hours ago), by run ${RUN}; 0 scheduled runs since have had 1 hour without publishing, and 2 in a row raise the alarm: not raised`,
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
});
