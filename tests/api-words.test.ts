/**
 * The data API's own words name nothing a reader of the API alone cannot
 * fetch (ADR-0030, rule 5). Its first readers are agents that read the API and
 * nothing else: no repository, no README. So no word the tree publishes may
 * send them to a file of this repository, a document section, an issue, a pull
 * request, an ADR, a function of the code or a program's option.
 *
 * The tree is built as the golden test builds it (tests/api-golden.test.ts),
 * but with the docs address the workflow publishes (DEFAULT_DOCS), and every
 * string of every file is scanned, except what is data. What is prose and what
 * is data:
 *
 * - **Data** is what the Runs recorded, or what a Method derived from them for
 *   one Series or one Run: the Series' identity and params, each Run's point
 *   (its failure reasons included) and each pair's entry, the Run files no
 *   Method could read with the validator's reasons, each group's facts, the
 *   dump sections, what the requests recorded and their pooled figures, the
 *   months. Its words are the Runs', or a Method's verdict on one Run, and
 *   change only with the Runs or a new Method version; they are listed, by
 *   place, in DATA. A price file is a record of the Runs repository, copied
 *   byte for byte and never edited: data, whole.
 * - **Prose** is everything else a file of the tree holds: the table of
 *   contents' words, each Method's definitions and words for what it splits
 *   on, leaves out, phases and facts, and in a schema every title,
 *   description and $comment. It is the same whatever Runs the tree is cut
 *   from. A place not listed as data is scanned, so a new field is prose until
 *   it is shown to be data.
 *
 * What the scan finds is in REFERENCES; ALLOWED lists, by file, place and
 * text, the only exception, with why.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { API_SCHEMAS, buildApi, DEFAULT_BASE, DEFAULT_DOCS, readApiSchemas, readBootSummaries, readPriceFiles, writtenSchemaOf, type WrittenSchema } from "../scripts/lib/api";
import { makeApiFixture } from "./api-fixtures";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");

/**
 * The places in each kind of written file that hold data, as JSON Pointers;
 * `*` stands for one member of any name (a Method's key). Everything under
 * one of them is data.
 */
const DATA: Readonly<Record<WrittenSchema, readonly string[]>> = {
	// Each price file held: its date, its path in the Runs repository and its address.
	index: ["/prices/newest", "/prices/files"],
	"series-list": [
		// One row per Series: its identity, params, counts and each Method's figures.
		"/series",
		// Run files no Method could read: their paths, ids, sha256 and the validator's reasons.
		"/methods/*/unreadable",
		// The dump sections the Runs hold, by name, and how often each changed.
		"/methods/*/sections",
	],
	series: [
		"/id",
		"/benchmark",
		"/params",
		"/build",
		"/instance_type",
		"/availability_zone_id",
		"/months",
		// Each group's facts, read from the Runs, and its figures.
		"/derivations/*/groups",
		"/derivations/*/sections",
		// The Region and the Service's inputs, as the Runs recorded them.
		"/derivations/*/recorded",
		// Pooled figures, broken down by the values the requests recorded.
		"/derivations/*/pool",
		// Each Run's point: what the Method derived from that Run, its reasons for not counting it included.
		"/derivations/*/newest_points",
	],
	"series-month": [
		"/id",
		"/month",
		"/benchmark",
		"/params",
		"/build",
		"/instance_type",
		"/availability_zone_id",
		"/derivations/*/points",
		// The facts and dump sections that changed between two Runs, by name.
		"/derivations/*/differed",
	],
};

/** The words of a schema, by keyword: what JSON Schema gives people to read. */
const SCHEMA_WORDS = new Set(["title", "description", "$comment"]);

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const top = readdirSync(ROOT, { withFileTypes: true }).filter((entry) => ![".git", "node_modules", "local"].includes(entry.name));
/** The repository's own top-level directories and files, as this checkout has them. */
const DIRECTORIES = top.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
const ROOT_FILES = top.filter((entry) => entry.isFile()).map((entry) => entry.name);
const TREE_SCHEMAS = new Set<string>(API_SCHEMAS.map(({ name }) => name));

/** Each kind of reference a reader of the API cannot follow, with a pattern that finds it. */
const REFERENCES: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
	// scripts/check-events.py, runner/, docs/dev-log.md: not after a / or a word, so v1/schemas/… is not one.
	{ kind: "a path in the repository", pattern: new RegExp(`(?<![\\w./-])(?:${DIRECTORIES.map(escape).join("|")})/`, "g") },
	{ kind: "a file at the repository's root", pattern: new RegExp(`(?<![\\w./-])(?:${ROOT_FILES.map(escape).join("|")})(?![\\w-])`, "g") },
	{ kind: "a source or document file", pattern: /(?<![\w./-])[\w./-]*[\w-]\.(?:py|ts|tsx|js|mjs|cjs|md|c|h|sh|toml|ya?ml|lock)(?![\w-])/g },
	{ kind: "a README", pattern: /\breadme\b/gi },
	{ kind: "an ADR", pattern: /\bADR[- ]?\d+/gi },
	{ kind: "an issue or pull request", pattern: /(?<![\w&/#])#\d+\b|\b(?:issue|pull request|PR)s?\s+#?\d+/gi },
	{ kind: "a numbered section of a document", pattern: /\bsection\s+\d+(?:\.\d+)*\b/gi },
	{ kind: "the dev log", pattern: /\bdev[- ]log\b/gi },
	{ kind: "a function of the code", pattern: /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\)/g },
	{ kind: "a program's command-line option", pattern: /(?<![\w-])--[A-Za-z][\w-]*/g },
	{ kind: "the repository on GitHub", pattern: /github\.com|\bsmrdotgg\b/gi },
];

/** A schema file named in words that is not one of the tree's: schemas/events.schema.json lives in the repository, not under v1/schemas/. */
function otherSchemas(text: string): string[] {
	return [...text.matchAll(/(?<![\w-])([\w-]+)\.schema\.json/g)].filter((match) => !TREE_SCHEMAS.has(match[1] as string)).map((match) => match[0]);
}

/**
 * The only words the tree publishes that a reader cannot follow today, each
 * with why it stays. Every entry must still be found: one that is not fails
 * the test, so the list never outlives its reason.
 */
const ALLOWED: ReadonlyArray<{ file: string; pointer: string; text: string; why: string }> = [
	{
		file: "v1/index.json",
		pointer: "/docs",
		text: DEFAULT_DOCS,
		why:
			"The docs' address is the README's section on GitHub until the docs have pages of their own (ADR-0030, Costs); " +
			"it is an address, not words, and it can be followed once the repository is public. Changing it is a decision of its own.",
	},
];

interface Finding {
	file: string;
	pointer: string;
	kind: string;
	text: string;
}

const pointerOf = (segments: readonly string[]): string => segments.map((segment) => `/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

function isData(kind: WrittenSchema, segments: readonly string[]): boolean {
	return DATA[kind].some((place) => {
		const parts = place.split("/").slice(1);
		return parts.length <= segments.length && parts.every((part, i) => part === "*" || part === segments[i]);
	});
}

/** Every string a file holds, with its place, that is prose. */
function proseOf(path: string, value: unknown): Array<{ pointer: string; text: string }> {
	const out: Array<{ pointer: string; text: string }> = [];
	const kind = writtenSchemaOf(path);
	const isSchema = path.startsWith("v1/schemas/");
	const walk = (node: unknown, segments: string[]): void => {
		if (kind !== undefined && isData(kind, segments)) return;
		if (typeof node === "string") {
			if (!isSchema || SCHEMA_WORDS.has(segments[segments.length - 1] as string)) out.push({ pointer: pointerOf(segments), text: node });
			return;
		}
		if (Array.isArray(node)) node.forEach((item, i) => walk(item, [...segments, String(i)]));
		else if (typeof node === "object" && node !== null) for (const [key, item] of Object.entries(node)) walk(item, [...segments, key]);
	};
	walk(value, []);
	return out;
}

/** Every reference the prose of a tree makes that a reader of the API cannot follow, and the prose scanned. */
function scanWords(tree: ReadonlyMap<string, Uint8Array>): { findings: Finding[]; scanned: Map<string, Set<string>> } {
	const findings: Finding[] = [];
	const scanned = new Map<string, Set<string>>();
	for (const [path, bytes] of tree) {
		// A price file is a record of the Runs repository, copied byte for byte and never edited: data, whole.
		if (path.startsWith("v1/prices/")) continue;
		const places = new Set<string>();
		scanned.set(path, places);
		for (const { pointer, text } of proseOf(path, JSON.parse(new TextDecoder().decode(bytes)))) {
			places.add(pointer);
			for (const { kind, pattern } of REFERENCES) for (const match of text.matchAll(pattern)) findings.push({ file: path, pointer, kind, text: match[0] });
			for (const name of otherSchemas(text)) findings.push({ file: path, pointer, kind: "a schema the tree does not serve", text: name });
		}
	}
	return { findings, scanned };
}

const describeFinding = (finding: Finding): string => `${finding.file} ${finding.pointer}: ${finding.kind}, ${JSON.stringify(finding.text)}`;

let tree: Map<string, Uint8Array>;

beforeAll(async () => {
	const fixture = await makeApiFixture({ small: true });
	tree = buildApi({
		base: DEFAULT_BASE,
		docs: DEFAULT_DOCS,
		series: fixture.series,
		requests: fixture.requests,
		prices: readPriceFiles(fixture.runs),
		boots: readBootSummaries(fixture.runs),
		schemas: readApiSchemas(),
	});
});

describe("the words the data API publishes", () => {
	test("name no file, document, issue, pull request, ADR, function or option a reader of the API alone cannot fetch", () => {
		const { findings } = scanWords(tree);
		const allowed = (finding: Finding) => ALLOWED.find((entry) => entry.file === finding.file && entry.pointer === finding.pointer && finding.text.length > 0 && entry.text.includes(finding.text));
		const unexplained = findings.filter((finding) => allowed(finding) === undefined);
		expect(unexplained.map(describeFinding)).toEqual([]);
		// Every exception is still needed.
		for (const entry of ALLOWED) expect([entry.file, entry.pointer, findings.some((finding) => allowed(finding) === entry)]).toEqual([entry.file, entry.pointer, true]);
	});

	test("are scanned where they are: the table of contents, both Methods' words and every schema's descriptions", () => {
		const { scanned } = scanWords(tree);
		const at = (file: string): Set<string> => scanned.get(file) ?? new Set();
		for (const pointer of ["/about", "/versioning", "/figures", "/months", "/evidence/about", "/schemas/0/describes"]) expect([pointer, at("v1/index.json").has(pointer)]).toEqual([pointer, true]);
		for (const pointer of [
			"/methods/series_v1/definitions/counted",
			"/methods/series_v1/split_on/1/what",
			"/methods/series_v1/left_out/0/why",
			"/methods/series_v1/not_split_on/0/what",
			"/methods/requests_v1/definitions/counted",
			"/methods/requests_v1/phases/0/interval",
			"/methods/requests_v1/request_facts/0/what",
			"/methods/requests_v1/histogram/definition",
		]) {
			expect([pointer, at("v1/series.json").has(pointer)]).toEqual([pointer, true]);
		}
		const seriesFiles = [...scanned.keys()].filter((path) => writtenSchemaOf(path) === "series");
		expect(seriesFiles.length).toBeGreaterThan(0);
		for (const path of seriesFiles) expect([path, at(path).has("/derivations/series_v1/definitions/counted")]).toEqual([path, true]);
		for (const { name } of API_SCHEMAS) expect([name, at(`v1/schemas/${name}.schema.json`).has("/description")]).toEqual([name, true]);
		// What is data is not scanned: a point, a Run file no Method could read, a price file.
		const month = [...scanned.keys()].find((path) => writtenSchemaOf(path) === "series-month") as string;
		expect([...at(month)].some((pointer) => pointer.startsWith("/derivations/series_v1/points"))).toBe(false);
		expect([...at("v1/series.json")].some((pointer) => pointer.includes("/unreadable"))).toBe(false);
		expect([...scanned.keys()].some((path) => path.startsWith("v1/prices/"))).toBe(false);
	});

	test("are told apart from data: a reference planted in prose is found, one in a point's failure is not", () => {
		const encoder = new TextEncoder();
		const planted = new Map(tree);
		const edit = (path: string, change: (value: any) => void): void => {
			const value = JSON.parse(new TextDecoder().decode(planted.get(path)));
			change(value);
			planted.set(path, encoder.encode(JSON.stringify(value)));
		};
		const month = [...tree.keys()].find((path) => writtenSchemaOf(path) === "series-month") as string;
		edit("v1/series.json", (value) => {
			value.methods.series_v1.definitions.series += " See methods/README.md.";
		});
		edit(month, (value) => {
			value.derivations.series_v1.points[0].failure = "event 3 does not match schemas/events.schema.json";
		});
		edit("v1/schemas/series.schema.json", (value) => {
			value.properties.months.description += " (ADR-0031, item 8)";
		});
		const found = scanWords(planted).findings.filter((finding) => ALLOWED.every((entry) => entry.pointer !== finding.pointer));
		expect(found.map(describeFinding).sort()).toEqual(
			[
				`v1/series.json /methods/series_v1/definitions/series: a path in the repository, "methods/"`,
				`v1/series.json /methods/series_v1/definitions/series: a source or document file, "methods/README.md"`,
				`v1/series.json /methods/series_v1/definitions/series: a README, "README"`,
				`v1/schemas/series.schema.json /properties/months/description: an ADR, "ADR-0031"`,
			].sort(),
		);
	});

	test("each kind of reference is found, and the tree's own addresses are not", () => {
		const kinds = (text: string): string[] => [...REFERENCES.filter(({ pattern }) => [...text.matchAll(pattern)].length > 0).map(({ kind }) => kind), ...otherSchemas(text).map(() => "a schema the tree does not serve")];
		const cases: Array<[string, string[]]> = [
			["every order rule scripts/check-events.py checks", ["a path in the repository", "a source or document file"]],
			["runner: the manifest of runner/ that launched the binary", ["a path in the repository"]],
			["as the binary's README says", ["a README"]],
			["The contract in prose is docs/dev-log.md section 2.", ["a path in the repository", "a source or document file", "a numbered section of a document", "the dev log"]],
			["as ADR-0031 records", ["an ADR"]],
			["decided on #64", ["an issue or pull request"]],
			["merged in pull request 72", ["an issue or pull request"]],
			["held to it by recoverable()", ["a function of the code"]],
			["not a --quick stream", ["a program's command-line option"]],
			["see https://github.com/smrdotgg/ledgermath", ["the repository on GitHub"]],
			["checked against schedule.json", ["a file at the repository's root"]],
			["matches events.schema.json", ["a schema the tree does not serve"]],
			// The tree's own addresses and words.
			["For a given layout (the layout of v1/index.json), a month file's bytes change", []],
			["each point links its Run file (evidence), at runs/<yyyy>/<mm>/<dd>/<id>.json", []],
			["https://api.ledgermath.com/v1/schemas/series-month.schema.json", []],
			["follows its own schema, ledgermath.prices/1, as v1/schemas/prices.schema.json gives it", []],
			["changes on every read (each block device's I/O counters, /sys/block/*/stat)", []],
			["the 5th, 50th and 95th percentiles, by linear interpolation between closest ranks (R type 7)", []],
			["dump section cpuid: the raw cpuid leaves of every CPU", []],
			["c6i.8xlarge, i4i.2xlarge and m5.large", []],
		];
		for (const [text, expected] of cases) expect([text, kinds(text)]).toEqual([text, expected]);
	});
});
