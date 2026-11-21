/**
 * The alarm's watch on the data API's publishing (ADR-0032;
 * scripts/lib/api-freshness.ts, scripts/check-api-publishing.ts,
 * scripts/alarm.ts): raised when the API bucket's table of contents was last
 * written, by S3's clock, more than MAX_PUBLISH_AGE_MS before the check, and
 * nothing else; read from a stand-in for S3 (tests/s3-standin.ts) with a key
 * that may only read; done whole in a child process the alarm kills after its
 * budget, so the stale Series and price files are judged as before whatever
 * it does; raised in the alarm's issue by its rule of writing only when
 * something changed. And the drill, which posts one comment and changes
 * nothing else.
 */

import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { treeObject } from "../infra/runs/api-bucket";
import type { Schedule } from "../infra/runs/schedule";
import {
	ALARM_MARKER,
	ALARM_TITLE,
	CHECK_BUDGET_MS,
	checkInChild,
	describeSeries,
	type IssueTracker,
	type OpenAlarm,
	postDrill,
	runAlarm,
	STATE_MARKER,
	stateOf,
} from "../scripts/alarm";
import {
	ACTIONS_RUN_URL,
	type ApiBucketCheck,
	type ApiReport,
	apiAlarmState,
	apiReport,
	checkApiBucket,
	checkFailed,
	MAX_PUBLISH_AGE_MS,
	parseReport,
	RETRY_WAITS_MS,
} from "../scripts/lib/api-freshness";
import { boundedText, ERROR_BODY_BYTES, S3ApiStore, STAMP_KEY, type TreeFile } from "../scripts/lib/api-upload";
import { credentialsFromEnvironment } from "../scripts/lib/s3-create";
import { sha256Hex } from "../scripts/lib/sigv4";
import { scheduledStarts } from "./runs-schedule";
import { S3Standin } from "./s3-standin";

// A local server, and child processes.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const CHILD = join(ROOT, "scripts", "check-api-publishing.ts");
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
const FIRST_PUBLISH = "2026-11-21T01:49:48.000Z";
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

const at = (iso: string | number): Date => new Date(iso);
const published = (lastModified: string, run: number | null = RUN): ApiBucketCheck => ({ kind: "published", bucket: `s3://${BUCKET}`, lastModified, run });

describe("the rule: the table of contents' age, nothing else", () => {
	test("raised past 14 hours, clear up to them, whatever the time of day", () => {
		expect(MAX_PUBLISH_AGE_MS).toBe(14 * HOUR);
		const cases: Array<[number, boolean]> = [
			[0, false],
			[6 * HOUR, false],
			[12 * HOUR, false],
			[13 * HOUR + 59 * MINUTE, false],
			[14 * HOUR, false],
			[14 * HOUR + 1 * MINUTE, true],
			[20 * HOUR, true],
			[72 * HOUR, true],
		];
		for (const [age, raised] of cases) {
			for (const written of ["2026-11-21T00:02:00.000Z", "2026-11-21T22:42:00.000Z"]) {
				const state = apiAlarmState(published(written), at(Date.parse(written) + age), "off");
				expect({ age: age / MINUTE, written, raised: state !== null }).toEqual({ age: age / MINUTE, written, raised });
				if (raised) expect(state).toBe(`stale since ${written}`);
			}
		}
	});

	test("the first publish, run 44852356733 at 2026-11-21 01:49:48 UTC, is fresh until 15:49:48 and raised after", () => {
		expect(apiAlarmState(published(FIRST_PUBLISH), at("2026-11-21T06:04:00Z"), "off")).toBeNull();
		expect(apiAlarmState(published(FIRST_PUBLISH), at("2026-11-21T15:49:48Z"), "off")).toBeNull();
		expect(apiAlarmState(published(FIRST_PUBLISH), at("2026-11-21T15:49:49Z"), "off")).toBe(`stale since ${FIRST_PUBLISH}`);
		// Had nothing published since, the 18:00 run's alarm would be the first to raise it.
		expect(apiAlarmState(published(FIRST_PUBLISH), at("2026-11-21T12:04:00Z"), "off")).toBeNull();
		expect(apiAlarmState(published(FIRST_PUBLISH), at("2026-11-21T18:04:00Z"), "off")).not.toBeNull();
	});

	/** A seeded random number in [0, 1), so the simulations are the same every time. */
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

	/**
	 * The real schedule over three days, each run starting late(index) after
	 * its time, its alarm a minute after it starts and, unless it fails, its
	 * publish a minute after that; in order of start. Each alarm's verdict, by
	 * the age of the newest publish before it. The 22:40 run before day one
	 * published at 22:42.
	 */
	function simulate(late: (index: number) => number, fails: (index: number) => boolean): Array<{ index: number; alarm: Date; raised: boolean; age: number }> {
		const runs = scheduledStarts(at("2026-11-20T23:00:00Z"), at("2026-11-23T23:00:00Z")).map((slot, index) => ({ index, start: slot.getTime() + late(index) }));
		let last = Date.parse("2026-11-20T22:42:00Z");
		return runs
			.sort((a, b) => a.start - b.start)
			.map(({ index, start }) => {
				const alarm = new Date(start + MINUTE);
				const raised = apiAlarmState(published(new Date(last).toISOString()), alarm, "off") !== null;
				const age = alarm.getTime() - last;
				if (!fails(index)) last = Math.max(last, start + 2 * MINUTE);
				return { index, alarm, raised, age };
			});
	}

	test("one failed publish never raises it, on the real schedule, with runs starting up to 2 hours late", () => {
		for (let seed = 1; seed <= 10; seed++) {
			const draw = random(seed);
			const lateness = Array.from({ length: 20 }, () => Math.floor(draw() * 121) * MINUTE);
			for (let failed = 0; failed < 15; failed++) {
				const raised = simulate((index) => lateness[index] as number, (index) => index === failed).filter((alarm) => alarm.raised);
				expect({ seed, failed, raised: raised.length }).toEqual({ seed, failed, raised: 0 });
			}
		}
		for (const late of [0, 60 * MINUTE, 119 * MINUTE, 120 * MINUTE]) {
			for (let failed = 0; failed < 15; failed++) expect(simulate(() => late, (index) => index === failed).some((alarm) => alarm.raised)).toBe(false);
		}
		// The worst: the 06:00 run fails, the 00:00 run on time, the 12:00 run two hours late: 13 hours 59 minutes, not raised.
		const worst = simulate((index) => (index === 2 ? 120 * MINUTE : 0), (index) => index === 1);
		expect(worst.find((alarm) => alarm.index === 2)).toMatchObject({ raised: false, age: 13 * HOUR + 59 * MINUTE });
	});

	test("publishing stopped for good is raised by the first alarm once the table of contents is 14 hours old, at most about 20 hours after the last publish, and stays raised", () => {
		for (let stopped = 0; stopped < 10; stopped++) {
			const results = simulate(() => 3 * MINUTE, (index) => index > stopped);
			const lastPublish = results.find((alarm) => alarm.index === stopped)?.alarm.getTime() as number;
			const after = results.filter((alarm) => alarm.index > stopped);
			const first = after.findIndex((alarm) => alarm.raised);
			expect(first).toBeGreaterThan(0);
			// Every alarm before it sees the bucket 14 hours old or less; it and every one after, more.
			expect(after.slice(0, first).every((alarm) => alarm.age <= MAX_PUBLISH_AGE_MS)).toBe(true);
			expect(after.slice(first).every((alarm) => alarm.raised)).toBe(true);
			const raisedAfter = (after[first] as { alarm: Date }).alarm.getTime() - (lastPublish + MINUTE);
			expect({ stopped, overFourteen: raisedAfter > MAX_PUBLISH_AGE_MS, withinTwenty: raisedAfter <= 20 * HOUR + 5 * MINUTE }).toEqual({ stopped, overFourteen: true, withinTwenty: true });
		}
	});

	test("not promised: the 22:40 and 00:00 runs failing either side of their short gap pass unnoticed when the 06:00 run publishes, since publishing has recovered", () => {
		// Index 4 is 22:40 on 2026-11-21, index 5 00:00 on 2026-11-22.
		const results = simulate(() => 3 * MINUTE, (index) => index === 4 || index === 5);
		expect(results.some((alarm) => alarm.raised)).toBe(false);
	});

	test("the README states the threshold the code and these tests read", () => {
		const readme = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
		expect(readme).toContain(`more than ${MAX_PUBLISH_AGE_MS / HOUR} hours before the check runs`);
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
const OBJECT_HEADERS = { "content-type": "application/json", "last-modified": new Date(FIRST_PUBLISH).toUTCString(), "x-amz-meta-ledgermath-run": String(RUN) };

describe("the API bucket, read from a stand-in for S3", () => {
	let standin: S3Standin;
	let publisher: S3ApiStore;
	/** The alarm's view: the first job's key, which may only read. */
	const alarmView = (bucket = BUCKET, keyId = READER) =>
		new S3ApiStore(bucket, "us-east-2", { endpoint: standin.url, errorBodyMs: 100, credentials: () => ({ accessKeyId: keyId, secretAccessKey: "secret", sessionToken: "token" }) });
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

	test("a published bucket: when its table of contents was last written, by S3's clock, and the run it records; one GET with the read-only key", async () => {
		await publish(FIRST_PUBLISH, RUN);
		expect(await checkApiBucket(alarmView())).toEqual(published(FIRST_PUBLISH));
		expect(standin.requests.at(-1)).toEqual({ method: "GET", bucket: BUCKET, key: STAMP_KEY, keyId: READER, ifNoneMatch: null });
	});

	test("an empty bucket, a refused read, a missing bucket and missing credentials are each a finding raised at once, never thrown", async () => {
		const empty = await checkApiBucket(alarmView());
		expect(empty).toEqual({ kind: "empty", bucket: `s3://${BUCKET}` });
		expect(apiAlarmState(empty, at("2026-11-21T06:04:00Z"), "off")).toBe("empty");
		const refused = await checkApiBucket(alarmView(BUCKET, STRANGER), { sleep: noSleep });
		expect(refused).toMatchObject({ kind: "unreadable", code: "403 AccessDenied", attempts: 1 });
		expect(apiAlarmState(refused, at("2026-11-21T06:04:00Z"), "off")).toBe("unreadable: 403 AccessDenied");
		expect(await checkApiBucket(alarmView("ledgermath-no-such-bucket"), { sleep: noSleep })).toMatchObject({ kind: "unreadable", code: "404 NoSuchBucket", attempts: 1 });
		const keyless = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => credentialsFromEnvironment({}) });
		expect(await checkApiBucket(keyless, { sleep: noSleep })).toMatchObject({ kind: "unreadable", code: "NoCredentials", attempts: 1 });
	});

	test("a single server error is tried again quietly, waiting a second; three in a row are a finding", async () => {
		await publish(FIRST_PUBLISH, RUN);
		let failures = 1;
		standin.fault = (request) => (request.method === "GET" && failures-- > 0 ? new Response("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>", { status: 500 }) : undefined);
		const waits: number[] = [];
		const sleep = async (ms: number) => {
			waits.push(ms);
		};
		expect(await checkApiBucket(alarmView(), { sleep })).toEqual(published(FIRST_PUBLISH));
		expect(waits).toEqual([RETRY_WAITS_MS[0] as number]);
		failures = 5;
		waits.length = 0;
		expect(await checkApiBucket(alarmView(), { sleep })).toMatchObject({ kind: "unreadable", code: "500 InternalError", attempts: 3 });
		expect(waits).toEqual([...RETRY_WAITS_MS]);
	});

	test("a 200 whose body stalls, or trickles, is read from its headers alone, at once", async () => {
		for (const body of [() => stalling("{"), trickling]) {
			standin.fault = (request) => (request.method === "GET" ? new Response(body(), { headers: OBJECT_HEADERS }) : undefined);
			const started = performance.now();
			expect(await checkApiBucket(alarmView())).toEqual(published(FIRST_PUBLISH));
			expect(performance.now() - started).toBeLessThan(1_000);
		}
	});

	test("of an error's body only the first 2,048 bytes are read: an S3 code beyond them is not seen, and what is quoted is one short line", async () => {
		expect(ERROR_BODY_BYTES).toBe(2_048);
		const padding = `<!--${" ".repeat(2_100)}-->`;
		standin.fault = (request) => (request.method === "GET" ? new Response(`<Error>${padding}<Code>CodeBeyondTheLimit</Code><Message>far</Message></Error>`, { status: 403 }) : undefined);
		const beyond = await checkApiBucket(alarmView(), { sleep: noSleep });
		expect(beyond).toMatchObject({ kind: "unreadable", code: "403 HTTP403" });
		expect(JSON.stringify(beyond)).not.toContain("CodeBeyondTheLimit");
		const message = "`run this`\n".repeat(150);
		standin.fault = (request) => (request.method === "GET" ? new Response(`<Error><Code>AccessDenied</Code><Message>${message}</Message></Error>`, { status: 403 }) : undefined);
		const long = (await checkApiBucket(alarmView(), { sleep: noSleep })) as { reason: string };
		expect(long.reason).not.toMatch(/[`\n]/);
		expect(long.reason.length).toBeLessThanOrEqual(`GET s3://${BUCKET}/v1/index.json answered 403 AccessDenied: `.length + 300);
	});

	test("an error whose body stalls after its headers is read for a limited time, then said by its status", async () => {
		standin.fault = (request) => (request.method === "GET" ? new Response(stalling("<Error><Code>Acc"), { status: 403 }) : undefined);
		const started = performance.now();
		expect(await checkApiBucket(alarmView(), { sleep: noSleep })).toMatchObject({ kind: "unreadable", code: "403 HTTP403", attempts: 1 });
		// The alarm's view reads an error's body for 100 ms (ERROR_BODY_MS, a second, otherwise).
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("one chunk larger than the limit is decoded only up to the limit", async () => {
		const big = `${"a".repeat(2_048)}<Code>Hidden</Code>${"b".repeat(1_000_000)}`;
		const text = await boundedText(new Response(big).body, 2_048, 1_000);
		expect(text).toBe("a".repeat(2_048));
		expect(await boundedText(new Response(stalling("abc")).body, 2_048, 100)).toBe("abc");
	});
});

describe("the check in a child process, killed after its budget: the stale Series and price files are judged as without it", () => {
	const NOW = "2026-11-21T06:04:00Z";
	const BUDGET = 1_000;
	/** A script for a child, written to a file of its own. */
	const script = (name: string, source: string): string[] => {
		const path = join(scratch, `${name}.ts`);
		writeFileSync(path, source);
		return [process.execPath, path];
	};
	/** The existing alarm on one stale Series, with this report of the bucket, or none, as on main. */
	const verdict = async (api: ApiReport | null) => {
		const tracker = new FakeIssues();
		const outcome = await runAlarm({ schedule: STALE_SCHEDULE, runs: [], now: at(NOW), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api });
		return { outcome, post: tracker.posts()[0] ?? "" };
	};
	const asOnMain = async (report: ApiReport) => {
		const main = await verdict(null);
		const ours = await verdict(report);
		expect({ action: ours.outcome.action, stale: ours.outcome.stale.map(describeSeries), prices: ours.outcome.prices }).toEqual({
			action: main.outcome.action,
			stale: main.outcome.stale.map(describeSeries),
			prices: main.outcome.prices,
		});
		for (const line of main.post.split("\n").slice(0, -1)) expect(ours.post).toContain(line);
		expect(stateOf(ours.post)).toEqual({ ...(stateOf(main.post) as NonNullable<ReturnType<typeof stateOf>>), stale_api: "check failed" });
	};
	const failingChildren: Array<[string, string, string]> = [
		["sleeps past the budget", "await Bun.sleep(60_000);\n", "it gave no result within 1 s, so it was stopped"],
		["ignores SIGTERM", 'process.on("SIGTERM", () => {});\nawait Bun.sleep(60_000);\n', "it gave no result within 1 s, so it was stopped"],
		["prints garbage", 'console.log("not a report {");\n', "its output is not a report: not a report {"],
		["exits non-zero", 'console.error("something broke");\nprocess.exit(3);\n', "it exited 3: something broke"],
	];

	for (const [name, source, reason] of failingChildren) {
		test(`a child that ${name}`, async () => {
			const started = performance.now();
			const report = await checkInChild(script(name.replaceAll(" ", "-"), source), { budgetMs: BUDGET });
			await asOnMain(report);
			expect(performance.now() - started).toBeLessThan(BUDGET + 2_500);
			expect(report).toEqual(checkFailed(reason));
			expect(report.raised).toContain("**The check of the API bucket failed**");
		});
	}

	test("the real check, whose line to the step summary blocks (a pipe nobody reads), is killed after its budget", async () => {
		const fifo = join(scratch, "summary-fifo");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		const started = performance.now();
		const report = await checkInChild([process.execPath, CHILD, "--bucket", "", "--now", NOW, "--public-api-state", "off"], {
			budgetMs: 2_000,
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GITHUB_STEP_SUMMARY: fifo },
		});
		expect(report).toEqual(checkFailed("it gave no result within 2 s, so it was stopped"));
		expect(performance.now() - started).toBeLessThan(2_000 + 2_500);
		await asOnMain(report);
	});

	test("the budget is 20 seconds, and a report is parsed only from a well-formed line", () => {
		expect(CHECK_BUDGET_MS).toBe(20_000);
		expect(parseReport(JSON.stringify(checkFailed("x")))).toEqual(checkFailed("x"));
		expect(parseReport('{"state":1}')).toBeNull();
		expect(parseReport("")).toBeNull();
		expect(parseReport(JSON.stringify({ ...checkFailed("x"), raised: "r".repeat(10_000) }))?.raised.length).toBe(4_000);
	});
});

describe("in the alarm's issue", () => {
	const pass = (tracker: FakeIssues, now: string, check: ApiBucketCheck, publicApiState = "off", schedule = SCHEDULE) =>
		runAlarm({ schedule, runs: [], now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: apiReport(check, at(now), publicApiState) });

	test("raises a bucket past 14 hours once, stays quiet while it only grows older, and says once that it is published again", async () => {
		const tracker = new FakeIssues();
		expect(await pass(tracker, "2026-11-21T12:04:00Z", published(FIRST_PUBLISH))).toMatchObject({ action: "none", api: null });
		const opened = await pass(tracker, "2026-11-21T18:04:00Z", published(FIRST_PUBLISH));
		expect(opened).toMatchObject({ action: "opened", issue: 1, api: `stale since ${FIRST_PUBLISH}` });
		expect(tracker.issues[0]?.title).toBe(ALARM_TITLE);
		expect(tracker.issues[0]?.body).toContain(
			`**The data API has not been published for 16.2 hours.** In \`s3://${BUCKET}\`, \`v1/index.json\` was last written at ${FIRST_PUBLISH}, by run [${RUN}](${ACTIONS_RUN_URL}${RUN}), more than 14 hours before this check, so the runs since have not published.`,
		);
		expect(stateOf(tracker.issues[0]?.body ?? "")).toEqual({ stale: [], copy_failed: false, stale_api: `stale since ${FIRST_PUBLISH}` });
		for (const now of ["2026-11-21T22:44:00Z", "2026-11-22T00:04:00Z", "2026-11-22T06:04:00Z"]) expect(await pass(tracker, now, published(FIRST_PUBLISH))).toMatchObject({ action: "unchanged" });
		const recovered = await pass(tracker, "2026-11-22T12:04:00Z", published("2026-11-22T12:02:00.000Z", RUN + 1000));
		expect(recovered).toMatchObject({ action: "commented", api: null });
		expect(tracker.issues[0]?.comments[0]).toContain(`every watched Series has had a Run in the last 48 hours again, and the data API was last published at 2026-11-22T12:02:00.000Z, by run [${RUN + 1000}]`);
		expect(await pass(tracker, "2026-11-22T18:04:00Z", published("2026-11-22T18:02:00.000Z", RUN + 2000))).toMatchObject({ action: "unchanged" });
		expect(tracker.issues[0]?.comments).toHaveLength(1);
	});

	test("a re-run of an old run judges as any run at that moment: its child prints the same report, so it cannot clear an open alarm", async () => {
		const standin = new S3Standin();
		standin.start();
		try {
			standin.bucket(BUCKET, { readers: [READER], writers: [WRITER] });
			standin.now = () => at(FIRST_PUBLISH);
			await new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: WRITER, secretAccessKey: "secret" }) }).put(indexFile(), RUN);
			const now = "2026-11-21T22:44:00Z";
			const command = [process.execPath, CHILD, "--bucket", BUCKET, "--now", now, "--public-api-state", "off", "--endpoint", standin.url];
			const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AWS_ACCESS_KEY_ID: READER, AWS_SECRET_ACCESS_KEY: "secret" };
			const ordinary = await checkInChild(command, { env });
			// The 06:00 run of the day before, run again by hand: another attempt, another event, an old run id and cron.
			const rerun = await checkInChild(command, { env: { ...env, GITHUB_RUN_ID: "44000000000", GITHUB_RUN_ATTEMPT: "3", GITHUB_EVENT_NAME: "schedule", GITHUB_EVENT_SCHEDULE: "0 */6 * * *" } });
			expect(rerun).toEqual(ordinary);
			expect(rerun.state).toBe(`stale since ${FIRST_PUBLISH}`);
			const tracker = new FakeIssues();
			await runAlarm({ schedule: SCHEDULE, runs: [], now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: ordinary });
			expect(await runAlarm({ schedule: SCHEDULE, runs: [], now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: rerun })).toMatchObject({ action: "unchanged", api: `stale since ${FIRST_PUBLISH}` });
		} finally {
			standin.stop();
		}
	});

	test("an empty bucket and an unreadable one are raised at once, each in its own words", async () => {
		const tracker = new FakeIssues();
		expect(await pass(tracker, "2026-11-21T06:04:00Z", { kind: "empty", bucket: `s3://${BUCKET}` })).toMatchObject({ action: "opened", api: "empty" });
		expect(tracker.issues[0]?.body).toContain(`**The API bucket holds no table of contents.** \`API_BUCKET\` names \`s3://${BUCKET}\``);
		const unreadable: ApiBucketCheck = { kind: "unreadable", bucket: `s3://${BUCKET}`, code: "403 AccessDenied", reason: `GET s3://${BUCKET}/v1/index.json answered 403 AccessDenied: Access Denied`, attempts: 1 };
		expect(await pass(tracker, "2026-11-21T12:04:00Z", unreadable)).toMatchObject({ action: "commented", api: "unreadable: 403 AccessDenied" });
		expect(tracker.issues[0]?.comments[0]).toContain("**The API bucket could not be read**, so whether the data API is being published cannot be told.");
	});

	test("with API_BUCKET unset, nothing is raised while PUBLIC_API is off", async () => {
		const tracker = new FakeIssues();
		expect(await pass(tracker, "2026-11-21T06:04:00Z", { kind: "unset" })).toMatchObject({ action: "none", api: null });
		expect(tracker.issues).toEqual([]);
		expect(apiReport({ kind: "unset" }, at("2026-11-21T06:04:00Z"), "off").summary).toBe("API_BUCKET is unset: the API bucket is not read and nothing is raised for it (the publish job is skipped too)");
	});

	test("with API_BUCKET unset, the alarm is raised in any other state of PUBLIC_API: serving is on, so a missing bucket name means publishing has stopped", async () => {
		for (const state of ["dark", "closed", "on"]) {
			const tracker = new FakeIssues();
			expect(await pass(tracker, "2026-11-21T06:04:00Z", { kind: "unset" }, state)).toMatchObject({ action: "opened", api: `unset while PUBLIC_API is ${state}` });
			expect(tracker.issues[0]?.body).toContain(`**\`API_BUCKET\` is unset while \`PUBLIC_API\` is \`${state}\`.**`);
		}
	});

	test("an open issue whose last post is from before the bucket was watched gets no comment while the bucket is fresh", async () => {
		const tracker = new FakeIssues();
		tracker.issues.push({ number: 1, title: "Stale: no Run, or no price file, for 48 hours", body: `${ALARM_MARKER}\nolder\n${STATE_MARKER}{"stale":[],"copy_failed":false} -->`, open: true, comments: [] });
		expect(await pass(tracker, "2026-11-21T06:04:00Z", published(FIRST_PUBLISH))).toMatchObject({ action: "unchanged" });
	});

	test("a stale bucket beside stale Series is said in the same post, and its recovery while they stay stale is said once", async () => {
		const tracker = new FakeIssues();
		const opened = await pass(tracker, "2026-11-21T18:04:00Z", published(FIRST_PUBLISH), "off", STALE_SCHEDULE);
		expect(opened.stale.length).toBe(1);
		expect(tracker.issues[0]?.body).toContain("1 watched Series has had no Run for more than 48 hours.");
		expect(tracker.issues[0]?.body).toContain("**The data API has not been published for 16.2 hours.**");
		expect(await pass(tracker, "2026-11-21T22:44:00Z", published("2026-11-21T22:42:00.000Z", RUN + 3000), "off", STALE_SCHEDULE)).toMatchObject({ action: "commented", api: null });
		expect(tracker.issues[0]?.comments[0]).toContain(`The data API is published again: it was last published at 2026-11-21T22:42:00.000Z, by run [${RUN + 3000}]`);
	});
});

describe("the drill: one comment, nothing else", () => {
	const RUN_URL = "https://github.com/smrdotgg/ledgermath/actions/runs/44900000000";
	const pass = (tracker: FakeIssues, now: string, check: ApiBucketCheck) =>
		runAlarm({ schedule: SCHEDULE, runs: [], now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: apiReport(check, at(now), "off") });

	test("during an open finding about the bucket: one comment that says it is a drill, by which run, and that nothing is wrong; the finding stays reported, unchanged", async () => {
		const tracker = new FakeIssues();
		await pass(tracker, "2026-11-21T18:04:00Z", published(FIRST_PUBLISH));
		const before = await tracker.findOpen(ALARM_MARKER);
		expect(await postDrill(tracker, RUN_URL)).toBe(1);
		expect(tracker.issues).toHaveLength(1);
		const drill = tracker.issues[0]?.comments.at(-1) ?? "";
		expect(drill).toContain(`**This is a drill**, started by hand with the input \`alarm_drill\` in [this run](${RUN_URL})`);
		expect(drill).toContain("Nothing is wrong because of it: the drill read nothing and changed nothing");
		expect(drill).not.toContain(STATE_MARKER);
		// What the alarm reads back is what it wrote last; its next pass, the bucket as stale as before, says nothing new.
		expect(await tracker.findOpen(ALARM_MARKER)).toEqual(before);
		expect(await pass(tracker, "2026-11-21T22:44:00Z", published(FIRST_PUBLISH))).toMatchObject({ action: "unchanged", api: `stale since ${FIRST_PUBLISH}` });
		expect(stateOf((await tracker.findOpen(ALARM_MARKER))?.lastPost ?? "")).toMatchObject({ stale_api: `stale since ${FIRST_PUBLISH}` });
	});

	test("with nothing stale: it opens the alarm issue with its one post, which the alarm's next pass, all well, leaves alone; the maintainer closes it", async () => {
		const tracker = new FakeIssues();
		expect(await pass(tracker, "2026-11-21T06:04:00Z", published(FIRST_PUBLISH))).toMatchObject({ action: "none" });
		expect(await postDrill(tracker, null)).toBe(1);
		expect(tracker.issues[0]).toMatchObject({ title: ALARM_TITLE, comments: [] });
		expect(tracker.issues[0]?.body.startsWith(`${ALARM_MARKER}\n**This is a drill**, started by hand with the input \`alarm_drill\`, to show`)).toBe(true);
		expect(await pass(tracker, "2026-11-21T12:04:00Z", published(FIRST_PUBLISH))).toMatchObject({ action: "unchanged", api: null });
		expect(tracker.issues[0]?.comments).toEqual([]);
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

	/** The alarm, posting nothing, with the read-only key in its environment. `stale` makes every watched Series stale (no Run, schedule long settled). */
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
		const started = performance.now();
		const child = Bun.spawn(
			["bun", join(ROOT, "scripts", "alarm.ts"), "--runs", runs, "--copy", "succeeded", "--schedule-changed-at", changed, "--now", now, "--dry-run", "--api-endpoint", standin.url, ...extra],
			{
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AWS_ACCESS_KEY_ID: READER, AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "token", GITHUB_STEP_SUMMARY: summary },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { exitCode, stdout, stderr, elapsed: performance.now() - started, summary: options.summary === "directory" ? "" : readFileSync(summary, "utf8") };
	};
	const staleLines = (stdout: string): string[] => stdout.split("\n").filter((line) => line.startsWith("stale: "));

	test("with API_BUCKET unset, the child says so in the step summary and reads nothing", async () => {
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", ""]);
		expect(done.stderr).toBe("");
		expect(done.exitCode).toBe(0);
		expect(standin.requests).toEqual([]);
		// Whether it is raised depends on the committed PUBLIC_API, on which no test but the release gate may depend: held above, each state given.
		expect(done.summary).toStartWith("### The API bucket\n\nAPI_BUCKET is unset");
	});

	test("with a fresh bucket, the child says when it was last written and by which run, and nothing is raised", async () => {
		standin.now = () => at(FIRST_PUBLISH);
		await new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: WRITER, secretAccessKey: "secret" }) }).put(indexFile(), RUN);
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET]);
		expect(done.stderr).toBe("");
		expect(done.exitCode).toBe(0);
		expect(done.summary).toBe(`### The API bucket\n\ns3://${BUCKET}: v1/index.json last written at ${FIRST_PUBLISH} (4.2 hours ago), by run ${RUN}; raised past 14 hours: not raised\n`);
		expect(done.stdout).not.toContain("would open");
		// The alarm ends when its work does: no timer of the check's keeps it alive (the budget is 20 s).
		expect(done.elapsed).toBeLessThan(CHECK_BUDGET_MS / 2);
	});

	test("with a bucket it cannot read, exits 0 all the same, and raises it in the alarm's words", async () => {
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", "ledgermath-no-such-bucket"]);
		expect(done.exitCode).toBe(0);
		expect(done.summary).toContain("s3://ledgermath-no-such-bucket could not be read (1 try): GET s3://ledgermath-no-such-bucket/v1/index.json answered 404 NoSuchBucket");
		expect(done.stdout).toContain("--dry-run: would open");
		expect(done.stdout).toContain("**The API bucket could not be read**");
	});

	test("a step summary that is a directory: the child warns, and the stale Series verdict and exit code are those of the alarm without the bucket", async () => {
		const main = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", ""], { stale: true });
		expect(main.exitCode).toBe(0);
		expect(staleLines(main.stdout).length).toBeGreaterThan(0);
		const ours = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET], { stale: true, summary: "directory" });
		expect(ours.exitCode).toBe(main.exitCode);
		expect(staleLines(ours.stdout)).toEqual(staleLines(main.stdout));
		expect(ours.stdout).toContain("--dry-run: would open");
		expect(ours.stdout).toContain("watched Series have had no Run for more than 48 hours.");
	});

	test("--drill yes posts the drill after the ordinary pass, which runs as without it, and reads nothing more", async () => {
		standin.now = () => at(FIRST_PUBLISH);
		await new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: WRITER, secretAccessKey: "secret" }) }).put(indexFile(), RUN);
		const plain = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET], { stale: true });
		const drill = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET, "--drill", "yes"], { stale: true });
		expect(drill.exitCode).toBe(0);
		// One GET each: the drill read nothing of its own.
		expect(standin.requests.filter((request) => request.method === "GET").map((request) => request.bucket)).toEqual([BUCKET, BUCKET]);
		expect(staleLines(drill.stdout)).toEqual(staleLines(plain.stdout));
		expect(drill.stdout).toContain(plain.stdout.trim().split("\n")[0] as string);
		expect(drill.stdout).toContain("**This is a drill**");
		expect(drill.summary).toBe(plain.summary);
	});
});
