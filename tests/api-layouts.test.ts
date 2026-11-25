/**
 * The published schemas of the kinds that existed at layout 1 (the table of
 * contents, the list of Series, a Series file, a month file) go on accepting
 * the files written at layout 1, and the schemas of layout 1 accept the files
 * written now. A reader may hold a file it fetched before and a schema it
 * fetches today, or the reverse; and during an upload the origin serves the
 * new schemas (written first, in phase 0) beside the old table of contents,
 * list and Series files (written later). So every field layout 2 added to
 * those kinds is optional in their published schemas, and the check, not the
 * schema, requires the present build to write it.
 *
 * A layout-1 file is the file the build writes now less what layout 2 added
 * (the golden copies' diff at the change shows that and nothing else but
 * words); the layout-1 schemas are the present ones less the properties layout
 * 2 added, which is what they were, their words aside.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Ajv2020 from "ajv/dist/2020";

import { buildApi, DEFAULT_BASE, readApiSchemas, readBootFiles, readBootSummaries, readPriceFiles, seriesPath, writerForm, writtenSchemaOf } from "../scripts/lib/api";
import { checkApi } from "../scripts/lib/api-check";
import { type ApiFixture, makeApiFixture } from "./api-fixtures";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");

type Json = Record<string, any>;

/** What layout 2 added to each kind that existed at layout 1, as places in the file. */
const ADDED_TO_GROUPS = ["counted_runs", "failed_runs", "oldest_run_started_at", "newest_run_started_at"];

/** The same file as layout 1 wrote it: without what layout 2 added. */
function asLayout1(kind: string, value: Json): Json {
	const out = structuredClone(value);
	if (kind === "index") {
		delete out.benchmarks;
		delete out.series.series_file_url_template;
		delete out.series.about;
		out.layout = 1;
		out.schemas = out.schemas.filter((schema: Json) => schema.name !== "benchmark");
	}
	if (kind === "series-list") for (const row of out.series) delete row.boots;
	if (kind === "series") {
		delete out.boots;
		delete out.benchmark_url;
		for (const block of Object.values(out.derivations) as Json[]) for (const group of block.groups) for (const key of ADDED_TO_GROUPS) delete group[key];
	}
	return out;
}

const read = (name: string): Json => JSON.parse(readFileSync(join(ROOT, "schemas", "api", "v1", `${name}.schema.json`), "utf8"));

/** A schema as layout 1 published it: the present one less the properties layout 2 added. */
function layout1Schema(name: string): Json {
	const schema = read(name);
	if (name === "index") {
		delete schema.properties.benchmarks;
		delete schema.properties.series.properties.series_file_url_template;
		delete schema.properties.series.properties.about;
		delete schema.$defs.benchmark;
	}
	if (name === "series-list") delete schema.$defs.row.properties.boots;
	if (name === "series") {
		delete schema.properties.boots;
		delete schema.properties.benchmark_url;
		for (const key of ADDED_TO_GROUPS) {
			delete schema.$defs.series_group.properties[key];
			delete schema.$defs.requests_v1.properties.groups.items.properties[key];
			delete schema.$defs[`group_${key}`];
		}
	}
	return schema;
}

let fixture: ApiFixture;
let tree: Map<string, Uint8Array>;

beforeAll(async () => {
	fixture = await makeApiFixture({ small: true });
	tree = buildApi({
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: fixture.series,
		requests: fixture.requests,
		prices: readPriceFiles(fixture.runs),
		boots: readBootSummaries(fixture.runs),
		bootFiles: readBootFiles(fixture.runs),
		schemas: readApiSchemas(),
	});
});

describe("files and schemas of both layouts", () => {
	test("the published schemas require nothing layout 2 added to the kinds that existed before it", () => {
		expect(read("index").required).not.toContain("benchmarks");
		expect(read("index").properties.series.required).toEqual(["url", "schema_url", "count", "series_file_schema_url", "month_file_schema_url"]);
		expect(read("series-list").$defs.row.required).not.toContain("boots");
		expect(read("series").required).not.toContain("boots");
		expect(read("series").required).not.toContain("benchmark_url");
		for (const key of ADDED_TO_GROUPS) {
			expect(read("series").$defs.series_group.required).not.toContain(key);
			expect(read("series").$defs.requests_v1.properties.groups.items.required).not.toContain(key);
		}
	});

	test("every file of a kind that existed at layout 1, as written now and as layout 1 wrote it, matches both the published schema of its kind and layout 1's", () => {
		const ajv = new Ajv2020({ strict: true, allErrors: true });
		const kinds = ["index", "series-list", "series", "series-month"];
		const now = new Map(kinds.map((name) => [name, ajv.compile(read(name))] as const));
		const before = new Map(kinds.map((name) => [name, new Ajv2020({ strict: true, allErrors: true }).compile(layout1Schema(name))] as const));
		let checked = 0;
		for (const [path, bytes] of tree) {
			const kind = writtenSchemaOf(path);
			if (kind === undefined || !kinds.includes(kind)) continue;
			const value = JSON.parse(new TextDecoder().decode(bytes)) as Json;
			const old = asLayout1(kind, value);
			for (const [schemas, which] of [
				[now, "today's schema"],
				[before, "layout 1's schema"],
			] as const) {
				for (const [file, what] of [
					[value, "the file as written now"],
					[old, "the file as layout 1 wrote it"],
				] as const) {
					const validate = schemas.get(kind) as ReturnType<typeof ajv.compile>;
					expect([path, which, what, validate(file), validate.errors?.[0] ?? null]).toEqual([path, which, what, true, null]);
				}
			}
			checked++;
		}
		expect(checked).toBeGreaterThanOrEqual(6);
	});

	test("the check, not the schema, requires the present build to write what layout 2 added", () => {
		const directory = mkdtempSync(join(tmpdir(), "api-layouts-tree-"));
		for (const [path, bytes] of tree) {
			mkdirSync(dirname(join(directory, path)), { recursive: true });
			writeFileSync(join(directory, path), bytes);
		}
		const check = (path: string, kind: string): string[] => {
			const copy = mkdtempSync(join(tmpdir(), "api-layouts-broken-"));
			cpSync(directory, copy, { recursive: true });
			const value = asLayout1(kind, JSON.parse(readFileSync(join(copy, path), "utf8")));
			writeFileSync(join(copy, path), writerForm(path, value));
			return checkApi({ tree: copy, runs: fixture.runs, base: DEFAULT_BASE, series: fixture.series, requests: fixture.requests }).problems;
		};
		const series = seriesPath([...tree.keys()].map((path) => /^v1\/series\/([0-9a-f]{12})\.json$/.exec(path)?.[1]).find((id) => id !== undefined) as string);
		const ofSeries = check(series, "series");
		expect(ofSeries).toContainEqual(expect.stringMatching(new RegExp(`^${series.replaceAll(".", "\\.")}: /boots is absent`)));
		expect(ofSeries).toContainEqual(expect.stringMatching(new RegExp(`^${series.replaceAll(".", "\\.")}: /benchmark_url is absent`)));
		expect(ofSeries).toContainEqual(expect.stringMatching(/: series_v1: \/groups\/0\/counted_runs is absent/));
		const ofList = check("v1/series.json", "series-list");
		expect(ofList).toContainEqual(expect.stringMatching(/^v1\/series\.json: the row of Series [0-9a-f]{12} differs from its file .*: \/boots is absent/));
		const ofIndex = check("v1/index.json", "index");
		expect(ofIndex).toContainEqual(expect.stringMatching(/^v1\/index\.json: \/series\/series_file_url_template is absent/));
		expect(ofIndex).toContainEqual(expect.stringMatching(/^v1\/index\.json: benchmarks: \/schema_url is absent/));
		expect(ofIndex).toContainEqual(expect.stringMatching(/^v1\/index\.json: \/layout is 1, not 2/));
	});
});
