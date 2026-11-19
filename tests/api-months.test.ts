/**
 * The data API's split of each Series by month (ADR-0030): what goes in a
 * month file and what stays in the Series file, that a month file does not
 * change once its month has passed, that a Series file does not grow with its
 * Runs, the ceilings on every file's size, the guard that no figure loses
 * digits on its way in, and the check's rules for all of it.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Ajv2020 from "ajv/dist/2020";

import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import { type ApiSources, apiJson, buildApi, DEFAULT_BASE, monthPath, NEWEST_RUNS, readApiSchemas, readBootSummaries, readDerivations, readPriceFiles, seriesPath } from "../scripts/lib/api";
import { CEILINGS, checkApi, checkStability } from "../scripts/lib/api-check";
import { type ApiFixture, type LongFixture, makeApiFixture, makeLongFixture } from "./api-fixtures";

setDefaultTimeout(120_000);

const ROOT = join(import.meta.dir, "..");

type Json = Record<string, any>;

function sourcesOf(fixture: { series: SeriesFile; requests: RequestsFile; runs: string }, boots?: Map<string, string>): ApiSources {
	return {
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: structuredClone(fixture.series),
		requests: structuredClone(fixture.requests),
		prices: readPriceFiles(fixture.runs),
		boots: boots ?? readBootSummaries(fixture.runs),
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
		expect(file.months).toEqual([
			{ month: "2026-11", url: `${DEFAULT_BASE}/${monthPath(fixture.memory, "2026-11")}`, runs: 4, oldest_run_started_at: "2026-11-12T04:12:00.000000000Z", newest_run_started_at: "2026-11-15T04:12:00.000000000Z" },
			{ month: "2026-12", url: `${DEFAULT_BASE}/${monthPath(fixture.memory, "2026-12")}`, runs: 1, oldest_run_started_at: "2026-12-01T04:12:00.000000000Z", newest_run_started_at: "2026-12-01T04:12:00.000000000Z" },
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

describe("a month file does not change once its month has passed", () => {
	test("a Run in a later month leaves every earlier month file of every Series byte for byte, even one that splits a Series into groups", () => {
		const earlier = [...beforeTree.keys()].filter((path) => /^v1\/series\/[^/]+\/[^/]+\.json$/.test(path));
		expect(earlier.length).toBe(3);
		for (const path of earlier) expect(text(tree, path)).toBe(text(beforeTree, path));
		// The Series files of the two Series that gained a Run change; the third's does not.
		expect(text(tree, seriesPath(fixture.memory))).not.toBe(text(beforeTree, seriesPath(fixture.memory)));
		expect(text(tree, seriesPath(fixture.http))).not.toBe(text(beforeTree, seriesPath(fixture.http)));
		expect(text(tree, seriesPath(fixture.syscall))).toBe(text(beforeTree, seriesPath(fixture.syscall)));
	});

	test("requests v1's group_through is written as it stood through each Run: the Derivation's changes on November's points when December's Run splits the Series, the tree's does not", () => {
		const was = requestsOf(before.requests, before.http);
		const now = requestsOf(fixture.requests, fixture.http);
		expect(was.groups.length).toBe(1);
		expect(now.groups.map((group) => group.id)).toEqual(["A", "B"]);
		// The Derivation: null on November's points while the Series had one group; their through once it has two.
		expect(was.points.map((point) => point.group_through)).toEqual([null, null]);
		expect(now.points.slice(0, 2).map((point) => point.group_through)).toEqual(now.points.slice(0, 2).map((point) => point.through));
		expect(now.points[2]?.group).toBe("B");
		expect(now.points[2]?.group_through).not.toBeNull();
		// The tree: null on November's points either way, and December's as the Derivation has it.
		const november = json(tree, monthPath(fixture.http, "2026-11")).derivations.requests_v1.points as Json[];
		expect(november.map((point) => point.group_through)).toEqual([null, null]);
		expect(json(tree, monthPath(fixture.http, "2026-12")).derivations.requests_v1.points[0].group_through).toEqual(now.points[2]?.group_through);
		expect(json(tree, seriesPath(fixture.http)).derivations.requests_v1.newest_points.map((point: Json) => point.group_through)).toEqual([null, null, now.points[2]?.group_through]);
	});

	test("its one other change: a boot summary that arrives turns its points' boot_summary from null into its address, and nothing else", () => {
		const boots = new Map(readBootSummaries(fixture.runs));
		boots.set("boot-2026-11-13", "boots/2026/11/13/boot-2026-11-13.json");
		const later = buildApi(sourcesOf(fixture, boots));
		const path = monthPath(fixture.memory, "2026-11");
		expect(text(later, path)).not.toBe(text(tree, path));
		const a = json(tree, path);
		const b = json(later, path);
		b.derivations.series_v1.points = b.derivations.series_v1.points.map((point: Json) => (point.boot === "boot-2026-11-13" ? { ...point, boot_summary: null } : point));
		expect(b).toEqual(a);
		expect(text(later, monthPath(fixture.memory, "2026-12"))).toBe(text(tree, monthPath(fixture.memory, "2026-12")));
	});
});

describe("the check against the tree readers were last served (--previous)", () => {
	test("passes a tree whose past months changed only by a Run of theirs or a boot summary that arrived", async () => {
		expect(checkStability(writeTree(beforeTree), directory)).toEqual([]);
		const sameMonth = buildApi(sourcesOf(await makeApiFixture({ nextMonth: true, extraSyscallRun: true })));
		expect(checkStability(directory, writeTree(sameMonth))).toEqual([]);
		const boots = new Map(readBootSummaries(fixture.runs));
		boots.set("boot-2026-11-13", "boots/2026/11/13/boot-2026-11-13.json");
		expect(checkStability(directory, writeTree(buildApi(sourcesOf(fixture, boots))))).toEqual([]);
	});

	test("reports a past month that changed otherwise: a Run that arrived after a later Run of its Series, a figure edited, a month gone", async () => {
		const late = await makeApiFixture({ nextMonth: true, lateRun: true });
		const lateTree = buildApi(sourcesOf(late));
		const december = monthPath(fixture.memory, "2026-12");
		const from = seriesOf(late.series, fixture.memory).differed[4]?.from;
		expect(checkStability(directory, writeTree(lateTree))).toEqual([
			`${december} changed since the previous tree although no Run of its month was added: /derivations/series_v1/differed/0/from is ${JSON.stringify(from)}, not ${JSON.stringify(seriesOf(fixture.series, fixture.memory).differed[3]?.from)}`,
		]);
		const edited = mkdtempSync(join(tmpdir(), "api-edited-"));
		cpSync(directory, edited, { recursive: true });
		const path = monthPath(fixture.syscall, "2026-11");
		const value = json(tree, path);
		value.derivations.series_v1.points[0].time_per_repetition_ns += 1;
		writeFileSync(join(edited, path), apiJson(value));
		expect(checkStability(directory, edited)).toEqual([expect.stringMatching(new RegExp(`^${path} changed since the previous tree although no Run of its month was added: /derivations/series_v1/points/0/time_per_repetition_ns is `))]);
		expect(checkStability(directory, writeTree(beforeTree))).toEqual([monthPath(fixture.http, "2026-12"), december].sort().map((gone) => `${gone} was in the previous tree and is not in this one: a month file, once written, stays`));
	});

	test("is the command's --previous", () => {
		const args = ["scripts/check-api.ts", "--tree", directory, "--derivations", fixture.derivationsPath, "--requests-derivations", fixture.requestsPath, "--runs", fixture.runs];
		const passed = Bun.spawnSync([process.execPath, ...args, "--previous", writeTree(beforeTree)], { cwd: ROOT });
		expect(passed.stderr.toString()).toBe("");
		expect(passed.stdout.toString()).toContain("no past month changed since");
		const failed = Bun.spawnSync([process.execPath, ...args.map((arg) => (arg === directory ? writeTree(beforeTree) : arg)), "--previous", directory], { cwd: ROOT });
		expect(failed.exitCode).toBe(1);
		expect(failed.stderr.toString()).toContain("was in the previous tree and is not in this one");
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
			const entries = files.flatMap((file) => file.text.split("\n").filter((line) => line.startsWith('    {"month":')).map((line) => line.replace(/,$/, "").replace(/"runs":[0-9]+/, '"runs":0').length));
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
		writeFileSync(join(copy, path), apiJson(value));
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
		expect(head).toEqual([`${dec(fixture.http)}: /series_url is "${DEFAULT_BASE}/${seriesPath(fixture.memory)}", not "${DEFAULT_BASE}/${seriesPath(fixture.http)}", as its Derivations and the base make it`]);
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

	test("when a file is over its kind's ceiling, saying what to do", () => {
		expect(CEILINGS.map((ceiling) => [ceiling.kind, ceiling.bytes])).toEqual([
			["the table of contents", 100_000],
			["the list of Series", 1_000_000],
			["a Series file", 1_000_000],
			["a month file", 5_000_000],
			["a price file", 1_000_000],
			["a schema", 256_000],
		]);
		// White space after the value: still the same JSON, and as many bytes as wanted.
		const pad = (path: string, bytes: number) => (copy: string) => writeFileSync(join(copy, path), Buffer.concat([readFileSync(join(copy, path)), Buffer.alloc(bytes, 0x20)]));
		const index = check(pad("v1/index.json", 100_000));
		const size = (tree.get("v1/index.json") as Uint8Array).length + 100_000;
		expect(index).toEqual([`v1/index.json is ${size} bytes, over the ceiling of 100000 for the table of contents: ${CEILINGS[0]?.whenHit}`]);
		const series = check(pad(seriesPath(fixture.memory), 1_000_000));
		expect(series).toEqual([expect.stringMatching(new RegExp(`^${seriesPath(fixture.memory)} is [0-9]+ bytes, over the ceiling of 1000000 for a Series file: it does not grow with its Runs`))]);
		const month = check(pad(dec(fixture.http), 5_000_000));
		expect(month).toEqual([expect.stringMatching(new RegExp(`^${dec(fixture.http)} is [0-9]+ bytes, over the ceiling of 5000000 for a month file: `))]);
		// Every file of the tree is of a kind with a ceiling.
		for (const path of tree.keys()) expect(CEILINGS.filter((ceiling) => ceiling.path.test(path)).length).toBe(1);
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

	test("are each a valid JSON Schema, by the 2020-12 meta-schema", () => {
		const ajv = new Ajv2020({ strict: true });
		for (const source of ["schemas/api/v1/index.schema.json", "schemas/api/v1/series-list.schema.json", "schemas/api/v1/series.schema.json", "schemas/api/v1/series-month.schema.json", "schemas/prices.schema.json"]) {
			const schema = JSON.parse(readFileSync(join(ROOT, source), "utf8"));
			expect([source, ajv.validateSchema(schema)]).toEqual([source, true]);
			expect(() => ajv.compile(schema)).not.toThrow();
		}
	});
});
