/**
 * The data API's split of each Series by month (ADR-0030): what goes in a
 * month file and what stays in the Series file, that a month file does not
 * change once its month has passed, that a Series file does not grow with its
 * Runs, the ceilings on every file's size, the guard that no figure loses
 * digits on its way in, and the check's rules for all of it.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Ajv2020 from "ajv/dist/2020";

import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import {
	type ApiSources,
	buildApi,
	DEFAULT_BASE,
	ABOUT,
	EVIDENCE,
	FIGURES,
	LAYOUT,
	MONTH_CONTRACT,
	MONTHS,
	monthPath,
	NEWEST_RUNS,
	readApiSchemas,
	readBootFiles,
	readBootSummaries,
	readDerivations,
	readPriceFiles,
	seriesPath,
	VERSIONING,
	writerForm,
} from "../scripts/lib/api";
import { CEILINGS, checkApi, checkStability, NOT_ESTABLISHED } from "../scripts/lib/api-check";
import { type ApiFixture, type LongFixture, makeApiFixture, makeLongFixture } from "./api-fixtures";

setDefaultTimeout(120_000);

const ROOT = join(import.meta.dir, "..");

type Json = Record<string, any>;

/** The address of a summary of the fixture's second day's boot that arrives (cause (b)): of a shape the API serves, as a point's link must be. */
const ARRIVING = "boots/2026/11/13/2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b.json";

function sourcesOf(fixture: { series: SeriesFile; requests: RequestsFile; runs: string }, boots?: Map<string, string>): ApiSources {
	return {
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: structuredClone(fixture.series),
		requests: structuredClone(fixture.requests),
		prices: readPriceFiles(fixture.runs),
		boots: boots ?? readBootSummaries(fixture.runs),
		bootFiles: readBootFiles(fixture.runs),
		schemas: readApiSchemas(),
	};
}

function writeTree(tree: Map<string, Uint8Array>): string {
	const directory = mkdtempSync(join(tmpdir(), "api-tree-"));
	for (const [path, bytes] of tree) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), bytes);
	}
	return directory;
}

const text = (tree: Map<string, Uint8Array>, path: string): string => new TextDecoder().decode(tree.get(path));
const json = (tree: Map<string, Uint8Array>, path: string): Json => JSON.parse(text(tree, path));
const seriesOf = (file: SeriesFile, id: string) => file.derivations.find((d) => d.series.id === id) as SeriesFile["derivations"][number];
const requestsOf = (file: RequestsFile, id: string) => file.derivations.find((d) => d.series.id === id) as RequestsFile["derivations"][number];

let before: ApiFixture;
let beforeTree: Map<string, Uint8Array>;
let fixture: ApiFixture;
let tree: Map<string, Uint8Array>;
let directory: string;

beforeAll(async () => {
	before = await makeApiFixture();
	beforeTree = buildApi(sourcesOf(before));
	fixture = await makeApiFixture({ nextMonth: true });
	tree = buildApi(sourcesOf(fixture));
	directory = writeTree(tree);
});

describe("a Series split by month", () => {
	test("has one file per month a Run of it started in, listed in its Series file, oldest first, with its address, Runs and first and last start", () => {
		const file = json(tree, seriesPath(fixture.memory));
		const hashOf = (month: string): { sha256: string; bytes: number } => {
			const bytes = tree.get(monthPath(fixture.memory, month)) as Uint8Array;
			return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
		};
		expect(file.months).toEqual([
			{ month: "2026-11", url: `${DEFAULT_BASE}/${monthPath(fixture.memory, "2026-11")}`, runs: 4, oldest_run_started_at: "2026-11-12T04:12:00.000000000Z", newest_run_started_at: "2026-11-15T04:12:00.000000000Z", ...hashOf("2026-11") },
			{ month: "2026-12", url: `${DEFAULT_BASE}/${monthPath(fixture.memory, "2026-12")}`, runs: 1, oldest_run_started_at: "2026-12-01T04:12:00.000000000Z", newest_run_started_at: "2026-12-01T04:12:00.000000000Z", ...hashOf("2026-12") },
		]);
		expect([...tree.keys()].filter((path) => path.startsWith(`v1/series/${fixture.memory}`))).toEqual([seriesPath(fixture.memory), monthPath(fixture.memory, "2026-11"), monthPath(fixture.memory, "2026-12")]);
		// The syscall Series had no Run in December: one month.
		expect(json(tree, seriesPath(fixture.syscall)).months.map((entry: Json) => entry.month)).toEqual(["2026-11"]);
		expect(file.newest_runs).toBe(NEWEST_RUNS);
		expect(NEWEST_RUNS).toBe(12);
	});

	test("a month file says which Series and month it is, links back, and holds each Method's points of that month, labelled as the Series file is", () => {
		const december = json(tree, monthPath(fixture.http, "2026-12"));
		expect(december).toMatchObject({
			schema: "ledgermath.api.series-month/1",
			schema_url: `${DEFAULT_BASE}/v1/schemas/series-month.schema.json`,
			index: `${DEFAULT_BASE}/v1/index.json`,
			id: fixture.http,
			month: "2026-12",
			url: `${DEFAULT_BASE}/${monthPath(fixture.http, "2026-12")}`,
			series_url: `${DEFAULT_BASE}/${seriesPath(fixture.http)}`,
			benchmark: "http_get",
			runs: 1,
		});
		expect(Object.keys(december.derivations)).toEqual(["series_v1", "requests_v1"]);
		expect(december.derivations.series_v1.method).toEqual({ name: "series", version: 1 });
		expect(december.derivations.requests_v1.method).toEqual({ name: "requests", version: 1 });
		expect(Object.keys(december.derivations.requests_v1)).toEqual(["method", "points"]);
		// Every Run is in exactly one month file, that of its start.
		for (const id of [fixture.memory, fixture.http, fixture.syscall]) {
			const months = json(tree, seriesPath(id)).months as Json[];
			const runs = months.flatMap((entry) => json(tree, monthPath(id, entry.month)).derivations.series_v1.points.map((point: Json) => [point.run, point.started_at.slice(0, 7), entry.month]));
			expect(runs.map(([run]) => run)).toEqual(seriesOf(fixture.series, id).points.map((point) => point.run));
			for (const [, started, month] of runs) expect(started).toBe(month);
		}
	});

	test("files each entry of a pair of consecutive Runs under the month of the later Run", () => {
		const derivation = seriesOf(fixture.series, fixture.memory);
		const across = derivation.differed[derivation.differed.length - 1];
		expect(across?.to).toBe(derivation.points[4]?.run);
		expect(json(tree, monthPath(fixture.memory, "2026-12")).derivations.series_v1.differed).toEqual([across]);
		expect(json(tree, monthPath(fixture.memory, "2026-11")).derivations.series_v1.differed).toEqual(derivation.differed.slice(0, 3));
	});

	test("the Series file keeps the newest points, the same as the month files', and leaves out every list of Runs a reader recovers from them", () => {
		const file = json(tree, seriesPath(fixture.memory));
		const points = ["2026-11", "2026-12"].flatMap((month) => json(tree, monthPath(fixture.memory, month)).derivations.series_v1.points);
		expect(file.derivations.series_v1.newest_points).toEqual(points.slice(-NEWEST_RUNS));
		const derivation = seriesOf(fixture.series, fixture.memory);
		// The percentiles' Runs: the counted points; a group's Runs: the points of its letter.
		expect(file.derivations.series_v1.percentiles.time_per_repetition_ns).toEqual({ count: 4, p5: derivation.percentiles.time_per_repetition_ns?.p5, p50: derivation.percentiles.time_per_repetition_ns?.p50, p95: derivation.percentiles.time_per_repetition_ns?.p95 });
		expect(derivation.percentiles.time_per_repetition_ns?.runs).toEqual(points.filter((point) => point.counted).map((point) => point.run));
		expect(derivation.percentiles.bytes_per_second?.runs).toEqual(points.filter((point) => point.counted && point.bytes_per_repetition !== null).map((point) => point.run));
		for (const group of derivation.groups) expect(group.runs).toEqual(points.filter((point) => point.group === group.id).map((point) => point.run));
		expect(file.derivations.series_v1.groups.every((group: Json) => !("runs" in group))).toBe(true);
		expect(json(tree, seriesPath(fixture.http)).derivations.requests_v1.groups.every((group: Json) => !("runs" in group))).toBe(true);
		expect([file.derivations.series_v1.counted_runs, file.derivations.series_v1.failed_runs]).toEqual([4, 1]);
	});

	test("matches its schemas, closed, and the check finds no problem", () => {
		const result = checkApi({ tree: directory, runs: fixture.runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests });
		expect(result.problems).toEqual([]);
		expect([result.series, result.months]).toEqual([3, 5]);
	});
});

describe("a month file's bytes change only for the four causes", () => {
	const MONTH = /^v1\/series\/[^/]+\/[^/]+\.json$/;
	/** The month files two trees both hold whose bytes differ, in path order. */
	const changed = (a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): string[] =>
		[...a.keys()].filter((path) => MONTH.test(path) && b.has(path) && text(a, path) !== text(b, path)).sort();
	/** The members of each published point that differ in `b`, by Run id, for one Method's block of a month file. */
	const pointChanges = (a: Json, b: Json, key: string): Record<string, string[]> => {
		const after = new Map((b.derivations[key].points as Json[]).map((point) => [point.run, point]));
		const out: Record<string, string[]> = {};
		for (const point of a.derivations[key].points as Json[]) {
			const other = after.get(point.run) as Json;
			const members = Object.keys(point).filter((member) => JSON.stringify(point[member]) !== JSON.stringify(other[member]));
			if (members.length > 0) out[point.run] = members;
		}
		return out;
	};
	const runsOf = (file: Json, key = "series_v1"): string[] => (file.derivations[key].points as Json[]).map((point) => point.run);

	test("the contract is published word for word in the table of contents, both Series schemas, ADR-0030 and the README", () => {
		const flat = (value: string): string => value.replace(/\s+/g, " ");
		const contract = flat(MONTH_CONTRACT);
		expect(contract).toContain("For a given layout (the layout of v1/index.json), a month file's bytes change only when (a) a Run that started in that month is added, (b) a boot summary that was missing arrives, (c) a Run arrives late");
		expect(contract).toContain("or (d) a Method first applies to the Series; otherwise they do not change.");
		expect(contract).toContain("These four are the only causes for a given layout: layout increases when LedgerMath changes how the files are written, and only then may a file's bytes change without one of them.");
		// The reader's rule for a month file that does not match its Series file (ADR-0031, decision 8), in the tree's own words.
		expect(contract).toContain(
			"So a reader checks the sha256 of every month file it fetches against the one its Series file lists; on a mismatch, it fetches the Series file again, then the month file, and compares again; while they still differ, it uses neither, and tries again later.",
		);
		const index = json(tree, "v1/index.json");
		expect(index.months).toBe(MONTHS);
		expect(index.months).toContain(MONTH_CONTRACT);
		expect(index.about).not.toMatch(/does not change|never changes|stays the same/);
		const schema = (name: string): Json => JSON.parse(readFileSync(join(ROOT, "schemas", "api", "v1", `${name}.schema.json`), "utf8"));
		expect(schema("series-month").description).toContain(MONTH_CONTRACT);
		expect(schema("series").properties.months.description).toContain(MONTH_CONTRACT);
		expect(schema("index").properties.months.description).toContain("for a given layout, for four causes only");
		// The layout itself: in the table of contents, described by its schema.
		expect(index.layout).toBe(LAYOUT);
		expect(Object.keys(index).indexOf("layout")).toBe(Object.keys(index).indexOf("months") + 1);
		expect(schema("index").required).toContain("layout");
		expect(schema("index").properties.layout).toMatchObject({ type: "integer", minimum: 1 });
		expect(schema("index").properties.layout.description).toContain("It increases when LedgerMath changes how the files are written");
		expect(schema("index").properties.layout.description).toContain("for a given layout, those four are the only causes");
		expect(schema("index").properties.layout.description).toContain("Editing a schema's words does not change it");
		expect(flat(readFileSync(join(ROOT, "docs", "adr", "0030-the-data-api-is-static-files-cut-from-the-derivations.md"), "utf8"))).toContain(contract);
		expect(flat(readFileSync(join(ROOT, "README.md"), "utf8"))).toContain(contract);
		// And no published words still say a past month never changes.
		for (const name of ["index", "series-list", "series", "series-month"]) expect([name, JSON.stringify(schema(name))]).not.toEqual([name, expect.stringMatching(/once a month has passed|stays the same|does not change once/)]);
	});

	test("a Series file's months give each month file's sha256 and size, as the tree holds it; a month file that does not change keeps its entry byte for byte", () => {
		for (const id of [fixture.memory, fixture.http, fixture.syscall]) {
			for (const entry of json(tree, seriesPath(id)).months as Json[]) {
				const bytes = tree.get(monthPath(id, entry.month)) as Uint8Array;
				expect([entry.sha256, entry.bytes]).toEqual([createHash("sha256").update(bytes).digest("hex"), bytes.length]);
			}
		}
		const entryLine = (t: Map<string, Uint8Array>, id: string, month: string): string | undefined =>
			text(t, seriesPath(id))
				.split("\n")
				.find((line) => line.includes(`"month":"${month}"`))
				?.replace(/,$/, "");
		expect(entryLine(tree, fixture.memory, "2026-11")).toBe(entryLine(beforeTree, fixture.memory, "2026-11"));
		expect(text(tree, seriesPath(fixture.memory))).not.toBe(text(beforeTree, seriesPath(fixture.memory)));
	});

	test("a strictly later Run in a later month, for Series both Methods already derive, changes no earlier month: even one that splits a Series into groups", () => {
		const earlier = [...beforeTree.keys()].filter((path) => MONTH.test(path));
		expect(earlier.length).toBe(3);
		expect(changed(beforeTree, tree)).toEqual([]);
		expect(json(tree, seriesPath(fixture.http)).derivations.requests_v1.groups.map((group: Json) => group.id)).toEqual(["A", "B"]);
		// The Series files of the two Series that gained a Run change; the third's does not.
		expect(text(tree, seriesPath(fixture.memory))).not.toBe(text(beforeTree, seriesPath(fixture.memory)));
		expect(text(tree, seriesPath(fixture.http))).not.toBe(text(beforeTree, seriesPath(fixture.http)));
		expect(text(tree, seriesPath(fixture.syscall))).toBe(text(beforeTree, seriesPath(fixture.syscall)));
		const result = checkStability(writeTree(beforeTree), directory);
		expect([result.problems, result.compared, result.inBoth, result.unchanged, result.added, result.explained]).toEqual([[], true, 3, 3, 2, []]);
	});

	test("(a) a Run that started in a month, after every Run of its Series, changes that month's file and nothing else: its point, its pair entry, its count and newest start", async () => {
		const more = await makeApiFixture({ nextMonth: true, extraSyscallRun: true });
		const after = buildApi(sourcesOf(more));
		const nov = monthPath(fixture.syscall, "2026-11");
		expect(changed(tree, after)).toEqual([nov]);
		const was = json(tree, nov);
		const is = json(after, nov);
		const run = seriesOf(more.series, fixture.syscall).points[1]?.run as string;
		expect(runsOf(is)).toEqual([...runsOf(was), run]);
		expect(pointChanges(was, is, "series_v1")).toEqual({});
		expect(is.derivations.series_v1.differed.slice(0, -1)).toEqual(was.derivations.series_v1.differed);
		const { derivations: _a, runs: _b, newest_run_started_at: _c, ...wasHead } = was;
		const { derivations: _d, runs: _e, newest_run_started_at: _f, ...isHead } = is;
		expect(isHead).toEqual(wasHead);
		expect([is.runs, is.newest_run_started_at]).toEqual([2, "2026-11-16T04:13:00.000000000Z"]);
		const result = checkStability(directory, writeTree(after));
		expect(result.problems).toEqual([]);
		expect(result.explained).toEqual([{ path: nov, causes: [{ cause: "a", detail: `Run ${run}` }] }]);
	});

	test("(b) a boot summary that was missing arriving turns its points' boot_summary from null into its address, and changes nothing else", () => {
		// A summary of the second day's boot, at an address of a served shape (a point links no other).
		const boots = new Map(readBootSummaries(fixture.runs));
		boots.set("boot-2026-11-13", ARRIVING);
		const later = buildApi(sourcesOf(fixture, boots));
		const runsOfBoot = (id: string, key = "series_v1"): string[] => (json(tree, monthPath(id, "2026-11")).derivations[key].points as Json[]).filter((point) => point.boot === "boot-2026-11-13").map((point) => point.run);
		expect(changed(tree, later)).toEqual([monthPath(fixture.memory, "2026-11"), monthPath(fixture.http, "2026-11")].sort());
		for (const id of [fixture.memory, fixture.http]) {
			const path = monthPath(id, "2026-11");
			for (const key of id === fixture.http ? ["series_v1", "requests_v1"] : ["series_v1"]) {
				expect(pointChanges(json(tree, path), json(later, path), key)).toEqual(Object.fromEntries(runsOfBoot(id, key).map((run) => [run, ["boot_summary"]])));
			}
			const b = json(later, path);
			for (const key of Object.keys(b.derivations)) b.derivations[key].points = b.derivations[key].points.map((point: Json) => (point.boot === "boot-2026-11-13" ? { ...point, boot_summary: null } : point));
			expect(b).toEqual(json(tree, path));
		}
		const result = checkStability(directory, writeTree(later));
		expect(result.problems).toEqual([]);
		expect(result.explained.map((file) => [file.path, file.causes.map((one) => one.cause)])).toEqual([monthPath(fixture.memory, "2026-11"), monthPath(fixture.http, "2026-11")].sort().map((path) => [path, ["b"]]));
	});

	test("(c) a Run that arrives late changes its own month, and in later months only what a late Run can change: a later point's group, through and group_through_as_of_run, and the pair entry of the Run after it", async () => {
		const late = await makeApiFixture({ nextMonth: true, lateRun: true, lateRequestsRun: true });
		const after = buildApi(sourcesOf(late));
		const [memoryNov, memoryDec, httpNov, httpDec] = [monthPath(fixture.memory, "2026-11"), monthPath(fixture.memory, "2026-12"), monthPath(fixture.http, "2026-11"), monthPath(fixture.http, "2026-12")];
		expect(changed(tree, after)).toEqual([memoryNov, memoryDec, httpNov, httpDec].sort());
		// Its own month: its point, after every published point of that month, which is unchanged.
		const lateHttp = requestsOf(late.requests, fixture.http).points.find((point) => point.started_at.startsWith("2026-11-20"))?.run as string;
		expect(runsOf(json(after, httpNov), "requests_v1")).toEqual([...runsOf(json(tree, httpNov), "requests_v1"), lateHttp]);
		expect(pointChanges(json(tree, httpNov), json(after, httpNov), "requests_v1")).toEqual({});
		// December's Run, after it, took the letter C and new pooled figures; nothing else of it changed.
		const decRun = runsOf(json(tree, httpDec))[0] as string;
		expect(pointChanges(json(tree, httpDec), json(after, httpDec), "series_v1")).toEqual({ [decRun]: ["group"] });
		expect(pointChanges(json(tree, httpDec), json(after, httpDec), "requests_v1")).toEqual({ [decRun]: ["group", "through"] });
		expect([json(tree, httpDec).derivations.requests_v1.points[0].group, json(after, httpDec).derivations.requests_v1.points[0].group]).toEqual(["B", "C"]);
		// And its pair entry now comes from the late Run.
		expect(json(after, httpDec).derivations.series_v1.differed.map((entry: Json) => [entry.from, entry.to])).toEqual([[lateHttp, decRun]]);
		expect(pointChanges(json(tree, memoryDec), json(after, memoryDec), "series_v1")).toEqual({});
		const result = checkStability(directory, writeTree(after));
		expect(result.problems).toEqual([]);
		expect(result.explained.map((file) => [file.path, file.causes.map((one) => one.cause)])).toEqual([memoryNov, memoryDec, httpNov, httpDec].sort().map((path) => [path, ["c"]]));
		expect(result.explained.find((file) => file.path === httpDec)?.causes[0]?.detail.split("; ").sort()).toEqual(
			[
				`requests_v1 Run ${decRun}'s group, after a Run added late`,
				`requests_v1 Run ${decRun}'s through, after a Run added late`,
				`series_v1 Run ${decRun}'s group, after a Run added late`,
				`the pair entry of Run ${decRun}, now from Run ${lateHttp}, added late`,
			].sort(),
		);
	});

	test("(d) a Method that first applies to a Series adds its block to every month file of the Series, and changes nothing else in them", async () => {
		const without = await makeApiFixture({ nextMonth: true, methodLater: true });
		const withRun = await makeApiFixture({ nextMonth: true, methodLater: true, methodLaterRun: true });
		const id = without.methodLater as string;
		expect(withRun.methodLater).toBe(id);
		const a = buildApi(sourcesOf(without));
		const b = buildApi(sourcesOf(withRun));
		const nov = monthPath(id, "2026-11");
		// November held only series v1: the Run failed before its stream held a request.
		expect(Object.keys(json(a, nov).derivations)).toEqual(["series_v1"]);
		expect(Object.keys(json(b, nov).derivations)).toEqual(["series_v1", "requests_v1"]);
		expect(changed(a, b)).toEqual([nov]);
		const { requests_v1: added, ...rest } = json(b, nov).derivations;
		const withoutIt: Json = { ...json(b, nov), derivations: rest };
		expect(withoutIt).toEqual(json(a, nov));
		expect(runsOf(json(b, nov), "requests_v1")).toEqual(runsOf(json(a, nov)));
		expect(added.points[0].counted).toBe(false);
		const result = checkStability(writeTree(a), writeTree(b));
		expect(result.problems).toEqual([]);
		expect(result.explained).toEqual([{ path: nov, causes: [{ cause: "d", detail: "requests_v1 first derives the Series" }] }]);
	});
});

describe("requests v1's group_through_as_of_run", () => {
	/**
	 * The Derivation's group_through, recovered by the rule the schemas give:
	 * through, for the points before the first point whose group differs from
	 * the first point's, in a Series whose requests v1 groups number more than
	 * one; this field as it is for every other point.
	 */
	const recover = (t: Map<string, Uint8Array>, id: string): unknown[] => {
		const file = json(t, seriesPath(id));
		const points = (file.months as Json[]).flatMap((entry) => json(t, monthPath(id, entry.month)).derivations.requests_v1.points as Json[]);
		const first = points.findIndex((point) => point.group !== points[0]?.group);
		const split = file.derivations.requests_v1.groups.length > 1;
		return points.map((point, i) => (split && i < first ? point.through : point.group_through_as_of_run));
	};

	test("is the group's figures as they stood through the Run; the Derivation's group_through is recovered from it exactly, by the rule the schemas give, for every point", async () => {
		const trap = await makeApiFixture({ nextMonth: true, failedSecondGroup: true, lateRequestsRun: true });
		const t = buildApi(sourcesOf(trap));
		for (const derivation of trap.requests.derivations) expect([derivation.series.id, recover(t, derivation.series.id)]).toEqual([derivation.series.id, derivation.points.map((point) => point.group_through)]);
		expect(trap.requests.derivations.length).toBe(2);
		for (const path of t.keys()) expect(text(t, path)).not.toContain('"group_through"');
		expect(checkApi({ tree: writeTree(t), runs: trap.runs, base: DEFAULT_BASE, series: trap.series, requests: trap.requests }).problems).toEqual([]);
	});

	test("is null for a group with no counted Run yet, although through holds the other groups' figures: a reader writing group_through_as_of_run ?? through would be wrong", async () => {
		const trap = await makeApiFixture({ failedSecondGroup: true });
		const id = trap.failedSecondGroup as string;
		const t = buildApi(sourcesOf(trap));
		const points = json(t, monthPath(id, "2026-11")).derivations.requests_v1.points as Json[];
		expect(points.map((point) => [point.group, point.counted, point.through?.runs ?? null, point.group_through_as_of_run])).toEqual([
			["A", true, 1, null],
			["B", false, 1, null],
		]);
		const derivation = requestsOf(trap.requests, id);
		// The Derivation: A's figures on A's point (the Series split later), null on B's.
		expect(derivation.points.map((point) => point.group_through?.runs ?? null)).toEqual([1, null]);
		expect(recover(t, id)).toEqual(derivation.points.map((point) => point.group_through));
		const naive = points.map((point) => point.group_through_as_of_run ?? point.through);
		expect(naive[1]).not.toEqual(derivation.points[1]?.group_through);
		// And the check, comparing with the Derivations by the same rule, finds nothing wrong.
		expect(checkApi({ tree: writeTree(t), runs: trap.runs, base: DEFAULT_BASE, series: trap.series, requests: trap.requests }).problems).toEqual([]);
	});

	test("is described in both Series schemas with both reasons it is null and the rule that recovers the Derivation's group_through", () => {
		for (const name of ["series", "series-month"]) {
			const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "api", "v1", `${name}.schema.json`), "utf8"));
			const point = schema.$defs.requests_point;
			expect(point.required).toContain("group_through_as_of_run");
			expect(point.required).not.toContain("group_through");
			const words = point.properties.group_through_as_of_run.description as string;
			expect(words).toContain("the Series had had Runs of one group only, up to and including this Run");
			expect(words).toContain("its group had had no counted Run by this Run");
			expect(words).toContain("take through for exactly those points: the points before the first point whose group differs from the first point's, in a Series whose requests_v1 groups number more than one");
			expect(words).toContain("Never substitute through for a null otherwise");
		}
	});
});

describe("the check against the tree before (--previous)", () => {
	const copyOf = (from: string): string => {
		const copy = mkdtempSync(join(tmpdir(), "api-previous-"));
		cpSync(from, copy, { recursive: true });
		return copy;
	};
	/** A copy of a tree with one month file changed, written as the build writes it, and its Series file's entry for it updated: only what `change` did differs. */
	const edited = (from: string, path: string, change: (value: Json) => void): string => {
		const copy = copyOf(from);
		const value = JSON.parse(readFileSync(join(copy, path), "utf8"));
		change(value);
		writeFileSync(join(copy, path), writerForm(path, value));
		const [, id, month] = /^v1\/series\/([^/]+)\/([^/]+)\.json$/.exec(path) as RegExpExecArray;
		const series = JSON.parse(readFileSync(join(copy, seriesPath(id as string)), "utf8"));
		const entry = (series.months as Json[]).find((one) => one.month === month) as Json;
		const bytes = readFileSync(join(copy, path));
		entry.sha256 = createHash("sha256").update(bytes).digest("hex");
		entry.bytes = bytes.length;
		writeFileSync(join(copy, seriesPath(id as string)), writerForm(seriesPath(id as string), series));
		return copy;
	};
	const unexplained = (path: string, what: string): string => `${path} changed since the previous tree in a way none of the four causes explains: ${what}`;
	const refusal = (why: string): string =>
		`no previous tree of this layout to compare this one with: ${why}. Only a human may declare a new baseline (--allow-no-previous; in the runs workflow, its input new_baseline), for the first build of a new layout or once the last tree kept has expired`;

	test("is an error when the previous tree is missing, empty, not a tree, of another layout or built for another base, unless a human declared a new baseline", () => {
		const missing = join(tmpdir(), "api-no-such-tree");
		const empty = mkdtempSync(join(tmpdir(), "api-empty-"));
		const notTree = mkdtempSync(join(tmpdir(), "api-not-tree-"));
		writeFileSync(join(notTree, "hello.txt"), "hello\n");
		const layout = copyOf(directory);
		writeFileSync(join(layout, "v1/index.json"), writerForm("v1/index.json", { ...JSON.parse(readFileSync(join(layout, "v1/index.json"), "utf8")), layout: LAYOUT + 1 }));
		const elsewhere = writeTree(buildApi({ ...sourcesOf(fixture), base: "https://staging.example.test" }));
		const cases: Array<[string, string]> = [
			[missing, `${missing} does not exist`],
			[empty, `${empty} is empty`],
			[notTree, `${notTree} holds no v1/index.json, so it is not a tree of the data API`],
			[layout, `${layout} is a tree of layout ${LAYOUT + 1}, this tree of layout ${LAYOUT}`],
			[elsewhere, `${elsewhere} was built for https://staging.example.test, this tree for ${DEFAULT_BASE}`],
		];
		for (const [previous, why] of cases) {
			const refused = checkStability(previous, directory);
			expect([refused.compared, refused.none, refused.problems]).toEqual([false, why, [refusal(why)]]);
			const declared = checkStability(previous, directory, { newBaseline: true });
			expect([declared.compared, declared.none, declared.problems]).toEqual([false, why, []]);
		}
		// A schema's bytes are not the layout: a previous tree whose schema's words differ is compared.
		const schemas = copyOf(directory);
		writeFileSync(join(schemas, "v1/schemas/series-month.schema.json"), `${readFileSync(join(schemas, "v1/schemas/series-month.schema.json"), "utf8")} `);
		expect([checkStability(schemas, directory).compared, checkStability(schemas, directory).problems]).toEqual([true, []]);
		// A new baseline declared, a tree of this layout is compared all the same.
		expect(checkStability(writeTree(beforeTree), directory, { newBaseline: true }).compared).toBe(true);
	});

	test("fails a month file whose bytes changed with no value: one space appended, alone or beside a boot summary that arrived", () => {
		const nov = monthPath(fixture.syscall, "2026-11");
		const spaced = copyOf(directory);
		writeFileSync(join(spaced, nov), `${readFileSync(join(spaced, nov), "utf8")} `);
		const size = (tree.get(nov) as Uint8Array).length;
		expect(checkStability(directory, spaced).problems).toEqual([
			unexplained(
				nov,
				`this file is not what the build writes for its own values (its members in the build's order, its white space, numbers and strings as the build writes them): it first differs at character ${size} (line ${text(tree, nov).split("\n").length}), " " where the build writes ""`,
			),
		]);
		const boots = new Map(readBootSummaries(fixture.runs));
		boots.set("boot-2026-11-13", ARRIVING);
		const arrived = writeTree(buildApi(sourcesOf(fixture, boots)));
		const memory = monthPath(fixture.memory, "2026-11");
		expect(checkStability(directory, arrived).problems).toEqual([]);
		writeFileSync(join(arrived, memory), readFileSync(join(arrived, memory), "utf8").replace('"boot_summary":null', '"boot_summary": null'));
		expect(checkStability(directory, arrived).problems).toEqual([expect.stringMatching(new RegExp(`^${memory} changed since the previous tree in a way none of the four causes explains: this file is not what the build writes for its own values`))]);
	});

	test("fails what none of the causes explains: a figure edited, a boot summary gone, a head field, a block gone, a published Run gone, a month gone", async () => {
		const syscallNov = monthPath(fixture.syscall, "2026-11");
		const figure = edited(directory, syscallNov, (value) => (value.derivations.series_v1.points[0].time_per_repetition_ns += 1));
		const ns = json(tree, syscallNov).derivations.series_v1.points[0].time_per_repetition_ns;
		const run = json(tree, syscallNov).derivations.series_v1.points[0].run;
		expect(checkStability(directory, figure).problems).toEqual([unexplained(syscallNov, `/derivations/series_v1: the point of Run ${run}: time_per_repetition_ns is ${ns + 1}, where it was ${ns}`)]);
		// A boot summary that goes back to null.
		const memoryNov = monthPath(fixture.memory, "2026-11");
		const first = json(tree, memoryNov).derivations.series_v1.points[0];
		expect(first.boot_summary).not.toBeNull();
		const gone = edited(directory, memoryNov, (value) => (value.derivations.series_v1.points[0].boot_summary = null));
		expect(checkStability(directory, gone).problems).toEqual([unexplained(memoryNov, `/derivations/series_v1: the point of Run ${first.run}: boot_summary is null, where it was ${JSON.stringify(first.boot_summary)}`)]);
		const head = edited(directory, syscallNov, (value) => (value.build = "dynamic"));
		expect(checkStability(directory, head).problems).toEqual([unexplained(syscallNov, '/build is "dynamic", where it was "static"')]);
		// A Run added to a month does not let its head change but for its count and span.
		const more = writeTree(buildApi(sourcesOf(await makeApiFixture({ nextMonth: true, extraSyscallRun: true }))));
		const headToo = edited(more, syscallNov, (value) => (value.series_url = `${DEFAULT_BASE}/elsewhere.json`));
		expect(checkStability(directory, headToo).problems).toEqual([unexplained(syscallNov, `/series_url is "${DEFAULT_BASE}/elsewhere.json", where it was "${DEFAULT_BASE}/${seriesPath(fixture.syscall)}"`)]);
		// A late Run does not let an earlier point, nor any other member of a later one, change.
		const late = writeTree(buildApi(sourcesOf(await makeApiFixture({ nextMonth: true, lateRequestsRun: true }))));
		const httpNov = monthPath(fixture.http, "2026-11");
		const httpDec = monthPath(fixture.http, "2026-12");
		const earlierRun = json(tree, httpNov).derivations.requests_v1.points[0].run;
		const earlier = edited(late, httpNov, (value) => (value.derivations.requests_v1.points[0].group = "Z"));
		expect(checkStability(directory, earlier).problems).toEqual([unexplained(httpNov, `/derivations/requests_v1: the point of Run ${earlierRun}: group is "Z", where it was "A"`)]);
		const decRun = json(tree, httpDec).derivations.requests_v1.points[0].run;
		const other = edited(late, httpDec, (value) => (value.derivations.requests_v1.points[0].exit_code = 7));
		expect(checkStability(directory, other).problems).toEqual([unexplained(httpDec, `/derivations/requests_v1: the point of Run ${decRun}: exit_code is 7, where it was 0`)]);
		// A Method's block that goes; and one that comes to a month although the Series was already derived by it.
		const withRun = await makeApiFixture({ nextMonth: true, methodLater: true, methodLaterRun: true });
		const both = writeTree(buildApi(sourcesOf(withRun)));
		const without = writeTree(buildApi(sourcesOf(await makeApiFixture({ nextMonth: true, methodLater: true }))));
		const nov = monthPath(withRun.methodLater as string, "2026-11");
		expect(checkStability(both, without).problems).toContain(unexplained(nov, "/derivations/requests_v1 is gone: a Method that derives a Series goes on deriving it"));
		const partial = edited(both, nov, (value) => delete value.derivations.requests_v1);
		expect(checkStability(partial, both).problems).toEqual([unexplained(nov, `/derivations/requests_v1 is new to this month file, but the previous tree's Series ${withRun.methodLater} was already derived by it`)]);
		// A published Run that is gone, and a month file that is gone.
		const lateMemory = writeTree(buildApi(sourcesOf(await makeApiFixture({ nextMonth: true, lateRun: true }))));
		const lateRun = seriesOf((await makeApiFixture({ nextMonth: true, lateRun: true })).series, fixture.memory).points.find((point) => point.started_at.startsWith("2026-11-20"))?.run;
		expect(checkStability(lateMemory, directory).problems).toContain(unexplained(memoryNov, `/derivations/series_v1: Run ${lateRun}, published in this month file, is no longer in it: a published Run never disappears`));
		expect(checkStability(directory, writeTree(beforeTree)).problems).toEqual(
			[monthPath(fixture.http, "2026-12"), monthPath(fixture.memory, "2026-12")].sort().map((path) => `${path} was in the previous tree and is not in this one: a month file, once written, stays`),
		);
	});

	test("is the command's --previous, which lists each changed month file by cause and what it cannot establish, and --allow-no-previous, which says plainly that nothing was compared", async () => {
		const args = ["scripts/check-api.ts", "--tree", directory, "--derivations", fixture.derivationsPath, "--requests-derivations", fixture.requestsPath, "--runs", fixture.runs];
		const summary = join(mkdtempSync(join(tmpdir(), "api-summary-")), "summary");
		const passed = Bun.spawnSync([process.execPath, ...args, "--previous", writeTree(beforeTree)], { cwd: ROOT, env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
		expect(passed.stderr.toString()).toBe("");
		expect(passed.exitCode).toBe(0);
		expect(passed.stdout.toString()).toContain(`(layout ${LAYOUT} here, ${LAYOUT} there): 3 month files in both, 3 the same byte for byte, 0 changed for a cause, 2 new`);
		expect(passed.stdout.toString()).toContain(`  ${NOT_ESTABLISHED}\n`);
		expect(passed.stdout.toString()).toContain("no past month changed since");
		// The same words in the step's summary.
		expect(readFileSync(summary, "utf8")).toContain("### The data API against the tree before");
		expect(readFileSync(summary, "utf8")).toContain(NOT_ESTABLISHED);
		// A tree whose November gained a Run: listed under (a).
		const more = await makeApiFixture({ nextMonth: true, extraSyscallRun: true });
		const moreTree = writeTree(buildApi(sourcesOf(more)));
		const moreArgs = ["scripts/check-api.ts", "--tree", moreTree, "--derivations", more.derivationsPath, "--requests-derivations", more.requestsPath, "--runs", more.runs];
		const listed = Bun.spawnSync([process.execPath, ...moreArgs, "--previous", directory], { cwd: ROOT });
		expect(listed.exitCode).toBe(0);
		expect(listed.stdout.toString()).toContain(`  (a) a Run that started in its month was added: 1 month file\n      ${monthPath(fixture.syscall, "2026-11")}: Run `);
		const failed = Bun.spawnSync([process.execPath, ...args.map((arg) => (arg === directory ? writeTree(beforeTree) : arg)), "--previous", directory], { cwd: ROOT });
		expect(failed.exitCode).toBe(1);
		expect(failed.stderr.toString()).toContain("was in the previous tree and is not in this one");
		const missing = join(tmpdir(), "api-no-such-tree");
		const refused = Bun.spawnSync([process.execPath, ...args, "--previous", missing], { cwd: ROOT });
		expect(refused.exitCode).toBe(1);
		expect(refused.stderr.toString()).toContain(refusal(`${missing} does not exist`));
		const declaredSummary = join(mkdtempSync(join(tmpdir(), "api-summary-")), "summary");
		const allowed = Bun.spawnSync([process.execPath, ...args, "--previous", missing, "--allow-no-previous"], { cwd: ROOT, env: { ...process.env, GITHUB_STEP_SUMMARY: declaredSummary } });
		expect(allowed.exitCode).toBe(0);
		expect(allowed.stdout.toString()).toContain(`past months: not compared with ${missing}: ${missing} does not exist (layout ${LAYOUT} here)`);
		expect(allowed.stdout.toString()).toContain("  a new baseline was declared by hand (--allow-no-previous): this tree is the baseline the next is compared with");
		expect(allowed.stdout.toString()).toContain("  published Series and Runs: none to compare, there being no previous tree to read");
		expect(allowed.stdout.toString()).toContain("past months not compared (a new baseline, declared by --allow-no-previous), no published Series or Run missing");
		expect(readFileSync(declaredSummary, "utf8")).toContain("a new baseline was declared by hand (--allow-no-previous)");
		const alone = Bun.spawnSync([process.execPath, ...args, "--allow-no-previous"], { cwd: ROOT });
		expect(alone.exitCode).toBe(2);
	});
});

describe("a Series file does not grow with its Runs", () => {
	/** A JSON value's shape: its objects' keys, its arrays' lengths, and each string's length and each other leaf's type. */
	const shape = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(shape)
			: typeof value === "object" && value !== null
				? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]))
				: typeof value === "string"
					? `string of ${value.length}`
					: typeof value;
	const withoutMonths = (file: Json): Json => {
		const { months: _months, ...rest } = file;
		return rest;
	};
	const N = 24;
	const sizes = [N, 8 * N, 24 * N];
	const built: Array<{ count: number; fixture: LongFixture; tree: Map<string, Uint8Array> }> = [];
	beforeAll(async () => {
		for (const count of sizes) {
			const long = await makeLongFixture(count);
			built.push({ count, fixture: long, tree: buildApi(sourcesOf(long)) });
		}
	});

	test(`with ${sizes.join(", ")} Runs a Series, four a day, its Series file keeps one shape, and gains only a month's entry a month`, () => {
		for (const key of ["syscall", "http"] as const) {
			const files = built.map(({ fixture: long, tree: t }) => ({ text: text(t, seriesPath(long[key])), json: json(t, seriesPath(long[key])) }));
			expect(files.map((file) => file.json.months.length)).toEqual([1, 2, 5]);
			expect(files.map((file) => file.json.runs)).toEqual(sizes);
			for (const file of files.slice(1)) expect(shape(withoutMonths(file.json))).toEqual(shape(withoutMonths(files[0]?.json as Json)));
			// In bytes, what is not a month's entry differs only by the digits of its numbers: a count 24 times as large has at most two digits more.
			const outside = (file: { text: string }): number => file.text.split("\n").filter((line) => !line.startsWith('    {"month":')).join("\n").length;
			const numbers = (value: unknown): number =>
				Array.isArray(value) ? value.reduce((sum: number, item) => sum + numbers(item), 0) : typeof value === "object" && value !== null ? numbers(Object.values(value)) : typeof value === "number" ? 1 : 0;
			const first = files[0] as (typeof files)[number];
			for (const file of files.slice(1)) expect(Math.abs(outside(file) - outside(first))).toBeLessThanOrEqual(2 * numbers(withoutMonths(first.json)));
			// And a month's entry is one line of the same length, whatever the month.
			const entries = files.flatMap((file) =>
				file.text
					.split("\n")
					.filter((line) => line.startsWith('    {"month":'))
					.map((line) => line.replace(/,$/, "").replace(/"runs":[0-9]+/, '"runs":0').replace(/"bytes":[0-9]+/, '"bytes":0').length),
			);
			expect(new Set(entries).size).toBe(1);
			// The month files carry the growth.
			const last = built[2] as (typeof built)[number];
			const months = json(last.tree, seriesPath(last.fixture[key])).months as Json[];
			expect(months.reduce((sum, entry) => sum + entry.runs, 0)).toBe(24 * N);
			expect(months.map((entry) => entry.month)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
		}
	});

	test("its newest points are the newest 12 of its month files' points, and the check finds no problem", () => {
		const { fixture: long, tree: t } = built[1] as (typeof built)[number];
		const months = json(t, seriesPath(long.http)).months as Json[];
		for (const key of ["series_v1", "requests_v1"]) {
			const points = months.flatMap((entry) => json(t, monthPath(long.http, entry.month)).derivations[key].points);
			expect(json(t, seriesPath(long.http)).derivations[key].newest_points).toEqual(points.slice(-12));
		}
		const result = checkApi({ tree: writeTree(t), runs: long.runs, base: DEFAULT_BASE, series: long.series, requests: long.requests });
		expect(result.problems).toEqual([]);
	});
});

describe("the build refuses Derivations whose lists the tree leaves out would not be recoverable", () => {
	test("Runs out of time order, a start not as the Run schema writes it, a percentile's or a group's Runs that its points do not give, a differed entry of another pair", () => {
		const order = sourcesOf(fixture);
		const memory = seriesOf(order.series, fixture.memory);
		[memory.points[0], memory.points[1]] = [memory.points[1] as (typeof memory.points)[number], memory.points[0] as (typeof memory.points)[number]];
		[memory.runs[0], memory.runs[1]] = [memory.runs[1] as (typeof memory.runs)[number], memory.runs[0] as (typeof memory.runs)[number]];
		expect(() => buildApi(order)).toThrow(`Series ${fixture.memory}: point 1 started before point 0: its points are not in time order`);
		const start = sourcesOf(fixture);
		(seriesOf(start.series, fixture.syscall).points[0] as Json).started_at = "2026-11-12T04:13:00Z";
		expect(() => buildApi(start)).toThrow("is not a Run's start as the Run schema writes it");
		const stat = sourcesOf(fixture);
		seriesOf(stat.series, fixture.memory).percentiles.time_per_repetition_ns?.runs.pop();
		expect(() => buildApi(stat)).toThrow(`Series ${fixture.memory}: series v1's percentiles of time_per_repetition_ns counts 4 Runs and lists 3`);
		const swapped = sourcesOf(fixture);
		const runs = seriesOf(swapped.series, fixture.memory).percentiles.time_per_repetition_ns?.runs as string[];
		runs[0] = seriesOf(swapped.series, fixture.memory).points[3]?.run as string;
		expect(() => buildApi(swapped)).toThrow(`Series ${fixture.memory}: series v1's percentiles of time_per_repetition_ns lists other Runs than its points recover`);
		const group = sourcesOf(fixture);
		requestsOf(group.requests, fixture.http).groups[0]?.runs.reverse();
		expect(() => buildApi(group)).toThrow(`Series ${fixture.http}: requests v1's group A lists other Runs than its points recover`);
		const pair = sourcesOf(fixture);
		(seriesOf(pair.series, fixture.memory).differed[0] as Json).to = "another";
		expect(() => buildApi(pair)).toThrow(`Series ${fixture.memory}: series v1's differed entry 0 is not of points 0 and 1`);
	});

	test("a group_through, before the Series' first Run of a second group, that is not its through: the tree's null would lose it", () => {
		const sources = sourcesOf(fixture);
		const point = requestsOf(sources.requests, fixture.http).points[0] as Json;
		point.group_through = { ...point.group_through, runs: 99 };
		expect(() => buildApi(sources)).toThrow(`Series ${fixture.http}: requests v1's point 0, before the Series' first Run of a second group, holds a group_through other than its through`);
		const one = sourcesOf(before);
		(requestsOf(one.requests, before.http).points[1] as Json).group_through = (requestsOf(one.requests, before.http).points[1] as Json).through;
		expect(() => buildApi(one)).toThrow(`Series ${before.http}: requests v1's point 1 holds a group_through in a Series of one group`);
	});
});

describe("the check keeps up with the months", () => {
	let runs = "";
	function check(change: (tree: string) => void, options: { series?: SeriesFile; requests?: RequestsFile } = {}): string[] {
		const copy = mkdtempSync(join(tmpdir(), "api-months-broken-"));
		cpSync(directory, copy, { recursive: true });
		runs = fixture.runs;
		change(copy);
		return checkApi({ tree: copy, runs, base: DEFAULT_BASE, series: options.series ?? fixture.series, requests: options.requests ?? fixture.requests }).problems;
	}
	const edit = (path: string, change: (value: Json) => void) => (copy: string) => {
		const value = JSON.parse(readFileSync(join(copy, path), "utf8"));
		change(value);
		writeFileSync(join(copy, path), writerForm(path, value));
	};
	const nov = (id: string): string => monthPath(id, "2026-11");
	const dec = (id: string): string => monthPath(id, "2026-12");

	test("when a Run is in the wrong month's file, in two, or in none", () => {
		const derivation = seriesOf(fixture.series, fixture.memory);
		const decemberRun = derivation.points[4]?.run as string;
		const moved = check((copy) => {
			let point: Json = {};
			edit(dec(fixture.memory), (file) => {
				point = file.derivations.series_v1.points.pop();
			})(copy);
			edit(nov(fixture.memory), (file) => file.derivations.series_v1.points.push(point))(copy);
		});
		expect(moved).toContain(`Series ${fixture.memory}: series v1's Run ${decemberRun} started in 2026-12, but is in the month file of 2026-11`);
		expect(moved).toContain(`${nov(fixture.memory)}: series_v1: /points has 5 items, not 4, as series v1's Derivation of Series ${fixture.memory} holds it for 2026-11`);
		const twice = check(edit(dec(fixture.memory), (file) => file.derivations.series_v1.points.unshift(JSON.parse(JSON.stringify(json(tree, nov(fixture.memory)).derivations.series_v1.points[3])))));
		expect(twice).toContain(`Series ${fixture.memory}: series v1's Run ${derivation.points[3]?.run} is in 2 month files: 2026-11, 2026-12`);
		const none = check(edit(nov(fixture.memory), (file) => file.derivations.series_v1.points.splice(1, 1)));
		expect(none).toContain(`Series ${fixture.memory}: series v1's Run ${derivation.points[1]?.run}, which started in 2026-11, is in no month file`);
		const foreign = check(edit(dec(fixture.http), (file) => file.derivations.requests_v1.points.push({ ...file.derivations.requests_v1.points[0], run: "not-a-run-of-it" })));
		expect(foreign).toContain(`Series ${fixture.http}: the month file of 2026-12 holds a requests v1 point of Run not-a-run-of-it, which its Derivation does not cite`);
	});

	test("when an entry of a pair is filed under another month than its later Run's", () => {
		const derivation = seriesOf(fixture.series, fixture.memory);
		const entry = derivation.differed[3] as Json;
		const misfiled = check((copy) => {
			edit(dec(fixture.memory), (file) => (file.derivations.series_v1.differed = []))(copy);
			edit(nov(fixture.memory), (file) => file.derivations.series_v1.differed.push(entry))(copy);
		});
		expect(misfiled).toContain(`${nov(fixture.memory)}: series_v1: the entry from ${entry.from} to ${entry.to} is filed under 2026-11, but ${entry.to} started in 2026-12: an entry is filed under the month of its later Run`);
		expect(misfiled).toContain(`${dec(fixture.memory)}: series_v1: /differed has 0 items, not 1, as series v1's Derivation of Series ${fixture.memory} holds the entries whose later Run started in 2026-12`);
	});

	test("when the Series file's months are not the month files of the tree, or a month file's head is not its month's", () => {
		const unlisted = check(edit(seriesPath(fixture.memory), (file) => file.months.pop()));
		expect(unlisted).toContain(`${seriesPath(fixture.memory)} does not list its month file ${dec(fixture.memory)} among its months`);
		expect(unlisted).toContain(`${seriesPath(fixture.memory)}: /months has 1 items, not 2, as its Derivations and the base make it`);
		const stray = check((copy) => writeFileSync(join(copy, monthPath(fixture.memory, "2026-10")), readFileSync(join(copy, nov(fixture.memory)))));
		expect(stray).toContain(`${monthPath(fixture.memory, "2026-10")} is in the tree, but no Run of Series ${fixture.memory} started in 2026-10`);
		expect(stray).toContain(`${seriesPath(fixture.memory)} does not list its month file ${monthPath(fixture.memory, "2026-10")} among its months`);
		const missing = check((copy) => writeFileSync(join(copy, dec(fixture.memory)), "")); // emptied: not JSON
		expect(missing[0]).toStartWith(`${dec(fixture.memory)} is not strict JSON: it is not JSON`);
		const head = check(edit(dec(fixture.http), (file) => (file.series_url = `${DEFAULT_BASE}/${seriesPath(fixture.memory)}`)));
		expect(head).toEqual([
			`${dec(fixture.http)}: /series_url is "${DEFAULT_BASE}/${seriesPath(fixture.memory)}", not "${DEFAULT_BASE}/${seriesPath(fixture.http)}", as its Derivations and the base make it`,
			// Its bytes changed, so its entry in the Series file no longer gives them.
			expect.stringMatching(new RegExp(`^${seriesPath(fixture.http)}: /months/1/sha256 is "${json(tree, seriesPath(fixture.http)).months[1].sha256}", not "[0-9a-f]{64}", as its Derivations and the base make it$`)),
		]);
		const count = check(edit(seriesPath(fixture.http), (file) => (file.months[1].runs = 2)));
		expect(count).toEqual([`${seriesPath(fixture.http)}: /months/1/runs is 2, not 1, as its Derivations and the base make it`]);
	});

	test("when what the Series file leaves out is not what its month files' points recover", () => {
		const stat = structuredClone(fixture.series);
		const runs = seriesOf(stat, fixture.memory).percentiles.time_per_repetition_ns?.runs as string[];
		runs[0] = seriesOf(stat, fixture.memory).points[3]?.run as string;
		expect(check(() => {}, { series: stat })).toEqual([
			`${seriesPath(fixture.memory)}: series v1's percentiles of time_per_repetition_ns lists other Runs in its Derivation than the counted points of the month files (/0 is ${JSON.stringify(runs[0])}, not ${JSON.stringify(seriesOf(fixture.series, fixture.memory).points[0]?.run)}), so the Series file cannot leave it out`,
		]);
		const group = structuredClone(fixture.requests);
		requestsOf(group, fixture.http).groups[1]?.runs.push("another");
		expect(check(() => {}, { requests: group })).toEqual([
			`${seriesPath(fixture.http)}: requests v1's group B lists other Runs in its Derivation than the points of group B of the month files (/ has 2 items, not 1), so the Series file cannot leave it out`,
		]);
		const through = structuredClone(fixture.requests);
		const point = requestsOf(through, fixture.http).points[1] as Json;
		point.group_through = { ...point.group_through, requests: 0 };
		expect(check(() => {}, { requests: through })).toEqual([
			`requests v1's Derivation of Series ${fixture.http} holds, at point 1, before the Series' first Run of a second group, a group_through other than its through: the tree's null would lose it`,
		]);
	});

	test("when a point's start, which files it under its month, is not its Run file's own", () => {
		// The Derivation's point moved from November 12 to October 31, its Run file and sha256 intact: the build files it under October.
		const series = structuredClone(fixture.series);
		const point = seriesOf(series, fixture.memory).points[0] as Json;
		expect(point.started_at).toBe("2026-11-12T04:12:00.000000000Z");
		point.started_at = "2026-10-31T04:12:00.000000000Z";
		const moved = buildApi({ ...sourcesOf(fixture), series });
		expect(json(moved, seriesPath(fixture.memory)).months.map((entry: Json) => entry.month)).toEqual(["2026-10", "2026-11", "2026-12"]);
		const problems = checkApi({ tree: writeTree(moved), runs: fixture.runs, base: DEFAULT_BASE, series, requests: fixture.requests }).problems;
		const wrong = `the Run file ${point.path} in the checkout started at 2026-11-12T04:12:00.000000000Z, not 2026-10-31T04:12:00.000000000Z: the point's month must be its Run's own`;
		expect(problems).toEqual([`${monthPath(fixture.memory, "2026-10")}: series_v1's point ${point.run}: ${wrong}`, `${seriesPath(fixture.memory)}: series_v1: newest_points's point ${point.run}: ${wrong}`]);
	});

	test("when a file is over its kind's ceiling, saying what to do", () => {
		expect(CEILINGS.map((ceiling) => [ceiling.kind, ceiling.bytes])).toEqual([
			["the table of contents", 100_000],
			["the list of Series", 1_000_000],
			["a benchmark's list of Series", 256_000],
			["a Series file", 1_000_000],
			["a month file", 5_000_000],
			["a price file", 1_000_000],
			["a schema", 256_000],
		]);
		// White space after the value: still the same JSON, and as many bytes as wanted; and no longer what the build writes for it.
		const pad = (path: string, bytes: number) => (copy: string) => writeFileSync(join(copy, path), Buffer.concat([readFileSync(join(copy, path)), Buffer.alloc(bytes, 0x20)]));
		const notWritten = (path: string) => expect.stringMatching(new RegExp(`^${path.replaceAll(".", "\\.")} is not what the build writes for its own values`));
		const index = check(pad("v1/index.json", 100_000));
		const size = (tree.get("v1/index.json") as Uint8Array).length + 100_000;
		expect(index).toEqual([`v1/index.json is ${size} bytes, over the ceiling of 100000 for the table of contents: ${CEILINGS[0]?.whenHit}`, notWritten("v1/index.json")]);
		const series = check(pad(seriesPath(fixture.memory), 1_000_000));
		expect(series).toEqual([
			expect.stringMatching(new RegExp(`^${seriesPath(fixture.memory)} is [0-9]+ bytes, over the ceiling of 1000000 for a Series file: the number of points in it is bounded \\(newest_runs\\)`)),
			notWritten(seriesPath(fixture.memory)),
		]);
		const month = check(pad(dec(fixture.http), 5_000_000));
		expect(month).toEqual([
			expect.stringMatching(new RegExp(`^${dec(fixture.http)} is [0-9]+ bytes, over the ceiling of 5000000 for a month file: `)),
			notWritten(dec(fixture.http)),
			// Padded, its bytes are no longer those its Series file gives.
			expect.stringMatching(new RegExp(`^${seriesPath(fixture.http)}: /months/1/sha256 is `)),
		]);
		// Every file of the tree is of a kind with a ceiling.
		for (const path of tree.keys()) expect(CEILINGS.filter((ceiling) => ceiling.path.test(path)).length).toBe(1);
	});
});

describe("the published words name only what a reader can fetch", () => {
	/** An internal name: the Runs repository, the bucket, GitHub, a script's path, an issue's number. */
	const INTERNAL = /Runs repository|bucket|github|scripts\/|[A-Za-z0-9_-]+\.(?:ts|py)\b|#[0-9]+/i;
	const strings = (value: unknown, out: string[] = []): string[] => {
		if (typeof value === "string") out.push(value);
		else if (Array.isArray(value)) for (const item of value) strings(item, out);
		else if (typeof value === "object" && value !== null) {
			for (const [key, item] of Object.entries(value)) {
				out.push(key);
				strings(item, out);
			}
		}
		return out;
	};

	test("no description or title in a published schema names one", () => {
		const found: string[] = [];
		const walk = (node: unknown, at: string): void => {
			if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${at}/${i}`));
			else if (typeof node === "object" && node !== null) {
				for (const [key, item] of Object.entries(node)) {
					if ((key === "description" || key === "title") && typeof item === "string" && INTERNAL.test(item)) found.push(`${at}/${key}: ${item.match(INTERNAL)?.[0]}`);
					walk(item, `${at}/${key}`);
				}
			}
		};
		for (const source of ["schemas/api/v1/index.schema.json", "schemas/api/v1/series-list.schema.json", "schemas/api/v1/benchmark.schema.json", "schemas/api/v1/series.schema.json", "schemas/api/v1/series-month.schema.json", "schemas/prices.schema.json"]) {
			walk(JSON.parse(readFileSync(join(ROOT, source), "utf8")), source);
		}
		expect(found).toEqual([]);
	});

	test("no string the build writes names one: only what it copies from the Methods' Derivations, and the docs address it is given, are left to them", async () => {
		const edges = await makeApiFixture({ nextMonth: true, edges: true });
		const t = buildApi(sourcesOf(edges));
		const copied = new Set([...strings(edges.series), ...strings(edges.requests), "https://example.test/docs"]);
		const found: string[] = [];
		for (const [path, bytes] of t) {
			if (path.startsWith("v1/prices/") || path.startsWith("v1/schemas/")) continue;
			for (const value of strings(JSON.parse(new TextDecoder().decode(bytes)))) if (!copied.has(value) && INTERNAL.test(value)) found.push(`${path}: ${value.slice(0, 120)}`);
		}
		expect(found).toEqual([]);
		for (const words of [ABOUT, VERSIONING, FIGURES, MONTHS, EVIDENCE]) expect(words).not.toMatch(INTERNAL);
		// What it would have caught before: the words as they were.
		expect("served at the keys of LedgerMath's bucket of Runs").toMatch(INTERNAL);
		expect("each is a price file of the Runs repository, byte for byte").toMatch(INTERNAL);
	});
});

describe("no figure loses digits on its way in", () => {
	/** The fixture's file of Derivations with the first of a number token written otherwise. */
	const withToken = (from: string, to: string): string => {
		const original = readFileSync(fixture.derivationsPath, "utf8");
		expect(original).toContain(from);
		const path = join(mkdtempSync(join(tmpdir(), "api-numbers-")), "derivations.json");
		writeFileSync(path, original.replace(from, to));
		return path;
	};
	/** A token of the fixture's Derivations that occurs once: a sample's ns, as Method series v1 writes it, pretty-printed. */
	const sample = (): { token: string; at: string } => {
		const memory = seriesOf(fixture.series, fixture.memory);
		const index = fixture.series.derivations.indexOf(memory);
		const ns = memory.points[0]?.samples[0]?.ns as number;
		return { token: `"ns": ${ns}`, at: `/derivations/${index}/points/0/samples/0/ns` };
	};

	test("the build refuses a file of Derivations holding a number a double does not hold exactly, naming the file, the place and the number", () => {
		const { token, at } = sample();
		expect(readFileSync(fixture.derivationsPath, "utf8").split(token).length).toBe(2);
		for (const [number, what] of [
			["9007199254740993", "which a double does not hold exactly: it would be written 9007199254740992, another value"],
			["1e400", "past the range of a double: JavaScript reads it as Infinity, which JSON writes as null"],
			["1e-400", "which a double does not hold exactly: it would be written 0, another value"],
			["0.10000000000000001", "which a double does not hold exactly: it would be written 0.1, another value"],
		] as const) {
			const path = withToken(token, `"ns": ${number}`);
			expect(() => readDerivations(path, "series")).toThrow(`${path} cannot be read exactly: the number at ${at} is ${number}, ${what}`);
			const out = join(mkdtempSync(join(tmpdir(), "api-numbers-out-")), "api");
			const build = Bun.spawnSync([process.execPath, "scripts/build-api.ts", "--derivations", path, "--requests-derivations", fixture.requestsPath, "--runs", fixture.runs, "--out", out], { cwd: ROOT });
			expect(build.exitCode).toBe(1);
			expect(build.stderr.toString()).toContain(`the number at ${at} is ${number}`);
		}
	});

	test("and takes a number written otherwise with the same value, 1e3 for 1000 or -0 for 0, writing the same tree", () => {
		const { token } = sample();
		const ns = Number(token.slice('"ns": '.length));
		const exponent = withToken(token, `"ns": ${ns / 1000}e3`);
		const negativeZero = withToken('"changed_within_run": 0', '"changed_within_run": -0');
		expect(readFileSync(negativeZero, "utf8")).toContain('"changed_within_run": -0');
		for (const path of [exponent, negativeZero]) {
			const sources = { ...sourcesOf(fixture), series: readDerivations<SeriesFile>(path, "series") };
			const again = buildApi(sources);
			for (const [file, bytes] of tree) expect([file, Buffer.from(again.get(file) as Uint8Array).equals(Buffer.from(bytes))]).toEqual([file, true]);
		}
		// JavaScript reads the -0 as -0, and writes it 0: the same value, which is all a decimal number says.
		expect(JSON.stringify(-0)).toBe("0");
	});
});

describe("the schemas of the split", () => {
	const read = (name: string): Json => JSON.parse(readFileSync(join(ROOT, "schemas", "api", "v1", `${name}.schema.json`), "utf8"));

	test("share their points' definitions word for word: what the month schema and the Series schema both define is the same", () => {
		const month = read("series-month").$defs as Json;
		const series = read("series").$defs as Json;
		const shared = Object.keys(month).filter((name) => name in series);
		expect(shared).toEqual(expect.arrayContaining(["series_point", "requests_point", "pool_summary", "point_boot_summary", "time", "url"]));
		for (const name of shared) expect([name, month[name]]).toEqual([name, series[name]]);
		// And the differed entry, which only month files hold, is the one the Series schema held before the split.
		expect(month.differed.required).toEqual(["from", "to", "facts", "sections"]);
	});

	test("a benchmark's list and the list of every Series define a row word for word, and everything a row refers to, so each writes a row in the same bytes", () => {
		const benchmark = read("benchmark").$defs as Json;
		const list = read("series-list").$defs as Json;
		expect(Object.keys(benchmark).sort()).toEqual(["bytes_per_second_summary", "method_requests", "method_series", "number_or_null", "params", "phase_stats", "request_stats", "row", "stat_summary", "time", "url"]);
		for (const name of Object.keys(benchmark)) expect([name, benchmark[name]]).toEqual([name, list[name]]);
		expect(read("benchmark").properties.series.items).toEqual(read("series-list").properties.series.items);
	});

	test("are each a valid JSON Schema, by the 2020-12 meta-schema", () => {
		const ajv = new Ajv2020({ strict: true });
		for (const source of ["schemas/api/v1/index.schema.json", "schemas/api/v1/series-list.schema.json", "schemas/api/v1/benchmark.schema.json", "schemas/api/v1/series.schema.json", "schemas/api/v1/series-month.schema.json", "schemas/prices.schema.json"]) {
			const schema = JSON.parse(readFileSync(join(ROOT, source), "utf8"));
			expect([source, ajv.validateSchema(schema)]).toEqual([source, true]);
			expect(() => ajv.compile(schema)).not.toThrow();
		}
	});
});
