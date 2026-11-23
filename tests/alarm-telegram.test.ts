/**
 * The alarm's Telegram message (ADR-0033; scripts/lib/telegram.ts,
 * scripts/alarm.ts): one plain-text message whenever the alarm writes on
 * GitHub, or had something to post and could not; none on a pass that writes
 * nothing. Sent to a stand-in for Telegram's Bot API, never the real one. A
 * message that cannot be sent (Telegram down, slow, refusing, answering what
 * is not JSON) changes nothing of the alarm: not its exit code, its posts or
 * its marker; it costs a bounded time; and the bot token is never printed.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Schedule } from "../infra/runs/schedule";
import {
	ALARM_ISSUE_URL,
	ALARM_MARKER,
	type AlarmOutcome,
	CHILD_ENVIRONMENT,
	checkInChild,
	type IssueTracker,
	type OpenAlarm,
	PING_BUDGET_MS,
	type PingFacts,
	type PingReport,
	pingSafely,
	pingText,
	runAlarm,
	STATE_MARKER,
	stateOf,
	verdictPost,
} from "../scripts/alarm";
import { ACTIONS_RUN_URL } from "../scripts/lib/api-freshness";
import { ANSWER_BYTES, MAX_MESSAGE_CHARS, type Messenger, outcomeWords, SEND_BUDGET_MS, type SendOutcome, TelegramBot, telegramFromEnvironment } from "../scripts/lib/telegram";
import { S3Standin } from "./s3-standin";

// Local servers, child processes, and budgets of up to 15 seconds.
setDefaultTimeout(90_000);

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "alarm-telegram-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A bot token of the right shape, made up: the tests look for it, and its secret half, in everything the alarm prints. */
const TOKEN = "123456789:AAtest-token-never-printed_0123456789ab";
const TOKEN_SECRET = TOKEN.split(":")[1] as string;
const CHAT = "-1001234567890";
const RUN_ID = "44900000000";
const RUN_URL = `${ACTIONS_RUN_URL}${RUN_ID}`;
/** Words nothing from Telegram, S3 or the check may bring into a message or the log: a token's shape, a mention, a link. */
const HOSTILE = ["ghp_0123456789abcdefghijABCDEFGHIJ012345", "@someone-to-ping", "[click here](https://example.org/x)"];
/** A port where nothing listens. */
const CLOSED = "http://127.0.0.1:9";

/** A body that sends `first` and then nothing more, never ending. */
const stalling = (first: string): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(first));
		},
	});

type Mode = "ok" | "not-ok" | "401" | "429" | "malformed" | "huge" | "stall-headers" | "stall-body" | "redirect";

/** A stand-in for Telegram's Bot API: records every request, and answers as `mode` says. */
class TelegramStandin {
	readonly requests: Array<{ method: string; path: string; contentType: string | null; fields: Record<string, string> }> = [];
	private readonly server: ReturnType<typeof Bun.serve>;

	constructor(
		public mode: Mode,
		redirectTo = CLOSED,
	) {
		this.server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			// Never closes a stalled connection itself: the alarm must give up on it.
			idleTimeout: 0,
			fetch: async (request) => {
				const fields = Object.fromEntries(new URLSearchParams(await request.text()));
				const path = new URL(request.url).pathname;
				this.requests.push({ method: request.method, path, contentType: request.headers.get("content-type"), fields });
				switch (this.mode) {
					case "ok":
						return Response.json({ ok: true, result: { message_id: 1, chat: { id: Number(fields.chat_id) }, text: fields.text } });
					case "not-ok":
						return Response.json({ ok: false, description: HOSTILE.join(" ") });
					case "401":
						return Response.json({ ok: false, error_code: 401, description: `Unauthorized ${HOSTILE.join(" ")}` }, { status: 401 });
					case "429":
						return Response.json({ ok: false, error_code: 429, description: `Too Many Requests: retry after 5 ${HOSTILE.join(" ")}`, parameters: { retry_after: 5 } }, { status: 429 });
					case "malformed":
						return new Response(`not JSON ${HOSTILE.join(" ")} {`, { headers: { "content-type": "application/json" } });
					case "huge":
						return new Response(`{"ok":true,"pad":"${"x".repeat(ANSWER_BYTES)}"}`, { headers: { "content-type": "application/json" } });
					case "stall-headers":
						return new Promise<Response>(() => {});
					case "stall-body":
						return new Response(stalling('{"ok":'), { headers: { "content-type": "application/json" } });
					case "redirect":
						return new Response(null, { status: 302, headers: { location: `${redirectTo}${path}` } });
				}
			},
		});
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	stop(): void {
		this.server.stop(true);
	}
}

const MODES_AND_OUTCOMES: Array<[Mode, SendOutcome]> = [
	["not-ok", { kind: "not-accepted" }],
	["401", { kind: "status", status: 401 }],
	["429", { kind: "status", status: 429 }],
	["malformed", { kind: "malformed" }],
	["huge", { kind: "malformed" }],
	["stall-headers", { kind: "timeout" }],
	["stall-body", { kind: "timeout" }],
];

describe("one message to the Bot API: a closed set of outcomes, never Telegram's words, within its budget", () => {
	const BUDGET = 500;
	const bot = (url: string, budgetMs = BUDGET) => new TelegramBot(TOKEN, CHAT, { apiBase: url, budgetMs });

	test("one POST of the form fields chat_id and text, plain (no parse_mode), to /bot<token>/sendMessage; sent when Telegram says ok", async () => {
		const telegram = new TelegramStandin("ok");
		try {
			expect(await bot(telegram.url).send("first line\nsecond line")).toEqual({ kind: "sent" });
			expect(telegram.requests).toHaveLength(1);
			const [request] = telegram.requests;
			expect(request?.method).toBe("POST");
			expect(request?.path).toBe(`/bot${TOKEN}/sendMessage`);
			expect(request?.contentType).toStartWith("application/x-www-form-urlencoded");
			expect(request?.fields).toEqual({ chat_id: CHAT, text: "first line\nsecond line" });
		} finally {
			telegram.stop();
		}
	});

	for (const [mode, expected] of MODES_AND_OUTCOMES) {
		test(`Telegram that answers ${mode}: ${JSON.stringify(expected)}, sent once, within the budget`, async () => {
			const telegram = new TelegramStandin(mode);
			try {
				const started = performance.now();
				expect(await bot(telegram.url).send("hello")).toEqual(expected);
				expect(performance.now() - started).toBeLessThan(BUDGET + 1_000);
				expect(telegram.requests).toHaveLength(1);
			} finally {
				telegram.stop();
			}
		});
	}

	test("Telegram down (nothing listens): no answer, at once", async () => {
		const started = performance.now();
		expect(await bot(CLOSED).send("hello")).toEqual({ kind: "no-answer" });
		expect(performance.now() - started).toBeLessThan(BUDGET + 1_000);
	});

	test("a redirect is not followed: its status is the outcome, and the place it points to hears nothing", async () => {
		const elsewhere = new TelegramStandin("ok");
		const telegram = new TelegramStandin("redirect", elsewhere.url);
		try {
			expect(await bot(telegram.url).send("hello")).toEqual({ kind: "status", status: 302 });
			expect(elsewhere.requests).toEqual([]);
		} finally {
			telegram.stop();
			elsewhere.stop();
		}
	});

	test("a fetch that throws, naming the address, is no answer: nothing of the error is kept, and send never throws", async () => {
		const naming = new TelegramBot(TOKEN, CHAT, {
			fetcher: async (url) => {
				throw new Error(`Unable to connect: ${url}`);
			},
		});
		const outcome = await naming.send("hello");
		expect(outcome).toEqual({ kind: "no-answer" });
		expect(JSON.stringify(outcome)).not.toContain(TOKEN_SECRET);
		const synchronous = new TelegramBot(TOKEN, CHAT, {
			fetcher: (url) => {
				throw new Error(`at once: ${url}`);
			},
		});
		expect(await synchronous.send("hello")).toEqual({ kind: "no-answer" });
	});

	test("the outcomes' words are fixed: no answer's own words, only the HTTP status", () => {
		expect(outcomeWords({ kind: "timeout" })).toBe("Telegram gave no whole answer within 15 s");
		expect(outcomeWords({ kind: "timeout" }, 500)).toBe("Telegram gave no whole answer within 0.5 s");
		expect(outcomeWords({ kind: "no-answer" })).toBe("Telegram could not be reached");
		expect(outcomeWords({ kind: "status", status: 401 })).toBe("Telegram answered HTTP 401");
		expect(outcomeWords({ kind: "status", status: 429 })).toBe("Telegram answered HTTP 429");
		expect(outcomeWords({ kind: "malformed" })).toBe("Telegram's answer was not understood");
		expect(outcomeWords({ kind: "not-accepted" })).toBe("Telegram did not accept the message");
		expect(SEND_BUDGET_MS).toBe(15_000);
	});

	test("the secrets: both must be set; a token not shaped like one is refused without being repeated; nothing else of the environment is read", () => {
		expect(telegramFromEnvironment({})).toEqual({ kind: "absent", missing: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] });
		expect(telegramFromEnvironment({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "" })).toEqual({ kind: "absent", missing: ["TELEGRAM_CHAT_ID"] });
		expect(telegramFromEnvironment({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: CHAT })).toEqual({ kind: "absent", missing: ["TELEGRAM_BOT_TOKEN"] });
		for (const bad of ["123:abc/../../evil", "123:abc?x=1", "evil.example.org/bot123:abc", "123:abc def", "no-colon"]) {
			expect(telegramFromEnvironment({ TELEGRAM_BOT_TOKEN: bad, TELEGRAM_CHAT_ID: CHAT })).toEqual({ kind: "bad-token" });
			let said = "";
			try {
				new TelegramBot(bad, CHAT);
			} catch (error) {
				said = (error as Error).message;
			}
			expect(said).toBe("the bot token is not shaped like one");
		}
		const ready = telegramFromEnvironment({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, GITHUB_TOKEN: "x" });
		expect(ready.kind).toBe("ready");
		expect(ready.kind === "ready" && ready.messenger instanceof TelegramBot).toBe(true);
	});
});

const TARGET = { instance_type: "c6i.8xlarge", vcpus: 32, zone: "us-east-2c", boots_utc: ["22:10"] };
const QUOTA = { limit: 64, reserved_outside_schedule: 4 };
/** One watched Series, with no Run: stale once the schedule is old enough. */
const ONE_SERIES: Schedule = { vcpu_quota: QUOTA, targets: [TARGET], benchmarks: [{ name: "syscall", builds: ["static"], samples: 10, timeout_seconds: 120, params: [{ call: "getpid" }] }] };
const SETTLED = new Date("2026-10-01T00:00:00Z");
const NOW = "2026-11-21T06:04:00Z";

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

const facts = (over: Partial<PingFacts>): PingFacts => ({
	verdict: null,
	drill: null,
	stale: 3,
	watched: 187,
	pricesStale: false,
	apiRaised: false,
	copyFailed: false,
	runUrl: RUN_URL,
	...over,
});

describe("the message's words: fixed, from the verdict, at most a few hundred characters", () => {
	test("each kind of post, word for word", () => {
		expect(pingText(facts({ verdict: { kind: "opened", issue: 41 } }))).toBe(
			[
				"LedgerMath alarm: opened issue #41 on GitHub.",
				"Now: 3 of 187 watched Series stale (no Run for 48 hours).",
				`Issue: ${ALARM_ISSUE_URL}41`,
				`Run: ${RUN_URL}`,
			].join("\n"),
		);
		expect(pingText(facts({ verdict: { kind: "commented", issue: 41 }, pricesStale: true, apiRaised: true, copyFailed: true }))).toBe(
			[
				"LedgerMath alarm: commented on issue #41, because what it reports has changed.",
				"Now: 3 of 187 watched Series stale (no Run for 48 hours); the price files stale (none new for 48 hours); the data API not published for 14 hours, or its publishing could not be checked; the copy job failed on this pass.",
				`Issue: ${ALARM_ISSUE_URL}41`,
				`Run: ${RUN_URL}`,
			].join("\n"),
		);
		expect(pingText(facts({ verdict: { kind: "all-clear", issue: 41 }, stale: 0 }))).toBe(
			[
				"LedgerMath alarm: all clear, said on issue #41. Nothing it watches is stale now.",
				"Now: 0 of 187 watched Series stale (no Run for 48 hours).",
				`Issue: ${ALARM_ISSUE_URL}41`,
				`Run: ${RUN_URL}`,
			].join("\n"),
		);
		expect(pingText(facts({ verdict: { kind: "not-posted" } }))).toBe(
			[
				"LedgerMath alarm: COULD NOT POST ON GITHUB. GitHub refused the post or could not be reached, so the issue does not say what follows. The run's log says why.",
				"Now: 3 of 187 watched Series stale (no Run for 48 hours).",
				`Run: ${RUN_URL}`,
			].join("\n"),
		);
	});

	test("a drill says it is one, and that nothing is wrong; with the verdict's post too, both in one message", () => {
		expect(pingText(facts({ drill: { kind: "posted", issue: 41 } }))).toBe(
			[
				"LedgerMath alarm drill: posted on issue #41, started by hand with alarm_drill. Nothing is wrong because of the drill. This is its Telegram message.",
				`Issue: ${ALARM_ISSUE_URL}41`,
				`Run: ${RUN_URL}`,
			].join("\n"),
		);
		expect(pingText(facts({ drill: { kind: "not-posted" } }))).toBe(
			[
				"LedgerMath alarm drill: it could not post on GitHub (GitHub refused it or could not be reached). Nothing is wrong because of the drill. This is its Telegram message.",
				`Run: ${RUN_URL}`,
			].join("\n"),
		);
		expect(pingText(facts({ verdict: { kind: "opened", issue: 41 }, drill: { kind: "posted", issue: 41 } }))).toBe(
			[
				"LedgerMath alarm: opened issue #41 on GitHub.",
				"Now: 3 of 187 watched Series stale (no Run for 48 hours).",
				"And a drill: posted on issue #41, started by hand with alarm_drill. Nothing is wrong because of the drill. This is its Telegram message.",
				`Issue: ${ALARM_ISSUE_URL}41`,
				`Run: ${RUN_URL}`,
			].join("\n"),
		);
	});

	test("nothing written, nothing tried: no message", () => {
		expect(pingText(facts({}))).toBeNull();
	});

	test("an issue number that is not a positive whole number, and a run address that is not this repository's Actions and a number, are left out", () => {
		for (const issue of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
			const text = pingText(facts({ verdict: { kind: "opened", issue } })) as string;
			expect(text.split("\n")[0]).toBe("LedgerMath alarm: opened the alarm issue on GitHub.");
			expect(text).not.toContain("Issue:");
		}
		for (const runUrl of [null, "https://example.org/actions/runs/1", `${ACTIONS_RUN_URL}12x`, `${ACTIONS_RUN_URL}0`, `${ACTIONS_RUN_URL}1/../../x`]) {
			expect(pingText(facts({ verdict: { kind: "opened", issue: 1 }, runUrl }))).not.toContain("Run:");
		}
	});

	test("every combination, with the largest numbers, is far under Telegram's limit of 4,096 characters", () => {
		expect(MAX_MESSAGE_CHARS).toBe(4_096);
		const big = Number.MAX_SAFE_INTEGER;
		const verdicts: PingFacts["verdict"][] = [null, { kind: "opened", issue: big }, { kind: "commented", issue: big }, { kind: "all-clear", issue: big }, { kind: "not-posted" }];
		const drills: PingFacts["drill"][] = [null, { kind: "posted", issue: big - 1 }, { kind: "not-posted" }];
		let longest = 0;
		for (const verdict of verdicts) {
			for (const drill of drills) {
				for (const flags of [false, true]) {
					const text = pingText({ verdict, drill, stale: big, watched: big, pricesStale: flags, apiRaised: flags, copyFailed: flags, runUrl: `${ACTIONS_RUN_URL}${"9".repeat(20)}` });
					longest = Math.max(longest, text?.length ?? 0);
				}
			}
		}
		expect(longest).toBeGreaterThan(300);
		expect(longest).toBeLessThan(1_000);
	});

	test("each kind of post, from the real alarm's outcomes: opened, nothing changed, commented, all clear, nothing to say", async () => {
		const tracker = new FakeIssues();
		const prices = { path: "prices/2026/11/13/aws.json", fetchedAt: "2026-11-13T03:17:42.123Z" };
		const pass = (changedAt: Date, newestPrices: typeof prices | null = null): Promise<AlarmOutcome> =>
			runAlarm({ schedule: ONE_SERIES, runs: [], now: new Date(NOW), scheduleChangedAt: changedAt, copyFailed: false, tracker, newestPrices });
		const kinds: Array<string | null> = [];
		for (const [changedAt, newestPrices] of [
			[SETTLED, null],
			[SETTLED, null],
			[SETTLED, prices],
			[new Date(NOW), null],
			[new Date(NOW), null],
		] as const) {
			const outcome = await pass(changedAt, newestPrices);
			kinds.push(verdictPost(outcome)?.kind ?? null);
		}
		expect(kinds).toEqual(["opened", null, "commented", "all-clear", null]);
		const quiet = new FakeIssues();
		expect(verdictPost(await runAlarm({ schedule: ONE_SERIES, runs: [], now: new Date(NOW), scheduleChangedAt: new Date(NOW), copyFailed: false, tracker: quiet }))).toBeNull();
		expect(quiet.issues).toEqual([]);
	});
});

/** A Messenger in memory, answering `outcome` (or never, or by throwing), recording what it was given. */
const fakeMessenger = (answer: SendOutcome | "never" | "throw") => {
	const sent: string[] = [];
	const messenger: Messenger = {
		send: (text) => {
			sent.push(text);
			if (answer === "never") return new Promise(() => {});
			if (answer === "throw") return Promise.reject(new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`));
			return Promise.resolve(answer);
		},
	};
	return { messenger, sent };
};
const recorder = () => {
	const printed: string[] = [];
	const summary: string[] = [];
	const report: PingReport = {
		print: (line) => printed.push(line),
		summary: (text) => {
			summary.push(text);
		},
	};
	return { report, printed, summary, all: () => [...printed, ...summary].join("\n") };
};

describe("sending it: never failing, never longer than its budget, a warning in fixed words when it is not sent", () => {
	const TEXT = pingText(facts({ verdict: { kind: "opened", issue: 1 } })) as string;

	test("no post: nothing is sent and nothing is said but a line in the log", async () => {
		const { messenger, sent } = fakeMessenger({ kind: "sent" });
		const out = recorder();
		expect(await pingSafely(null, { kind: "ready", messenger }, out.report)).toBe("nothing");
		expect(sent).toEqual([]);
		expect(out.summary).toEqual([]);
		expect(out.printed).toEqual(["telegram: the alarm wrote nothing on GitHub, so it sends no message"]);
	});

	test("sent: one message, said in the log and the step summary", async () => {
		const { messenger, sent } = fakeMessenger({ kind: "sent" });
		const out = recorder();
		expect(await pingSafely(TEXT, { kind: "ready", messenger }, out.report)).toBe("sent");
		expect(sent).toEqual([TEXT]);
		expect(out.printed).toEqual(["telegram: one message sent"]);
		expect(out.summary.join("")).toContain("Sent: one message");
	});

	test("every way it is not sent is a warning annotation and a summary line, in fixed words", async () => {
		const cases: Array<[SendOutcome | "throw", string]> = [
			[{ kind: "timeout" }, "Telegram gave no whole answer within 16 s"],
			[{ kind: "no-answer" }, "Telegram could not be reached"],
			[{ kind: "status", status: 401 }, "Telegram answered HTTP 401"],
			[{ kind: "status", status: 429 }, "Telegram answered HTTP 429"],
			[{ kind: "malformed" }, "Telegram's answer was not understood"],
			[{ kind: "not-accepted" }, "Telegram did not accept the message"],
			["throw", "Telegram could not be reached"],
		];
		for (const [answer, words] of cases) {
			const { messenger } = fakeMessenger(answer);
			const out = recorder();
			expect(await pingSafely(TEXT, { kind: "ready", messenger }, out.report)).toBe("failed");
			expect(out.printed).toEqual([`::warning title=The alarm's Telegram message::The alarm's Telegram message was not sent: ${words}. Nothing else changes.`]);
			expect(out.summary).toEqual([`### The alarm's Telegram message\n\nThe alarm's Telegram message was not sent: ${words}. Nothing else changes.\n`]);
			expect(out.all()).not.toContain(TOKEN_SECRET);
		}
	});

	test("a Messenger that never answers is abandoned after the budget", async () => {
		const { messenger } = fakeMessenger("never");
		const out = recorder();
		const started = performance.now();
		expect(await pingSafely(TEXT, { kind: "ready", messenger }, out.report, 300)).toBe("failed");
		expect(performance.now() - started).toBeLessThan(1_300);
		expect(out.printed[0]).toContain("Telegram gave no whole answer within 0.3 s");
		expect(PING_BUDGET_MS).toBe(SEND_BUDGET_MS + 1_000);
	});

	test("the secrets unset: skipped with a notice, nothing sent; a token not shaped like one: a warning", async () => {
		const out = recorder();
		expect(await pingSafely(TEXT, { kind: "absent", missing: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] }, out.report)).toBe("skipped");
		expect(out.printed).toEqual([
			"::notice title=The alarm's Telegram message::No Telegram message: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set (a fork, or the secrets were never set). Nothing else changes.",
		]);
		const one = recorder();
		expect(await pingSafely(TEXT, { kind: "absent", missing: ["TELEGRAM_CHAT_ID"] }, one.report)).toBe("skipped");
		expect(one.printed[0]).toContain("TELEGRAM_CHAT_ID is not set");
		const bad = recorder();
		expect(await pingSafely(TEXT, { kind: "bad-token" }, bad.report)).toBe("failed");
		expect(bad.printed[0]).toStartWith("::warning title=The alarm's Telegram message::The alarm's Telegram message was not sent: TELEGRAM_BOT_TOKEN is not shaped like a bot token.");
	});

	test("a text over Telegram's limit is never sent (by construction there is none)", async () => {
		const { messenger, sent } = fakeMessenger({ kind: "sent" });
		const out = recorder();
		expect(await pingSafely("x".repeat(MAX_MESSAGE_CHARS + 1), { kind: "ready", messenger }, out.report)).toBe("failed");
		expect(sent).toEqual([]);
		expect(out.printed[0]).toContain("over Telegram's limit of 4096 characters");
	});

	test("a report that throws does not make it throw", async () => {
		const { messenger } = fakeMessenger({ kind: "no-answer" });
		const throwing: PingReport = {
			print: () => {
				throw new Error("stdout closed");
			},
			summary: () => {},
		};
		expect(await pingSafely(TEXT, { kind: "ready", messenger }, throwing)).toBe("failed");
	});

	test("the check's child never sees the secrets: they are not in CHILD_ENVIRONMENT, and a child given them in the environment does not get them", async () => {
		for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) expect(CHILD_ENVIRONMENT as readonly string[]).not.toContain(name);
		const keys = join(scratch, "child-env.json");
		const child = join(scratch, "child-env.ts");
		writeFileSync(child, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(keys)}, JSON.stringify(Object.keys(process.env)));\nconsole.log(JSON.stringify({ kind: "empty" }));\n`);
		const outcome = await checkInChild([process.execPath, child], { env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, AWS_ACCESS_KEY_ID: "a" } });
		expect(outcome).toEqual({ result: { kind: "empty" } });
		const seen = JSON.parse(readFileSync(keys, "utf8")) as string[];
		expect(seen.filter((name) => name.startsWith("TELEGRAM"))).toEqual([]);
	});
});

/** A stand-in for GitHub's issues API: the open issue it is given, if any, with no comments; each POST answered in turn from `answers`. */
class FakeGitHub {
	readonly posts: Array<{ path: string; body: string }> = [];
	private readonly server: ReturnType<typeof Bun.serve>;

	constructor(answers: number[], open: { number: number; body: string } | null = null) {
		this.server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const path = new URL(request.url).pathname;
				if (request.method === "GET") return Response.json(path.endsWith("/comments") || open === null ? [] : [open]);
				this.posts.push({ path, body: ((await request.json()) as { body: string }).body });
				const status = answers[this.posts.length - 1] ?? 500;
				return status < 300 ? Response.json({ number: open?.number ?? this.posts.length }, { status }) : new Response("Validation Failed", { status });
			},
		});
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	stop(): void {
		this.server.stop(true);
	}
}

interface ScriptOptions {
	/** Every watched Series of the real schedule stale (it changed long ago, and there are no Runs), or none (it changed just now). */
	stale: boolean;
	github: string;
	/** The stand-in for Telegram; absent, the real address is never used because no secrets are given either. */
	telegram?: string;
	/** Which secrets the step has: both (the default), none, or the token alone. */
	secrets?: "both" | "none" | "token";
	drill?: boolean;
	apiBucket?: string;
	apiEndpoint?: string;
	env?: Record<string, string>;
}

/** The alarm, as the workflow's step runs it, against stand-ins for GitHub and Telegram. */
async function alarmScript(options: ScriptOptions) {
	const directory = mkdtempSync(join(scratch, "script-"));
	const runs = join(directory, "ledgermath-runs");
	mkdirSync(runs);
	const summary = join(directory, "summary.md");
	writeFileSync(summary, "");
	const secrets = options.secrets ?? "both";
	if (options.telegram === undefined && secrets !== "none") throw new Error("a test that gives the secrets gives a stand-in for Telegram too");
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
			options.stale ? SETTLED.toISOString() : NOW,
			"--now",
			NOW,
			"--api-bucket",
			options.apiBucket ?? "",
			...(options.apiEndpoint === undefined ? [] : ["--api-endpoint", options.apiEndpoint]),
			...(options.drill === true ? ["--drill", "yes"] : []),
			...(options.telegram === undefined ? [] : ["--telegram-endpoint", options.telegram]),
		],
		{
			// Built whole, never from process.env: this machine's own Telegram secrets must not reach a test.
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				GITHUB_STEP_SUMMARY: summary,
				GITHUB_API_URL: options.github,
				GITHUB_REPOSITORY: "smrdotgg/ledgermath",
				GITHUB_TOKEN: HOSTILE[0] as string,
				GITHUB_RUN_ID: RUN_ID,
				...(secrets === "none" ? {} : { TELEGRAM_BOT_TOKEN: TOKEN }),
				...(secrets === "both" ? { TELEGRAM_CHAT_ID: CHAT } : {}),
				...options.env,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { exitCode, stdout, stderr, summary: readFileSync(summary, "utf8"), elapsed: performance.now() - started };
}

/** Neither the token, nor its secret half, nor the chat, in anything the alarm printed or wrote to the step summary. */
function expectNoSecrets(done: { stdout: string; stderr: string; summary: string }, label: string): void {
	for (const [where, text] of Object.entries({ stdout: done.stdout, stderr: done.stderr, summary: done.summary })) {
		expect({ label, where, token: text.includes(TOKEN_SECRET), chat: text.includes(CHAT) }).toEqual({ label, where, token: false, chat: false });
	}
}

describe("the script, as the workflow's alarm step runs it: one message for each run that writes on GitHub, none otherwise", () => {
	/** The one message the stand-in received, as text, checking it went to the right chat in plain text. */
	const theMessage = (telegram: TelegramStandin): string => {
		expect(telegram.requests).toHaveLength(1);
		const [request] = telegram.requests;
		expect(request?.path).toBe(`/bot${TOKEN}/sendMessage`);
		expect(Object.keys(request?.fields ?? {}).sort()).toEqual(["chat_id", "text"]);
		expect(request?.fields.chat_id).toBe(CHAT);
		return request?.fields.text ?? "";
	};
	/** An open alarm issue whose last post carries a state no pass here reaches. */
	const OLD_STATE = `${ALARM_MARKER}\nan earlier post\n${STATE_MARKER}${JSON.stringify({ stale_count: 1, stale_hash: "0000000000000000", copy_failed: false })} -->`;

	test("the issue opened: one message, saying so, with the counts, the issue's address and the run's", async () => {
		const github = new FakeGitHub([201]);
		const telegram = new TelegramStandin("ok");
		try {
			const done = await alarmScript({ stale: true, github: github.url, telegram: telegram.url });
			expect(done.exitCode).toBe(0);
			expect(github.posts).toHaveLength(1);
			const text = theMessage(telegram);
			const lines = text.split("\n");
			expect(lines[0]).toBe("LedgerMath alarm: opened issue #1 on GitHub.");
			const stale = stateOf(github.posts[0]?.body ?? "")?.stale_count as number;
			expect(stale).toBeGreaterThan(100);
			expect(lines[1]).toBe(`Now: ${stale} of ${stale} watched Series stale (no Run for 48 hours).`);
			expect(lines.slice(2)).toEqual([`Issue: ${ALARM_ISSUE_URL}1`, `Run: ${RUN_URL}`]);
			expect(done.stdout).toContain("telegram: one message sent");
			expect(done.summary).toContain("Sent: one message");
			expectNoSecrets(done, "opened");
		} finally {
			github.stop();
			telegram.stop();
		}
	});

	test("a comment because something changed: one message, saying so", async () => {
		const github = new FakeGitHub([201], { number: 7, body: OLD_STATE });
		const telegram = new TelegramStandin("ok");
		try {
			const done = await alarmScript({ stale: true, github: github.url, telegram: telegram.url });
			expect(done.exitCode).toBe(0);
			expect(github.posts.map((post) => post.path)).toEqual(["/repos/smrdotgg/ledgermath/issues/7/comments"]);
			const text = theMessage(telegram);
			expect(text.split("\n")[0]).toBe("LedgerMath alarm: commented on issue #7, because what it reports has changed.");
			expect(text).toContain(`Issue: ${ALARM_ISSUE_URL}7`);
		} finally {
			github.stop();
			telegram.stop();
		}
	});

	test("the all-clear comment: one message, saying all is clear", async () => {
		const github = new FakeGitHub([201], { number: 7, body: OLD_STATE });
		const telegram = new TelegramStandin("ok");
		try {
			const done = await alarmScript({ stale: false, github: github.url, telegram: telegram.url });
			expect(done.exitCode).toBe(0);
			expect(github.posts).toHaveLength(1);
			expect(github.posts[0]?.body).toContain("every watched Series has had a Run in the last 48 hours again");
			const text = theMessage(telegram);
			expect(text.split("\n")[0]).toBe("LedgerMath alarm: all clear, said on issue #7. Nothing it watches is stale now.");
		} finally {
			github.stop();
			telegram.stop();
		}
	});

	test("a drill: one message that says it is a drill and that nothing is wrong", async () => {
		const github = new FakeGitHub([201]);
		const telegram = new TelegramStandin("ok");
		try {
			const done = await alarmScript({ stale: false, github: github.url, telegram: telegram.url, drill: true });
			expect(done.exitCode).toBe(0);
			expect(github.posts).toHaveLength(1);
			expect(github.posts[0]?.body).toContain("**This is a drill**");
			const text = theMessage(telegram);
			expect(text).toBe(
				[
					"LedgerMath alarm drill: posted on issue #1, started by hand with alarm_drill. Nothing is wrong because of the drill. This is its Telegram message.",
					`Issue: ${ALARM_ISSUE_URL}1`,
					`Run: ${RUN_URL}`,
				].join("\n"),
			);
		} finally {
			github.stop();
			telegram.stop();
		}
	});

	test("a pass that writes nothing sends nothing: nothing stale, and nothing changed since the last post", async () => {
		const quiet = new FakeGitHub([]);
		const telegram = new TelegramStandin("ok");
		try {
			const done = await alarmScript({ stale: false, github: quiet.url, telegram: telegram.url });
			expect(done.exitCode).toBe(0);
			expect(quiet.posts).toEqual([]);
			expect(telegram.requests).toEqual([]);
			expect(done.stdout).toContain("telegram: the alarm wrote nothing on GitHub, so it sends no message");
			expect(done.summary).not.toContain("Telegram");
			// The issue the first pass opened, read back by the second: nothing changed, no post, no message.
			const first = new FakeGitHub([201]);
			const firstTelegram = new TelegramStandin("ok");
			await alarmScript({ stale: true, github: first.url, telegram: firstTelegram.url });
			first.stop();
			firstTelegram.stop();
			const again = new FakeGitHub([], { number: 1, body: first.posts[0]?.body ?? "" });
			try {
				const unchanged = await alarmScript({ stale: true, github: again.url, telegram: telegram.url });
				expect(unchanged.exitCode).toBe(0);
				expect(unchanged.stdout).toContain("nothing changed since the last post on issue #1");
				expect(again.posts).toEqual([]);
				expect(telegram.requests).toEqual([]);
			} finally {
				again.stop();
			}
		} finally {
			quiet.stop();
			telegram.stop();
		}
	});

	test("GitHub refuses the post (422): the alarm fails as before, and one message says it could not post", async () => {
		const github = new FakeGitHub([422]);
		const telegram = new TelegramStandin("ok");
		try {
			const done = await alarmScript({ stale: true, github: github.url, telegram: telegram.url });
			expect(done.exitCode).toBe(1);
			expect(done.stderr).toContain("422");
			expect(github.posts).toHaveLength(1);
			const text = theMessage(telegram);
			expect(text.split("\n")[0]).toStartWith("LedgerMath alarm: COULD NOT POST ON GITHUB.");
			expect(text).not.toContain("Issue:");
			expect(text).toContain(`Run: ${RUN_URL}`);
			expectNoSecrets(done, "refused");
		} finally {
			github.stop();
			telegram.stop();
		}
	});

	test("GitHub cannot be reached, with Series stale: the alarm fails as before, and one message says it could not post", async () => {
		const telegram = new TelegramStandin("ok");
		try {
			const done = await alarmScript({ stale: true, github: CLOSED, telegram: telegram.url });
			expect(done.exitCode).toBe(1);
			expect(theMessage(telegram).split("\n")[0]).toStartWith("LedgerMath alarm: COULD NOT POST ON GITHUB.");
			// With nothing stale, it cannot tell whether it owed a post: no message, and it fails as before.
			const quiet = new TelegramStandin("ok");
			try {
				const nothing = await alarmScript({ stale: false, github: CLOSED, telegram: quiet.url });
				expect(nothing.exitCode).toBe(1);
				expect(quiet.requests).toEqual([]);
			} finally {
				quiet.stop();
			}
		} finally {
			telegram.stop();
		}
	});

	test("the secrets unset, or one of them: no message, nothing fails, and a notice says why", async () => {
		const telegram = new TelegramStandin("ok");
		try {
			for (const secrets of ["none", "token"] as const) {
				const github = new FakeGitHub([201]);
				try {
					const done = await alarmScript({ stale: true, github: github.url, telegram: telegram.url, secrets });
					expect(done.exitCode).toBe(0);
					expect(github.posts).toHaveLength(1);
					expect(done.stdout).toContain(
						`::notice title=The alarm's Telegram message::No Telegram message: ${secrets === "none" ? "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are" : "TELEGRAM_CHAT_ID is"} not set`,
					);
					expect(done.summary).toContain("No Telegram message");
					expectNoSecrets(done, secrets);
				} finally {
					github.stop();
				}
			}
			expect(telegram.requests).toEqual([]);
		} finally {
			telegram.stop();
		}
	});

	test("nothing S3 or the check said reaches the message, nor the bucket's name: only that publishing is raised", async () => {
		const BUCKET = "ledgermath-production-runs-apibucketbucket-abcdefgh";
		const READER = "AKIAALARMEXAMPLE0000";
		const s3 = new S3Standin();
		s3.start();
		const github = new FakeGitHub([201]);
		const telegram = new TelegramStandin("ok");
		try {
			s3.bucket(BUCKET, { readers: [READER] });
			s3.fault = (request) => (request.method === "GET" ? new Response(`<Error><Code>AccessDenied</Code><Message>${HOSTILE.join(" ")}</Message></Error>`, { status: 403 }) : undefined);
			const done = await alarmScript({
				stale: false,
				github: github.url,
				telegram: telegram.url,
				apiBucket: BUCKET,
				apiEndpoint: s3.url,
				env: { AWS_ACCESS_KEY_ID: READER, AWS_SECRET_ACCESS_KEY: "secret" },
			});
			expect(done.exitCode).toBe(0);
			expect(github.posts[0]?.body).toContain("**The API bucket could not be read**");
			const text = theMessage(telegram);
			expect(text).toContain("the data API not published for 14 hours, or its publishing could not be checked");
			for (const word of [...HOSTILE, BUCKET, "403", "AccessDenied", "s3://"]) expect({ word, inMessage: text.includes(word) }).toEqual({ word, inMessage: false });
		} finally {
			s3.stop();
			github.stop();
			telegram.stop();
		}
	});
});

describe("Telegram down, slow or refusing: the alarm's exit code, posts and marker are those of a run with no Telegram at all, within a bounded time, and the token is never printed", () => {
	const MODES: Array<[string, Mode | "down" | "absent", string | null]> = [
		["no Telegram at all", "absent", null],
		["Telegram down", "down", "Telegram could not be reached"],
		["Telegram that never sends its headers", "stall-headers", "Telegram gave no whole answer within 15 s"],
		["Telegram whose body stalls", "stall-body", "Telegram gave no whole answer within 15 s"],
		["Telegram answering 401", "401", "Telegram answered HTTP 401"],
		["Telegram answering 429", "429", "Telegram answered HTTP 429"],
		["Telegram answering what is not JSON", "malformed", "Telegram's answer was not understood"],
	];

	/** Every mode at once, each against its own stand-ins for GitHub (answering `answers`) and Telegram. */
	async function everyMode(answers: number[]) {
		const runs = MODES.map(async ([label, mode, words]) => {
			const github = new FakeGitHub(answers);
			const telegram = mode === "absent" || mode === "down" ? null : new TelegramStandin(mode);
			try {
				const done = await alarmScript({
					stale: true,
					github: github.url,
					telegram: mode === "down" ? CLOSED : telegram?.url,
					secrets: mode === "absent" ? "none" : "both",
				});
				return { label, mode, words, done, posts: github.posts.map((post) => post.body), received: telegram?.requests.length ?? 0 };
			} finally {
				github.stop();
				telegram?.stop();
			}
		});
		return Promise.all(runs);
	}

	function expectAsWithout(results: Awaited<ReturnType<typeof everyMode>>, exitCode: number): void {
		const [baseline, ...others] = results;
		if (baseline === undefined) throw new Error("no baseline");
		expect(baseline.done.exitCode).toBe(exitCode);
		expect(baseline.posts).toHaveLength(1);
		for (const result of others) {
			expect({ label: result.label, exitCode: result.done.exitCode }).toEqual({ label: result.label, exitCode });
			expect({ label: result.label, posts: result.posts }).toEqual({ label: result.label, posts: baseline.posts });
			expect({ label: result.label, marker: stateOf(result.posts.at(-1) ?? "") }).toEqual({ label: result.label, marker: stateOf(baseline.posts.at(-1) ?? "") });
			// Sent once, never tried again.
			if (result.mode !== "down") expect({ label: result.label, received: result.received }).toEqual({ label: result.label, received: 1 });
			expect(result.done.stdout).toContain(`::warning title=The alarm's Telegram message::The alarm's Telegram message was not sent: ${result.words}. Nothing else changes.`);
			expect(result.done.summary).toContain(`The alarm's Telegram message was not sent: ${result.words}.`);
			// Bounded: the message's 15 seconds and a second, the summary's two, and room for a loaded machine.
			expect({ label: result.label, bounded: result.done.elapsed < PING_BUDGET_MS + 10_000 }).toEqual({ label: result.label, bounded: true });
			if (result.mode === "stall-headers" || result.mode === "stall-body") expect(result.done.elapsed).toBeGreaterThan(SEND_BUDGET_MS - 1_000);
			// Nothing of Telegram's answer in the log or the summary.
			for (const word of HOSTILE.slice(1)) expect({ label: result.label, said: `${result.done.stdout}${result.done.stderr}${result.done.summary}`.includes(word) }).toEqual({ label: result.label, said: false });
		}
		for (const result of results) expectNoSecrets(result.done, result.label);
	}

	test("the issue opened: exit 0 every time", async () => {
		expectAsWithout(await everyMode([201]), 0);
	});

	test("GitHub refusing the post: exit 1 every time, and the same one attempt", async () => {
		expectAsWithout(await everyMode([422]), 1);
	});
});
