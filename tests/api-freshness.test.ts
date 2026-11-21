/**
 * The alarm's watch on the data API's publishing (ADR-0032;
 * scripts/lib/api-freshness.ts, scripts/check-api-publishing.ts,
 * scripts/alarm.ts): raised by the first check made more than
 * MAX_PUBLISH_AGE_MS after the API bucket's table of contents was last
 * written, by S3's clock; read from a stand-in for S3 (tests/s3-standin.ts)
 * with a key that may only read; done in a child process with only the
 * environment it needs, in a process group the alarm kills after its budget,
 * reporting a result from a closed set that the alarm renders in fixed words;
 * raised in the alarm's issue by its rule of writing only when something
 * changed. And the drill, one notification that changes nothing else.
 */

import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { treeObject } from "../infra/runs/api-bucket";
import type { Schedule } from "../infra/runs/schedule";
import {
	ALARM_MARKER,
	ALARM_TITLE,
	CHECK_BUDGET_MS,
	CHILD_ENVIRONMENT,
	checkInChild,
	describeSeries,
	drillSafely,
	drillText,
	type IssueTracker,
	MAX_BODY_CHARS,
	type OpenAlarm,
	postDrill,
	reportOf,
	runAlarm,
	STATE_MARKER,
	stateOf,
} from "../scripts/alarm";
import {
	ACTIONS_RUN_URL,
	type ApiReport,
	apiAlarmState,
	apiReport,
	type CheckResult,
	checkApiBucket,
	checkFailed,
	MAX_PUBLISH_AGE_MS,
	parseResult,
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
/** Words nothing from the child or S3 may bring into an issue: a token's shape, a mention, a link. */
const HOSTILE = ["ghp_0123456789abcdefghijABCDEFGHIJ012345", "@someone-to-ping", "[click here](https://example.org/x)"];

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
const published = (lastModified: string, run: number | null = RUN): CheckResult => ({ kind: "published", last_modified: lastModified, run });
const report = (result: CheckResult, now: string, publicApiState = "off"): ApiReport => apiReport(result, BUCKET, at(now), publicApiState);
/** Whether a process with this id still exists. */
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("the rule: raised by the first check made more than 14 hours after the last publish", () => {
	test("ages either side of 14 hours, whatever the time of day", () => {
		expect(MAX_PUBLISH_AGE_MS).toBe(14 * HOUR);
		const cases: Array<[number, boolean]> = [
			[0, false],
			[12 * HOUR, false],
			[13 * HOUR + 59 * MINUTE, false],
			[14 * HOUR, false],
			[14 * HOUR + 1 * MINUTE, true],
			[22 * HOUR, true],
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

	test("the first publish, run 44852356733 at 2026-11-21 01:49:48 UTC, is fresh until 15:49:48 and raised by any check after", () => {
		expect(apiAlarmState(published(FIRST_PUBLISH), at("2026-11-21T15:49:48Z"), "off")).toBeNull();
		expect(apiAlarmState(published(FIRST_PUBLISH), at("2026-11-21T15:49:49Z"), "off")).toBe(`stale since ${FIRST_PUBLISH}`);
	});

	test("the verifier's cases: the 06:00 publish failing and the noon alarm checking at 14:04 raises it; a hand publish at 16:00 is clear at 06:00 sharp and raised by a noon check made at 14:00", () => {
		expect(apiAlarmState(published("2026-11-21T00:02:00.000Z"), at("2026-11-21T14:04:00Z"), "off")).not.toBeNull();
		expect(apiAlarmState(published("2026-11-21T16:00:00.000Z"), at("2026-11-22T06:00:00Z"), "off")).toBeNull();
		expect(apiAlarmState(published("2026-11-21T16:00:00.000Z"), at("2026-11-22T14:00:00Z"), "off")).not.toBeNull();
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
	 * The real schedule over three days. Each run's alarm checks alarmAfter(i)
	 * after its slot (however late the job started, and however long it took to
	 * reach the alarm step); its publish, unless it fails, lands publishAfter(i)
	 * after that. In order of check. The 22:40 run before day one published at
	 * 22:40.
	 */
	function simulate(alarmAfter: (index: number) => number, publishAfter: (index: number) => number, fails: (index: number) => boolean) {
		const runs = scheduledStarts(at("2026-11-20T23:00:00Z"), at("2026-11-23T23:00:00Z")).map((slot, index) => {
			const check = slot.getTime() + alarmAfter(index);
			return { index, slot: slot.getTime(), check, publish: fails(index) ? null : check + publishAfter(index) };
		});
		const publishes = [Date.parse("2026-11-20T22:40:00Z"), ...runs.flatMap((run) => (run.publish === null ? [] : [run.publish]))];
		return runs
			.sort((a, b) => a.check - b.check)
			.map((run) => {
				const last = Math.max(...publishes.filter((time) => time < run.check));
				const raised = apiAlarmState(published(new Date(last).toISOString()), at(run.check), "off") !== null;
				return { ...run, last, age: run.check - last, raised };
			});
	}

	test("every check is raised exactly when it is made more than 14 hours after the last successful publish", () => {
		for (let seed = 1; seed <= 5; seed++) {
			const draw = random(seed);
			const alarms = Array.from({ length: 20 }, () => Math.floor(draw() * 180) * MINUTE);
			const results = simulate((i) => alarms[i] as number, () => 5 * MINUTE, (i) => draw() < 0.3 || i === 7);
			for (const result of results) expect(result.raised).toBe(result.age > MAX_PUBLISH_AGE_MS);
		}
	});

	test("one failed publish in the ordinary schedule stays quiet whenever every alarm checks less than two hours after its slot", () => {
		for (let seed = 1; seed <= 10; seed++) {
			const draw = random(seed);
			const alarms = Array.from({ length: 20 }, () => Math.floor(draw() * 120) * MINUTE);
			const publishes = Array.from({ length: 20 }, () => (1 + Math.floor(draw() * 15)) * MINUTE);
			for (let failed = 0; failed < 15; failed++) {
				const raised = simulate((i) => alarms[i] as number, (i) => publishes[i] as number, (i) => i === failed).filter((result) => result.raised);
				expect({ seed, failed, raised: raised.length }).toEqual({ seed, failed, raised: 0 });
			}
		}
		// The next check comes 12 hours after the last publish at most, plus how late its alarm runs: 1 h 59 m late, 13 h 59 m, quiet.
		const worst = simulate((i) => (i === 2 ? 119 * MINUTE : 0), () => 0, (i) => i === 1);
		expect(worst.find((result) => result.index === 2)).toMatchObject({ age: 13 * HOUR + 59 * MINUTE, raised: false });
		// And two hours or more late, it may raise: the verifier's 14:04.
		const late = simulate((i) => (i === 2 ? 124 * MINUTE : i === 0 ? 2 * MINUTE : 0), () => 0, (i) => i === 1);
		expect(late.find((result) => result.index === 2)).toMatchObject({ age: 14 * HOUR + 2 * MINUTE, raised: true });
	});

	test("publishing that has stopped is raised by the first check after 14 hours: with on-time runs, 16 h 40 m to 19 h 20 m after the last scheduled publish", () => {
		const firsts: number[] = [];
		for (let stopped = 0; stopped < 10; stopped++) {
			const results = simulate(() => 0, () => 0, (i) => i > stopped).filter((result) => result.index > stopped);
			const first = results.findIndex((result) => result.raised);
			expect(results.slice(0, first).every((result) => !result.raised)).toBe(true);
			expect(results.slice(first).every((result) => result.raised)).toBe(true);
			firsts.push((results[first] as { age: number }).age);
		}
		expect(Math.min(...firsts)).toBe(16 * HOUR + 40 * MINUTE);
		expect(Math.max(...firsts)).toBe(19 * HOUR + 20 * MINUTE);
	});

	test("not promised: the 22:40 and 00:00 runs failing either side of their short gap pass unnoticed when the 06:00 run publishes", () => {
		expect(simulate(() => 3 * MINUTE, () => MINUTE, (i) => i === 4 || i === 5).some((result) => result.raised)).toBe(false);
	});

	test("the README states the threshold the code and these tests read", () => {
		const readme = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
		expect(readme).toContain(`first check made more than ${MAX_PUBLISH_AGE_MS / HOUR} hours after the last successful publish`);
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

describe("the API bucket, read from a stand-in for S3: a result from the closed set", () => {
	let standin: S3Standin;
	let publisher: S3ApiStore;
	/** The alarm's view: the first job's key, which may only read. */
	const alarmView = (bucket = BUCKET, keyId = READER) =>
		new S3ApiStore(bucket, "us-east-2", { endpoint: standin.url, errorBodyMs: 100, credentials: () => ({ accessKeyId: keyId, secretAccessKey: "secret", sessionToken: "token" }) });
	const noSleep = async () => {};

	beforeEach(() => {
		standin = new S3Standin();
		standin.start();
		standin.bucket(BUCKET, { writers: [WRITER], readers: [READER] });
		publisher = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: WRITER, secretAccessKey: "secret", sessionToken: "token" }) });
	});
	afterEach(() => standin.stop());

	test("published, empty, refused, no such bucket, no credentials", async () => {
		expect(await checkApiBucket(alarmView())).toEqual({ kind: "empty" });
		standin.now = () => at(FIRST_PUBLISH);
		await publisher.put(indexFile(), RUN);
		expect(await checkApiBucket(alarmView())).toEqual(published(FIRST_PUBLISH));
		expect(standin.requests.at(-1)).toEqual({ method: "GET", bucket: BUCKET, key: STAMP_KEY, keyId: READER, ifNoneMatch: null });
		expect(await checkApiBucket(alarmView(BUCKET, STRANGER), { sleep: noSleep })).toEqual({ kind: "refused", status: 403, attempts: 1 });
		expect(await checkApiBucket(alarmView("ledgermath-no-such-bucket"), { sleep: noSleep })).toEqual({ kind: "refused", status: 404, attempts: 1 });
		const keyless = new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => credentialsFromEnvironment({}) });
		expect(await checkApiBucket(keyless, { sleep: noSleep })).toEqual({ kind: "no-credentials" });
	});

	test("a single server error is tried again quietly; three in a row are a server error with the HTTP status; a closed port is no answer", async () => {
		standin.now = () => at(FIRST_PUBLISH);
		await publisher.put(indexFile(), RUN);
		let failures = 1;
		standin.fault = (request) => (request.method === "GET" && failures-- > 0 ? new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 }) : undefined);
		const waits: number[] = [];
		const sleep = async (ms: number) => {
			waits.push(ms);
		};
		expect(await checkApiBucket(alarmView(), { sleep })).toEqual(published(FIRST_PUBLISH));
		expect(waits).toEqual([RETRY_WAITS_MS[0] as number]);
		failures = 5;
		expect(await checkApiBucket(alarmView(), { sleep: noSleep })).toEqual({ kind: "server-error", status: 503, attempts: 3 });
		const closed = new S3ApiStore(BUCKET, "us-east-2", { endpoint: "http://127.0.0.1:9", credentials: () => ({ accessKeyId: READER, secretAccessKey: "secret" }) });
		expect(await checkApiBucket(closed, { sleep: noSleep })).toEqual({ kind: "no-answer", attempts: 3 });
	});

	test("a 200 whose body stalls, or trickles, is read from its headers alone, at once", async () => {
		for (const body of [() => stalling("{"), trickling]) {
			standin.fault = (request) => (request.method === "GET" ? new Response(body(), { headers: OBJECT_HEADERS }) : undefined);
			const started = performance.now();
			expect(await checkApiBucket(alarmView())).toEqual(published(FIRST_PUBLISH));
			expect(performance.now() - started).toBeLessThan(1_000);
		}
	});

	test("of an error's body only the first 2,048 bytes are read: an S3 code beyond them is never seen; a stalled one is read for a limited time", async () => {
		expect(ERROR_BODY_BYTES).toBe(2_048);
		const padding = `<!--${" ".repeat(2_100)}-->`;
		standin.fault = (request) => (request.method === "GET" ? new Response(`<Error>${padding}<Code>CodeBeyondTheLimit</Code></Error>`, { status: 403 }) : undefined);
		const said: string[] = [];
		expect(await checkApiBucket(alarmView(), { sleep: noSleep, log: (line) => said.push(line) })).toEqual({ kind: "refused", status: 403, attempts: 1 });
		expect(said.join("\n")).toContain("answered 403 HTTP403");
		expect(said.join("\n")).not.toContain("CodeBeyondTheLimit");
		standin.fault = (request) => (request.method === "GET" ? new Response(stalling("<Error><Code>Acc"), { status: 403 }) : undefined);
		const started = performance.now();
		expect(await checkApiBucket(alarmView(), { sleep: noSleep })).toEqual({ kind: "refused", status: 403, attempts: 1 });
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("one chunk larger than the limit is decoded only up to the limit", async () => {
		const big = `${"a".repeat(2_048)}<Code>Hidden</Code>${"b".repeat(1_000_000)}`;
		expect(await boundedText(new Response(big).body, 2_048, 1_000)).toBe("a".repeat(2_048));
	});
});

describe("what the child prints: validated against the closed set, rendered in fixed words", () => {
	test("each kind, field for field; anything else, extra fields, odd dates, numbers out of range, is not a result", () => {
		const good: CheckResult[] = [
			{ kind: "unset" },
			published(FIRST_PUBLISH),
			published(FIRST_PUBLISH, null),
			{ kind: "empty" },
			{ kind: "refused", status: 403, attempts: 1 },
			{ kind: "no-credentials" },
			{ kind: "server-error", status: 503, attempts: 3 },
			{ kind: "no-answer", attempts: 3 },
			{ kind: "no-date" },
		];
		for (const result of good) expect(parseResult(JSON.stringify(result))).toEqual(result);
		for (const bad of [
			"",
			"null",
			"[]",
			'{"kind":"fresh"}',
			'{"kind":"empty","note":"@someone"}',
			'{"kind":"published","last_modified":"2026-11-21","run":1}',
			'{"kind":"published","last_modified":"2026-13-21T01:49:48.000Z","run":1}',
			'{"kind":"published","last_modified":"2026-11-21T01:49:48.000Z","run":-1}',
			'{"kind":"published","last_modified":"2026-11-21T01:49:48.000Z"}',
			'{"kind":"refused","status":503,"attempts":1}',
			'{"kind":"server-error","status":"500","attempts":1}',
			'{"kind":"no-answer","attempts":99}',
		]) {
			expect({ bad, parsed: parseResult(bad) }).toEqual({ bad, parsed: null });
		}
	});

	test("the words for every result and every failure are fixed: nothing in them but the bucket's name, a date and validated numbers", () => {
		const results: CheckResult[] = [
			{ kind: "refused", status: 403, attempts: 1 },
			{ kind: "no-credentials" },
			{ kind: "server-error", status: 503, attempts: 3 },
			{ kind: "no-answer", attempts: 3 },
			{ kind: "no-date" },
		];
		expect(results.map((result) => report(result, "2026-11-21T06:04:00Z").raised.match(/could not be read\*\*: (.+?), so whether/)?.[1])).toEqual([
			"S3 refused the read (HTTP 403)",
			"the job had no AWS credentials to read it with",
			"S3 answered with a server error (HTTP 503, on each of 3 tries)",
			"S3 gave no answer in time, on each of 3 tries",
			"S3 answered without a date to judge by",
		]);
		expect(results.map((result) => report(result, "2026-11-21T06:04:00Z").state)).toEqual([
			"unreadable: refused 403",
			"unreadable: no credentials",
			"unreadable: server error 503",
			"unreadable: no answer",
			"unreadable: no date",
		]);
		expect(checkFailed({ reason: "killed", budgetMs: 20_000 }).raised).toContain("it gave no result within 20 s and was stopped");
		expect(checkFailed({ reason: "exited", code: 3 }).raised).toContain("it exited with code 3");
		expect(checkFailed({ reason: "output" }).raised).toContain("its output was not understood");
		expect(checkFailed({ reason: "start" }).raised).toContain("it could not be started");
	});
});

describe("the check in a child process: only the environment it needs, its group killed after the budget, the stale Series judged as without it", () => {
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
	const asOnMain = async (api: ApiReport) => {
		const main = await verdict(null);
		const ours = await verdict(api);
		expect({ action: ours.outcome.action, stale: ours.outcome.stale.map(describeSeries), prices: ours.outcome.prices }).toEqual({
			action: main.outcome.action,
			stale: main.outcome.stale.map(describeSeries),
			prices: main.outcome.prices,
		});
		for (const line of main.post.split("\n").slice(0, -1)) expect(ours.post).toContain(line);
		expect(stateOf(ours.post)).toEqual({ ...(stateOf(main.post) as NonNullable<ReturnType<typeof stateOf>>), stale_api: "check failed" });
		return ours.post;
	};

	test("the child's environment holds only CHILD_ENVIRONMENT: the AWS keys and the step summary's path, no GITHUB_TOKEN", async () => {
		const keys = join(scratch, "child-env.json");
		const command = script("env", `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(keys)}, JSON.stringify(Object.keys(process.env)));\nconsole.log(JSON.stringify({ kind: "empty" }));\n`);
		const outcome = await checkInChild(command, {
			env: { GITHUB_TOKEN: HOSTILE[0], ACTIONS_RUNTIME_TOKEN: "secret", PATH: "/usr/bin", HOME: "/home/x", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", AWS_SESSION_TOKEN: "c", GITHUB_STEP_SUMMARY: join(scratch, "s.md") },
		});
		expect(outcome).toEqual({ result: { kind: "empty" } });
		expect([...CHILD_ENVIRONMENT]).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GITHUB_STEP_SUMMARY"]);
		const seen = JSON.parse(readFileSync(keys, "utf8")) as string[];
		for (const name of seen) expect(CHILD_ENVIRONMENT as readonly string[]).toContain(name);
		expect(seen).not.toContain("GITHUB_TOKEN");
	});

	test("a child that prints a token, a mention and a link, on stdout and stderr: none of it reaches the issue; it reaches the log", async () => {
		const words = JSON.stringify(HOSTILE.join(" "));
		const log: string[] = [];
		for (const source of [`console.log(${words});\n`, `console.error(${words});\nconsole.log(JSON.stringify({ kind: "empty" }) + ${words});\n`, `console.error(${words});\nprocess.exit(4);\n`]) {
			const outcome = await checkInChild(script("hostile", source), { log: (line) => log.push(line) });
			expect("failure" in outcome).toBe(true);
			const post = await asOnMain(reportOf(outcome, BUCKET, at(NOW), "off"));
			for (const word of HOSTILE) expect(post).not.toContain(word);
		}
		expect(log.join("\n")).toContain(HOSTILE[1] as string);
	});

	test("a stand-in S3 error body with a token, a mention and a link: the issue says only that S3 refused the read, and its status", async () => {
		const standin = new S3Standin();
		standin.start();
		try {
			standin.bucket(BUCKET, { readers: [READER] });
			standin.fault = (request) => (request.method === "GET" ? new Response(`<Error><Code>AccessDenied</Code><Message>${HOSTILE.join(" ")}</Message></Error>`, { status: 403 }) : undefined);
			const log: string[] = [];
			const outcome = await checkInChild([process.execPath, CHILD, "--bucket", BUCKET, "--now", NOW, "--public-api-state", "off", "--endpoint", standin.url], {
				env: { AWS_ACCESS_KEY_ID: READER, AWS_SECRET_ACCESS_KEY: "secret" },
				log: (line) => log.push(line),
			});
			expect(outcome).toEqual({ result: { kind: "refused", status: 403, attempts: 1 } });
			const tracker = new FakeIssues();
			await runAlarm({ schedule: SCHEDULE, runs: [], now: at(NOW), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: reportOf(outcome, BUCKET, at(NOW), "off") });
			const post = tracker.posts().join("\n");
			expect(post).toContain("**The API bucket could not be read**: S3 refused the read (HTTP 403)");
			for (const word of HOSTILE) expect(post).not.toContain(word);
			expect(log.join("\n")).toContain(HOSTILE[1] as string);
		} finally {
			standin.stop();
		}
	});

	const failingChildren: Array<[string, string, ReturnType<typeof checkFailed>]> = [
		["sleeps past the budget", "await Bun.sleep(60_000);\n", checkFailed({ reason: "killed", budgetMs: BUDGET })],
		["prints garbage", 'console.log("not a result {");\n', checkFailed({ reason: "output" })],
		["exits non-zero", 'console.error("something broke");\nprocess.exit(3);\n', checkFailed({ reason: "exited", code: 3 })],
	];
	for (const [name, source, expected] of failingChildren) {
		test(`a child that ${name}`, async () => {
			const started = performance.now();
			const outcome = await checkInChild(script(name.replaceAll(" ", "-"), source), { budgetMs: BUDGET, log: () => {} });
			const api = reportOf(outcome, BUCKET, at(NOW), "off");
			expect(api).toEqual(expected);
			await asOnMain(api);
			expect(performance.now() - started).toBeLessThan(BUDGET + 2_500);
		});
	}

	test("a child that ignores SIGTERM is dead when the alarm goes on: it is killed with SIGKILL", async () => {
		const pids = join(scratch, "stubborn.pid");
		const command = script("stubborn", `import { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nwriteFileSync(${JSON.stringify(pids)}, String(process.pid));\nawait Bun.sleep(60_000);\n`);
		const outcome = await checkInChild(command, { budgetMs: BUDGET, log: () => {} });
		expect(outcome).toEqual({ failure: { reason: "killed", budgetMs: BUDGET } });
		const pid = Number(readFileSync(pids, "utf8"));
		expect(pid).toBeGreaterThan(0);
		expect(alive(pid)).toBe(false);
	});

	test("its whole process group is killed: a grandchild that holds the pipes dies too, and the alarm does not wait out the grace", async () => {
		for (const [name, tail] of [
			["grandchild-killed", "await Bun.sleep(60_000);\n"],
			["grandchild-left", 'await Bun.write(Bun.stdout, `${JSON.stringify({ kind: "empty" })}\\n`);\nprocess.exit(0);\n'],
		] as const) {
			const pids = join(scratch, `${name}.pid`);
			// The child has no PATH (CHILD_ENVIRONMENT), so the grandchild is named by its full path.
			const sleep = Bun.which("sleep") as string;
			const command = script(
				name,
				`import { writeFileSync } from "node:fs";\nconst grandchild = Bun.spawn([${JSON.stringify(sleep)}, "60"], { stdout: "inherit", stderr: "inherit" });\nwriteFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, grandchild.pid]));\n${tail}`,
			);
			const started = performance.now();
			const outcome = await checkInChild(command, { budgetMs: BUDGET, log: () => {} });
			const elapsed = performance.now() - started;
			const [childPid, grandchildPid] = JSON.parse(readFileSync(pids, "utf8")) as [number, number];
			await Bun.sleep(100);
			expect({ name, child: alive(childPid), grandchild: alive(grandchildPid) }).toEqual({ name, child: false, grandchild: false });
			if (name === "grandchild-left") {
				// The child ended with a result; the grandchild holding its stdout was killed with the group, so the result is read at once.
				expect(outcome).toEqual({ result: { kind: "empty" } });
				expect(elapsed).toBeLessThan(BUDGET);
			} else expect(outcome).toEqual({ failure: { reason: "killed", budgetMs: BUDGET } });
		}
	});

	test("the real check, whose line to the step summary blocks (a pipe nobody reads), is killed after its budget", async () => {
		const fifo = join(scratch, "summary-fifo");
		if (!existsSync(fifo)) expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		const started = performance.now();
		const outcome = await checkInChild([process.execPath, CHILD, "--bucket", "", "--now", NOW, "--public-api-state", "off"], { budgetMs: 2_000, env: { GITHUB_STEP_SUMMARY: fifo }, log: () => {} });
		expect(outcome).toEqual({ failure: { reason: "killed", budgetMs: 2_000 } });
		expect(performance.now() - started).toBeLessThan(2_000 + 2_500);
		await asOnMain(reportOf(outcome, BUCKET, at(NOW), "off"));
	});

	test("the budget is 20 seconds", () => {
		expect(CHECK_BUDGET_MS).toBe(20_000);
	});
});

describe("in the alarm's issue", () => {
	const pass = (tracker: FakeIssues, now: string, result: CheckResult, publicApiState = "off", schedule = SCHEDULE) =>
		runAlarm({ schedule, runs: [], now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: report(result, now, publicApiState) });

	test("raises a bucket past 14 hours once, stays quiet while it only grows older, and says once that it is published again", async () => {
		const tracker = new FakeIssues();
		expect(await pass(tracker, "2026-11-21T12:04:00Z", published(FIRST_PUBLISH))).toMatchObject({ action: "none", api: null });
		expect(await pass(tracker, "2026-11-21T18:04:00Z", published(FIRST_PUBLISH))).toMatchObject({ action: "opened", issue: 1, api: `stale since ${FIRST_PUBLISH}` });
		expect(tracker.issues[0]?.title).toBe(ALARM_TITLE);
		expect(tracker.issues[0]?.body).toContain(
			`**The data API has not been published for 16.2 hours.** In the API bucket, \`v1/index.json\` was last written at ${FIRST_PUBLISH}, by run [${RUN}](${ACTIONS_RUN_URL}${RUN}), more than 14 hours before this check, so the runs since have not published.`,
		);
		for (const now of ["2026-11-21T22:44:00Z", "2026-11-22T00:04:00Z", "2026-11-22T06:04:00Z"]) expect(await pass(tracker, now, published(FIRST_PUBLISH))).toMatchObject({ action: "unchanged" });
		expect(await pass(tracker, "2026-11-22T12:04:00Z", published("2026-11-22T12:02:00.000Z", RUN + 1000))).toMatchObject({ action: "commented", api: null });
		expect(tracker.issues[0]?.comments[0]).toContain(`every watched Series has had a Run in the last 48 hours again, and the data API was last published at 2026-11-22T12:02:00.000Z, by run [${RUN + 1000}]`);
		expect(await pass(tracker, "2026-11-22T18:04:00Z", published("2026-11-22T18:02:00.000Z", RUN + 2000))).toMatchObject({ action: "unchanged" });
		expect(tracker.issues[0]?.comments).toHaveLength(1);
	});

	test("a re-run of an old run judges as any run at that moment: its child prints the same result, so it cannot clear an open alarm", async () => {
		const standin = new S3Standin();
		standin.start();
		try {
			standin.bucket(BUCKET, { readers: [READER], writers: [WRITER] });
			standin.now = () => at(FIRST_PUBLISH);
			await new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: WRITER, secretAccessKey: "secret" }) }).put(indexFile(), RUN);
			const now = "2026-11-21T22:44:00Z";
			const command = [process.execPath, CHILD, "--bucket", BUCKET, "--now", now, "--public-api-state", "off", "--endpoint", standin.url];
			const env = { AWS_ACCESS_KEY_ID: READER, AWS_SECRET_ACCESS_KEY: "secret" };
			const ordinary = await checkInChild(command, { env });
			const rerun = await checkInChild(command, { env: { ...env, GITHUB_RUN_ID: "44000000000", GITHUB_RUN_ATTEMPT: "3", GITHUB_EVENT_NAME: "schedule" } });
			expect(rerun).toEqual(ordinary);
			const tracker = new FakeIssues();
			await runAlarm({ schedule: SCHEDULE, runs: [], now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: reportOf(ordinary, BUCKET, at(now), "off") });
			expect(await runAlarm({ schedule: SCHEDULE, runs: [], now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: reportOf(rerun, BUCKET, at(now), "off") })).toMatchObject({
				action: "unchanged",
				api: `stale since ${FIRST_PUBLISH}`,
			});
		} finally {
			standin.stop();
		}
	});

	test("no issue or comment names the bucket, for any result in the closed set; the line for the log and step summary does", async () => {
		const results: CheckResult[] = [
			{ kind: "unset" },
			published(FIRST_PUBLISH),
			published("2026-11-22T00:02:00.000Z", null),
			{ kind: "empty" },
			{ kind: "refused", status: 403, attempts: 1 },
			{ kind: "no-credentials" },
			{ kind: "server-error", status: 503, attempts: 3 },
			{ kind: "no-answer", attempts: 3 },
			{ kind: "no-date" },
		];
		for (const state of ["off", "on"]) {
			for (const result of results) {
				// Raised beside a stale Series, then said again with the bucket fresh, and once with nothing else stale: every kind of post.
				const tracker = new FakeIssues();
				await pass(tracker, "2026-11-22T06:04:00Z", result, state, STALE_SCHEDULE);
				await pass(tracker, "2026-11-22T06:04:00Z", published("2026-11-22T06:02:00.000Z"), state, STALE_SCHEDULE);
				await pass(tracker, "2026-11-22T06:04:00Z", result, state);
				for (const post of tracker.posts()) expect({ result, state, named: post.includes(BUCKET) }).toEqual({ result, state, named: false });
				const words = report(result, "2026-11-22T06:04:00Z", state);
				expect([words.raised, words.well, words.again].join("\n")).not.toContain(BUCKET);
				if (result.kind !== "unset") expect(words.summary).toContain(`s3://${BUCKET}`);
			}
		}
	});

	test("an empty bucket and an unreadable one are raised at once, each in its own fixed words", async () => {
		const tracker = new FakeIssues();
		expect(await pass(tracker, "2026-11-21T06:04:00Z", { kind: "empty" })).toMatchObject({ action: "opened", api: "empty" });
		expect(tracker.issues[0]?.body).toContain("**The API bucket holds no table of contents.** The bucket `API_BUCKET` names holds no `v1/index.json`");
		expect(await pass(tracker, "2026-11-21T12:04:00Z", { kind: "refused", status: 403, attempts: 1 })).toMatchObject({ action: "commented", api: "unreadable: refused 403" });
	});

	test("with API_BUCKET unset, nothing is raised while PUBLIC_API is off", async () => {
		const tracker = new FakeIssues();
		expect(await pass(tracker, "2026-11-21T06:04:00Z", { kind: "unset" })).toMatchObject({ action: "none", api: null });
		expect(tracker.issues).toEqual([]);
	});

	test("with API_BUCKET unset, the alarm is raised in any other state of PUBLIC_API: serving is on, so a missing bucket name means publishing has stopped", async () => {
		for (const state of ["dark", "closed", "on"]) {
			const tracker = new FakeIssues();
			expect(await pass(tracker, "2026-11-21T06:04:00Z", { kind: "unset" }, state)).toMatchObject({ action: "opened", api: `unset while PUBLIC_API is ${state}` });
		}
	});

	test("a stale bucket beside stale Series is said in the same post, and its recovery while they stay stale is said once", async () => {
		const tracker = new FakeIssues();
		expect((await pass(tracker, "2026-11-21T18:04:00Z", published(FIRST_PUBLISH), "off", STALE_SCHEDULE)).stale.length).toBe(1);
		expect(tracker.issues[0]?.body).toContain("**The data API has not been published for 16.2 hours.**");
		expect(await pass(tracker, "2026-11-21T22:44:00Z", published("2026-11-21T22:42:00.000Z", RUN + 3000), "off", STALE_SCHEDULE)).toMatchObject({ action: "commented", api: null });
		expect(tracker.issues[0]?.comments[0]).toContain(`The data API is published again: it was last published at 2026-11-21T22:42:00.000Z, by run [${RUN + 3000}]`);
	});
});

describe("the drill: exactly one notification, nothing else", () => {
	const RUN_URL = "https://github.com/smrdotgg/ledgermath/actions/runs/44900000000";
	const pass = (tracker: FakeIssues, now: string, result: CheckResult) =>
		runAlarm({ schedule: SCHEDULE, runs: [], now: at(now), scheduleChangedAt: SETTLED, copyFailed: false, tracker, api: report(result, now) });

	test("on an open alarm issue: one comment, the run's link, nothing wrong; an open finding stays reported, unchanged", async () => {
		const tracker = new FakeIssues();
		await pass(tracker, "2026-11-21T18:04:00Z", published(FIRST_PUBLISH));
		const before = await tracker.findOpen(ALARM_MARKER);
		expect(await postDrill(tracker, RUN_URL)).toBe(1);
		expect(tracker.issues).toHaveLength(1);
		expect(tracker.issues[0]?.comments).toHaveLength(1);
		const drill = tracker.issues[0]?.comments[0] ?? "";
		expect(drill).toBe(drillText(RUN_URL));
		expect(drill).toContain(`in [this run](${RUN_URL})`);
		expect(drill).not.toContain(STATE_MARKER);
		expect(await tracker.findOpen(ALARM_MARKER)).toEqual(before);
		expect(await pass(tracker, "2026-11-21T22:44:00Z", published(FIRST_PUBLISH))).toMatchObject({ action: "unchanged", api: `stale since ${FIRST_PUBLISH}` });
	});

	test("with no open issue: the issue is opened with the drill's words as its body, and no comment, one notification; the next pass, all well, leaves it alone", async () => {
		const tracker = new FakeIssues();
		expect(await postDrill(tracker, null)).toBe(1);
		expect(tracker.issues[0]).toMatchObject({ title: ALARM_TITLE, body: `${ALARM_MARKER}\n${drillText(null)}`, comments: [] });
		expect(await pass(tracker, "2026-11-21T12:04:00Z", published(FIRST_PUBLISH))).toMatchObject({ action: "unchanged", api: null });
		expect(tracker.issues[0]?.comments).toEqual([]);
		expect(drillText(RUN_URL).length).toBeLessThan(MAX_BODY_CHARS / 50);
	});

	test("a drill that cannot post is said in the log and the step summary, and throws nothing", async () => {
		const failing: IssueTracker = {
			findOpen: async () => null,
			open: async () => {
				throw new Error("GitHub POST /issues: 500 nope");
			},
			comment: async () => {},
		};
		const log: string[] = [];
		const summary: string[] = [];
		expect(
			await drillSafely(
				failing,
				RUN_URL,
				(line) => log.push(line),
				(text) => {
					summary.push(text);
				},
			),
		).toBeNull();
		expect(log).toEqual(["the drill's comment could not be posted: GitHub POST /issues: 500 nope"]);
		expect(summary.join("")).toContain("The drill's comment could not be posted");
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

	/** The alarm, with the read-only key in its environment; posting nothing unless `github` names a stand-in for GitHub's API. `stale` makes every watched Series stale. */
	const alarm = async (now: string, extra: string[], options: { stale?: boolean; summary?: "file" | "directory" | "fifo"; github?: string } = {}) => {
		const directory = mkdtempSync(join(scratch, "script-"));
		const runs = join(directory, "ledgermath-runs");
		mkdirSync(runs);
		let summary = join(directory, "summary.md");
		if (options.summary === "directory") {
			summary = join(directory, "summary-is-a-directory");
			mkdirSync(summary);
		} else if (options.summary === "fifo") {
			summary = join(directory, "summary-is-a-pipe");
			expect(Bun.spawnSync(["mkfifo", summary]).exitCode).toBe(0);
		} else writeFileSync(summary, "");
		const changed = options.stale === true ? SETTLED.toISOString() : now;
		const started = performance.now();
		const child = Bun.spawn(
			[
				"bun",
				join(ROOT, "scripts", "alarm.ts"),
				"--runs",
				runs,
				"--copy",
				"succeeded",
				"--schedule-changed-at",
				changed,
				"--now",
				now,
				...(options.github === undefined ? ["--dry-run"] : []),
				"--api-endpoint",
				standin.url,
				...extra,
			],
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					AWS_ACCESS_KEY_ID: READER,
					AWS_SECRET_ACCESS_KEY: "secret",
					AWS_SESSION_TOKEN: "token",
					GITHUB_STEP_SUMMARY: summary,
					...(options.github === undefined ? {} : { GITHUB_API_URL: options.github, GITHUB_REPOSITORY: "smrdotgg/ledgermath", GITHUB_TOKEN: HOSTILE[0], GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "44900000000" }),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { exitCode, stdout, stderr, elapsed: performance.now() - started, summary: options.summary === "directory" || options.summary === "fifo" ? "" : readFileSync(summary, "utf8") };
	};
	const staleLines = (stdout: string): string[] => stdout.split("\n").filter((line) => line.startsWith("stale: "));

	/** A stand-in for GitHub's issues API: no open issue; each POST answered in turn from `answers`. */
	const fakeGitHub = (answers: number[]) => {
		const posts: string[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				if (request.method === "GET") return Response.json([]);
				posts.push(((await request.json()) as { body: string }).body);
				const status = answers[posts.length - 1] ?? 500;
				return status < 300 ? Response.json({ number: posts.length }, { status }) : new Response("Validation Failed", { status });
			},
		});
		return { url: `http://127.0.0.1:${server.port}`, posts, stop: () => server.stop(true) };
	};

	test("with API_BUCKET unset, the child says so in the step summary and reads nothing", async () => {
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", ""]);
		expect(done.exitCode).toBe(0);
		expect(standin.requests).toEqual([]);
		expect(done.summary).toStartWith("### The API bucket\n\nAPI_BUCKET is unset");
	});

	test("with a fresh bucket, the child says when it was last written, nothing is raised, and the alarm ends when its work does", async () => {
		standin.now = () => at(FIRST_PUBLISH);
		await new S3ApiStore(BUCKET, "us-east-2", { endpoint: standin.url, credentials: () => ({ accessKeyId: WRITER, secretAccessKey: "secret" }) }).put(indexFile(), RUN);
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET]);
		expect(done.exitCode).toBe(0);
		expect(done.summary).toBe(`### The API bucket\n\ns3://${BUCKET}: v1/index.json last written at ${FIRST_PUBLISH} (4.2 hours ago), by run ${RUN}; raised past 14 hours: not raised\n`);
		expect(done.stdout).not.toContain("would open");
		expect(done.elapsed).toBeLessThan(CHECK_BUDGET_MS / 2);
	});

	test("a step summary that is a directory: warned of, and the stale Series verdict and exit code are those of the alarm without the bucket", async () => {
		const main = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", ""], { stale: true });
		const ours = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", BUCKET], { stale: true, summary: "directory" });
		expect(ours.exitCode).toBe(main.exitCode);
		expect(staleLines(ours.stdout)).toEqual(staleLines(main.stdout));
		expect(ours.stdout).toContain("--dry-run: would open");
	});

	test("a step summary that blocks on open (a pipe nobody reads) does not hold the alarm: its write is abandoned after two seconds and the alarm exits with its verdict's code", async () => {
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", ""], { stale: true, summary: "fifo" });
		expect(done.exitCode).toBe(0);
		expect(done.stdout).toContain("--dry-run: would open");
		expect(staleLines(done.stdout).length).toBeGreaterThan(100);
		expect(done.stderr).toContain("could not write to the step's summary (not written within 2 s); carrying on");
		// The check's child blocks on the same pipe until its 20 seconds are up; the alarm's own write adds two.
		expect(done.elapsed).toBeLessThan(CHECK_BUDGET_MS + 10_000);
	});

	test("every stale Series is listed in the step summary, which the issue points to when it cannot list them all", async () => {
		const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", ""], { stale: true });
		const count = staleLines(done.stdout).length;
		expect(count).toBeGreaterThan(100);
		expect(done.summary).toContain(`### Stale watched Series (${count})`);
		expect(done.summary.split("\n").filter((line) => line.startsWith("- `")).length).toBe(count);
	});

	test("a post GitHub refuses (422) fails the alarm loudly and is not sent again", async () => {
		const github = fakeGitHub([422]);
		try {
			const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", ""], { stale: true, github: github.url });
			expect(done.exitCode).toBe(1);
			expect(done.stderr).toContain("422");
			expect(github.posts).toHaveLength(1);
		} finally {
			github.stop();
		}
	});

	test("a drill that cannot post does not fail the job: the verdict is posted, the drill's failure is said in the log and the step summary, and the exit code is the verdict's", async () => {
		const github = fakeGitHub([201, 500]);
		try {
			const done = await alarm("2026-11-21T06:04:00Z", ["--api-bucket", "", "--drill", "yes"], { stale: true, github: github.url });
			expect(done.exitCode).toBe(0);
			expect(github.posts).toHaveLength(2);
			expect(github.posts[0]).toContain("watched Series have had no Run for more than 48 hours.");
			expect(github.posts[1]).toContain("**This is a drill**, started by hand with the input `alarm_drill` in [this run](https://github.com/smrdotgg/ledgermath/actions/runs/44900000000)");
			expect(done.stderr).toContain("the drill's comment could not be posted");
			expect(done.summary).toContain("The drill's comment could not be posted");
			// Every post under GitHub's limit, however many Series are stale; the token never in one.
			for (const post of github.posts) {
				expect(post.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
				expect(post).not.toContain(HOSTILE[0] as string);
			}
		} finally {
			github.stop();
		}
	});
});
