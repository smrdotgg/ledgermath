/**
 * The newest rounds of boots in the table of contents (v1/index.json's
 * recent_rounds; ADR-0030, rule 12): what a round is, worked out from the
 * boot summaries alone, what each figure counts, and that the check holds the
 * field to the checkout and the Derivations, independently of the build.
 *
 * The fixture is a Runs repository checkout of six rounds on 2026-11-20 and
 * 21, each boot with its summary and a syscall Run, on the five instance
 * types the schedule boots ten minutes apart. Nothing in it was measured.
 *
 * - 04:11, a full round: five boots.
 * - 10:11, a round missing c8i.2xlarge (refused for capacity: no boot), whose
 *   c8a.2xlarge boot started 8.5 minutes late: 27.6 minutes after the boot
 *   before it, still the same round.
 * - 13:44, a boot of m5.large started by hand between two rounds: a round of
 *   its own.
 * - 16:11, a round whose c8i.2xlarge boot started 8.5 minutes late; its
 *   m5.large boot also left a Run that crashed (failed), a build that failed
 *   and a parameter set not run.
 * - 22:11, three boots before midnight UTC; its c6i.8xlarge boot also left two
 *   Runs of a Series of requests: one that exited 4, a request having failed
 *   (Method requests v1 counts it, Method series v1 does not), and one that
 *   exited 1 (neither counts it).
 * - 23:55, three boots on either side of midnight UTC (their summaries under
 *   two days), 64 minutes after the round before: one round; its c8i.2xlarge
 *   boot's summary also lists a Run whose Run file is not in the checkout.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as requestsMethod from "../methods/requests/v1";
import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { Run } from "../methods/run";
import * as seriesMethod from "../methods/v1";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import { type ApiSources, type BootFile, buildApi, DEFAULT_BASE, INDEX_PATH, LAYOUT, RECENT_ROUNDS, ROUND_GAP_MINUTES, readApiSchemas, readBootFiles, readBootSummaries, readPriceFiles, seriesPath, writerForm } from "../scripts/lib/api";
import { checkApi } from "../scripts/lib/api-check";
import { HandMade, rampRequests, requestRun } from "./hand-made-requests";
import { bootSummaryPath, bootSummaryText, type HandMadeBoot } from "./hand-made-runs";

setDefaultTimeout(120_000);

type Json = Record<string, any>;

const C6I = "c6i.8xlarge";
const M5 = "m5.large";
const C8I = "c8i.2xlarge";
const C8A = "c8a.2xlarge";
const I4I = "i4i.2xlarge";

interface RoundsFixture {
	/** The checkout: runs/ and boots/. */
	runs: string;
	series: SeriesFile;
	requests: RequestsFile;
	boots: HandMadeBoot[];
	/** The Series of requests, and the ids of its Run that exited 4 and its Run that exited 1. */
	http: string;
	exitedFour: string;
	exitedOne: string;
	/** The Run the 23:55 round's c8i.2xlarge boot lists that has no Run file. */
	missing: string;
}

/** The whole second of a boot's start, plus `minutes`, as a hand-made Run's start. */
const after = (startedAt: string, minutes: number): string => new Date(Date.parse(`${startedAt.slice(0, 19)}Z`) + minutes * 60_000).toISOString().replace(".000Z", "Z");

async function makeRoundsFixture(): Promise<RoundsFixture> {
	const made = new HandMade();
	const boots: HandMadeBoot[] = [];
	const syscall = (boot: string, type: string, startedAt: string): Run =>
		made.run({ startedAt: after(startedAt, 1), benchmark: "syscall", binary: "syscall", params: { call: "getpid" }, samplesNs: [94, 95, 96], bytesPerRepetition: null, instanceType: type, boot });
	const add = (boot: string, type: string, startedAt: string, more: Partial<HandMadeBoot> = {}, extra: Run[] = []): void => {
		boots.push({ boot, startedAt, endedAt: after(startedAt, 13).replace("Z", ".000000000Z"), instanceType: type, ...more, runs: [syscall(boot, type, startedAt), ...extra] });
	};

	add("full-c6i", C6I, "2026-11-20T04:11:43.100000001Z");
	add("full-m5", M5, "2026-11-20T04:21:53.200000002Z");
	add("full-c8i", C8I, "2026-11-20T04:31:52.300000003Z");
	add("full-c8a", C8A, "2026-11-20T04:41:51.400000004Z");
	add("full-i4i", I4I, "2026-11-20T04:51:50.500000005Z");

	add("gap-c6i", C6I, "2026-11-20T10:11:43.000000000Z");
	add("gap-m5", M5, "2026-11-20T10:21:53.000000000Z");
	add("gap-c8a", C8A, "2026-11-20T10:49:30.000000000Z");
	add("gap-i4i", I4I, "2026-11-20T10:51:50.000000000Z");

	add("hand-m5", M5, "2026-11-20T13:44:05.000000000Z");

	const crashed = (boot: string, startedAt: string): Run => made.run({ startedAt: after(startedAt, 2), instanceType: M5, boot, samplesNs: [7e6, 7e6, 7e6], crashAfter: 1 });
	add("late-c6i", C6I, "2026-11-20T16:11:43.000000000Z");
	add(
		"late-m5",
		M5,
		"2026-11-20T16:21:53.000000000Z",
		{ buildFailures: [{ benchmark: "memory_write", build: "static" }], notRun: [{ benchmark: "memory_copy", build: "static", params: { size_bytes: 4096 } }] },
		[crashed("late-m5", "2026-11-20T16:21:53.000000000Z")],
	);
	add("late-c8i", C8I, "2026-11-20T16:39:30.000000000Z");
	add("late-c8a", C8A, "2026-11-20T16:41:51.000000000Z");
	add("late-i4i", I4I, "2026-11-20T16:51:50.000000000Z");

	const evening = "2026-11-20T22:11:44.000000000Z";
	const four = requestRun(made, {
		startedAt: after(evening, 2),
		boot: "evening-c6i",
		exit: { code: 4 },
		stream: { connection: "new", requests: [...rampRequests(3, 21_000_000, 40_000), { fail: { phase: "first_byte", error: "timeout" } }] },
	});
	const one = requestRun(made, {
		startedAt: after(evening, 3),
		boot: "evening-c6i",
		exit: { code: 1 },
		stream: { connection: "new", requests: [...rampRequests(3, 21_000_000, 40_000), { fail: { phase: "first_byte", error: "timeout" } }] },
	});
	add("evening-c6i", C6I, evening, {}, [four, one]);
	add("evening-m5", M5, "2026-11-20T22:21:53.000000000Z");
	add("evening-c8i", C8I, "2026-11-20T22:31:52.000000000Z");

	const missing = "019aa3c0-0000-7000-8000-000000000001";
	const noFile = { id: missing, benchmark: "syscall", params: { call: "getpid" }, binary: { build: "static" }, exit: { code: 0 } } as unknown as Run;
	add("midnight-c6i", C6I, "2026-11-20T23:55:00.500000000Z");
	add("midnight-m5", M5, "2026-11-21T00:05:10.000000000Z");
	add("midnight-c8i", C8I, "2026-11-21T00:15:20.000000000Z");
	(boots[boots.length - 1] as HandMadeBoot).runs.push(noFile);

	const files = [...made.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const series = seriesMethod.derive(files, await seriesMethod.gather(files, made.fetch));
	const requests = requestsMethod.derive(files, await requestsMethod.gather(files, made.fetch));
	const runs = mkdtempSync(join(tmpdir(), "api-rounds-runs-"));
	const put = (path: string, text: string): void => {
		mkdirSync(dirname(join(runs, path)), { recursive: true });
		writeFileSync(join(runs, path), text);
	};
	for (const file of made.files) put(file.path, `${JSON.stringify(file.record, null, 2)}\n`);
	for (const boot of boots) put(bootSummaryPath(boot), bootSummaryText(boot));
	const http = (series.derivations.find((d) => d.series.benchmark === "http_get") as SeriesFile["derivations"][number]).series.id;
	return {
		runs,
		series: JSON.parse(seriesMethod.serialize(series)) as SeriesFile,
		requests: JSON.parse(requestsMethod.serialize(requests)) as RequestsFile,
		boots,
		http,
		exitedFour: four.id,
		exitedOne: one.id,
		missing,
	};
}

function sourcesOf(fixture: { runs: string; series: SeriesFile; requests: RequestsFile }, bootFiles?: BootFile[]): ApiSources {
	return {
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: structuredClone(fixture.series),
		requests: structuredClone(fixture.requests),
		prices: readPriceFiles(fixture.runs),
		boots: readBootSummaries(fixture.runs),
		bootFiles: bootFiles ?? readBootFiles(fixture.runs),
		schemas: readApiSchemas(),
	};
}

function writeTree(tree: Map<string, Uint8Array>): string {
	const directory = mkdtempSync(join(tmpdir(), "api-rounds-tree-"));
	for (const [path, bytes] of tree) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), bytes);
	}
	return directory;
}

const json = (tree: Map<string, Uint8Array>, path: string): Json => JSON.parse(new TextDecoder().decode(tree.get(path)));
const address = (path: string): string => `${DEFAULT_BASE}/${path}`;

/** A boot of the fixture as recent_rounds gives it, its figures stated by hand. */
function byBoot(fixture: RoundsFixture, boot: string, figures: { runs?: number; failed_runs?: number; runs_in_no_series?: number; build_failures?: number; not_run?: number } = {}): Json {
	const made = fixture.boots.find((one) => one.boot === boot) as HandMadeBoot;
	return {
		boot_summary: address(bootSummaryPath(made)),
		instance_type: made.instanceType,
		started_at: made.startedAt,
		runs: figures.runs ?? 1,
		failed_runs: figures.failed_runs ?? 0,
		runs_in_no_series: figures.runs_in_no_series ?? 0,
		build_failures: figures.build_failures ?? 0,
		not_run: figures.not_run ?? 0,
	};
}

/** A round of the fixture: its boots summed, as recent_rounds gives it. */
function round(boots: Json[]): Json {
	const sum = (key: string): number => boots.reduce((total, boot) => total + (boot[key] as number), 0);
	return {
		started_at: (boots[0] as Json).started_at,
		boots: boots.length,
		runs: sum("runs"),
		failed_runs: sum("failed_runs"),
		runs_in_no_series: sum("runs_in_no_series"),
		build_failures: sum("build_failures"),
		not_run: sum("not_run"),
		instance_types: boots.map((boot) => boot.instance_type),
		by_boot: boots,
	};
}

/** A boot summary's bytes, made by hand: no Runs, at a start. */
function emptyBoot(boot: string, startedAt: string): BootFile {
	const made: HandMadeBoot = { boot, startedAt, runs: [] };
	return { path: bootSummaryPath(made), bytes: new TextEncoder().encode(bootSummaryText(made)) };
}

let fixture: RoundsFixture;
let tree: Map<string, Uint8Array>;
let directory: string;

beforeAll(async () => {
	fixture = await makeRoundsFixture();
	tree = buildApi(sourcesOf(fixture));
	directory = writeTree(tree);
});

describe("the newest rounds of boots", () => {
	test("are the fixture's six rounds, newest first, each with its boots in order of start and every figure as the summaries and the points make it", () => {
		const f = fixture;
		expect(json(tree, INDEX_PATH).recent_rounds.rounds).toEqual([
			round([byBoot(f, "midnight-c6i"), byBoot(f, "midnight-m5"), byBoot(f, "midnight-c8i", { runs: 2, runs_in_no_series: 1 })]),
			round([byBoot(f, "evening-c6i", { runs: 3, failed_runs: 1 }), byBoot(f, "evening-m5"), byBoot(f, "evening-c8i")]),
			round([byBoot(f, "late-c6i"), byBoot(f, "late-m5", { runs: 2, failed_runs: 1, build_failures: 1, not_run: 1 }), byBoot(f, "late-c8i"), byBoot(f, "late-c8a"), byBoot(f, "late-i4i")]),
			round([byBoot(f, "hand-m5")]),
			round([byBoot(f, "gap-c6i"), byBoot(f, "gap-m5"), byBoot(f, "gap-c8a"), byBoot(f, "gap-i4i")]),
			round([byBoot(f, "full-c6i"), byBoot(f, "full-m5"), byBoot(f, "full-c8i"), byBoot(f, "full-c8a"), byBoot(f, "full-i4i")]),
		]);
		const [midnight, , late, , gap, full] = json(tree, INDEX_PATH).recent_rounds.rounds as [Json, Json, Json, Json, Json, Json];
		expect([full.boots, full.instance_types]).toEqual([5, [C6I, M5, C8I, C8A, I4I]]);
		// A machine type refused a boot leaves a round of four, its next boot 27.6 minutes after the one before.
		expect([gap.boots, gap.instance_types]).toEqual([4, [C6I, M5, C8A, I4I]]);
		// A boot started 8.5 minutes late stays in its round.
		expect(late.instance_types).toEqual([C6I, M5, C8I, C8A, I4I]);
		// A round on both sides of midnight UTC is one round, its summaries under two days.
		expect(midnight.by_boot.map((boot: Json) => boot.boot_summary.split("/").slice(-4, -1).join("/"))).toEqual(["2026/11/20", "2026/11/21", "2026/11/21"]);
		expect(json(tree, INDEX_PATH).layout).toBe(LAYOUT);
	});

	test("count a Run of a Series of requests that exited 4 as not failed, as requests v1 and the Series' file do, and one that exited 1 as failed", () => {
		const file = json(tree, seriesPath(fixture.http));
		// Method series v1 counts neither; Method requests v1, whose figures a Series of requests is for, counts the Run that exited 4.
		expect([file.derivations.series_v1.failed_runs, file.derivations.requests_v1.failed_runs]).toEqual([2, 1]);
		const verdicts = (key: string) => Object.fromEntries((file.derivations[key].newest_points as Json[]).map((point) => [point.run, point.counted]));
		expect(verdicts("series_v1")).toEqual({ [fixture.exitedFour]: false, [fixture.exitedOne]: false });
		expect(verdicts("requests_v1")).toEqual({ [fixture.exitedFour]: true, [fixture.exitedOne]: false });
		const evening = (json(tree, INDEX_PATH).recent_rounds.rounds as Json[])[1] as Json;
		expect([evening.by_boot[0].instance_type, evening.by_boot[0].runs, evening.by_boot[0].failed_runs]).toEqual([C6I, 3, 1]);
	});

	test("say in words what a round is, by the rule and the count the build uses", () => {
		const about = json(tree, INDEX_PATH).recent_rounds.about as string;
		expect(about).toContain(`a boot starting a new round when it started more than ${ROUND_GAP_MINUTES} minutes after the boot before it`);
		expect(about).toContain(`the newest ${RECENT_ROUNDS}, newest first`);
		expect(about).toContain("exited 4");
		expect([ROUND_GAP_MINUTES, RECENT_ROUNDS]).toEqual([40, 8]);
	});

	test("measure the gap from the boot before, to the nanosecond: exactly 40 minutes is the same round, a nanosecond more is a new one", () => {
		const boots = [
			emptyBoot("a", "2026-11-25T04:11:00.000000000Z"),
			emptyBoot("b", "2026-11-25T04:51:00.000000000Z"),
			emptyBoot("c", "2026-11-25T05:31:00.000000000Z"),
			emptyBoot("d", "2026-11-25T06:11:00.000000001Z"),
		];
		const rounds = json(buildApi(sourcesOf(fixture, [...readBootFiles(fixture.runs), ...boots])), INDEX_PATH).recent_rounds.rounds as Json[];
		// a, b and c chain at 40 minutes each, 80 minutes from a to c: a round is measured boot to boot, not from its first boot.
		expect(rounds.slice(0, 2).map((one) => [one.started_at, one.boots])).toEqual([
			["2026-11-25T06:11:00.000000001Z", 1],
			["2026-11-25T04:11:00.000000000Z", 3],
		]);
	});

	test("hold the newest 8 rounds only, newest first", () => {
		const later = Array.from({ length: 10 }, (_, i) => emptyBoot(`later-${i}`, `2026-11-${String(22 + Math.floor(i / 4)).padStart(2, "0")}T${String(4 + (i % 4) * 6).padStart(2, "0")}:11:00.000000000Z`));
		const rounds = json(buildApi(sourcesOf(fixture, [...readBootFiles(fixture.runs), ...later])), INDEX_PATH).recent_rounds.rounds as Json[];
		expect(rounds.map((one) => one.started_at)).toEqual(
			later
				.slice(2)
				.reverse()
				.map((file) => JSON.parse(new TextDecoder().decode(file.bytes)).started_at),
		);
	});

	test("are the same bytes from the same data in any order", () => {
		const files = readBootFiles(fixture.runs);
		const sources = sourcesOf(fixture, [...files].reverse());
		sources.series.derivations.reverse();
		sources.requests.derivations.reverse();
		const shuffled = [...files.filter((_, i) => i % 2 === 1), ...files.filter((_, i) => i % 2 === 0)];
		for (const again of [buildApi(sources), buildApi(sourcesOf(fixture, shuffled))]) {
			expect(new TextDecoder().decode(again.get(INDEX_PATH))).toBe(new TextDecoder().decode(tree.get(INDEX_PATH)));
		}
	});

	test("are empty with no boot summary", () => {
		expect(json(buildApi(sourcesOf(fixture, [])), INDEX_PATH).recent_rounds.rounds).toEqual([]);
	});

	test("refuse boot summaries the rounds cannot be told from: one without a start, a Run listed twice, a Run of another boot", () => {
		const files = readBootFiles(fixture.runs);
		const edited = (path: string, change: (summary: Json) => void): BootFile[] =>
			files.map((file) => {
				if (file.path !== path) return file;
				const summary = JSON.parse(new TextDecoder().decode(file.bytes));
				change(summary);
				return { path, bytes: new TextEncoder().encode(JSON.stringify(summary)) };
			});
		const hand = bootSummaryPath(fixture.boots.find((boot) => boot.boot === "hand-m5") as HandMadeBoot);
		const evening = fixture.boots.find((boot) => boot.boot === "evening-m5") as HandMadeBoot;
		expect(() => buildApi(sourcesOf(fixture, edited(hand, (summary) => delete summary.started_at)))).toThrow(`the boot summary ${hand} gives no start`);
		expect(() => buildApi(sourcesOf(fixture, edited(hand, (summary) => summary.runs.push({ id: (evening.runs[0] as Run).id }))))).toThrow(`is listed by two boot summaries`);
		const other = edited(hand, (summary) => {
			summary.runs = [{ id: (evening.runs[0] as Run).id }];
		});
		expect(() => buildApi(sourcesOf(fixture, other.filter((file) => file.path !== bootSummaryPath(evening))))).toThrow(`lists Run ${(evening.runs[0] as Run).id}, whose point in series v1's Derivations is of boot evening-m5, not hand-m5`);
	});
});

describe("the check of the newest rounds of boots", () => {
	/** The six rounds as the tree holds them, to be changed. */
	type Rounds = [Json, Json, Json, Json, Json, Json];
	const checkWith = (change: (rounds: Rounds) => void): string[] => {
		const copy = writeTree(tree);
		const index = json(tree, INDEX_PATH);
		change(index.recent_rounds.rounds);
		writeFileSync(join(copy, INDEX_PATH), writerForm(INDEX_PATH, index));
		return checkApi({ tree: copy, runs: fixture.runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems;
	};

	test("passes the tree as built", () => {
		expect(checkApi({ tree: directory, runs: fixture.runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems).toEqual([]);
	});

	test("catches a wrong count, a missing boot and a boot in the wrong round", () => {
		const against = "as the boot summaries of the checkout and the Derivations make it";
		expect(
			checkWith((rounds) => {
				rounds[2].by_boot[1].failed_runs = 0;
				rounds[2].failed_runs = 0;
			}),
		).toEqual([`v1/index.json: /recent_rounds/rounds/2/failed_runs is 0, not 1, ${against}`]);
		expect(
			checkWith((rounds) => {
				const [gone] = rounds[4].by_boot.splice(2, 1);
				rounds[4].boots = 3;
				rounds[4].runs -= gone.runs;
				rounds[4].instance_types.splice(2, 1);
			}),
		).toEqual([`v1/index.json: /recent_rounds/rounds/4/boots is 3, not 4, ${against}`]);
		// The boot by hand, put in the round before it: the same boots and figures in all, in other rounds.
		expect(
			checkWith((rounds) => {
				const [hand] = rounds.splice(3, 1) as [Json];
				const before = rounds[3];
				before.by_boot.push(...hand.by_boot);
				before.instance_types.push(...hand.instance_types);
				before.boots += 1;
				before.runs += 1;
			}),
		).toEqual([`v1/index.json: /recent_rounds/rounds/3/started_at is "2026-11-20T10:11:43.000000000Z", not "2026-11-20T13:44:05.000000000Z", ${against}`]);
		// A boot's own summary named wrongly: a link the checkout does not hold, and a value the summaries do not make.
		const elsewhere = checkWith((rounds) => {
			rounds[0].by_boot[0].boot_summary = address("boots/2026/11/20/nowhere.json");
		});
		expect(elsewhere).toEqual([
			`v1/index.json: /recent_rounds/rounds/0/by_boot/0/boot_summary is "${address("boots/2026/11/20/nowhere.json")}", not "${address("boots/2026/11/20/midnight-c6i.json")}", ${against}`,
			`v1/index.json links ${address("boots/2026/11/20/nowhere.json")}, which is not a file of the Runs repository checkout ${fixture.runs}`,
		]);
	});

	test("catches a checkout whose summaries do not hold together, or that a round cannot be told from", () => {
		const runs = mkdtempSync(join(tmpdir(), "api-rounds-broken-"));
		const copy = (path: string): void => {
			mkdirSync(dirname(join(runs, path)), { recursive: true });
			writeFileSync(join(runs, path), readFileSync(join(fixture.runs, path)));
		};
		for (const file of readBootFiles(fixture.runs)) copy(file.path);
		for (const derivation of fixture.series.derivations) for (const run of derivation.runs) copy(run.path);
		const hand = bootSummaryPath(fixture.boots.find((boot) => boot.boot === "hand-m5") as HandMadeBoot);
		const evening = fixture.boots.find((boot) => boot.boot === "evening-m5") as HandMadeBoot;
		const summary = JSON.parse(readFileSync(join(runs, hand), "utf8"));
		summary.runs.push({ id: (evening.runs[0] as Run).id });
		writeFileSync(join(runs, hand), JSON.stringify(summary));
		const problems = checkApi({ tree: directory, runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems;
		expect(problems).toContain(`Run ${(evening.runs[0] as Run).id} is listed by two boot summaries of the checkout: ${bootSummaryPath(evening)} and ${hand}`);
		expect(problems).toContain(`the boot summary ${hand} lists Run ${(evening.runs[0] as Run).id}, whose point is of boot evening-m5, not hand-m5`);
		expect(problems).toContain(`v1/index.json: /recent_rounds/rounds/3/runs is 1, not 2, as the boot summaries of the checkout and the Derivations make it`);
		// A summary that cannot be read: the rounds cannot be told, so they are not compared, and the check says why.
		writeFileSync(join(runs, hand), "{");
		const unreadable = checkApi({ tree: directory, runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems;
		expect(unreadable).toContainEqual(expect.stringContaining(`the boot summary ${hand} in the checkout ${runs} is not strict JSON`));
		expect(unreadable.filter((problem) => problem.includes("recent_rounds"))).toEqual([]);
	});
});
