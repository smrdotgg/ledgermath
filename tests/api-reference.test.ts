/**
 * The data API's reference (scripts/lib/api-reference.ts), held to what it promises:
 *
 * - every schema under schemas/ has a page, or is named as having none;
 * - every field the description test finds in a schema (tests/schema-descriptions.test.ts: each
 *   member of properties, patternProperties and additionalProperties, wherever it sits) is on
 *   that schema's page, by its path, with its words in full, found by a walk of the schema of
 *   this test's own;
 * - every file of the fixed sample (docs/api-sample/) is the one its manifest lists, validates
 *   against its schema, agrees with the others as one update of the API, and holds no key;
 * - every example on a page is an excerpt of the sample's file of its kind;
 * - every link from a page to a documentation page is a known address
 *   (scripts/lib/docs-addresses.ts), every link inside a page names a heading of it, and every
 *   other link is the API's or the repository's;
 * - each page is the Markdown the pipeline relies on; the overview quotes the API's contract
 *   word for word from scripts/lib/api.ts; the machines page gives every target of schedule.json;
 * - the same input gives the same bytes, and a small schema written here gives the page kept in
 *   tests/api-reference-golden.md, which shows what a page looks like:
 *
 *     LEDGERMATH_WRITE_GOLDEN=1 bun test tests/api-reference.test.ts    (writes it anew, on purpose)
 */

import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { SAMPLE_KINDS, SAMPLE_MANIFEST, type SampleKind, type SampleManifest } from "../scripts/fetch-api-sample";
import { ABOUT, EVIDENCE, FIGURES, LIST_UPDATES, MONTHS, VERSIONING } from "../scripts/lib/api";
import { closeSchema } from "../scripts/lib/api-check";
import {
	apiReference,
	EXCERPT_RULE,
	excerpt,
	KEYWORDS,
	markdownText,
	MEMBERS_BUDGET,
	SAMPLE_DIRECTORY,
	SCHEMAS_WITHOUT_A_PAGE,
	schemaPage,
	SHORT_LIST,
	splitFirstSentence,
	STRING_CUT,
	writeApiReference,
} from "../scripts/lib/api-reference";
import { FILE_PAGES, type FilePage, MACHINES, OVERVIEW } from "../scripts/lib/api-reference-words";
import { API_SCHEMAS } from "../scripts/lib/api-schemas";
import { isDocsAddress } from "../scripts/lib/docs-addresses";

const ROOT = join(import.meta.dir, "..");
const SAMPLE = join(ROOT, SAMPLE_DIRECTORY);
const GOLDEN = join(import.meta.dir, "api-reference-golden.md");
const PAGES = apiReference();

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const page = (file: string): string => {
	const text = PAGES.get(file);
	if (text === undefined) throw new Error(`no page ${file}`);
	return text;
};

// ---------------------------------------------------------------------------------------------
// Reading a page as a reader does

/** A line of Markdown as plain text: each backslash escape undone, code spans kept as written. */
function unescapeMarkdown(line: string): string {
	let out = "";
	for (let i = 0; i < line.length; i++) {
		const c = line[i] as string;
		if (c === "`") {
			const run = (/^`+/.exec(line.slice(i)) as RegExpExecArray)[0];
			let close = -1;
			for (let at = i + run.length; ; ) {
				const next = line.indexOf("`", at);
				if (next === -1) break;
				const length = (/^`+/.exec(line.slice(next)) as RegExpExecArray)[0].length;
				if (length === run.length) {
					close = next;
					break;
				}
				at = next + length;
			}
			const end = close === -1 ? i + run.length : close + run.length;
			out += line.slice(i, end);
			i = end - 1;
		} else if (c === "\\" && /[!-/:-@[-`{-~]/.test(line[i + 1] ?? "")) {
			out += line[i + 1];
			i++;
		} else out += c;
	}
	return out;
}

const decodeHtml = (text: string): string => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

/** A block of a page as the words a reader sees: a <summary> as HTML, everything else as Markdown, white space as single spaces. */
function plainText(markdown: string): string {
	const words: string[] = [];
	for (const line of markdown.split("\n")) {
		const summary = /^<summary>(.*)<\/summary>$/.exec(line);
		if (summary) words.push(decodeHtml(summary[1] as string));
		else if (line !== "<details>" && line !== "</details>") words.push(unescapeMarkdown(line));
	}
	return words.join(" ").replace(/\s+/g, " ").trim();
}

/** A page's lines outside fenced code blocks, each with its number. */
function proseLines(text: string): Array<{ line: string; at: number }> {
	const out: Array<{ line: string; at: number }> = [];
	let fence: string | undefined;
	text.split("\n").forEach((line, at) => {
		const marker = /^(`{3,})/.exec(line)?.[1];
		if (fence !== undefined) {
			if (marker !== undefined && line.trim() === fence) fence = undefined;
			return;
		}
		if (marker !== undefined) {
			fence = marker;
			return;
		}
		out.push({ line, at });
	});
	return out;
}

/**
 * Each field entry of a page: the shared shape whose section holds it (none for the section
 * "Fields"), the path its heading names, and the words up to the next heading.
 */
function entries(text: string): Array<{ shape?: string; condition?: string; path: string; words: string }> {
	const lines = text.split("\n");
	const prose = proseLines(text);
	const found: Array<{ shape?: string; condition?: string; path: string; words: string }> = [];
	let shape: string | undefined;
	// The heading of the condition a field stands under ("When `event` is …"), and its level: a later heading of that level or higher ends it.
	let condition: { text: string; level: number } | undefined;
	prose.forEach(({ line, at }, i) => {
		const level = /^(#{1,6}) /.exec(line)?.[1]?.length;
		if (level === undefined) return;
		if (level === 2) shape = undefined;
		const section = /^### Shape (`+)(.+?)\1$/.exec(line);
		if (section !== null) shape = (section[2] as string).trim();
		if (condition !== undefined && level <= condition.level) condition = undefined;
		if (/^#{1,6} (When|Otherwise) /.test(line)) condition = { text: line.replace(/^#+ /, ""), level };
		const heading = /^#{3,6} (`+)(.+?)\1$/.exec(line);
		if (heading === null) return;
		const next = prose.slice(i + 1).find((candidate) => /^#{1,6} /.test(candidate.line));
		found.push({ shape, condition: condition?.text, path: (heading[2] as string).trim(), words: plainText(lines.slice(at + 1, next?.at ?? lines.length).join("\n")) });
	});
	return found;
}

/** Whether a heading names the condition an if gives: each member it tests, with the value it requires. */
function namesCondition(heading: string | undefined, condition: Json | undefined): boolean {
	if (condition === undefined) return heading === undefined;
	if (heading === undefined || !heading.startsWith("When ")) return false;
	const tests = isObject(condition.properties) ? Object.entries(condition.properties) : [];
	return tests.length > 0 && tests.every(([name, test]) => isObject(test) && "const" in test && heading.includes(`\`${name}\``) && heading.includes(JSON.stringify(test.const)));
}

/** The shared shapes a page describes, by name. */
const shapesOf = (text: string): Set<string> => new Set([...text.matchAll(/^### Shape (`+)(.+?)\1$/gm)].map((match) => (match[2] as string).trim()));

/** A heading's anchor, as GitHub makes it. */
const slug = (heading: string): string => heading.toLowerCase().replace(/[^\p{L}\p{M}\p{N} _-]/gu, "").replaceAll(" ", "-");

// ---------------------------------------------------------------------------------------------
// The schemas' fields, found as tests/schema-descriptions.test.ts finds them

/** Every *.schema.json under schemas/, by its path from the repository's root. */
function schemaFiles(): string[] {
	return readdirSync(join(ROOT, "schemas"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
		.map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

type Step = { name: string } | { any: true } | { pattern: string } | { item: true } | { shape: true };

function renderSteps(steps: readonly Step[]): string {
	let out = "";
	for (const step of steps) {
		if ("shape" in step) out += "…";
		else if ("item" in step) out += "[]";
		else if ("any" in step) out += `${out === "" ? "" : "."}*`;
		else if ("pattern" in step) out += `${out === "" ? "" : "."}/${step.pattern}/`;
		else out += /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(step.name) ? `${out === "" ? "" : "."}${step.name}` : `[${JSON.stringify(step.name)}]`;
	}
	return out;
}

function resolve(root: Json, ref: string): unknown {
	let at: unknown = root;
	for (const part of ref.replace(/^#\/?/, "").split("/").filter((piece) => piece !== "")) at = isObject(at) ? at[decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
	return at;
}

/** A field's words: its own description, or, without one, the first its $ref leads to. */
function wordsOf(node: Json, root: Json): string | undefined {
	let at: unknown = node;
	for (let i = 0; i < 16 && isObject(at); i++) {
		if (typeof at.description === "string") return at.description;
		if (typeof at.$ref !== "string") return undefined;
		at = resolve(root, at.$ref);
	}
	return undefined;
}

interface Field {
	/** Where the description test names it: the path of the field from the root, or within a definition. */
	where: string;
	/** The definition it is declared in, if any, and its path from the root or within that definition. */
	definition?: string;
	steps: Step[];
	/** The if whose then declares it (or whose else, with otherwise true), if any. */
	condition?: Condition;
	words: string;
}

type Condition = { if: Json; otherwise: boolean };

/** Where each definition is named from: the definition holding the $ref (none for the root's fields), the path of the $ref within it, and the condition it stands under. */
type Sites = Map<string, Array<{ definition?: string; steps: Step[]; condition?: Condition }>>;

/**
 * Every field of a schema, found where the description test looks: under each field, an array's
 * elements, each branch of anyOf, oneOf and allOf, then and else, and each definition; and where
 * each definition is named from, found in the same places. A field declared under a then or an
 * else carries that condition.
 */
function fieldsOf(schema: Json): { fields: Field[]; sites: Sites } {
	const found: Field[] = [];
	const sites: Sites = new Map();
	const field = (node: unknown, steps: Step[], definition: string | undefined, condition: Condition | undefined): void => {
		if (!isObject(node)) return;
		const rendered = renderSteps(steps);
		const words = wordsOf(node, schema);
		if (words === undefined) throw new Error(`${rendered} has no words`);
		found.push({ where: definition === undefined ? rendered : `$defs.${definition}${rendered.startsWith("[") ? "" : "."}${rendered}`, definition, steps, condition, words });
		walk(node, steps, definition, condition);
	};
	const walk = (node: unknown, steps: Step[], definition: string | undefined, condition: Condition | undefined): void => {
		if (!isObject(node)) return;
		const named = typeof node.$ref === "string" ? /^#\/\$defs\/([^/]+)$/.exec(node.$ref)?.[1] : undefined;
		if (named !== undefined) sites.set(named, [...(sites.get(named) ?? []), { definition, steps, condition }]);
		if (isObject(node.properties)) for (const [name, member] of Object.entries(node.properties)) field(member, [...steps, { name }], definition, condition);
		if (isObject(node.patternProperties)) for (const [pattern, member] of Object.entries(node.patternProperties)) field(member, [...steps, { pattern }], definition, condition);
		for (const keyword of ["additionalProperties", "unevaluatedProperties"]) if (isObject(node[keyword])) field(node[keyword], [...steps, { any: true }], definition, condition);
		for (const keyword of ["items", "contains", "unevaluatedItems"]) if (isObject(node[keyword])) walk(node[keyword], [...steps, { item: true }], definition, condition);
		if (Array.isArray(node.prefixItems)) for (const item of node.prefixItems) walk(item, [...steps, { item: true }], definition, condition);
		for (const keyword of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[keyword])) for (const branch of node[keyword] as unknown[]) walk(branch, steps, definition, condition);
		if (isObject(node.if)) {
			walk(node.then, steps, definition, { if: node.if, otherwise: false });
			walk(node.else, steps, definition, { if: node.if, otherwise: true });
		} else for (const keyword of ["then", "else"]) walk(node[keyword], steps, definition, condition);
		if (isObject(node.dependentSchemas)) for (const branch of Object.values(node.dependentSchemas)) walk(branch, steps, definition, condition);
		for (const keyword of ["$defs", "definitions"]) if (isObject(node[keyword])) for (const [name, inner] of Object.entries(node[keyword] as Json)) walk(inner, [], name, undefined);
	};
	walk(schema, [], undefined, undefined);
	return { fields: found, sites };
}

/**
 * Where a page must show a field: in the section of the shared shape its definition is (its path
 * written from `…`), or, for a definition written out where it is used, at each place it is named
 * from, followed back to the root or to the shared shape that holds that place; and under the
 * heading of the condition it stands under (its own, or else its definition's place's), if any.
 */
function placesOf(field: Field, sites: Sites, shapes: ReadonlySet<string>): Array<{ shape?: string; path: string; condition?: Condition }> {
	const expand = (definition: string | undefined, steps: Step[], condition: Condition | undefined, seen: ReadonlySet<string>): Array<{ shape?: string; path: string; condition?: Condition }> => {
		if (definition === undefined) return [{ path: renderSteps(steps), condition }];
		if (shapes.has(definition)) return [{ shape: definition, path: renderSteps([{ shape: true }, ...steps]), condition }];
		if (seen.has(definition)) return [];
		return (sites.get(definition) ?? []).flatMap((site) => expand(site.definition, [...site.steps, ...steps], condition ?? site.condition, new Set([...seen, definition])));
	};
	return expand(field.definition, field.steps, field.condition, new Set());
}

/** Whether an entry's condition heading is the one a place stands under: none for none; "Otherwise" for an else; for a then, a "When" heading naming what its if tests. */
function underCondition(heading: string | undefined, condition: Condition | undefined): boolean {
	if (condition === undefined) return heading === undefined;
	if (condition.otherwise) return heading !== undefined && heading.startsWith("Otherwise ");
	return namesCondition(heading, condition.if);
}

/** Every field of SCHEMA that PAGE does not show in full at each place it owns: an empty list when the page holds them all. */
function missingFields(schema: Json, text: string): string[] {
	const shown = entries(text);
	const { fields, sites } = fieldsOf(schema);
	const missing: string[] = [];
	for (const field of fields) {
		const words = field.words.replace(/\s+/g, " ").trim();
		const places = placesOf(field, sites, shapesOf(text));
		if (places.length === 0) missing.push(`${field.where}: no place on the page`);
		for (const place of places) {
			const at = shown.filter((entry) => entry.shape === place.shape && entry.path === place.path && underCondition(entry.condition, place.condition));
			const when = place.condition === undefined ? "" : ` under the condition ${JSON.stringify(place.condition.if)}${place.condition.otherwise ? " (otherwise)" : ""}`;
			const where = `${place.path}${place.shape === undefined ? "" : ` in shape ${place.shape}`}${when}`;
			if (at.length === 0) missing.push(`${field.where}: no entry ${where}`);
			else if (!at.some((entry) => entry.words.includes(words))) missing.push(`${field.where}: its words are not in full under ${where}`);
		}
	}
	return missing;
}

// ---------------------------------------------------------------------------------------------
// The sample

const MANIFEST = readJson(join(SAMPLE, SAMPLE_MANIFEST)) as SampleManifest;
const sampleFile = (kind: SampleKind): { url: string; bytes: Uint8Array } => {
	const file = MANIFEST.files.find((one) => one.kind === kind);
	if (file === undefined) throw new Error(`the sample has no file of the kind ${kind}`);
	return { url: file.url, bytes: new Uint8Array(readFileSync(join(SAMPLE, ...file.path.split("/")))) };
};
const sampleJson = (kind: SampleKind): any => JSON.parse(new TextDecoder().decode(sampleFile(kind).bytes));
const sampleLines = (): string[] => new TextDecoder().decode(sampleFile("events").bytes).split("\n").filter((line) => line !== "");

/** The schema each kind of sample file is checked against, by its path in this repository. */
const SCHEMA_OF: Record<SampleKind, string> = {
	index: "schemas/api/v1/index.schema.json",
	"series-list": "schemas/api/v1/series-list.schema.json",
	benchmark: "schemas/api/v1/benchmark.schema.json",
	series: "schemas/api/v1/series.schema.json",
	"series-month": "schemas/api/v1/series-month.schema.json",
	prices: "schemas/prices.schema.json",
	run: "schemas/run.schema.json",
	events: "schemas/events.schema.json",
};
const API_OWN: readonly SampleKind[] = ["index", "series-list", "benchmark", "series", "series-month"];

/**
 * Whether EXAMPLE could be cut from VALUE: lists their first elements, objects some of their
 * members, strings their first characters ending in "…", and nothing else changed; and no list
 * or object that holds something is cut to nothing.
 */
function isExcerptOf(example: unknown, value: unknown): boolean {
	if (typeof example === "string") return example === value || (typeof value === "string" && example.endsWith("…") && value.length >= example.length && value.startsWith(example.slice(0, -1)));
	if (Array.isArray(example)) return Array.isArray(value) && example.length <= value.length && (example.length > 0 || value.length === 0) && example.every((element, i) => isExcerptOf(element, value[i]));
	if (isObject(example)) {
		const keys = Object.keys(example);
		return isObject(value) && (keys.length > 0 || Object.keys(value).length === 0) && keys.every((key) => Object.hasOwn(value, key) && isExcerptOf(example[key], value[key]));
	}
	return example === value;
}

/** The six universal events, whose members the events schema names. */
const UNIVERSAL = ["started", "observed", "sample_started", "sample_ended", "verified", "finished"];

/** The first fenced block after a page's "## Example". */
function exampleOf(text: string): { info: string; body: string } {
	const lines = text.split("\n");
	const start = lines.indexOf("## Example");
	const open = lines.findIndex((line, i) => i > start && /^`{3,}\S*$/.test(line));
	const fence = (/^`{3,}/.exec(lines[open] ?? "") as RegExpExecArray)[0];
	const close = lines.findIndex((line, i) => i > open && line === fence);
	return { info: (lines[open] as string).slice(fence.length), body: lines.slice(open + 1, close).join("\n") };
}

// ---------------------------------------------------------------------------------------------

describe("the API reference", () => {
	test("has a page for every schema under schemas/, or names it as having none", () => {
		const paged = FILE_PAGES.map((one) => one.schema);
		const without = SCHEMAS_WITHOUT_A_PAGE.map((one) => one.schema);
		expect(new Set(paged).size).toBe(paged.length);
		for (const schema of schemaFiles()) expect({ schema, paged: paged.includes(schema) || without.includes(schema) }).toEqual({ schema, paged: true });
		for (const schema of [...paged, ...without]) expect(existsSync(join(ROOT, schema))).toBe(true);
	});

	test("writes the files the docs pipeline expects, at the addresses it serves them", () => {
		expect([...PAGES.keys()]).toEqual([
			"docs/api/index.md",
			"docs/api/table-of-contents.md",
			"docs/api/series-list.md",
			"docs/api/benchmark-list.md",
			"docs/api/series.md",
			"docs/api/series-month.md",
			"docs/api/prices.md",
			"docs/api/run.md",
			"docs/api/events.md",
			"docs/machines.md",
		]);
		for (const one of [OVERVIEW, ...FILE_PAGES, MACHINES]) {
			expect(isDocsAddress(one.address)).toBe(true);
			expect(one.address.replace(/\/$/, "/index").replace(/^\//, "")).toBe(one.file.replace(/\.md$/, ""));
		}
	});

	for (const one of FILE_PAGES) {
		test(`${one.file}: every field of ${one.schema} is there, under the path or the shared shape that owns it, with its words in full`, () => {
			expect(missingFields(readJson(join(ROOT, one.schema)) as Json, page(one.file))).toEqual([]);
			expect(entries(page(one.file)).length).toBeGreaterThan(0);
		});
	}

	test("every schema uses only keywords the generator puts into words, and a name pattern and a condition only in the forms it reads", () => {
		const known = new Set<string>(KEYWORDS);
		const problems: string[] = [];
		const NAMES = new Set(["properties", "patternProperties", "$defs", "dependentSchemas"]);
		const visit = (node: unknown, file: string, at: string): void => {
			if (Array.isArray(node)) {
				node.forEach((item, i) => visit(item, file, `${at}/${i}`));
				return;
			}
			if (!isObject(node)) return;
			for (const [key, value] of Object.entries(node)) {
				if (!known.has(key)) problems.push(`${file}${at}: ${key}`);
				if (key === "propertyNames" && isObject(value) && Object.keys(value).some((inner) => inner !== "pattern")) problems.push(`${file}${at}: propertyNames holds more than a pattern`);
				if (key === "if" && isObject(value)) {
					if (Object.keys(value).some((inner) => inner !== "properties" && inner !== "required")) problems.push(`${file}${at}: an if holds more than properties and required`);
					if (isObject(value.properties)) for (const test of Object.values(value.properties)) if (!isObject(test) || Object.keys(test).some((inner) => inner !== "const" && inner !== "enum")) problems.push(`${file}${at}: an if tests a member by more than const or enum`);
				}
				if (["description", "title", "const", "enum", "pattern", "$ref", "$id", "$schema", "required"].includes(key)) continue;
				if (NAMES.has(key) && isObject(value)) for (const [name, inner] of Object.entries(value)) visit(inner, file, `${at}/${key}/${name}`);
				else visit(value, file, `${at}/${key}`);
			}
		};
		for (const file of schemaFiles()) visit(readJson(join(ROOT, file)), file, "");
		expect(problems).toEqual([]);
	});

	test("an example's excerpt does what the rule printed with it says", () => {
		const root = {
			type: "object",
			properties: {
				short: { type: "array", items: { type: "string" } },
				long: { type: "array", items: { type: "integer" } },
				phases: { type: "object", properties: { a: { $ref: "#/$defs/p" }, b: { $ref: "#/$defs/p" }, c: { description: "Its own words.", $ref: "#/$defs/p" } } },
				map: { type: "object", additionalProperties: { type: "string" } },
				text: { type: "string" },
			},
			$defs: { p: { type: "object", properties: { n: { type: "integer" } } } },
		};
		const long = Array.from({ length: 50 }, (_, i) => i);
		// Two bytes a character in UTF-8: cut to STRING_CUT characters, it still takes more than MEMBERS_BUDGET bytes.
		const big = "é".repeat(STRING_CUT + 10);
		expect(new TextEncoder().encode(JSON.stringify(`${"é".repeat(STRING_CUT)}…`)).length).toBeGreaterThan(MEMBERS_BUDGET);
		const value = { short: ["x", "y", "z"], long, phases: { a: { n: 1 }, b: { n: 2 }, c: { n: 3 } }, map: { first: big, second: "s" }, text: "z".repeat(STRING_CUT + 5) };
		const cuts: Array<{ path: string; what: string }> = [];
		expect(JSON.stringify(long).length).toBeGreaterThan(SHORT_LIST);
		expect(excerpt(root, value, root, "", cuts)).toEqual({
			// A short list of plain values is kept whole; a longer one keeps its first element.
			short: ["x", "y", "z"],
			long: [0],
			// Of members named with one shape and no words of their own, the first; one with words of its own is kept.
			phases: { a: { n: 1 }, c: { n: 3 } },
			// The first member whose name is not fixed is kept whatever its size, and none after the first that does not fit.
			map: { first: `${"é".repeat(STRING_CUT)}…` },
			text: `${"z".repeat(STRING_CUT)}…`,
		});
		expect(cuts.map((cut) => cut.path)).toEqual(["long", "phases", "map.first", "map", "text"]);
		for (const one of FILE_PAGES) if (page(one.file).includes("What the excerpt leaves out")) expect(page(one.file)).toContain(EXCERPT_RULE);
	});

	test("every page is the Markdown the pipeline relies on: a title, a paragraph, no HTML but <details> and <summary>, no front matter, no image", () => {
		for (const [file, text] of PAGES) {
			const blocks = text.split("\n\n");
			expect({ file, title: /^# \S/.test(blocks[0] ?? "") && !(blocks[0] ?? "").includes("\n") }).toEqual({ file, title: true });
			const second = blocks[1] ?? "";
			expect({ file, paragraph: /^[^#\-*+>|<\s]/.test(second) && !/^\d+[.)]\s/.test(second) && !second.startsWith("```") && !second.includes("\n") }).toEqual({ file, paragraph: true });
			const prose = proseLines(text)
				.map(({ line }) => line.replace(/(`+)[\s\S]*?\1/g, "").replace(/\\[<!]/g, ""))
				.join("\n");
			const tags =[...prose.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)/g)].map((match) => (match[1] as string).toLowerCase());
			expect({ file, tags: [...new Set(tags)].filter((tag) => tag !== "details" && tag !== "summary") }).toEqual({ file, tags: [] });
			expect(prose.includes("![")).toBe(false);
			expect(text.startsWith("---")).toBe(false);
			expect(text.endsWith("\n") && !text.endsWith("\n\n")).toBe(true);
		}
	});

	test("every link goes to a documentation page the list knows, a heading of its own page, the API or the repository", () => {
		const problems: string[] = [];
		for (const [file, text] of PAGES) {
			const prose = proseLines(text).map(({ line }) => line);
			const anchors = prose.filter((line) => /^#{1,6} /.test(line)).map((line) => slug(line.replace(/^#+ /, "").replaceAll("`", "")));
			const linkable = prose.map((line) => line.replace(/(`+)[\s\S]*?\1/g, "").replace(/\\[[\]]/g, "")).join("\n");
			for (const [, , target] of linkable.matchAll(/\[([^\]\n]*)\]\(([^()\s]+)\)/g)) {
				if (target === undefined) continue;
				if (target.startsWith("#")) {
					const matches = anchors.filter((anchor) => anchor === target.slice(1)).length;
					if (matches !== 1) problems.push(`${file}: ${target} names ${matches} headings`);
				} else if (target.startsWith("/")) {
					if (!isDocsAddress(target)) problems.push(`${file}: ${target} is no known documentation address`);
				} else if (!target.startsWith("https://api.ledgermath.com/") && !target.startsWith("https://github.com/smrdotgg/ledgermath/")) {
					problems.push(`${file}: ${target} is neither the API nor the repository`);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	test("each file page links its schema: at the API for the seven it serves, on GitHub for the Run's", () => {
		for (const one of FILE_PAGES) {
			const served = API_SCHEMAS.find((schema) => schema.source === one.schema);
			const address = served === undefined ? `https://github.com/smrdotgg/ledgermath/blob/main/${one.schema}` : `https://api.ledgermath.com/v1/schemas/${served.name}.schema.json`;
			expect({ page: one.file, links: page(one.file).includes(`](${address})`) }).toEqual({ page: one.file, links: true });
		}
		expect(FILE_PAGES.filter((one) => !API_SCHEMAS.some((schema) => schema.source === one.schema)).map((one) => one.schema)).toEqual(["schemas/run.schema.json"]);
	});

	test("the overview quotes the API's contract word for word, from its one source", () => {
		const quoted = page(OVERVIEW.file)
			.split("\n")
			.filter((line) => line.startsWith("> "))
			.map((line) => unescapeMarkdown(line.slice(2)));
		for (const [name, words] of Object.entries({ ABOUT, VERSIONING, FIGURES, MONTHS, LIST_UPDATES, EVIDENCE })) expect({ name, quoted: quoted.includes(words) }).toEqual({ name, quoted: true });
		for (const one of FILE_PAGES) expect(page(OVERVIEW.file)).toContain(`](${one.address})`);
	});

	test("the machines page gives every target of schedule.json: its vCPUs, its zone and the times it boots", () => {
		const schedule = readJson(join(ROOT, "schedule.json")) as { targets: Array<{ instance_type: string; vcpus: number; zone: string; boots_utc: string[] }> };
		const text = page(MACHINES.file);
		for (const target of schedule.targets) expect(text).toContain(`| ${target.instance_type} | ${target.vcpus} | ${target.zone} | ${target.boots_utc.join(", ")} |`);
		expect(text.split("\n").filter((line) => /^\| [a-z0-9]+\.[a-z0-9]+ \|/.test(line))).toHaveLength(schedule.targets.length);
	});

	test("the same input gives the same bytes, and writing refuses to overwrite", () => {
		expect([...apiReference()]).toEqual([...PAGES]);
		const out = mkdtempSync(join(tmpdir(), "api-reference-"));
		try {
			expect(writeApiReference(out, PAGES)).toEqual([...PAGES.keys()]);
			for (const [file, text] of PAGES) expect(readFileSync(join(out, ...file.split("/")), "utf8")).toBe(text);
			expect(() => writeApiReference(out, PAGES)).toThrow(/already exist/);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});
});

describe("the fixed sample", () => {
	test("holds exactly the files its manifest lists, one of each kind, each of the size and sha256 listed", () => {
		const held = readdirSync(SAMPLE, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => relative(SAMPLE, join(entry.parentPath, entry.name)).split(sep).join("/"))
			.filter((path) => path !== SAMPLE_MANIFEST)
			.sort();
		expect(held).toEqual(MANIFEST.files.map((file) => file.path).sort());
		expect(MANIFEST.files.map((file) => file.kind).sort()).toEqual([...SAMPLE_KINDS].sort());
		for (const file of MANIFEST.files) {
			const bytes = readFileSync(join(SAMPLE, ...file.path.split("/")));
			expect({ path: file.path, bytes: bytes.length, sha256: sha256(bytes), url: file.url }).toEqual({ path: file.path, bytes: file.bytes, sha256: file.sha256, url: `${MANIFEST.base}/${file.path}` });
		}
	});

	test("each file validates against its schema, the API's own also against the schema closed, and each line of the stream against the events schema", () => {
		for (const kind of SAMPLE_KINDS) {
			const schema = readJson(join(ROOT, SCHEMA_OF[kind])) as object;
			const values = kind === "events" ? sampleLines().map((line) => JSON.parse(line)) : [sampleJson(kind)];
			for (const closed of API_OWN.includes(kind) ? [false, true] : [false]) {
				const validate = new Ajv2020({ strict: true, allErrors: true }).compile(closed ? (closeSchema(schema) as object) : schema);
				for (const value of values) expect({ kind, closed, errors: validate(value) ? null : validate.errors }).toEqual({ kind, closed, errors: null });
			}
		}
	});

	test("its files agree as one update of the API, following one Series from the table of contents to its Run's stdout", () => {
		const index = sampleJson("index");
		const list = sampleJson("series-list");
		const series = sampleJson("series");
		const month = sampleFile("series-month");
		const run = sampleFile("run");
		const listed = series.months.find((entry: Json) => entry.url === month.url);
		expect({ bytes: month.bytes.length, sha256: sha256(month.bytes) }).toEqual({ bytes: listed.bytes, sha256: listed.sha256 });
		const point = series.derivations.series_v1.newest_points.find((one: Json) => one.evidence === run.url);
		expect(sha256(run.bytes)).toBe(point.sha256);
		expect(`sha256:${sha256(sampleFile("events").bytes)}`).toBe(sampleJson("run").stdout);
		const rowLine = (bytes: Uint8Array): string | undefined =>
			new TextDecoder()
				.decode(bytes)
				.split("\n")
				.find((line) => line.includes(`"id":"${series.id}"`))
				?.trim()
				.replace(/,$/, "");
		expect(rowLine(sampleFile("benchmark").bytes)).toBe(rowLine(sampleFile("series-list").bytes) as string);
		expect(list.series.find((row: Json) => row.id === series.id).url).toBe(series.url);
		expect(index.series.count).toBe(list.count);
		expect(index.prices.newest.url).toBe(sampleFile("prices").url);
		expect(index.benchmarks.list.some((entry: Json) => entry.url === sampleFile("benchmark").url)).toBe(true);
	});

	test("holds no AWS access key", () => {
		for (const file of MANIFEST.files) expect({ path: file.path, keys: readFileSync(join(SAMPLE, ...file.path.split("/")), "latin1").match(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g) }).toEqual({ path: file.path, keys: null });
	});

	test("every example on a page is an excerpt of the sample's file of its kind, linked from the page", () => {
		for (const one of FILE_PAGES) {
			const text = page(one.file);
			const example = exampleOf(text);
			expect(text).toContain(`](${sampleFile(one.sample).url})`);
			if (one.sample === "events") {
				expect(example.info).toBe("jsonl");
				const stream = sampleLines().map((line) => JSON.parse(line));
				// One line for each kind of universal event the stream holds, and no kind twice.
				const kinds = example.body.split("\n").map((line) => String((JSON.parse(line) as Json).event)).filter((name) => UNIVERSAL.includes(name));
				expect(kinds.sort()).toEqual(UNIVERSAL.filter((name) => stream.some((event) => event.event === name)).sort());
				for (const line of example.body.split("\n")) {
					const shown = JSON.parse(line) as Json;
					const source = stream.find((event) => event.event === shown.event && event.t === shown.t);
					expect({ line, fromTheStream: source !== undefined && isExcerptOf(shown, source) }).toEqual({ line, fromTheStream: true });
					// The floor: every line keeps its name and time, and a universal event every member it has.
					const kept = UNIVERSAL.includes(String(shown.event)) ? Object.keys(source as Json) : ["event", "t"];
					expect({ line, keeps: kept.every((key) => Object.hasOwn(shown, key)) }).toEqual({ line, keeps: true });
				}
			} else {
				expect(example.info).toBe("json");
				const shown = JSON.parse(example.body) as Json;
				expect({ page: one.file, excerpt: isExcerptOf(shown, sampleJson(one.sample)) }).toEqual({ page: one.file, excerpt: true });
				// The floor: the example keeps every member the file has at its top level.
				expect({ page: one.file, top: Object.keys(shown) }).toEqual({ page: one.file, top: Object.keys(sampleJson(one.sample)) });
			}
		}
	});
});

describe("the Markdown the generator writes", () => {
	test("shows a description character for character, and keeps the code spans it writes", () => {
		expect(markdownText("v1/series/<id>.json, keyed <method name>_v<version>")).toBe("v1/series/\\<id\\>.json, keyed \\<method name\\>\\_v\\<version\\>");
		expect(markdownText("time_per_repetition_ns, LM_PARAM_*, 10^9 × [bin, count]")).toBe("time_per_repetition_ns, LM_PARAM\\_\\*, 10^9 × \\[bin, count\\]");
		expect(markdownText("`inputs` holds it; a lone ` is not code")).toBe("`inputs` holds it; a lone \\` is not code");
		expect(markdownText("1. Not a list")).toBe("1\\. Not a list");
		for (const words of ["v1/series/<id>.json: one <b>Series</b> & *more*", "`a_b` and \\ and _c_"]) expect(unescapeMarkdown(markdownText(words))).toBe(words);
	});

	test("folds a description after its first sentence, which ends at a full stop outside parentheses that is not an abbreviation's", () => {
		expect(splitFirstSentence("One. Two.")).toEqual(["One.", "Two."]);
		expect(splitFirstSentence("Read (a) a thing. b) not. Then more.")).toEqual(["Read (a) a thing.", "b) not. Then more."]);
		expect(splitFirstSentence("Such as e.g. this, i.e. that. Then.")).toEqual(["Such as e.g. this, i.e. that.", "Then."]);
		expect(splitFirstSentence("sample_ended.t minus sample_started.t.")).toEqual(["sample_ended.t minus sample_started.t.", ""]);
	});

	test("a small schema written here gives the page kept in tests/api-reference-golden.md", () => {
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			title: "A small file",
			description:
				"v1/small/<id>.json: what a small file holds, to show what a page of the reference looks like. Its description is long enough to fold, so a reader sees its first sentence and opens the rest on a click; all of its words are in the Markdown either way.",
			type: "object",
			required: ["kind", "size", "items", "end"],
			properties: {
				kind: { description: "What this file is.", const: "ledgermath.small/1" },
				size: { description: "How many items it holds.", type: "integer", minimum: 0 },
				when: { description: "When it was made; null when nobody knows.", anyOf: [{ $ref: "#/$defs/time" }, { type: "null" }] },
				items: { description: "Its items, oldest first.", type: "array", minItems: 1, items: { $ref: "#/$defs/item" } },
				first: { description: "Its first item, again.", $ref: "#/$defs/item" },
				tags: { description: "Words about it, by name.", type: "object", minProperties: 1, propertyNames: { pattern: "^[a-z]+$" }, additionalProperties: { description: "One tag, under its name.", type: "string" } },
				counters: { description: "Counts, each under a name that starts x_.", type: "object", patternProperties: { "^x_": { description: "One count.", type: "integer" } } },
				mode: { description: "How fast it was made.", enum: ["fast", "slow"] },
				end: {
					description: "How it ended: its code, or the signal that ended it.",
					oneOf: [
						{ type: "object", required: ["code"], properties: { code: { description: "The exit code.", type: "integer", minimum: 0 } }, additionalProperties: false },
						{ type: "object", required: ["signal"], properties: { signal: { description: "The signal's number.", type: "integer", minimum: 1 } }, additionalProperties: false },
					],
				},
			},
			allOf: [{ if: { properties: { kind: { const: "ledgermath.small/1" } } }, then: { description: "The first version of the shape.", properties: { kind: true, extra: { description: "Whether it holds more than it says.", type: "boolean" } } } }],
			$defs: {
				time: { description: "UTC, to the second.", type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" },
				item: {
					description: "One item.",
					type: "object",
					required: ["name"],
					properties: {
						name: { description: "Its name, which may hold <angle brackets>, an_underscore, *stars* and `code`.", type: "string", minLength: 1 },
						"p99.9": { description: "A figure whose name has a dot in it.", anyOf: [{ type: "number" }, { type: "null" }] },
					},
				},
			},
		};
		const small: FilePage = {
			file: "docs/api/small.md",
			address: "/docs/api/small",
			schema: "schemas/small.schema.json",
			sample: "index",
			title: "A small file",
			intro: "`v1/small/<id>.json` is a file that exists only in this test, to show what a page looks like.",
			where: ["Address: `https://api.ledgermath.com/v1/small/<id>.json`.", "Reached from: nowhere; it is a test's."],
			v1: true,
		};
		const value = {
			kind: "ledgermath.small/1",
			size: 3,
			when: "2026-11-26T12:00:00Z",
			items: [{ name: "a", "p99.9": 1.5 }, { name: "b" }, { name: "c", "p99.9": null }],
			first: { name: "a", "p99.9": 1.5 },
			tags: { colour: "blue", shape: "round", note: "x".repeat(400) },
			counters: { x_a: 1, x_b: 2 },
			mode: "fast",
			end: { code: 0 },
			extra: false,
		};
		const source = { url: "https://api.ledgermath.com/v1/small/abc.json", bytes: new TextEncoder().encode(JSON.stringify(value)), takenOn: "2026-11-26" };
		const written = schemaPage(small, schema, source);
		if (process.env.LEDGERMATH_WRITE_GOLDEN === "1") writeFileSync(GOLDEN, written);
		expect(written).toBe(readFileSync(GOLDEN, "utf8"));
		// The golden page holds every field of its schema too, by the same check as the real pages.
		expect(missingFields(schema as unknown as Json, written)).toEqual([]);
	});
});
