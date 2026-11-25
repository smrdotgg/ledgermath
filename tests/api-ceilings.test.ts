/**
 * Layout 2 refuses for its size no tree layout 1 accepted. It added fields to
 * three kinds of file that existed at layout 1 (the table of contents, the
 * list of Series, a Series file), so each of their ceilings rose by the most
 * those fields can add, derived here from the writer: what each addition takes
 * at most as the build writes it, against the least the file's own parts took
 * at layout 1. Then the two inputs the verification of the change found,
 * which layout 1 published and layout 2 as first built refused for size, are
 * built and pass; and a tree past each new ceiling is refused.
 *
 * What one Run can add to these files is unbounded still (a string of any
 * length in its params, build, instance type or zone ID): #81's to bound.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { apiJson, apiShapes, BENCHMARKS, BENCHMARKS_LISTED_BYTES, buildApi, DEFAULT_BASE, FIGURES, LIST_PATH, readApiSchemas, SERIES_FILES, seriesPath, VERSIONING, writerForm } from "../scripts/lib/api";
import { CEILINGS, checkApi } from "../scripts/lib/api-check";
import { makeManyFixture } from "./api-fixtures";

setDefaultTimeout(300_000);

type Json = Record<string, any>;

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const ceiling = (kind: string): number => (CEILINGS.find((one) => one.kind === kind) as (typeof CEILINGS)[number]).bytes;
/** The greatest count a file can hold: 2^53 - 1, sixteen digits. */
const MAX = Number.MAX_SAFE_INTEGER;
const TIME = "2026-11-01T01:02:03.000000000Z";
const HASH = `sha256:${"0".repeat(64)}`;

/** The layout-1 ceilings: what the check refused at layout 1. */
const LAYOUT_1 = { index: 100_000, list: 1_000_000, series: 1_000_000 };
/**
 * The table of contents' words at layout 1, in bytes as written: `versioning` and `figures` of main's tests/api-golden/v1/index.json before
 * layout 2 (647 and 619). Layout 2 made both longer.
 */
const LAYOUT_1_WORDS = 647 + 619;

describe("each ceiling layout 2 raised rose by the most layout 2 can add, derived from the writer", () => {
	test("the list of Series: a row gains at most its boots, against the least a layout-1 row takes", () => {
		// The least a row takes at layout 1, as the list writes it (as JSON with no white space, 6 bytes more for its indentation, comma and line break):
		// an id, its file's address, a benchmark of one letter, no params, an empty build, no instance type or zone, one Run, and no percentile.
		const least = {
			id: "000000000000",
			url: `${DEFAULT_BASE}/v1/series/000000000000.json`,
			benchmark: "a",
			params: {},
			build: "",
			instance_type: null,
			availability_zone_id: null,
			runs: 1,
			oldest_run_started_at: TIME,
			newest_run_started_at: TIME,
			derivations: { series_v1: { method: { name: "series", version: 1 }, counted_runs: 0, failed_runs: 1, groups: 1, percentiles: { time_per_repetition_ns: null, bytes_per_second: null } } },
		};
		const line = bytes(least) + 6;
		expect(line).toBe(484);
		// boots is at most runs, so a row with d digits of boots has d digits of runs, and its counted and failed Runs take d - 1 more between them.
		let ratio = 0;
		for (let digits = 1; digits <= 16; digits++) ratio = Math.max(ratio, (`,"boots":`.length + digits) / (line + 2 * (digits - 1)));
		expect(bytes({ boots: MAX }) - bytes({})).toBe(`"boots":`.length + 16);
		const bound = Math.ceil(LAYOUT_1.list * (1 + ratio));
		expect(bound).toBe(1_048_639);
		expect([ceiling("the list of Series") >= bound, ceiling("the list of Series") - bound < 2_000]).toEqual([true, true]);
	});

	test("a Series file: a group gains at most its counts and starts, against the least a layout-1 group takes, and the file its boots", () => {
		// Method series v1 gives every group the same ten facts (methods/v1/facts.ts, splitFacts): the binary and the runner always as hashes, the
		// samples as a count, and the rest null at least. A group of requests v1 holds more than one of series v1, and comes with one.
		const least = { id: "A", facts: { binary: HASH, cpuid: null, image: null, kernel: null, lscpu: null, packages: null, process: null, runner: HASH, samples: 1, sys_cpu: null }, percentiles: { time_per_repetition_ns: null, bytes_per_second: null } };
		const line = bytes(least) + 10;
		expect(line).toBe(377);
		const added = bytes({ ...least, counted_runs: MAX, failed_runs: MAX, oldest_run_started_at: TIME, newest_run_started_at: TIME }) - bytes(least);
		expect(added).toBe(177);
		const boots = `  "boots": ${MAX},\n`.length;
		const bound = Math.ceil(LAYOUT_1.series * (1 + added / line) + boots);
		expect(bound).toBe(1_469_526);
		expect([ceiling("a Series file") >= bound, ceiling("a Series file") - bound < 2_000]).toEqual([true, true]);
	});

	test("the table of contents: at most the benchmarks at their budget, the templates and words, the new schema's entry and the longer words", () => {
		const shapes = apiShapes(readApiSchemas());
		const name = "n".repeat(64);
		const entry = { name, url: `${DEFAULT_BASE}/v1/benchmarks/${name}.json`, series: MAX, runs: MAX, newest_run_started_at: TIME };
		const list: Json[] = [];
		while ((list.length + 1) * (bytes(entry) + 6) <= BENCHMARKS_LISTED_BYTES) list.push(entry);
		const before = { schema: "s", series: { url: "u", schema_url: "u", count: MAX, series_file_schema_url: "u", month_file_schema_url: "u" } };
		const after = {
			...before,
			series: { ...before.series, series_file_url_template: `${DEFAULT_BASE}/v1/series/{id}.json`, about: SERIES_FILES },
			benchmarks: { about: BENCHMARKS, schema_url: `${DEFAULT_BASE}/v1/schemas/benchmark.schema.json`, benchmark_file_url_template: `${DEFAULT_BASE}/v1/benchmarks/{benchmark}.json`, count: MAX, unlisted: MAX, left_out: MAX, list },
		};
		const schema = `    {"name":"benchmark","describes":"v1/benchmarks/<benchmark>.json","url":"${DEFAULT_BASE}/v1/schemas/benchmark.schema.json"},\n`.length;
		const words = bytes(VERSIONING) + bytes(FIGURES) - LAYOUT_1_WORDS;
		const added = apiJson(after, shapes.index).length - apiJson(before, shapes.index).length + schema + words;
		expect(added).toBe(19_851);
		const bound = LAYOUT_1.index + added;
		expect([ceiling("the table of contents") >= bound, ceiling("the table of contents") - bound < 2_000]).toEqual([true, true]);
	});
});

/** A tree built from many valid Runs, written out, and what the check says of it. */
async function built(entries: Parameters<typeof makeManyFixture>[0]) {
	const fixture = await makeManyFixture(entries);
	const tree = buildApi({ base: DEFAULT_BASE, docs: "https://example.test/docs", series: fixture.series, requests: fixture.requests, prices: [], boots: new Map(), bootFiles: [], schemas: readApiSchemas() });
	const directory = mkdtempSync(join(tmpdir(), "api-ceilings-tree-"));
	for (const [path, content] of tree) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
	const problems = checkApi({ tree: directory, runs: fixture.runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems;
	return { tree, problems, json: (path: string): Json => JSON.parse(new TextDecoder().decode(tree.get(path))) };
}

/** A file's size as layout 1 wrote it: without what layout 2 added, written by the same writer, in the same order. */
function layout1Size(path: string, value: Json): number {
	const out = structuredClone(value);
	if (path === LIST_PATH) for (const row of out.series) delete row.boots;
	else {
		delete out.boots;
		for (const block of Object.values(out.derivations) as Json[]) for (const group of block.groups) for (const key of ["counted_runs", "failed_runs", "oldest_run_started_at", "newest_run_started_at"]) delete group[key];
	}
	return new TextEncoder().encode(writerForm(path, out)).length;
}

describe("trees layout 1 accepted are accepted; trees past the new ceilings are refused", () => {
	/** 64 Series of one benchmark, one Run each, each with a param of `length` characters: a list near its ceiling. */
	const sixtyFour = (length: number) => Array.from({ length: 64 }, (_, i) => ({ benchmark: "test", params: { n: String(i).padStart(3, "0"), p: "x".repeat(length) } }));
	/** One Series of twelve Runs, each on another processor (so a group each), with a param of `length` characters: a Series file near its ceiling. */
	const twelve = (length: number) => Array.from({ length: 12 }, (_, i) => ({ benchmark: "test", params: { p: "x".repeat(length) }, startedAt: `2026-11-01T01:${String(i).padStart(2, "0")}:03Z`, processor: `processor ${i}` }));

	test("64 Series whose list layout 1 wrote within its ceiling, and layout 2 writes past the old one: accepted", async () => {
		const small = await built(sixtyFour(0));
		const grow = LAYOUT_1.list - layout1Size(LIST_PATH, small.json(LIST_PATH));
		const length = Math.floor(grow / 64);
		const { tree, problems, json } = await built(sixtyFour(length));
		const before = layout1Size(LIST_PATH, json(LIST_PATH));
		const now = (tree.get(LIST_PATH) as Uint8Array).length;
		expect([before <= LAYOUT_1.list, now > LAYOUT_1.list, now <= ceiling("the list of Series")]).toEqual([true, true, true]);
		expect(problems).toEqual([]);
	});

	test("a Series of twelve groups whose file layout 1 wrote within its ceiling, and layout 2 writes past the old one: accepted", async () => {
		const small = await built(twelve(1));
		const first = (small.json(LIST_PATH).series[0] as Json).id as string;
		// A few bytes short of the layout-1 ceiling: the month files' sizes, which the Series file lists, gain digits as the param grows.
		const length = LAYOUT_1.series - layout1Size(seriesPath(first), small.json(seriesPath(first))) - 20;
		const { tree, problems, json } = await built(twelve(length));
		// The Series' id is its key's, which holds its params: another Series.
		const id = (json(LIST_PATH).series[0] as Json).id as string;
		expect(json(seriesPath(id)).derivations.series_v1.groups.length).toBe(12);
		const before = layout1Size(seriesPath(id), json(seriesPath(id)));
		const now = (tree.get(seriesPath(id)) as Uint8Array).length;
		expect([before <= LAYOUT_1.series, before > LAYOUT_1.series - 100, now > LAYOUT_1.series, now <= ceiling("a Series file")]).toEqual([true, true, true, true]);
		expect(problems).toEqual([]);
	});

	test("past the new ceilings, each is refused", async () => {
		const list = await built(sixtyFour(Math.ceil(ceiling("the list of Series") / 64)));
		expect(list.problems).toContainEqual(expect.stringMatching(new RegExp(`^v1/series\\.json is [0-9]+ bytes, over the ceiling of ${ceiling("the list of Series")} for the list of Series`)));
		const series = await built(twelve(ceiling("a Series file")));
		expect(series.problems).toContainEqual(expect.stringMatching(new RegExp(`^v1/series/[0-9a-f]{12}\\.json is [0-9]+ bytes, over the ceiling of ${ceiling("a Series file")} for a Series file`)));
	});
});
