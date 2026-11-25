/**
 * The newest rounds of boots in the table of contents (v1/index.json's
 * recent_rounds; ADR-0030, rule 12): what a round is, worked out from the
 * boot summaries alone, what each figure counts, which summaries are left out
 * and why (none stops the build), and that the check holds the field to the
 * checkout and the Derivations, independently of the build.
 *
 * The fixture is a Runs repository checkout of six rounds on 2026-11-20 and
 * 21, each boot with its summary (named, as a box names it, by a UUID: the
 * kernel's boot id) and a syscall Run, on the five instance types the
 * schedule boots ten minutes apart. Nothing in it was measured.
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
 * - 02:31 on 2026-11-21, a boot whose id could not be read: its Run's boot is
 *   empty and its summary is boots/2026/11/21/unknown.json, as the runner
 *   writes them. The API does not serve that address, so the summary is in no
 *   round, and no point links it.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { isServedKey } from "../infra/runs/public-blobs";
import * as requestsMethod from "../methods/requests/v1";
import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { Run } from "../methods/run";
import * as seriesMethod from "../methods/v1";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import {
	type ApiSources,
	type BootFile,
	buildApi,
	DEFAULT_BASE,
	INDEX_PATH,
	LAYOUT,
	LEFT_OUT_LISTED,
	LEFT_OUT_WHY,
	RECENT_ROUNDS,
	ROUND_GAP_MINUTES,
	ROUND_RULE,
	readApiSchemas,
	readBootFiles,
	readBootSummaries,
	readPriceFiles,
	seriesPath,
	writerForm,
} from "../scripts/lib/api";
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

/** A boot's id as a box gives it, the kernel's boot id, a UUID in lowercase hex: here made from a name, so a test can name its boots. */
function idOf(name: string): string {
	const hex = createHash("sha256").update(`boot ${name}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The summary of the fixture's boot whose id could not be read, where the runner writes it. */
const UNKNOWN = "boots/2026/11/21/unknown.json";

interface RoundsFixture {
	/** The checkout: runs/ and boots/. */
	runs: string;
	series: SeriesFile;
	requests: RequestsFile;
	/** Each boot of a round, by the name the test gives it. */
	boots: Record<string, HandMadeBoot>;
	/** The Series of requests, and the ids of its Run that exited 4 and its Run that exited 1. */
	http: string;
	exitedFour: string;
	exitedOne: string;
	/** The Run the 23:55 round's c8i.2xlarge boot lists that has no Run file. */
	missing: string;
	/** The Run of the boot whose id could not be read. */
	unknownRun: string;
}

/** The whole second of a boot's start, plus `minutes`, as a hand-made Run's start. */
const after = (startedAt: string, minutes: number): string => new Date(Date.parse(`${startedAt.slice(0, 19)}Z`) + minutes * 60_000).toISOString().replace(".000Z", "Z");

async function makeRoundsFixture(): Promise<RoundsFixture> {
	const made = new HandMade();
	const boots: Record<string, HandMadeBoot> = {};
	const syscall = (boot: string, type: string, startedAt: string): Run =>
		made.run({ startedAt: after(startedAt, 1), benchmark: "syscall", binary: "syscall", params: { call: "getpid" }, samplesNs: [94, 95, 96], bytesPerRepetition: null, instanceType: type, boot });
	const add = (name: string, type: string, startedAt: string, more: Partial<HandMadeBoot> = {}, extra: Run[] = []): void => {
		const boot = idOf(name);
		boots[name] = { boot, startedAt, endedAt: after(startedAt, 13).replace("Z", ".000000000Z"), instanceType: type, ...more, runs: [syscall(boot, type, startedAt), ...extra] };
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

	const lateM5 = "2026-11-20T16:21:53.000000000Z";
	add("late-c6i", C6I, "2026-11-20T16:11:43.000000000Z");
	add(
		"late-m5",
		M5,
		lateM5,
		{ buildFailures: [{ benchmark: "memory_write", build: "static" }], notRun: [{ benchmark: "memory_copy", build: "static", params: { size_bytes: 4096 } }] },
		[made.run({ startedAt: after(lateM5, 2), instanceType: M5, boot: idOf("late-m5"), samplesNs: [7e6, 7e6, 7e6], crashAfter: 1 })],
	);
	add("late-c8i", C8I, "2026-11-20T16:39:30.000000000Z");
	add("late-c8a", C8A, "2026-11-20T16:41:51.000000000Z");
	add("late-i4i", I4I, "2026-11-20T16:51:50.000000000Z");

	const evening = "2026-11-20T22:11:44.000000000Z";
	const failedRequest = { connection: "new" as const, requests: [...rampRequests(3, 21_000_000, 40_000), { fail: { phase: "first_byte" as const, error: "timeout" } }] };
	const four = requestRun(made, { startedAt: after(evening, 2), boot: idOf("evening-c6i"), exit: { code: 4 }, stream: failedRequest });
	const one = requestRun(made, { startedAt: after(evening, 3), boot: idOf("evening-c6i"), exit: { code: 1 }, stream: failedRequest });
	add("evening-c6i", C6I, evening, {}, [four, one]);
	add("evening-m5", M5, "2026-11-20T22:21:53.000000000Z");
	add("evening-c8i", C8I, "2026-11-20T22:31:52.000000000Z");

	const missing = "019aa3c0-0000-7000-8000-000000000001";
	const noFile = { id: missing, benchmark: "syscall", params: { call: "getpid" }, binary: { build: "static" }, exit: { code: 0 } } as unknown as Run;
	add("midnight-c6i", C6I, "2026-11-20T23:55:00.500000000Z");
	add("midnight-m5", M5, "2026-11-21T00:05:10.000000000Z");
	add("midnight-c8i", C8I, "2026-11-21T00:15:20.000000000Z", {}, [noFile]);

	// A boot whose id could not be read: the runner writes its Runs with an empty boot and its summary as unknown.json.
	const unknownAt = "2026-11-21T02:31:00.000000000Z";
	const unknownRun = syscall("", M5, unknownAt);

	const files = [...made.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const series = seriesMethod.derive(files, await seriesMethod.gather(files, made.fetch));
	const requests = requestsMethod.derive(files, await requestsMethod.gather(files, made.fetch));
	const runs = mkdtempSync(join(tmpdir(), "api-rounds-runs-"));
	const put = (path: string, text: string): void => {
		mkdirSync(dirname(join(runs, path)), { recursive: true });
		writeFileSync(join(runs, path), text);
	};
	for (const file of made.files) put(file.path, `${JSON.stringify(file.record, null, 2)}\n`);
	for (const boot of Object.values(boots)) put(bootSummaryPath(boot), bootSummaryText(boot));
	put(UNKNOWN, bootSummaryText({ boot: "", startedAt: unknownAt, instanceType: M5, runs: [unknownRun] }));
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
		unknownRun: unknownRun.id,
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
const recent = (tree: Map<string, Uint8Array>): Json => json(tree, INDEX_PATH).recent_rounds;

/** A boot of the fixture as recent_rounds gives it, its figures stated by hand. */
function byBoot(fixture: RoundsFixture, name: string, figures: { runs?: number; failed_runs?: number; runs_in_no_series?: number; build_failures?: number; not_run?: number } = {}): Json {
	const made = fixture.boots[name] as HandMadeBoot;
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

/** A boot summary's bytes as a box writes it, for a boot of no Run, named after `name`, at a start. */
function emptyBoot(name: string, startedAt: string): BootFile {
	const made: HandMadeBoot = { boot: idOf(name), startedAt, runs: [] };
	return { path: bootSummaryPath(made), bytes: new TextEncoder().encode(bootSummaryText(made)) };
}

/** A boot summary's file with whatever bytes. */
const fileOf = (path: string, text: string): BootFile => ({ path, bytes: new TextEncoder().encode(text) });

/** A summary of no Run, as JSON, for a boot named after `name`, with `change` made to it. */
function changed(name: string, startedAt: string, change: (summary: Json) => void): string {
	const summary = JSON.parse(bootSummaryText({ boot: idOf(name), startedAt, runs: [] }));
	change(summary);
	return JSON.stringify(summary);
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
		expect(recent(tree).rounds).toEqual([
			round([byBoot(f, "midnight-c6i"), byBoot(f, "midnight-m5"), byBoot(f, "midnight-c8i", { runs: 2, runs_in_no_series: 1 })]),
			round([byBoot(f, "evening-c6i", { runs: 3, failed_runs: 1 }), byBoot(f, "evening-m5"), byBoot(f, "evening-c8i")]),
			round([byBoot(f, "late-c6i"), byBoot(f, "late-m5", { runs: 2, failed_runs: 1, build_failures: 1, not_run: 1 }), byBoot(f, "late-c8i"), byBoot(f, "late-c8a"), byBoot(f, "late-i4i")]),
			round([byBoot(f, "hand-m5")]),
			round([byBoot(f, "gap-c6i"), byBoot(f, "gap-m5"), byBoot(f, "gap-c8a"), byBoot(f, "gap-i4i")]),
			round([byBoot(f, "full-c6i"), byBoot(f, "full-m5"), byBoot(f, "full-c8i"), byBoot(f, "full-c8a"), byBoot(f, "full-i4i")]),
		]);
		const [midnight, , late, , gap, full] = recent(tree).rounds as [Json, Json, Json, Json, Json, Json];
		expect([full.boots, full.instance_types]).toEqual([5, [C6I, M5, C8I, C8A, I4I]]);
		// A machine type refused a boot leaves a round of four, its next boot 27.6 minutes after the one before.
		expect([gap.boots, gap.instance_types]).toEqual([4, [C6I, M5, C8A, I4I]]);
		// A boot started 8.5 minutes late stays in its round.
		expect(late.instance_types).toEqual([C6I, M5, C8I, C8A, I4I]);
		// A round on both sides of midnight UTC is one round, its summaries under two days.
		expect(midnight.by_boot.map((boot: Json) => boot.boot_summary.split("/").slice(-4, -1).join("/"))).toEqual(["2026/11/20", "2026/11/21", "2026/11/21"]);
		// The boot whose id could not be read is in no round: the API does not serve unknown.json.
		expect(recent(tree).left_out).toEqual({ count: 1, summaries: [{ path: UNKNOWN, boot_summary: null, why: LEFT_OUT_WHY.address }] });
		expect(json(tree, INDEX_PATH).layout).toBe(LAYOUT);
	});

	test("count a Run of a Series of requests that exited 4 as not failed, as requests v1 and the Series' file do, and one that exited 1 as failed", () => {
		const file = json(tree, seriesPath(fixture.http));
		// Method series v1 counts neither; Method requests v1, whose figures a Series of requests is for, counts the Run that exited 4.
		expect([file.derivations.series_v1.failed_runs, file.derivations.requests_v1.failed_runs]).toEqual([2, 1]);
		const verdicts = (key: string) => Object.fromEntries((file.derivations[key].newest_points as Json[]).map((point) => [point.run, point.counted]));
		expect(verdicts("series_v1")).toEqual({ [fixture.exitedFour]: false, [fixture.exitedOne]: false });
		expect(verdicts("requests_v1")).toEqual({ [fixture.exitedFour]: true, [fixture.exitedOne]: false });
		const evening = (recent(tree).rounds as Json[])[1] as Json;
		expect([evening.by_boot[0].instance_type, evening.by_boot[0].runs, evening.by_boot[0].failed_runs]).toEqual([C6I, 3, 1]);
	});

	test("say in words what a round is, beginning with the rule and the count the build uses, and that any round shown may change", () => {
		const about = recent(tree).about as string;
		expect(about.startsWith(`${ROUND_RULE} `)).toBe(true);
		expect(ROUND_RULE).toContain(`a boot starting a new round when it started more than ${ROUND_GAP_MINUTES} minutes after the boot before it.`);
		expect(ROUND_RULE).toContain(`rounds holds the newest ${RECENT_ROUNDS} rounds, newest first.`);
		expect(about).toContain("exited 4");
		expect(about).toContain("Any round shown may change at a later update, not only the newest");
		expect(about).toContain(`lists the newest ${LEFT_OUT_LISTED} by path`);
		expect([ROUND_GAP_MINUTES, RECENT_ROUNDS, LEFT_OUT_LISTED]).toEqual([40, 8, 8]);
	});

	test("measure the gap from the boot before, to the nanosecond: exactly 40 minutes is the same round, a nanosecond more is a new one", () => {
		const boots = [
			emptyBoot("a", "2026-11-25T04:11:00.000000000Z"),
			emptyBoot("b", "2026-11-25T04:51:00.000000000Z"),
			emptyBoot("c", "2026-11-25T05:31:00.000000000Z"),
			emptyBoot("d", "2026-11-25T06:11:00.000000001Z"),
		];
		const rounds = recent(buildApi(sourcesOf(fixture, [...readBootFiles(fixture.runs), ...boots]))).rounds as Json[];
		// a, b and c chain at 40 minutes each, 80 minutes from a to c: a round is measured boot to boot, not from its first boot.
		expect(rounds.slice(0, 2).map((one) => [one.started_at, one.boots])).toEqual([
			["2026-11-25T06:11:00.000000001Z", 1],
			["2026-11-25T04:11:00.000000000Z", 3],
		]);
	});

	test("hold the newest 8 rounds only, newest first", () => {
		const later = Array.from({ length: 10 }, (_, i) => emptyBoot(`later-${i}`, `2026-11-${String(22 + Math.floor(i / 4)).padStart(2, "0")}T${String(4 + (i % 4) * 6).padStart(2, "0")}:11:00.000000000Z`));
		const rounds = recent(buildApi(sourcesOf(fixture, [...readBootFiles(fixture.runs), ...later]))).rounds as Json[];
		expect(rounds.map((one) => one.started_at)).toEqual(
			later
				.slice(2)
				.reverse()
				.map((file) => JSON.parse(new TextDecoder().decode(file.bytes)).started_at),
		);
	});

	test("may change when shown, not only the newest: a summary that arrives late joins two older rounds into one, or moves a round's start", () => {
		const base = [emptyBoot("t0", "2026-11-26T04:00:00.000000000Z"), emptyBoot("t70", "2026-11-26T05:10:00.000000000Z"), emptyBoot("t360", "2026-11-26T10:00:00.000000000Z")];
		const starts = (files: BootFile[]): Array<[string, number]> => (recent(buildApi(sourcesOf(fixture, [...readBootFiles(fixture.runs), ...files]))).rounds as Json[]).slice(0, 3).map((one) => [one.started_at, one.boots]);
		expect(starts(base)).toEqual([
			["2026-11-26T10:00:00.000000000Z", 1],
			["2026-11-26T05:10:00.000000000Z", 1],
			["2026-11-26T04:00:00.000000000Z", 1],
		]);
		// A boot of minute 35, its summary arriving after the others were shown: the two older rounds are one, and a round further back enters the list.
		expect(starts([...base, emptyBoot("t35", "2026-11-26T04:35:00.000000000Z")])).toEqual([
			["2026-11-26T10:00:00.000000000Z", 1],
			["2026-11-26T04:00:00.000000000Z", 3],
			["2026-11-20T23:55:00.500000000Z", 3],
		]);
		// A boot of 20 minutes before the first: that round starts earlier.
		expect(starts([...base, emptyBoot("t-20", "2026-11-26T03:40:00.000000000Z")])[2]).toEqual(["2026-11-26T03:40:00.000000000Z", 2]);
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
		expect(recent(buildApi(sourcesOf(fixture, [])))).toMatchObject({ rounds: [], left_out: { count: 0, summaries: [] } });
	});
});

describe("a boot summary the rounds cannot be told from", () => {
	const old = "2025-01-01T04:11:00.000000000Z";
	const oldPath = (name: string): string => `boots/2025/01/01/${idOf(name)}.json`;
	/** Each kind of summary left out on its own, at an old day, and why. */
	const kinds: Array<{ name: string; file: BootFile; why: string }> = [
		{ name: "only {", file: fileOf(oldPath("brace"), "{"), why: LEFT_OUT_WHY.json },
		{ name: "a byte-order mark", file: fileOf(oldPath("bom"), `﻿${bootSummaryText({ boot: idOf("bom"), startedAt: old, runs: [] })}`), why: LEFT_OUT_WHY.json },
		{ name: "a member twice", file: fileOf(oldPath("twice"), `{"schema":"ledgermath.boot/1","schema":"ledgermath.boot/1"}`), why: LEFT_OUT_WHY.json },
		{ name: "an array", file: fileOf(oldPath("array"), "[]"), why: LEFT_OUT_WHY.schema },
		{ name: "another version", file: fileOf(oldPath("v2"), changed("v2", old, (s) => (s.schema = "ledgermath.boot/2"))), why: LEFT_OUT_WHY.schema },
		{ name: "no boot", file: fileOf(oldPath("noboot"), changed("noboot", old, (s) => delete s.boot)), why: LEFT_OUT_WHY.boot },
		{ name: "a boot that is a number", file: fileOf(oldPath("numboot"), changed("numboot", old, (s) => (s.boot = 7))), why: LEFT_OUT_WHY.boot },
		{ name: "no start", file: fileOf(oldPath("nostart"), changed("nostart", old, (s) => delete s.started_at)), why: LEFT_OUT_WHY.start },
		{ name: "a start that is no time", file: fileOf(oldPath("feb30"), changed("feb30", old, (s) => (s.started_at = "2026-02-30T04:11:00.000000000Z"))), why: LEFT_OUT_WHY.start },
		{ name: "a start to the millisecond", file: fileOf(oldPath("ms"), changed("ms", old, (s) => (s.started_at = "2025-01-01T04:11:00.000Z"))), why: LEFT_OUT_WHY.start },
		{ name: "no provider", file: fileOf(oldPath("noprov"), changed("noprov", old, (s) => delete s.provider)), why: LEFT_OUT_WHY.provider },
		{ name: "an instance type that is a number", file: fileOf(oldPath("numtype"), changed("numtype", old, (s) => (s.provider.instance_type = 5))), why: LEFT_OUT_WHY.provider },
		{ name: "Runs that are not a list", file: fileOf(oldPath("runsobj"), changed("runsobj", old, (s) => (s.runs = {}))), why: LEFT_OUT_WHY.runs },
		{ name: "a Run without its id", file: fileOf(oldPath("noid"), changed("noid", old, (s) => (s.runs = [{ benchmark: "syscall" }]))), why: LEFT_OUT_WHY.runs },
		{ name: "failed builds that are not a list", file: fileOf(oldPath("bf"), changed("bf", old, (s) => (s.build_failures = 1))), why: LEFT_OUT_WHY.lists },
		{ name: "no executions not run", file: fileOf(oldPath("nr"), changed("nr", old, (s) => delete s.not_run)), why: LEFT_OUT_WHY.lists },
		{ name: "unknown.json, which the API does not serve", file: fileOf("boots/2025/01/01/unknown.json", changed("x", old, (s) => (s.boot = ""))), why: LEFT_OUT_WHY.address },
		{ name: "a name that is no boot's id", file: fileOf("boots/2025/01/01/my-boot.json", changed("my-boot", old, (s) => (s.boot = "my-boot"))), why: LEFT_OUT_WHY.address },
	];

	for (const { name, file, why } of kinds) {
		test(`is left out, with why, and the build goes on: ${name}`, () => {
			const built = buildApi(sourcesOf(fixture, [...readBootFiles(fixture.runs), file]));
			expect(recent(built).rounds).toEqual(recent(tree).rounds);
			expect(recent(built).left_out.summaries).toContainEqual({ path: file.path, boot_summary: isServedKey(file.path) ? address(file.path) : null, why });
			expect(recent(built).left_out.count).toBe(2);
		});
	}

	test("one old summary that cannot be read beside newer good ones stops nothing: the tree is made, checked and passes, and lists it", () => {
		const runs = mkdtempSync(join(tmpdir(), "api-rounds-old-"));
		for (const path of [...readBootFiles(fixture.runs).map((file) => file.path), ...fixture.series.derivations.flatMap((d) => d.runs.map((run) => run.path))]) {
			mkdirSync(dirname(join(runs, path)), { recursive: true });
			writeFileSync(join(runs, path), readFileSync(join(fixture.runs, path)));
		}
		mkdirSync(join(runs, "boots/2025/01/01"), { recursive: true });
		writeFileSync(join(runs, oldPath("brace")), "{");
		const built = buildApi(sourcesOf({ ...fixture, runs }));
		expect(recent(built).rounds).toEqual(recent(tree).rounds);
		expect(recent(built).left_out).toEqual({
			count: 2,
			summaries: [
				{ path: UNKNOWN, boot_summary: null, why: LEFT_OUT_WHY.address },
				{ path: oldPath("brace"), boot_summary: address(oldPath("brace")), why: LEFT_OUT_WHY.json },
			],
		});
		expect(checkApi({ tree: writeTree(built), runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems).toEqual([]);
	});

	test("is listed newest path first, at most 8, and counted all", () => {
		const many = Array.from({ length: 11 }, (_, i) => fileOf(`boots/2025/01/${String(i + 1).padStart(2, "0")}/${idOf(`bad-${i}`)}.json`, "{"));
		const left = recent(buildApi(sourcesOf(fixture, [...readBootFiles(fixture.runs), ...many]))).left_out;
		expect(left.count).toBe(12);
		expect(left.summaries.map((one: Json) => one.path)).toEqual([UNKNOWN, ...many.map((file) => file.path).reverse()].slice(0, LEFT_OUT_LISTED));
	});

	test("in conflict with another is left out with it: two naming one boot, one listing a Run of another boot, two listing one Run, one listing a Run twice", () => {
		const files = readBootFiles(fixture.runs);
		const hand = fixture.boots["hand-m5"] as HandMadeBoot;
		const evening = fixture.boots["evening-m5"] as HandMadeBoot;
		const eveningRun = (evening.runs[0] as Run).id;
		const leftOf = (extra: BootFile[], replace: Record<string, string> = {}) => {
			const built = buildApi(sourcesOf(fixture, [...files.map((file) => (replace[file.path] === undefined ? file : fileOf(file.path, replace[file.path] as string))), ...extra]));
			return { left: recent(built).left_out as Json, boots: (recent(built).rounds as Json[]).flatMap((one) => one.by_boot.map((boot: Json) => boot.boot_summary)) };
		};
		// A second summary of the boot by hand, on another day: both are left out, and the boot is in no round.
		const second = fileOf(`boots/2026/11/22/${hand.boot}.json`, bootSummaryText({ ...hand, startedAt: "2026-11-22T13:44:05.000000000Z" }));
		const same = leftOf([second]);
		expect(same.left.summaries).toEqual(
			expect.arrayContaining([
				{ path: second.path, boot_summary: address(second.path), why: LEFT_OUT_WHY.same_boot },
				{ path: bootSummaryPath(hand), boot_summary: address(bootSummaryPath(hand)), why: LEFT_OUT_WHY.same_boot },
			]),
		);
		expect(same.boots).not.toContain(address(bootSummaryPath(hand)));
		// The summary by hand also listing a Run of the evening's m5.large boot: it is left out, the evening's stays.
		const other = leftOf([], { [bootSummaryPath(hand)]: bootSummaryText({ ...hand, runs: [...hand.runs, evening.runs[0] as Run] }) });
		expect(other.left.summaries).toContainEqual({ path: bootSummaryPath(hand), boot_summary: address(bootSummaryPath(hand)), why: LEFT_OUT_WHY.other_boot });
		expect(other.boots).toContain(address(bootSummaryPath(evening)));
		// Two summaries listing one Run that no point has: both left out.
		const ghost = { id: "019aa3c0-0000-7000-8000-0000000000ff", benchmark: "syscall", params: {}, binary: { build: "static" }, exit: { code: 0 } } as unknown as Run;
		const shared = leftOf([], { [bootSummaryPath(hand)]: bootSummaryText({ ...hand, runs: [...hand.runs, ghost] }), [bootSummaryPath(evening)]: bootSummaryText({ ...evening, runs: [...evening.runs, ghost] }) });
		expect(shared.left.summaries).toEqual(
			expect.arrayContaining([
				{ path: bootSummaryPath(hand), boot_summary: address(bootSummaryPath(hand)), why: LEFT_OUT_WHY.shared_run },
				{ path: bootSummaryPath(evening), boot_summary: address(bootSummaryPath(evening)), why: LEFT_OUT_WHY.shared_run },
			]),
		);
		// One listing its own Run twice.
		const twice = leftOf([], { [bootSummaryPath(evening)]: bootSummaryText({ ...evening, runs: [...evening.runs, evening.runs[0] as Run] }) });
		expect(twice.left.summaries).toContainEqual({ path: bootSummaryPath(evening), boot_summary: address(bootSummaryPath(evening)), why: LEFT_OUT_WHY.shared_run });
		expect(eveningRun).toBe((evening.runs[0] as Run).id);
	});

	test("listing an enormous number of Runs is counted, not copied: the table of contents grows by digits", () => {
		const runs = Array.from({ length: 100_000 }, (_, i) => ({ id: `019aa3c1-0000-7000-8000-${String(i).padStart(12, "0")}`, benchmark: "syscall", params: {}, binary: { build: "static" }, exit: { code: 0 } })) as unknown as Run[];
		const huge = fileOf(`boots/2026/11/27/${idOf("huge")}.json`, bootSummaryText({ boot: idOf("huge"), startedAt: "2026-11-27T04:11:00.000000000Z", runs }));
		const built = buildApi(sourcesOf(fixture, [...readBootFiles(fixture.runs), huge]));
		expect((recent(built).rounds as Json[])[0]).toMatchObject({ boots: 1, runs: 100_000, runs_in_no_series: 100_000, failed_runs: 0 });
		expect((built.get(INDEX_PATH) as Uint8Array).length - (tree.get(INDEX_PATH) as Uint8Array).length).toBeLessThan(2_000);
	});
});

describe("every boot summary address the build writes", () => {
	test("is one the API serves, by the list of served shapes the edge is made from, in the points and the rounds alike", () => {
		const addresses: string[] = [];
		const walk = (node: unknown, key: string): void => {
			if (typeof node === "string" && key === "boot_summary") addresses.push(node);
			else if (Array.isArray(node)) for (const item of node) walk(item, key);
			else if (typeof node === "object" && node !== null) for (const [name, value] of Object.entries(node)) walk(value, name);
		};
		for (const [path, bytes] of tree) if (path.endsWith(".json") && !path.startsWith("v1/schemas/")) walk(JSON.parse(new TextDecoder().decode(bytes)), "");
		expect(addresses.length).toBeGreaterThan(20);
		expect(addresses.filter((url) => !isServedKey(url.slice(DEFAULT_BASE.length + 1)))).toEqual([]);
		// The boot whose id could not be read: its Run's point links no summary, and unknown.json is no link.
		const point = (Object.values(Object.fromEntries(tree)) as Uint8Array[])
			.map((bytes) => new TextDecoder().decode(bytes))
			.flatMap((text) => (text.includes(fixture.unknownRun) ? [text] : []));
		expect(point.length).toBeGreaterThan(0);
		expect(point.some((text) => text.includes("unknown.json\""))).toBe(false);
	});
});

describe("the check of the newest rounds of boots", () => {
	/** The six rounds as the tree holds them, to be changed. */
	type Rounds = [Json, Json, Json, Json, Json, Json];
	const checkWith = (change: (recent: { rounds: Rounds; left_out: Json; about: string }) => void): string[] => {
		const copy = writeTree(tree);
		const index = json(tree, INDEX_PATH);
		change(index.recent_rounds);
		writeFileSync(join(copy, INDEX_PATH), writerForm(INDEX_PATH, index));
		return checkApi({ tree: copy, runs: fixture.runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems;
	};
	const against = "as the boot summaries of the checkout and the Derivations make it";

	test("passes the tree as built, the boot whose id could not be read included", () => {
		expect(checkApi({ tree: directory, runs: fixture.runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems).toEqual([]);
	});

	test("catches a wrong count, a missing boot and a boot in the wrong round", () => {
		expect(
			checkWith(({ rounds }) => {
				rounds[2].by_boot[1].failed_runs = 0;
				rounds[2].failed_runs = 0;
			}),
		).toEqual([`v1/index.json: /recent_rounds/rounds/2/failed_runs is 0, not 1, ${against}`]);
		expect(
			checkWith(({ rounds }) => {
				const [gone] = rounds[4].by_boot.splice(2, 1);
				rounds[4].boots = 3;
				rounds[4].runs -= gone.runs;
				rounds[4].instance_types.splice(2, 1);
			}),
		).toEqual([`v1/index.json: /recent_rounds/rounds/4/boots is 3, not 4, ${against}`]);
		// The boot by hand, put in the round before it: the same boots and figures in all, in other rounds.
		expect(
			checkWith(({ rounds }) => {
				const [hand] = rounds.splice(3, 1) as [Json];
				const before = rounds[3];
				before.by_boot.push(...hand.by_boot);
				before.instance_types.push(...hand.instance_types);
				before.boots += 1;
				before.runs += 1;
			}),
		).toEqual([`v1/index.json: /recent_rounds/rounds/3/started_at is "2026-11-20T10:11:43.000000000Z", not "2026-11-20T13:44:05.000000000Z", ${against}`]);
		// A boot's own summary named wrongly: a value the summaries do not make, and a link the checkout does not hold.
		const nowhere = address(`boots/2026/11/20/${idOf("nowhere")}.json`);
		expect(
			checkWith(({ rounds }) => {
				rounds[0].by_boot[0].boot_summary = nowhere;
			}),
		).toEqual([
			`v1/index.json: /recent_rounds/rounds/0/by_boot/0/boot_summary is "${nowhere}", not "${address(bootSummaryPath(fixture.boots["midnight-c6i"] as HandMadeBoot))}", ${against}`,
			`v1/index.json links ${nowhere}, which is not a file of the Runs repository checkout ${fixture.runs}`,
		]);
	});

	test("catches a list of summaries left out that is not the checkout's: one missing, a wrong count, a wrong why, an address the API does not serve", () => {
		expect(checkWith(({ left_out }) => (left_out.summaries = []))).toEqual([`v1/index.json: /recent_rounds/left_out/summaries has 0 items, not 1, ${against}`]);
		expect(checkWith(({ left_out }) => (left_out.count = 0))).toEqual([`v1/index.json: /recent_rounds/left_out/count is 0, not 1, ${against}`]);
		expect(checkWith(({ left_out }) => (left_out.summaries[0].why = LEFT_OUT_WHY.json))).toEqual([`v1/index.json: /recent_rounds/left_out/summaries/0/why is ${JSON.stringify(LEFT_OUT_WHY.json)}, not ${JSON.stringify(LEFT_OUT_WHY.address)}, ${against}`]);
		const unknown = address(UNKNOWN);
		expect(checkWith(({ left_out }) => (left_out.summaries[0].boot_summary = unknown))).toEqual([
			`v1/index.json: /recent_rounds/left_out/summaries/0/boot_summary is ${JSON.stringify(unknown)}, not null, ${against}`,
			`v1/index.json: recent_rounds links ${unknown}, an address the API does not serve`,
		]);
	});

	test("catches words that do not begin with the rule and the count, word for word", () => {
		const opening = `v1/index.json: recent_rounds.about does not begin, word for word, with the rule and the count the rounds are held to: ${JSON.stringify(ROUND_RULE)}`;
		expect(checkWith((r) => (r.about = r.about.replace("40 minutes", "90 minutes")))).toEqual([opening]);
		expect(checkWith((r) => (r.about = `Rounds are hours apart. ${r.about}`))).toEqual([opening]);
	});

	test("catches a tree made before a summary arrived that cannot be read: its list of summaries left out is not the checkout's", () => {
		const runs = mkdtempSync(join(tmpdir(), "api-rounds-broken-"));
		for (const path of [...readBootFiles(fixture.runs).map((file) => file.path), ...fixture.series.derivations.flatMap((d) => d.runs.map((run) => run.path))]) {
			mkdirSync(dirname(join(runs, path)), { recursive: true });
			writeFileSync(join(runs, path), readFileSync(join(fixture.runs, path)));
		}
		const hand = bootSummaryPath(fixture.boots["hand-m5"] as HandMadeBoot);
		writeFileSync(join(runs, hand), "{");
		const problems = checkApi({ tree: directory, runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems;
		expect(problems).toContain(`v1/index.json: /recent_rounds/rounds/3/started_at is "2026-11-20T13:44:05.000000000Z", not "2026-11-20T10:11:43.000000000Z", ${against}`);
		expect(problems).toContain(`v1/index.json: /recent_rounds/left_out/count is 1, not 2, ${against}`);
		// No summary is itself a problem: built from that checkout, the tree passes.
		expect(checkApi({ tree: writeTree(buildApi(sourcesOf({ ...fixture, runs }))), runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems).toEqual([]);
	});
});
