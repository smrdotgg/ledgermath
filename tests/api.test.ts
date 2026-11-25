import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DerivationsFile as RequestsFile } from "../methods/requests/v1/output";
import type { DerivationsFile as SeriesFile } from "../methods/v1/output";
import {
	type ApiSources,
	apiJson,
	buildApi,
	DEFAULT_BASE,
	monthPath,
	readApiSchemas,
	readBootFiles,
	readBootSummaries,
	readPriceFiles,
	seriesPath,
	writerForm,
} from "../scripts/lib/api";
import { checkApi, closeSchema, difference } from "../scripts/lib/api-check";
import { ADDRESS_PARAM, type ApiFixture, makeApiFixture, OVERFLOW_X } from "./api-fixtures";

// Deriving the hand-made Runs, and reading a whole tree back, can take longer than bun's five-second default on a loaded machine.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");

type Json = Record<string, any>;

function sourcesOf(fixture: ApiFixture, base = DEFAULT_BASE): ApiSources {
	return {
		base,
		docs: "https://example.test/docs",
		series: structuredClone(fixture.series),
		requests: structuredClone(fixture.requests),
		prices: readPriceFiles(fixture.runs),
		boots: readBootSummaries(fixture.runs),
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
/** Every Run of the fixture's Series started in November 2026: each Series has that one month file. */
const NOVEMBER = "2026-11";
const november = (id: string): string => monthPath(id, NOVEMBER);
/** A stat of the Derivations as the Series file writes it: without the Runs behind it. */
const summary = (stat: Json | null): Json | null => (stat === null ? null : { count: stat.count, p5: stat.p5, p50: stat.p50, p95: stat.p95 });

/** A seeded shuffle, so a failure can be seen again. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let state = seed;
	for (let i = out.length - 1; i > 0; i--) {
		state = (state * 1103515245 + 12345) % 2 ** 31;
		const j = state % (i + 1);
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

/** The same value with every object's members in the reverse order: what the input could hold, and the same data. */
function reversedKeys<T>(value: T): T {
	if (Array.isArray(value)) return value.map(reversedKeys) as T;
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)])) as T;
}

let fixture: ApiFixture;
let tree: Map<string, Uint8Array>;
let directory: string;

beforeAll(async () => {
	fixture = await makeApiFixture();
	tree = buildApi(sourcesOf(fixture));
	directory = writeTree(tree);
});

describe("the tree", () => {
	test("holds the table of contents, the list, one file per Series, one per price file and the schemas, laid out as served", () => {
		expect([...tree.keys()]).toEqual([
			"v1/index.json",
			"v1/prices/2026-11-11.json",
			"v1/prices/2026-11-12.json",
			"v1/schemas/events.schema.json",
			"v1/schemas/index.schema.json",
			"v1/schemas/prices.schema.json",
			"v1/schemas/series-list.schema.json",
			"v1/schemas/series-month.schema.json",
			"v1/schemas/series.schema.json",
			"v1/series.json",
			...[fixture.http, fixture.memory, fixture.syscall].sort().flatMap((id) => [seriesPath(id), november(id)]),
		]);
		// The price files and their schema, byte for byte; and the schema of one line of a Run's stdout, which the Methods' definitions name.
		expect(Buffer.from(tree.get("v1/prices/2026-11-12.json") as Uint8Array).equals(readFileSync(join(fixture.runs, "prices/2026/11/12/aws.json")))).toBe(true);
		expect(Buffer.from(tree.get("v1/schemas/prices.schema.json") as Uint8Array).equals(readFileSync(join(ROOT, "schemas/prices.schema.json")))).toBe(true);
		expect(Buffer.from(tree.get("v1/schemas/events.schema.json") as Uint8Array).equals(readFileSync(join(ROOT, "schemas/events.schema.json")))).toBe(true);
	});

	test("matches its schemas, closed, and the check finds no problem", () => {
		const result = checkApi({ tree: directory, runs: fixture.runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests });
		expect(result.problems).toEqual([]);
		expect(result.series).toBe(3);
		expect(result.months).toBe(3);
		// Every Run file the Derivations cite, the unreadable one included.
		expect(result.runFiles).toBe(fixture.series.runs_read);
	});

	test("the table of contents links the list, every price file with the newest marked, the schemas and the docs", () => {
		const index = json(tree, "v1/index.json");
		expect(index.schema).toBe("ledgermath.api.index/1");
		expect(index.url).toBe(`${DEFAULT_BASE}/v1/index.json`);
		expect(index.series).toEqual({
			url: `${DEFAULT_BASE}/v1/series.json`,
			schema_url: `${DEFAULT_BASE}/v1/schemas/series-list.schema.json`,
			count: 3,
			series_file_schema_url: `${DEFAULT_BASE}/v1/schemas/series.schema.json`,
			month_file_schema_url: `${DEFAULT_BASE}/v1/schemas/series-month.schema.json`,
		});
		expect(index.prices.files.map((file: Json) => file.date)).toEqual(["2026-11-11", "2026-11-12"]);
		expect(index.prices.newest).toEqual({ date: "2026-11-12", path: "prices/2026/11/12/aws.json", url: `${DEFAULT_BASE}/v1/prices/2026-11-12.json` });
		expect(index.schemas.map((schema: Json) => schema.name)).toEqual(["index", "series-list", "series", "series-month", "prices", "events"]);
		// The events schema describes no file of the tree, and says what it does describe.
		expect(index.schemas.at(-1)).toEqual({ name: "events", describes: "one line of a Run's stdout: the blob at blobs/sha256/<hex> that the Run file's stdout names", url: `${DEFAULT_BASE}/v1/schemas/events.schema.json` });
		expect(index.schemas.find((schema: Json) => schema.name === "series-month").describes).toBe("v1/series/<id>/<yyyy-mm>.json");
		expect(index.docs).toBe("https://example.test/docs");
		expect(index.evidence.blob_url_template).toBe(`${DEFAULT_BASE}/blobs/sha256/{hex}`);
		expect(index.versioning).toContain("only ever gains fields");
		// The newest Run's start, from the data: no clock.
		expect(index.newest_run_started_at).toBe("2026-11-15T04:12:00.000000000Z");
	});

	test("writes each row of the list on a line of its own, and each object of the Series' arrays", () => {
		const lines = text(tree, "v1/series.json").split("\n");
		const rows = lines.filter((line) => line.startsWith('    {"id":'));
		expect(rows.length).toBe(3);
		for (const row of rows) expect(JSON.parse(row.replace(/,$/, "")).url).toMatch(/^https:\/\/api\.ledgermath\.com\/v1\/series\/[0-9a-f]{12}\.json$/);
		for (const path of [seriesPath(fixture.memory), november(fixture.memory)]) {
			const points = text(tree, path)
				.split("\n")
				.filter((line) => line.startsWith('        {"run":'));
			expect(points.length).toBe(4);
		}
		expect(apiJson({ a: [1, 2], b: [{ c: { d: 1 } }, { c: null }], e: {} })).toBe('{\n  "a": [1,2],\n  "b": [\n    {"c":{"d":1}},\n    {"c":null}\n  ],\n  "e": {}\n}\n');
	});

	test("takes the base address from its input, for every link", () => {
		const other = buildApi(sourcesOf(fixture, "http://localhost:8080/private/"));
		const all = [...other.entries()].filter(([path]) => !path.startsWith("v1/prices/") && !path.startsWith("v1/schemas/")).map(([, bytes]) => new TextDecoder().decode(bytes));
		expect(all.join("\n")).not.toContain("api.ledgermath.com");
		expect(json(other, seriesPath(fixture.memory)).url).toBe(`http://localhost:8080/private/v1/series/${fixture.memory}.json`);
		expect(() => buildApi(sourcesOf(fixture, "https://api.ledgermath.com/?x=1"))).toThrow("is not a base address");
	});
});

describe("the same inputs give the same bytes", () => {
	test("whatever order the Series, the price files and the boot summaries come in", () => {
		for (const seed of [1, 2, 3]) {
			const sources = sourcesOf(fixture);
			sources.series.derivations = shuffled(sources.series.derivations, seed);
			sources.requests.derivations = shuffled(sources.requests.derivations, seed + 10);
			sources.series.sections = shuffled(sources.series.sections, seed + 20);
			sources.series.unreadable = shuffled(sources.series.unreadable, seed + 30);
			sources.prices = shuffled(sources.prices, seed + 40);
			sources.boots = new Map(shuffled([...sources.boots], seed + 50));
			const again = buildApi(sources);
			expect([...again.keys()]).toEqual([...tree.keys()]);
			for (const [path, bytes] of tree) expect(Buffer.from(again.get(path) as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
		}
	});

	test("whatever order the members of any object of the Derivations come in, the free-form ones (params, facts, definitions, a Service's inputs) written by UTF-16 code unit", () => {
		const sources = sourcesOf(fixture);
		sources.series = reversedKeys(sources.series);
		sources.requests = reversedKeys(sources.requests);
		const again = buildApi(sources);
		expect([...again.keys()]).toEqual([...tree.keys()]);
		for (const [path, bytes] of tree) expect(text(again, path)).toBe(new TextDecoder().decode(bytes));
		// Only the params, reversed (the case first seen), changes nothing either.
		const params = sourcesOf(fixture);
		for (const derivation of [...params.series.derivations, ...params.requests.derivations]) derivation.series.params = reversedKeys(derivation.series.params);
		for (const [path, bytes] of buildApi(params)) expect(new TextDecoder().decode(bytes)).toBe(text(tree, path));
		// Free-form objects by UTF-16 code unit (JavaScript's default string order); known fields in the order of their schema.
		const memory = text(tree, seriesPath(fixture.memory));
		expect(memory).toContain('"params": {\n    "path": "scalar",\n    "size_bytes": 1073741824,\n    "threads": 1\n  },');
		const facts = Object.keys(json(tree, seriesPath(fixture.memory)).derivations.series_v1.groups[0].facts);
		expect(facts).toEqual([...facts].sort());
		const services = json(tree, seriesPath(fixture.http)).derivations.requests_v1.recorded.services;
		for (const service of services) expect(Object.keys(service.inputs)).toEqual(Object.keys(service.inputs).sort());
		expect(Object.keys(json(tree, november(fixture.memory)).derivations.series_v1.points[0]).slice(0, 6)).toEqual(["run", "path", "sha256", "evidence", "boot_summary", "started_at"]);
		expect(Object.keys(json(tree, seriesPath(fixture.memory)).derivations.series_v1.newest_points[0]).slice(0, 6)).toEqual(["run", "path", "sha256", "evidence", "boot_summary", "started_at"]);
	});

	test("and a Series that gained no Run keeps its file byte for byte, while the list and the table of contents move on", async () => {
		const later = await makeApiFixture({ extraSyscallRun: true });
		const next = buildApi(sourcesOf(later));
		for (const id of [fixture.memory, fixture.http]) {
			expect(text(next, seriesPath(id))).toBe(text(tree, seriesPath(id)));
			expect(text(next, november(id))).toBe(text(tree, november(id)));
		}
		// The syscall Series gained a Run in the same month: its Series file and that month's file change.
		expect(text(next, seriesPath(fixture.syscall))).not.toBe(text(tree, seriesPath(fixture.syscall)));
		expect(text(next, november(fixture.syscall))).not.toBe(text(tree, november(fixture.syscall)));
		expect(json(next, "v1/series.json").newest_run_started_at).toBe("2026-11-16T04:13:00.000000000Z");
		expect(json(next, "v1/index.json").newest_run_started_at).toBe("2026-11-16T04:13:00.000000000Z");
		for (const path of ["v1/prices/2026-11-11.json", "v1/schemas/series.schema.json"]) expect(text(next, path)).toBe(text(tree, path));
	});
});

describe("a Series", () => {
	/** A point as the Derivation holds it: the API's point without what it adds. */
	const asDerived = (point: Json): Json => {
		const { sha256: _sha256, evidence: _evidence, boot_summary: _bootSummary, group_through_as_of_run: asOfRun, ...rest } = point;
		// The fixture's Series of requests has one group: there the Derivation's group_through is the tree's group_through_as_of_run, null.
		return asOfRun === undefined ? rest : { ...rest, group_through: asOfRun };
	};

	test("of both Methods carries each one's summary in its Series file and each one's points in its month file, labelled with its name and version, and its row each one's summary", () => {
		const file = json(tree, seriesPath(fixture.http));
		const month = json(tree, november(fixture.http));
		const seriesV1 = fixture.series.derivations.find((d) => d.series.id === fixture.http) as SeriesFile["derivations"][number];
		const requestsV1 = fixture.requests.derivations.find((d) => d.series.id === fixture.http) as RequestsFile["derivations"][number];
		for (const of of [file, month]) {
			expect(Object.keys(of.derivations)).toEqual(["series_v1", "requests_v1"]);
			expect(of.derivations.series_v1.method).toEqual({ name: "series", version: 1 });
			expect(of.derivations.requests_v1.method).toEqual({ name: "requests", version: 1 });
		}
		expect(month.derivations.series_v1.points.map(asDerived)).toEqual(seriesV1.points);
		expect(month.derivations.requests_v1.points.map(asDerived)).toEqual(requestsV1.points);
		expect(month.derivations.series_v1.differed).toEqual(seriesV1.differed);
		// Fewer than 12 Runs: every point is among the newest, in the Series file too.
		expect(file.derivations.series_v1.newest_points).toEqual(month.derivations.series_v1.points);
		expect(file.derivations.requests_v1.newest_points).toEqual(month.derivations.requests_v1.points);
		expect(file.derivations.series_v1.percentiles).toEqual({ time_per_repetition_ns: summary(seriesV1.percentiles.time_per_repetition_ns), bytes_per_second: summary(seriesV1.percentiles.bytes_per_second) });
		expect(file.derivations.series_v1.sections).toEqual(seriesV1.sections);
		expect(file.derivations.series_v1.groups.map((group: Json) => [group.id, group.facts])).toEqual(seriesV1.groups.map((group) => [group.id, group.facts]));
		for (const key of ["recorded", "pool"] as const) expect(file.derivations.requests_v1[key]).toEqual(requestsV1[key]);
		expect(file.derivations.requests_v1.groups).toEqual(requestsV1.groups.map((group) => ({ id: group.id, facts: group.facts, pool: group.pool })));
		expect(file.derivations.requests_v1.definitions).toEqual(fixture.requests.definitions);
		expect(file.derivations.series_v1.definitions).toEqual(fixture.series.definitions);
		// The second Run exited 4 with one timed-out request: series v1 does not count it, requests v1 does.
		expect(month.derivations.series_v1.points.map((point: Json) => point.counted)).toEqual([true, false]);
		expect(month.derivations.requests_v1.points.map((point: Json) => point.counted)).toEqual([true, true]);
		expect([file.derivations.series_v1.counted_runs, file.derivations.series_v1.failed_runs]).toEqual([1, 1]);
		expect([file.derivations.requests_v1.counted_runs, file.derivations.requests_v1.failed_runs]).toEqual([2, 0]);

		const row = json(tree, "v1/series.json").series.find((r: Json) => r.id === fixture.http);
		expect(row.derivations.series_v1).toEqual({
			method: { name: "series", version: 1 },
			counted_runs: 1,
			failed_runs: 1,
			groups: 1,
			percentiles: {
				time_per_repetition_ns: { count: 1, p5: seriesV1.percentiles.time_per_repetition_ns?.p5, p50: seriesV1.percentiles.time_per_repetition_ns?.p50, p95: seriesV1.percentiles.time_per_repetition_ns?.p95 },
				bytes_per_second: null,
			},
		});
		const { histogram: _histogram, ...total } = requestsV1.pool.phases.total as Json;
		expect(row.derivations.requests_v1.method).toEqual({ name: "requests", version: 1 });
		expect(row.derivations.requests_v1.counted_runs).toBe(2);
		expect(row.derivations.requests_v1.pool).toMatchObject({ runs: 2, requests: requestsV1.pool.requests, failed: 1 });
		expect(row.derivations.requests_v1.pool.phases.total).toEqual(total);
		// A Series of series v1 alone has no requests_v1, in its row or its file.
		expect(Object.keys(json(tree, seriesPath(fixture.memory)).derivations)).toEqual(["series_v1"]);
		expect(Object.keys(json(tree, "v1/series.json").series.find((r: Json) => r.id === fixture.memory).derivations)).toEqual(["series_v1"]);
	});

	test("split into groups shows its groups, their facts and figures, and what differed, as the Derivation has them; a group's Runs are its points", () => {
		const file = json(tree, seriesPath(fixture.memory));
		const month = json(tree, november(fixture.memory));
		const derivation = fixture.series.derivations.find((d) => d.series.id === fixture.memory) as SeriesFile["derivations"][number];
		expect(file.derivations.series_v1.groups.map((group: Json) => group.id)).toEqual(["A", "B"]);
		expect(file.derivations.series_v1.groups).toEqual(
			derivation.groups.map((group) => ({
				id: group.id,
				facts: group.facts,
				percentiles: { time_per_repetition_ns: summary(group.percentiles.time_per_repetition_ns as unknown as Json), bytes_per_second: summary(group.percentiles.bytes_per_second as unknown as Json) },
			})),
		);
		// What the file leaves out, each group's Runs, is the month file's points of its letter.
		for (const group of derivation.groups) expect(month.derivations.series_v1.points.filter((point: Json) => point.group === group.id).map((point: Json) => point.run)).toEqual(group.runs);
		const split = month.derivations.series_v1.differed.find((entry: Json) => entry.facts.includes("cpuid"));
		expect(split).toBeDefined();
		expect(split.sections.find((section: Json) => section.section === "cpuid").effect).toBe("splits");
		expect(month.derivations.series_v1.differed).toEqual(derivation.differed);
		expect(file.derivations.series_v1.differed).toBeUndefined();
		const row = json(tree, "v1/series.json").series.find((r: Json) => r.id === fixture.memory);
		expect(row.derivations.series_v1.groups).toBe(2);
		expect(row.runs).toBe(4);
		expect(row.oldest_run_started_at).toBe("2026-11-12T04:12:00.000000000Z");
		expect(row.newest_run_started_at).toBe("2026-11-15T04:12:00.000000000Z");
	});

	test("shows a failed Run's point with why and its evidence, counts it as failed, and leaves it out of every percentile", () => {
		const month = json(tree, november(fixture.memory));
		const derivation = fixture.series.derivations.find((d) => d.series.id === fixture.memory) as SeriesFile["derivations"][number];
		const failed = month.derivations.series_v1.points.filter((point: Json) => !point.counted);
		expect(failed.length).toBe(1);
		expect(failed[0].failure).toEqual(expect.any(String));
		expect(failed[0].samples).toEqual([]);
		expect(failed[0].evidence).toBe(`${DEFAULT_BASE}/${failed[0].path}`);
		// The Runs behind the percentiles, which the tree leaves out, are the counted points.
		expect(derivation.percentiles.time_per_repetition_ns?.runs).not.toContain(failed[0].run);
		expect(derivation.percentiles.time_per_repetition_ns?.runs).toEqual(month.derivations.series_v1.points.filter((point: Json) => point.counted).map((point: Json) => point.run));
		expect(json(tree, seriesPath(fixture.memory)).derivations.series_v1.percentiles.time_per_repetition_ns.runs).toBeUndefined();
		const row = json(tree, "v1/series.json").series.find((r: Json) => r.id === fixture.memory);
		expect([row.derivations.series_v1.counted_runs, row.derivations.series_v1.failed_runs]).toEqual([3, 1]);
		expect(row.derivations.series_v1.percentiles.time_per_repetition_ns.count).toBe(3);
	});

	test("links each point's Run file with its sha256, and its boot's summary when the Runs repository holds one", () => {
		const file = json(tree, november(fixture.memory));
		const derivation = fixture.series.derivations.find((d) => d.series.id === fixture.memory) as SeriesFile["derivations"][number];
		file.derivations.series_v1.points.forEach((point: Json, i: number) => {
			expect(point.sha256).toBe(derivation.runs[i]?.sha256);
			expect(point.evidence).toBe(`${DEFAULT_BASE}/${derivation.runs[i]?.path}`);
		});
		expect(file.derivations.series_v1.points.map((point: Json) => point.boot_summary)).toEqual([`${DEFAULT_BASE}/boots/2026/11/12/boot-2026-11-12.json`, null, null, null]);
	});

	test("writes every number exactly as the Derivation holds it", () => {
		const derivation = fixture.series.derivations.find((d) => d.series.id === fixture.memory) as SeriesFile["derivations"][number];
		const fileText = text(tree, november(fixture.memory));
		for (const point of derivation.points) {
			if (point.time_per_repetition_ns !== null) expect(fileText).toContain(`"time_per_repetition_ns":${JSON.stringify(point.time_per_repetition_ns)}`);
			if (point.bytes_per_second !== null) expect(fileText).toContain(`"bytes_per_second":${JSON.stringify(point.bytes_per_second)}`);
		}
		const p50 = derivation.percentiles.bytes_per_second?.p50 as number;
		expect(text(tree, "v1/series.json")).toContain(`"p50":${JSON.stringify(p50)}`);
	});
});

describe("Run files that could not be read", () => {
	test("are listed in the list, under each Method, with why and their evidence", () => {
		const list = json(tree, "v1/series.json");
		for (const key of ["series_v1", "requests_v1"]) {
			const unreadable = list.methods[key].unreadable;
			expect(unreadable.map((run: Json) => run.path)).toEqual([fixture.unreadable]);
			expect(unreadable[0].reason).toEqual(expect.any(String));
			expect(unreadable[0].evidence).toBe(`${DEFAULT_BASE}/${fixture.unreadable}`);
		}
		expect(list.methods.series_v1.runs_read).toBe(fixture.series.runs_read);
	});
});

describe("the build refuses Derivations that do not hold together", () => {
	test("two Methods citing different Runs for one Series, a Series of requests series v1 lacks, an id that is not one, docs that are no https address", () => {
		const differ = sourcesOf(fixture);
		(differ.requests.derivations[0] as Json).runs = (differ.requests.derivations[0] as Json).runs.slice(1);
		expect(() => buildApi(differ)).toThrow("cite different Runs");
		const lacking = sourcesOf(fixture);
		lacking.series.derivations = lacking.series.derivations.filter((d) => d.series.id !== fixture.http);
		expect(() => buildApi(lacking)).toThrow("which series v1 does not");
		const unsafe = sourcesOf(fixture);
		(unsafe.series.derivations[0] as Json).series.id = "../../etc";
		expect(() => buildApi(unsafe)).toThrow("not 12 hex digits");
		for (const docs of ["https://", "http://example.test/docs", "https://example.test/a b"]) expect(() => buildApi({ ...sourcesOf(fixture), docs })).toThrow("is not an address for the docs");
	});
});

describe("the check fails loudly", () => {
	/** The checkout a broken copy is checked against: a copy of the fixture's, made anew for each check. */
	let runs = "";
	/** A copy of the good tree and of the checkout, changed by `change`, checked. */
	function check(change: (tree: string, runs: string) => void, options: { series?: SeriesFile; base?: string } = {}): string[] {
		const copy = mkdtempSync(join(tmpdir(), "api-broken-"));
		cpSync(directory, copy, { recursive: true });
		runs = mkdtempSync(join(tmpdir(), "api-broken-runs-"));
		cpSync(fixture.runs, runs, { recursive: true });
		change(copy, runs);
		return checkApi({ tree: copy, runs, base: options.base ?? DEFAULT_BASE, series: options.series ?? fixture.series, requests: fixture.requests }).problems;
	}
	/** A file of a copy changed by `change`, written as the build writes it (writerForm()), so a test of a rule sees only that rule's problems. */
	const edit = (path: string, change: (value: Json) => void) => (copy: string) => {
		const value = JSON.parse(readFileSync(join(copy, path), "utf8"));
		change(value);
		writeFileSync(join(copy, path), writerForm(path, value));
		keepEntry(copy, path);
	};
	/**
	 * A changed month file's entry in its Series file made to give its new
	 * sha256 and size, so that a test of another rule sees only that rule's
	 * problems (tests/api-months.test.ts tests the entry itself).
	 */
	const keepEntry = (copy: string, path: string): void => {
		const month = /^v1\/series\/([^/]+)\/([^/]+)\.json$/.exec(path);
		if (month === null) return;
		const at = join(copy, seriesPath(month[1] as string));
		const series = JSON.parse(readFileSync(at, "utf8"));
		const entry = (series.months as Json[]).find((one) => one.month === month[2]) as Json;
		const bytes = readFileSync(join(copy, path));
		entry.sha256 = createHash("sha256").update(bytes).digest("hex");
		entry.bytes = bytes.length;
		writeFileSync(at, writerForm(seriesPath(month[1] as string), series));
	};

	test("when a file does not match its schema: a field the schema does not describe, or one of the wrong type", () => {
		const extra = check(edit(november(fixture.memory), (file) => (file.derivations.series_v1.points[0].colour = "red")));
		const run = json(tree, november(fixture.memory)).derivations.series_v1.points[0].run;
		expect(extra).toEqual([
			expect.stringContaining(`${november(fixture.memory)} does not match v1/schemas/series-month.schema.json: /derivations/series_v1/points/0 must NOT have additional properties: colour`),
			`${november(fixture.memory)}: series_v1: point 0: /colour is "red", where nothing is expected, as series v1's Derivation of Series ${fixture.memory} holds it for ${NOVEMBER}`,
			`${seriesPath(fixture.memory)}: series_v1: newest_points/0, Run ${run}, is not its point in the month file of ${NOVEMBER}: /colour is absent, not "red"`,
		]);
		const newest = check(edit(seriesPath(fixture.memory), (file) => (file.derivations.series_v1.newest_points[0].colour = "red")));
		expect(newest[0]).toContain(`${seriesPath(fixture.memory)} does not match v1/schemas/series.schema.json: /derivations/series_v1/newest_points/0 must NOT have additional properties: colour`);
		const wrong = check(edit("v1/series.json", (list) => (list.series[0].runs = "four")));
		expect(wrong[0]).toContain("v1/series.json does not match v1/schemas/series-list.schema.json: /series/0/runs must be integer");
		expect(wrong[1]).toMatch(/^v1\/series\.json: the row of Series [0-9a-f]{12} differs from its file v1\/series\/[0-9a-f]{12}\.json: \/runs is "four", not [0-9]+$/);
		expect(wrong.length).toBe(2);
		const index = check(edit("v1/index.json", (value) => delete value.prices));
		expect(index[0]).toContain("v1/index.json does not match v1/schemas/index.schema.json: / must have required property 'prices'");
		expect(index.filter((problem) => problem.startsWith("v1/index.json: prices: /")).map((problem) => problem.split(" ")[2])).toEqual(["/schema_url", "/files", "/newest"]);
	});

	test("when a file is not strict JSON: a member twice in one object, a byte that is not UTF-8, a byte-order mark", () => {
		const count = check((copy) => {
			const path = join(copy, "v1/series.json");
			const value = readFileSync(path, "utf8");
			const [line] = value.match(/^  "count": [0-9]+,$/m) ?? [];
			expect(line).toBeDefined();
			writeFileSync(path, value.replace(line as string, `  "count": 999,\n${line}`));
		});
		expect(count).toEqual(['v1/series.json is not strict JSON: the object at / holds the member "count" twice']);
		const nested = check((copy) => {
			const path = join(copy, november(fixture.memory));
			writeFileSync(path, readFileSync(path, "utf8").replace('{"run":', '{"run":"x","\\u0072un":'));
			keepEntry(copy, november(fixture.memory));
		});
		expect(nested).toEqual([`${november(fixture.memory)} is not strict JSON: the object at /derivations/series_v1/points/0 holds the member "run" twice`]);
		// A number a double does not hold exactly: a reader's parse would change it.
		const digits = check((copy) => {
			const path = join(copy, november(fixture.memory));
			writeFileSync(path, readFileSync(path, "utf8").replace('"sample":1,', '"sample":9007199254740993,'));
			keepEntry(copy, november(fixture.memory));
		});
		expect(digits).toEqual([
			`${november(fixture.memory)} is not strict JSON: the number at /derivations/series_v1/points/0/samples/0/sample is 9007199254740993, which a double does not hold exactly: it would be written 9007199254740992, another value`,
		]);
		const byte = check((copy) => {
			const path = join(copy, "v1/index.json");
			const value = readFileSync(path);
			const at = value.indexOf('"about": "') + 12;
			writeFileSync(path, Buffer.concat([value.subarray(0, at), Buffer.from([0xff]), value.subarray(at)]));
		});
		expect(byte).toEqual([expect.stringMatching(/^v1\/index\.json is not strict JSON: it is not UTF-8: byte [0-9]+ is 0xff$/)]);
		const mark = check((copy) => {
			const path = join(copy, seriesPath(fixture.syscall));
			writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(path)]));
		});
		expect(mark).toEqual([`${seriesPath(fixture.syscall)} is not strict JSON: it begins with a byte-order mark`]);
	});

	test("when the docs are not an absolute https address with a host", () => {
		for (const docs of ["https://", "https:///README.md", "http://example.test/docs", "https://user@example.test/docs", "example.test/docs"]) {
			const problems = check(edit("v1/index.json", (value) => (value.docs = docs)));
			expect(problems).toContain(`v1/index.json: docs is ${JSON.stringify(docs)}, not an absolute https address with a host`);
			expect(problems).toContain('v1/index.json does not match v1/schemas/index.schema.json: /docs must match pattern "' + JSON.parse(readFileSync(join(ROOT, "schemas/api/v1/index.schema.json"), "utf8")).properties.docs.pattern + '"');
		}
		expect(check(edit("v1/index.json", (value) => (value.docs = "https://Example.test:8443/a/b?c=d#e")))).toEqual([]);
	});

	test("when a link in the list or the table of contents names a file the tree lacks", () => {
		const series = check((copy) => rmSync(join(copy, seriesPath(fixture.syscall))));
		expect(series).toContain(`${seriesPath(fixture.syscall)} is missing: Series ${fixture.syscall} of series v1 has no file in the tree`);
		// Its month file, read first, links it back; and nothing leads to the month file now.
		expect(series).toContain(`${november(fixture.syscall)} links ${DEFAULT_BASE}/${seriesPath(fixture.syscall)}, which is not a file of the tree`);
		expect(series).toContain(`${november(fixture.syscall)} is in the tree, but no link leads to it from v1/index.json`);
		const price = check((copy) => rmSync(join(copy, "v1/prices/2026-11-11.json")));
		expect(price).toContain(`v1/index.json links ${DEFAULT_BASE}/v1/prices/2026-11-11.json, which is not a file of the tree`);
		const schema = check(edit("v1/index.json", (value) => (value.schemas[0].url = `${DEFAULT_BASE}/v1/schemas/nothing.schema.json`)));
		expect(schema).toEqual([
			`v1/index.json: /schemas/0/url is "${DEFAULT_BASE}/v1/schemas/nothing.schema.json", not "${DEFAULT_BASE}/v1/schemas/index.schema.json", as the tree and the Derivations make it`,
			`v1/index.json links ${DEFAULT_BASE}/v1/schemas/nothing.schema.json, which is not a file of the tree`,
			"v1/schemas/index.schema.json is a schema, but v1/index.json does not list it",
		]);
	});

	test("when a Series of the Derivations is missing from the tree, or the tree holds one the Derivations lack", () => {
		const noRow = check(edit("v1/series.json", (list) => (list.series = list.series.filter((row: Json) => row.id !== fixture.memory))));
		expect(noRow).toContain(`v1/series.json has no row for Series ${fixture.memory} of series v1`);
		const stray = check((copy) => writeFileSync(join(copy, seriesPath("ffffffffffff")), readFileSync(join(copy, seriesPath(fixture.memory)))));
		expect(stray).toContain(`${seriesPath("ffffffffffff")} is in the tree, but Series ffffffffffff is in neither file of Derivations`);
		const fewer = structuredClone(fixture.series);
		fewer.derivations = fewer.derivations.filter((d) => d.series.id !== fixture.syscall);
		const gone = check(() => {}, { series: fewer });
		expect(gone).toContain(`${seriesPath(fixture.syscall)} is in the tree, but Series ${fixture.syscall} is in neither file of Derivations`);
		expect(gone).toContain(`v1/series.json has a row for Series ${fixture.syscall}, which is in neither file of Derivations`);
		const unexpected = check((copy) => writeFileSync(join(copy, "v1/latest.json"), "{}\n"));
		expect(unexpected).toEqual([
			"v1/latest.json is in the tree, but is no file the tree should hold",
			"v1/latest.json is of no kind of file a schema listed in v1/index.json describes",
			"v1/latest.json is in the tree, but no link leads to it from v1/index.json",
		]);
	});

	test("when an evidence link names a Run file that is not in the Runs repository checkout, or one with other bytes", () => {
		const derivation = fixture.series.derivations.find((d) => d.series.id === fixture.memory) as SeriesFile["derivations"][number];
		const first = derivation.runs[0] as SeriesFile["derivations"][number]["runs"][number];
		const missing = check((_copy, checkout) => rmSync(join(checkout, first.path)));
		expect(missing).toContain(`${november(fixture.memory)}: series_v1's point ${first.id}: evidence ${DEFAULT_BASE}/${first.path} names a Run file that is not in the Runs repository checkout ${runs}`);
		expect(missing).toContain(`${seriesPath(fixture.memory)}: series_v1: newest_points's point ${first.id}: evidence ${DEFAULT_BASE}/${first.path} names a Run file that is not in the Runs repository checkout ${runs}`);
		const changed = check((_copy, checkout) => writeFileSync(join(checkout, first.path), `${readFileSync(join(checkout, first.path), "utf8")} `));
		expect(changed).toEqual([
			expect.stringContaining(`${november(fixture.memory)}: series_v1's point ${first.id}: the Run file ${first.path} in the checkout has sha256`),
			expect.stringContaining(`${seriesPath(fixture.memory)}: series_v1: newest_points's point ${first.id}: the Run file ${first.path} in the checkout has sha256`),
		]);
		const unreadable = check((_copy, checkout) => rmSync(join(checkout, fixture.unreadable)));
		expect(unreadable).toContain(`v1/series.json: series_v1's unreadable Run not-a-run: evidence ${DEFAULT_BASE}/${fixture.unreadable} names a Run file that is not in the Runs repository checkout ${runs}`);
		// Every point of the first day's boot links its summary, and so does the table of contents' one round of boots; once it is gone, each point
		// says so, the round is one the checkout no longer makes, and the link is reported once, from the table of contents, read first.
		const boot = check((_copy, checkout) => rmSync(join(checkout, "boots"), { recursive: true }));
		const summary = `${DEFAULT_BASE}/boots/2026/11/12/boot-2026-11-12.json`;
		const firstDay = (id: string, key: string) =>
			(json(tree, november(id)).derivations[key].points as Json[])
				.filter((point) => point.boot_summary === summary)
				.flatMap((point) => [
					`${november(id)}: ${key}'s point ${point.run}: boot_summary is ${summary}, but the checkout ${runs} holds no summary of boot boot-2026-11-12`,
					`${seriesPath(id)}: ${key}: newest_points's point ${point.run}: boot_summary is ${summary}, but the checkout ${runs} holds no summary of boot boot-2026-11-12`,
				]);
		expect(boot.filter((problem) => problem.includes(" links "))).toEqual([`v1/index.json links ${summary}, which is not a file of the Runs repository checkout ${runs}`]);
		expect(boot.filter((problem) => !problem.includes(" links ")).sort()).toEqual(
			[
				"v1/index.json: /recent_rounds/rounds has 1 items, not 0, as the boot summaries of the checkout and the Derivations make it",
				...firstDay(fixture.memory, "series_v1"),
				...firstDay(fixture.syscall, "series_v1"),
				...firstDay(fixture.http, "series_v1"),
				...firstDay(fixture.http, "requests_v1"),
			].sort(),
		);
	});

	test("when a price file is not the checkout's, byte for byte, or the tree was built for another base", () => {
		const price = check((copy) => writeFileSync(join(copy, "v1/prices/2026-11-12.json"), `${readFileSync(join(copy, "v1/prices/2026-11-12.json"), "utf8")}\n`));
		expect(price).toEqual(["v1/prices/2026-11-12.json is not byte for byte prices/2026/11/12/aws.json of the checkout"]);
		const base = check(() => {}, { base: "https://staging.example.test" });
		expect(base).toEqual([`v1/index.json says its address is ${DEFAULT_BASE}/v1/index.json, not https://staging.example.test/v1/index.json: the tree was built for another base`, ...base.slice(1)]);
		expect(base.length).toBeGreaterThan(1);
	});

	test("when a point cites another Run's evidence: the Run file at its path is another Run's, of another boot", () => {
		const file = json(tree, november(fixture.memory));
		const [a, b] = file.derivations.series_v1.points as Json[];
		if (a === undefined || b === undefined) throw new Error("the memory_read Series has fewer than two points");
		// Point A keeps its Run id and its figures; B's path, sha256, evidence and boot summary are copied onto it.
		const copied = check(
			edit(november(fixture.memory), (value) => {
				for (const key of ["path", "sha256", "evidence", "boot_summary"]) value.derivations.series_v1.points[0][key] = b[key];
			}),
		);
		const where = `${november(fixture.memory)}: series_v1's point ${a.run}`;
		expect(copied).toContain(`${where}: the Run file ${b.path} in the checkout is Run ${b.run}, not ${a.run}`);
		expect(copied).toContain(`${where}: the Run file ${b.path} in the checkout is of boot ${b.boot}, not ${a.boot}`);
		expect(copied).toContain(`${november(fixture.memory)}: series_v1: point 0: /path is ${JSON.stringify(b.path)}, not ${JSON.stringify(a.path)}, as series v1's Derivation of Series ${fixture.memory} holds it for ${NOVEMBER}`);
		// And the other way: B with A's evidence, whose boot has a summary, now B's too.
		const back = check(
			edit(november(fixture.memory), (value) => {
				for (const key of ["path", "sha256", "evidence", "boot_summary"]) value.derivations.series_v1.points[1][key] = a[key];
			}),
		);
		expect(back).toContain(`${november(fixture.memory)}: series_v1's point ${b.run}: the Run file ${a.path} in the checkout is Run ${a.run}, not ${b.run}`);
	});

	test("when a point's boot_summary is not the summary of its Run's boot, as the summaries in the checkout name their boots", () => {
		const file = json(tree, november(fixture.memory));
		const [a, b] = file.derivations.series_v1.points as Json[];
		if (a === undefined || b === undefined) throw new Error("the memory_read Series has fewer than two points");
		const other = check(edit(november(fixture.memory), (value) => (value.derivations.series_v1.points[1].boot_summary = a.boot_summary)));
		expect(other).toEqual([
			`${november(fixture.memory)}: series_v1's point ${b.run}: boot_summary is ${a.boot_summary}, but the checkout ${runs} holds no summary of boot ${b.boot}`,
			`${seriesPath(fixture.memory)}: series_v1: newest_points/1, Run ${b.run}, is not its point in the month file of ${NOVEMBER}: /boot_summary is null, not ${JSON.stringify(a.boot_summary)}`,
		]);
		// A summary is its boot's by what it says, not by its file's name.
		const renamed = check((_copy, checkout) => {
			const path = join(checkout, "boots/2026/11/12/boot-2026-11-12.json");
			writeFileSync(path, readFileSync(path, "utf8").replace('"boot": "boot-2026-11-12"', '"boot": "another-boot"'));
		});
		expect(renamed).toContain(`${november(fixture.memory)}: series_v1's point ${a.run}: boot_summary is ${a.boot_summary}, but the checkout ${runs} holds no summary of boot ${a.boot}`);
	});

	test("when an unreadable Run's entry is not its Run file's: another id, or another Run file's sha256", () => {
		const id = check(edit("v1/series.json", (list) => (list.methods.series_v1.unreadable[0].id = "another")));
		expect(id).toContain(`v1/series.json: series_v1's unreadable Run another: its id is another, but its Run file is named not-a-run.json`);
		expect(id).toContain(`v1/series.json: methods.series_v1: /unreadable/0/id is "another", not "not-a-run", as series v1's file of Derivations holds it`);
		const memory = fixture.series.derivations.find((d) => d.series.id === fixture.memory) as SeriesFile["derivations"][number];
		const sha = check(edit("v1/series.json", (list) => (list.methods.requests_v1.unreadable[0].sha256 = memory.runs[0]?.sha256)));
		expect(sha).toContain(`v1/series.json: requests_v1's unreadable Run not-a-run: the Run file ${fixture.unreadable} in the checkout has sha256 ${fixture.series.unreadable[0]?.sha256}, not ${memory.runs[0]?.sha256}`);
	});

	test("when a Series file's figures are not its Derivations': a point's measurement, a percentile, a pooled figure", () => {
		const memory = fixture.series.derivations.find((d) => d.series.id === fixture.memory) as SeriesFile["derivations"][number];
		const time = memory.points[0]?.time_per_repetition_ns as number;
		const point = check(edit(november(fixture.memory), (file) => (file.derivations.series_v1.points[0].time_per_repetition_ns = time + 1)));
		expect(point).toEqual([
			`${november(fixture.memory)}: series_v1: point 0: /time_per_repetition_ns is ${time + 1}, not ${time}, as series v1's Derivation of Series ${fixture.memory} holds it for ${NOVEMBER}`,
			`${seriesPath(fixture.memory)}: series_v1: newest_points/0, Run ${memory.points[0]?.run}, is not its point in the month file of ${NOVEMBER}: /time_per_repetition_ns is ${time}, not ${time + 1}`,
		]);
		const newest = check(edit(seriesPath(fixture.memory), (file) => (file.derivations.series_v1.newest_points[0].time_per_repetition_ns = time + 1)));
		expect(newest).toEqual([
			`${seriesPath(fixture.memory)}: series_v1: newest_points: point 0: /time_per_repetition_ns is ${time + 1}, not ${time}, as series v1's Derivation of Series ${fixture.memory} holds its newest 12`,
			`${seriesPath(fixture.memory)}: series_v1: newest_points/0, Run ${memory.points[0]?.run}, is not its point in the month file of ${NOVEMBER}: /time_per_repetition_ns is ${time + 1}, not ${time}`,
		]);
		const p50 = memory.percentiles.time_per_repetition_ns?.p50 as number;
		const percentile = check(edit(seriesPath(fixture.memory), (file) => (file.derivations.series_v1.percentiles.time_per_repetition_ns.p50 = p50 * 2)));
		expect(percentile).toEqual([
			`${seriesPath(fixture.memory)}: series_v1: /percentiles/time_per_repetition_ns/p50 is ${p50 * 2}, not ${p50}, as series v1's Derivation of Series ${fixture.memory} holds it`,
			`v1/series.json: the row of Series ${fixture.memory} differs from its file ${seriesPath(fixture.memory)}: /derivations/series_v1/percentiles/time_per_repetition_ns/p50 is ${p50}, not ${p50 * 2}`,
		]);
		const http = fixture.requests.derivations.find((d) => d.series.id === fixture.http) as RequestsFile["derivations"][number];
		const pooled = check(edit(seriesPath(fixture.http), (file) => (file.derivations.requests_v1.pool.requests += 1)));
		expect(pooled).toContain(`${seriesPath(fixture.http)}: requests_v1: /pool/requests is ${http.pool.requests + 1}, not ${http.pool.requests}, as requests v1's Derivation of Series ${fixture.http} holds it`);
		const words = check(edit(seriesPath(fixture.http), (file) => (file.derivations.series_v1.definitions.series = "something else")));
		expect(words).toEqual([expect.stringMatching(/^v1\/series\/[0-9a-f]{12}\.json: series_v1: \/definitions\/series is "something else", not "The Runs that share/)]);
		const head = check(edit(seriesPath(fixture.http), (file) => (file.params.auth = "none")));
		expect(head).toContain(`${seriesPath(fixture.http)}: /params/auth is "none", not "sigv4", as its Derivations and the base make it`);
	});

	test("when a row is not its Series file's: its count of Runs, or a url to another Series' file", () => {
		const rowOf = (list: Json, id: string): Json => list.series.find((row: Json) => row.id === id);
		const count = check(edit("v1/series.json", (list) => (rowOf(list, fixture.memory).runs = 5)));
		expect(count).toEqual([`v1/series.json: the row of Series ${fixture.memory} differs from its file ${seriesPath(fixture.memory)}: /runs is 5, not 4`]);
		const url = check(edit("v1/series.json", (list) => (rowOf(list, fixture.memory).url = `${DEFAULT_BASE}/${seriesPath(fixture.syscall)}`)));
		expect(url).toEqual([
			`v1/series.json: the row of Series ${fixture.memory} has url "${DEFAULT_BASE}/${seriesPath(fixture.syscall)}", not ${DEFAULT_BASE}/${seriesPath(fixture.memory)}, the address of its file`,
			`v1/series.json: the row of Series ${fixture.memory} differs from its file ${seriesPath(fixture.memory)}: /url is "${DEFAULT_BASE}/${seriesPath(fixture.syscall)}", not "${DEFAULT_BASE}/${seriesPath(fixture.memory)}"`,
			// Nothing else leads to the Series file, nor so to its month.
			`${seriesPath(fixture.memory)} is in the tree, but no link leads to it from v1/index.json`,
			`${november(fixture.memory)} is in the tree, but no link leads to it from v1/index.json`,
		]);
		const total = check(edit("v1/series.json", (list) => (list.count = 4)));
		expect(total).toEqual(["v1/series.json: /count is 4, not 3, as the tree and the Derivations make it"]);
		const words = check(edit("v1/series.json", (list) => (list.methods.series_v1.runs_read += 1)));
		expect(words).toEqual([`v1/series.json: methods.series_v1: /runs_read is ${fixture.series.runs_read + 1}, not ${fixture.series.runs_read}, as series v1's file of Derivations holds it`]);
		const order = check(edit("v1/series.json", (list) => list.series.reverse()));
		expect(order).toEqual(["v1/series.json: the rows are not in the order of benchmark, instance type, zone ID, params, build"]);
	});

	test("when the table of contents does not list exactly the price files and schemas in the tree, or counts the Series wrong", () => {
		const emptied = check(
			edit("v1/index.json", (index) => {
				index.prices.files = [];
				index.prices.newest = null;
				index.schemas = [];
			}),
		);
		expect(emptied.slice(0, 3)).toEqual([
			"v1/index.json: /schemas has 0 items, not 6, as the tree and the Derivations make it",
			"v1/index.json: prices: /files has 0 items, not 2, as the price files in the tree make it",
			`v1/index.json: prices: /newest is null, not {"date":"2026-11-12","path":"prices/2026/11/12/aws.json","url":"${DEFAULT_BASE}/v1/prices/2026-11-12.json"}, as the price files in the tree make it`,
		]);
		// With no schema listed, no file's kind is described; and nothing leads to the price files now, nor to the events schema, which no file of the tree names as its own.
		const schemas = [...tree.keys()].filter((path) => path.startsWith("v1/schemas/"));
		expect(emptied.slice(3).filter((problem) => problem.endsWith("is of no kind of file a schema listed in v1/index.json describes")).length).toBe(tree.size - schemas.length);
		expect(emptied.filter((problem) => problem.endsWith("is a schema, but v1/index.json does not list it"))).toEqual(schemas.map((path) => `${path} is a schema, but v1/index.json does not list it`));
		expect(emptied.filter((problem) => problem.includes("no link leads to it"))).toEqual(
			["v1/prices/2026-11-11.json", "v1/prices/2026-11-12.json", "v1/schemas/events.schema.json"].map((path) => `${path} is in the tree, but no link leads to it from v1/index.json`),
		);
		const count = check(edit("v1/index.json", (index) => (index.series.count = 2)));
		expect(count).toEqual(["v1/index.json: /series/count is 2, not 3, as the tree and the Derivations make it"]);
	});

	test("when a schema in the tree is not this repository's, and validates with this repository's whatever the tree holds", () => {
		const blank = check((copy) => {
			writeFileSync(join(copy, "v1/schemas/series.schema.json"), "{}\n");
			edit(seriesPath(fixture.memory), (file) => (file.derivations.series_v1.newest_points[0].colour = "red"))(copy);
		});
		expect(blank[0]).toBe("v1/schemas/series.schema.json is not byte for byte schemas/api/v1/series.schema.json of this repository");
		expect(blank).toContainEqual(expect.stringContaining(`${seriesPath(fixture.memory)} does not match v1/schemas/series.schema.json: /derivations/series_v1/newest_points/0 must NOT have additional properties: colour`));
		// A schema in the tree that is no JSON Schema at all.
		const invalid = check((copy) => writeFileSync(join(copy, "v1/schemas/series-month.schema.json"), '{"type":"thing"}\n'));
		expect(invalid).toContainEqual(expect.stringMatching(/^v1\/schemas\/series-month\.schema\.json is not a valid JSON Schema: /));
	});

	test("when a link field names no file, by its place in the files: a row's url to a Series that is not there", () => {
		const gone = check(edit("v1/series.json", (list) => (list.series[0].url = `${DEFAULT_BASE}/v1/{gone}.json`)));
		const id = json(tree, "v1/series.json").series[0].id;
		expect(gone).toContain(`v1/series.json links ${DEFAULT_BASE}/v1/{gone}.json, which is not a file of the tree`);
		expect(gone).toContain(`v1/series.json: the row of Series ${id} has url "${DEFAULT_BASE}/v1/{gone}.json", not ${DEFAULT_BASE}/${seriesPath(id)}, the address of its file`);
		// The blob address template is the one address that names no file: it is checked to be exactly the base's.
		const template = check(edit("v1/index.json", (index) => (index.evidence.blob_url_template = "https://elsewhere.example/blobs/sha256/{hex}")));
		expect(template).toEqual([`v1/index.json: evidence.blob_url_template is "https://elsewhere.example/blobs/sha256/{hex}", not ${DEFAULT_BASE}/blobs/sha256/{hex}`]);
	});
});

describe("what a Method can emit and today's data do not show", () => {
	let edges: ApiFixture;
	let edgeTree: Map<string, Uint8Array>;
	let edgeDirectory: string;
	beforeAll(async () => {
		edges = await makeApiFixture({ edges: true });
		edgeTree = buildApi(sourcesOf(edges));
		edgeDirectory = writeTree(edgeTree);
	});

	test("matches the schemas, and the check finds no problem", () => {
		const result = checkApi({ tree: edgeDirectory, runs: edges.runs, base: DEFAULT_BASE, series: edges.series, requests: edges.requests });
		expect(result.problems).toEqual([]);
		expect(result.series).toBe(6);
		expect(result.months).toBe(6);
	});

	test("a counted Run of 0 ns per repetition, with bytes per repetition: its bytes per second, and every percentile of it, is null", () => {
		const id = edges.zeroTime as string;
		const file = json(edgeTree, seriesPath(id));
		const [point] = json(edgeTree, monthPath(id, "2026-11")).derivations.series_v1.points;
		expect([point.counted, point.time_per_repetition_ns, point.bytes_per_repetition, point.bytes_per_second]).toEqual([true, 0, 4096, null]);
		expect(file.derivations.series_v1.newest_points).toEqual([point]);
		const stat = { count: 1, p5: null, p50: null, p95: null };
		expect(file.derivations.series_v1.percentiles.bytes_per_second).toEqual(stat);
		expect(file.derivations.series_v1.groups[0].percentiles.bytes_per_second).toEqual(stat);
		expect(file.derivations.series_v1.percentiles.time_per_repetition_ns).toEqual({ count: 1, p5: 0, p50: 0, p95: 0 });
		// The Run behind them, which the tree leaves out, is the counted point with a bytes_per_repetition: its bytes per second, null, is infinite.
		expect(edges.series.derivations.find((d) => d.series.id === id)?.percentiles.bytes_per_second?.runs).toEqual([point.run]);
		const row = json(edgeTree, "v1/series.json").series.find((r: Json) => r.id === id);
		expect(row.derivations.series_v1.percentiles.bytes_per_second).toEqual({ count: 1, p5: null, p50: null, p95: null });
		expect(row.derivations.series_v1.counted_runs).toBe(1);
	});

	test("a counted Run whose time per repetition overflows a double: its time, and every percentile of time, is null; its bytes per second is 0", () => {
		const id = edges.overflowTime as string;
		const file = json(edgeTree, seriesPath(id));
		const [point] = json(edgeTree, monthPath(id, "2026-11")).derivations.series_v1.points;
		expect(point.samples.map((sample: Json) => sample.ns)).toEqual([OVERFLOW_X, Number.MAX_VALUE - OVERFLOW_X]);
		expect([point.counted, point.time_per_repetition_ns, point.bytes_per_repetition, point.bytes_per_second]).toEqual([true, null, 4096, 0]);
		const time = { count: 1, p5: null, p50: null, p95: null };
		expect(file.derivations.series_v1.percentiles.time_per_repetition_ns).toEqual(time);
		expect(file.derivations.series_v1.groups[0].percentiles.time_per_repetition_ns).toEqual(time);
		expect(file.derivations.series_v1.percentiles.bytes_per_second).toEqual({ count: 1, p5: 0, p50: 0, p95: 0 });
		// The Run behind them, which the tree leaves out, is the counted point: its time, null, is infinite.
		expect(edges.series.derivations.find((d) => d.series.id === id)?.percentiles.time_per_repetition_ns?.runs).toEqual([point.run]);
		const row = json(edgeTree, "v1/series.json").series.find((r: Json) => r.id === id);
		expect(row.derivations.series_v1.percentiles.time_per_repetition_ns).toEqual({ count: 1, p5: null, p50: null, p95: null });
		expect(row.derivations.series_v1.counted_runs).toBe(1);
	});

	test("a parameter whose value is an address under the base is data, not a link", () => {
		const id = edges.addressParam as string;
		expect(json(edgeTree, seriesPath(id)).params).toEqual({ destination: ADDRESS_PARAM });
		expect(ADDRESS_PARAM.startsWith(`${DEFAULT_BASE}/`)).toBe(true);
		expect(text(edgeTree, "v1/series.json")).toContain(`"params":{"destination":"${ADDRESS_PARAM}"}`);
	});
});

describe("the check's comparison of parsed values", () => {
	test("sees objects whatever the order of their members, arrays in order, numbers by value", () => {
		expect(difference({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBeNull();
		expect(difference({ a: 1.5 }, { a: 1.50 })).toBeNull();
		expect(difference({ a: [1, 2] }, { a: [2, 1] })).toBe("/a/0 is 1, not 2");
		expect(difference({ a: [1] }, { a: [1, 2] })).toBe("/a has 1 items, not 2");
		expect(difference({ a: null }, { a: 0 })).toBe("/a is null, not 0");
		expect(difference({}, { a: 0 })).toBe("/a is absent, not 0");
		expect(difference({ a: 0, "b/c": 1 }, { a: 0 })).toBe('/b~1c is 1, where nothing is expected');
	});
});

describe("the schemas", () => {
	const names = ["index", "series-list", "series", "series-month"];
	const schemas = names.map((name) => JSON.parse(readFileSync(join(ROOT, "schemas", "api", "v1", `${name}.schema.json`), "utf8")) as Json);

	test("forbid no member they do not list, so a field v1 gains later does not fail an older reader's check, and say so", () => {
		const visit = (value: unknown): void => {
			if (Array.isArray(value)) value.forEach(visit);
			else if (typeof value === "object" && value !== null) {
				expect((value as Json).additionalProperties).not.toBe(false);
				expect((value as Json).unevaluatedProperties).toBeUndefined();
				Object.values(value).forEach(visit);
			}
		};
		for (const schema of schemas) {
			visit(schema);
			expect(schema.description).toContain("only ever gains fields");
			expect(schema.description).toContain("v2, beside v1");
		}
	});

	test("closed, as the check reads them, still accept a file with every field described", () => {
		const closed = closeSchema({ type: "object", properties: { a: { type: "object", properties: { b: { const: { properties: 1 } } } }, c: { type: "object", additionalProperties: { type: "string" } } } }) as Json;
		expect(closed.additionalProperties).toBe(false);
		expect(closed.properties.a.additionalProperties).toBe(false);
		expect(closed.properties.a.properties.b).toEqual({ const: { properties: 1 } });
		expect(closed.properties.c.additionalProperties).toEqual({ type: "string" });
	});

	test("are the files the tree serves", () => {
		for (const name of names) expect(text(tree, `v1/schemas/${name}.schema.json`)).toBe(readFileSync(join(ROOT, "schemas", "api", "v1", `${name}.schema.json`), "utf8"));
	});
});

describe("the commands", () => {
	const bun = process.execPath;

	test("build the tree into an empty directory, and check it", () => {
		const out = join(mkdtempSync(join(tmpdir(), "api-cli-")), "api");
		const build = Bun.spawnSync([bun, "scripts/build-api.ts", "--derivations", fixture.derivationsPath, "--requests-derivations", fixture.requestsPath, "--runs", fixture.runs, "--out", out], { cwd: ROOT });
		expect(build.stderr.toString()).toBe("");
		expect(build.exitCode).toBe(0);
		expect(build.stdout.toString()).toContain("3 Series, 3 month files, 2 price files, 6 schemas");
		const written = readdirSync(join(out, "v1", "series"), { recursive: true }).map(String).sort();
		expect(written).toEqual([fixture.http, fixture.memory, fixture.syscall].sort().flatMap((id) => [id, `${id}.json`, join(id, `${NOVEMBER}.json`)]).sort());
		for (const [path, bytes] of tree) {
			if (path === "v1/index.json") continue; // its docs address is the default here
			expect(Buffer.from(readFileSync(join(out, path))).equals(Buffer.from(bytes))).toBe(true);
		}
		const checked = Bun.spawnSync([bun, "scripts/check-api.ts", "--tree", out, "--derivations", fixture.derivationsPath, "--requests-derivations", fixture.requestsPath, "--runs", fixture.runs], { cwd: ROOT });
		expect(checked.exitCode).toBe(0);
		expect(checked.stdout.toString()).toContain("no problem");

		const again = Bun.spawnSync([bun, "scripts/build-api.ts", "--derivations", fixture.derivationsPath, "--requests-derivations", fixture.requestsPath, "--runs", fixture.runs, "--out", out], { cwd: ROOT });
		expect(again.exitCode).toBe(1);
		expect(again.stderr.toString()).toContain("is not empty");

		rmSync(join(out, seriesPath(fixture.memory)));
		const broken = Bun.spawnSync([bun, "scripts/check-api.ts", "--tree", out, "--derivations", fixture.derivationsPath, "--requests-derivations", fixture.requestsPath, "--runs", fixture.runs], { cwd: ROOT });
		expect(broken.exitCode).toBe(1);
		expect(broken.stderr.toString()).toContain(`${seriesPath(fixture.memory)} is missing`);
	});
});
