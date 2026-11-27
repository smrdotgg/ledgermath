/**
 * The data API's reference, as Markdown, generated from the schemas (#64, decision 9): a page
 * for each kind of file, the overview at /docs/api/ and the machines page.
 *
 *     docs/api/index.md                the overview: hand-written words (api-reference-words.ts),
 *                                      the API's contract paragraphs quoted from scripts/lib/api.ts
 *     docs/api/<page>.md               one page per schema (FILE_PAGES): where the file is, the
 *                                      schema's own description, an example, every field
 *     docs/machines.md                 the targets of schedule.json
 *
 * What a field means is its schema's description, copied whole, never rewritten: only escaped,
 * so that Markdown shows it as written. A field is named by its full path from the top of the
 * file. A definition the schema uses in more than one place, and which has fields of its own, is
 * a shared shape: its fields are described once, under "Shared shapes", where it lists every
 * place it is used, and each place links to it. A definition used in one place is written out
 * there, under that place's paths. A description longer than FOLD_ABOVE characters, of more than
 * one sentence, folds: <details>, with its first sentence as the <summary>.
 *
 * The examples come from the fixed sample in docs/api-sample/ (scripts/fetch-api-sample.ts),
 * never from the live API, so a page changes only when its schema, its words or the sample do.
 * An example is an excerpt the generator makes (excerpt()), and the page lists what it left out.
 *
 * Same input, same bytes: no clock is read, nothing depends on the order of a directory or the
 * machine's locale. The generated pages are not kept in the repository; the site's build writes
 * them (writeApiReference(), or `bun scripts/api-reference.ts --out DIR`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SAMPLE_MANIFEST, type SampleKind, type SampleManifest } from "../fetch-api-sample";
import { ABOUT, DEFAULT_BASE, EVIDENCE, FIGURES, LIST_UPDATES, MONTHS, VERSIONING } from "./api";
import { API_SCHEMAS } from "./api-schemas";
import { FILE_PAGES, type FilePage, MACHINES, OVERVIEW, overviewBody } from "./api-reference-words";

const ROOT = resolve(import.meta.dir, "..", "..");

/** The fixed sample of the API's files, laid out as served, with its manifest (sample.json). */
export const SAMPLE_DIRECTORY = "docs/api-sample";
export const REPOSITORY = "https://github.com/smrdotgg/ledgermath";
/** Schemas under schemas/ that have no page, each with why. None today: tests/api-reference.test.ts holds every other schema to a page. */
export const SCHEMAS_WITHOUT_A_PAGE: ReadonlyArray<{ schema: string; why: string }> = [];

/** A description longer than this, of more than one sentence, folds behind its first sentence. */
export const FOLD_ABOVE = 200;
/** An example keeps this many characters of a longer string, and ends it with "…". */
export const STRING_CUT = 160;
/** An example keeps an object's members whose names its schema does not fix: the first, then each next while the values kept take at most this many bytes of JSON. */
export const MEMBERS_BUDGET = 300;
/** An example keeps a list of plain values whole when its JSON takes at most this many characters; any other list keeps its first element. */
export const SHORT_LIST = 120;
/** A pattern longer than this is not written out in a field's type: the schema has it. */
export const PATTERN_SHOWN = 80;

/**
 * Every keyword of JSON Schema the generator puts into words (or, for $schema, $id and $defs,
 * needs none): tests/api-reference.test.ts fails on a schema under schemas/ that uses any other,
 * so a constraint a schema gains is never dropped from its page unseen.
 */
export const KEYWORDS = [
	"$schema",
	"$id",
	"$defs",
	"$ref",
	"title",
	"description",
	"type",
	"const",
	"enum",
	"properties",
	"patternProperties",
	"additionalProperties",
	"propertyNames",
	"required",
	"minProperties",
	"maxProperties",
	"items",
	"prefixItems",
	"minItems",
	"maxItems",
	"uniqueItems",
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"anyOf",
	"oneOf",
	"allOf",
	"if",
	"then",
	"else",
] as const;

type Json = { [key: string]: unknown };

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const plural = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`;
const orList = (items: readonly string[], word = "or"): string => (items.length <= 2 ? items.join(` ${word} `) : `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`);

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
	if (isObject(a) && isObject(b)) {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
	}
	return false;
}

// ---------------------------------------------------------------------------------------------
// Markdown

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Where the run of backticks starting at START closes, as a code span: the next run of exactly as many; -1 when none does. */
function codeSpanEnd(text: string, start: number): number {
	const opening = (/^`+/.exec(text.slice(start)) as RegExpExecArray)[0].length;
	let at = start + opening;
	for (;;) {
		const next = text.indexOf("`", at);
		if (next === -1) return -1;
		const run = (/^`+/.exec(text.slice(next)) as RegExpExecArray)[0].length;
		if (run === opening) return next + run;
		at = next + run;
	}
}

/**
 * Text as Markdown shows it, character for character: each character Markdown would read as
 * markup is escaped with a backslash (an underscore only where it could open or close emphasis,
 * not inside a word), and a paragraph that would start a heading, a list or a rule has its first
 * mark escaped. A code span the text writes (`stdout_bytes`, in backticks) is kept as one, as
 * written: the schemas use backticks for names.
 */
export function markdownText(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (c === "`") {
			const end = codeSpanEnd(text, i);
			const run = (/^`+/.exec(text.slice(i)) as RegExpExecArray)[0];
			if (end === -1) out += run.replaceAll("`", "\\`");
			else out += text.slice(i, end);
			i = (end === -1 ? i + run.length : end) - 1;
		} else if ("\\*<>[]~|".includes(c)) out += `\\${c}`;
		else if (c === "_" && !(LETTER_OR_DIGIT.test(text[i - 1] ?? "") && LETTER_OR_DIGIT.test(text[i + 1] ?? ""))) out += "\\_";
		else if (c === "&" && /^&#?[A-Za-z0-9]+;/.test(text.slice(i))) out += "\\&";
		else out += c;
	}
	return out.replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2").replace(/^([#+=-])(?=\s|$)/, "\\$1");
}

/** Text inside an HTML element (a <summary>), which Markdown does not read: &, < and > as entities. */
export function htmlText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A code span holding TEXT as it is, fenced with more backticks than any run inside it. */
export function code(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** A fenced code block holding TEXT, fenced with more backticks than any run inside it. */
function codeBlock(text: string, info: string): string {
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${info}\n${text}\n${fence}`;
}

/** A heading's anchor as GitHub makes it: lower case, punctuation but - and _ dropped, each space a -. */
export function headingSlug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N} _-]/gu, "")
		.replaceAll(" ", "-");
}

const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "cf"]);

/** A text's first sentence and the rest: it ends at the first ., ? or ! outside parentheses that is followed by a space, and is not an abbreviation's. */
export function splitFirstSentence(text: string): [string, string] {
	let depth = 0;
	for (let i = 0; i < text.length - 1; i++) {
		const c = text[i];
		if (c === "(") depth++;
		else if (c === ")") depth = Math.max(0, depth - 1);
		else if (depth === 0 && (c === "." || c === "?" || c === "!") && text[i + 1] === " ") {
			const word = /(\S+)$/.exec(text.slice(0, i))?.[1] ?? "";
			if (ABBREVIATIONS.has(word.toLowerCase()) || /^[A-Za-z]$/.test(word)) continue;
			const rest = text.slice(i + 2);
			if (rest.trim() !== "") return [text.slice(0, i + 1), rest];
		}
	}
	return [text, ""];
}

/**
 * A description as a block: a paragraph, or, when it is longer than FOLD_ABOVE characters and
 * has more than one sentence, folded behind its first sentence. PREFIX (the generator's own
 * words, such as "Each element: ") goes before it.
 */
export function describe(text: string, prefix = ""): string {
	const [first, rest] = splitFirstSentence(text);
	if (text.length <= FOLD_ABOVE || rest === "") return markdownText(`${prefix}${text}`);
	return `<details>\n<summary>${htmlText(`${prefix}${first}`)}</summary>\n\n${markdownText(rest)}\n\n</details>`;
}

// ---------------------------------------------------------------------------------------------
// Paths

/** One step of a field's path: a member's name, a member of any name, of a pattern, each element of a list, or the place a shared shape is used. */
type Step = { name: string } | { any: true } | { pattern: string } | { item: true } | { shape: true };
const ANY: Step = { any: true };
const ITEM: Step = { item: true };
const SHAPE: Step = { shape: true };
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A path as the pages write it: derivations.series_v1.counted_runs, months[].url, params.*, at_or_above["p99.9"], ….p50. */
export function renderPath(path: readonly Step[]): string {
	let out = "";
	for (const step of path) {
		if ("shape" in step) out += "…";
		else if ("item" in step) out += "[]";
		else if ("any" in step) out += `${out === "" ? "" : "."}*`;
		else if ("pattern" in step) out += `${out === "" ? "" : "."}/${step.pattern}/`;
		else out += IDENTIFIER.test(step.name) ? `${out === "" ? "" : "."}${step.name}` : `[${JSON.stringify(step.name)}]`;
	}
	return out;
}

/** A member's place in a value, as an excerpt's notes give it: line 3.values, newest_points[0].samples. */
function memberPath(path: string, key: string | number): string {
	if (typeof key === "number") return `${path}[${key}]`;
	return IDENTIFIER.test(key) ? (path === "" ? key : `${path}.${key}`) : `${path}[${JSON.stringify(key)}]`;
}

// ---------------------------------------------------------------------------------------------
// Schemas

/** The schema a local $ref names, or undefined. */
function resolveRef(root: Json, ref: string): unknown {
	if (!ref.startsWith("#")) return undefined;
	let at: unknown = root;
	for (const part of ref.slice(1).split("/").filter((piece) => piece !== "")) {
		const key = decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~");
		if (Array.isArray(at)) at = at[Number(key)];
		else if (isObject(at)) at = at[key];
		else return undefined;
	}
	return at;
}

/** The definition a $ref names, by its name under $defs, or undefined for any other $ref. */
function definitionName(ref: string): string | undefined {
	const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
	return match ? decodeURIComponent(match[1] as string).replaceAll("~1", "/").replaceAll("~0", "~") : undefined;
}

/** What applies to a value at one place of a schema, gathered from the node, the definitions it names and its allOf branches without an if. */
interface View {
	properties: Array<[string, Json | boolean]>;
	patterns: Array<[string, Json]>;
	additional: Json | boolean | undefined;
	required: Set<string>;
	items: Json | undefined;
	prefixItems: unknown[];
	branches: { word: "oneOf" | "anyOf"; list: unknown[] } | undefined;
	conditionals: Array<{ if: Json; then: unknown; else: unknown }>;
	types: string[];
	description: string | undefined;
	/** The pattern every member's name must match (propertyNames), if any. */
	namePattern: string | undefined;
	minProperties: number | undefined;
	maxProperties: number | undefined;
}

function view(root: Json, node: unknown): View {
	const v: View = {
		properties: [],
		patterns: [],
		additional: undefined,
		required: new Set(),
		items: undefined,
		prefixItems: [],
		branches: undefined,
		conditionals: [],
		types: [],
		description: undefined,
		namePattern: undefined,
		minProperties: undefined,
		maxProperties: undefined,
	};
	const seen = new Set<Json>();
	const add = (n: unknown): void => {
		if (!isObject(n) || seen.has(n)) return;
		seen.add(n);
		if (v.description === undefined && typeof n.description === "string") v.description = n.description;
		if (isObject(n.properties)) for (const [name, schema] of Object.entries(n.properties)) if (!v.properties.some(([known]) => known === name)) v.properties.push([name, schema as Json | boolean]);
		if (isObject(n.patternProperties)) for (const [pattern, schema] of Object.entries(n.patternProperties)) if (isObject(schema)) v.patterns.push([pattern, schema]);
		if (n.additionalProperties !== undefined && v.additional === undefined) v.additional = n.additionalProperties as Json | boolean;
		if (Array.isArray(n.required)) for (const name of n.required) if (typeof name === "string") v.required.add(name);
		if (isObject(n.items) && v.items === undefined) v.items = n.items;
		if (Array.isArray(n.prefixItems) && v.prefixItems.length === 0) v.prefixItems = n.prefixItems;
		if (typeof n.type === "string") v.types.push(n.type);
		if (Array.isArray(n.type)) for (const type of n.type) if (typeof type === "string") v.types.push(type);
		if (v.branches === undefined && Array.isArray(n.oneOf)) v.branches = { word: "oneOf", list: n.oneOf };
		if (v.branches === undefined && Array.isArray(n.anyOf)) v.branches = { word: "anyOf", list: n.anyOf };
		if (isObject(n.if)) v.conditionals.push({ if: n.if, then: n.then, else: n.else });
		if (v.namePattern === undefined && isObject(n.propertyNames) && typeof n.propertyNames.pattern === "string") v.namePattern = n.propertyNames.pattern;
		if (v.minProperties === undefined && typeof n.minProperties === "number") v.minProperties = n.minProperties;
		if (v.maxProperties === undefined && typeof n.maxProperties === "number") v.maxProperties = n.maxProperties;
		if (typeof n.$ref === "string") add(resolveRef(root, n.$ref));
		if (Array.isArray(n.allOf)) {
			for (const branch of n.allOf) {
				if (isObject(branch) && isObject(branch.if)) v.conditionals.push({ if: branch.if, then: branch.then, else: branch.else });
				else add(branch);
			}
		}
	};
	add(node);
	return v;
}

const hasObjectMembers = (v: View): boolean => v.properties.length > 0 || v.patterns.length > 0 || isObject(v.additional) || v.conditionals.length > 0 || v.types.includes("object");

/** The places each definition is named from, among the nodes the root reaches (each definition visited once, so a place inside it counts once). */
function referenceCounts(root: Json): Map<string, number> {
	const counts = new Map<string, number>();
	const seen = new Set<Json>();
	const visit = (node: unknown): void => {
		if (!isObject(node) || seen.has(node)) return;
		seen.add(node);
		if (typeof node.$ref === "string") {
			const name = definitionName(node.$ref);
			if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
			visit(resolveRef(root, node.$ref));
		}
		for (const keyword of ["properties", "patternProperties", "dependentSchemas"]) if (isObject(node[keyword])) for (const child of Object.values(node[keyword] as Json)) visit(child);
		for (const keyword of ["additionalProperties", "unevaluatedProperties", "items", "contains", "unevaluatedItems", "then", "else"]) visit(node[keyword]);
		for (const keyword of ["prefixItems", "anyOf", "oneOf", "allOf"]) if (Array.isArray(node[keyword])) for (const child of node[keyword] as unknown[]) visit(child);
	};
	visit(root);
	return counts;
}

/** Whether a schema, followed through its definitions, branches and elements, declares fields. */
function hasFields(root: Json, node: unknown, seen = new Set<unknown>()): boolean {
	if (!isObject(node) || seen.has(node)) return false;
	seen.add(node);
	const v = view(root, node);
	if (v.properties.some(([, schema]) => isObject(schema)) || v.patterns.length > 0 || isObject(v.additional)) return true;
	if (v.items !== undefined && hasFields(root, v.items, seen)) return true;
	if (v.branches?.list.some((branch) => hasFields(root, branch, seen))) return true;
	return v.conditionals.some((c) => hasFields(root, c.then, seen) || hasFields(root, c.else, seen));
}

// ---------------------------------------------------------------------------------------------
// Fields

interface Use {
	path: string;
	/** The shared shape whose fields hold the place, when the place is inside one. */
	shape?: string;
}

interface Model {
	root: Json;
	/** The definitions shown once, as shared shapes. */
	shared: Set<string>;
	/** The blocks of the section being written. */
	blocks: string[];
	/** The shared shapes, in the order they are first used. */
	queue: string[];
	uses: Map<string, Use[]>;
	/** The shape whose fields are being written, if any. */
	shape: string | undefined;
}

function model(root: Json): Model {
	const shared = new Set<string>();
	for (const [name, places] of referenceCounts(root)) if (places > 1 && hasFields(root, resolveRef(root, `#/$defs/${name}`))) shared.add(name);
	return { root, shared, blocks: [], queue: [], uses: new Map(), shape: undefined };
}

const shapeAnchor = (name: string): string => headingSlug(`Shape ${name}`);
const shapeLink = (name: string): string => `[${name}](#${shapeAnchor(name)})`;

/** The shared shape a node names by its $ref, or undefined. */
function sharedName(m: Model, node: unknown): string | undefined {
	if (!isObject(node) || typeof node.$ref !== "string") return undefined;
	const name = definitionName(node.$ref);
	return name !== undefined && m.shared.has(name) ? name : undefined;
}

function use(m: Model, name: string, path: readonly Step[]): void {
	const uses = m.uses.get(name) ?? [];
	uses.push({ path: renderPath(path), shape: m.shape });
	m.uses.set(name, uses);
	if (!m.queue.includes(name)) m.queue.push(name);
}

const NOUNS: Record<string, [string, string]> = {
	string: ["string", "strings"],
	integer: ["integer", "integers"],
	number: ["number", "numbers"],
	boolean: ["boolean", "booleans"],
	object: ["object", "objects"],
	array: ["list", "lists"],
	null: ["null", "nulls"],
};
const noun = (type: string, many: boolean): string => (NOUNS[type] ?? [type, type])[many ? 1 : 0];

/** A schema's type in plain words: "integer, 0 or more", "string or null", "list of objects (shape split_fact)", "always "ledgermath.run/1"". */
function typeWords(m: Model, node: unknown, many = false): string {
	if (node === true) return "any value";
	if (node === false) return "nothing";
	if (!isObject(node)) return "any value";
	if (typeof node.$ref === "string") {
		const target = resolveRef(m.root, node.$ref);
		const shape = sharedName(m, node);
		const words = typeWords(m, target, many);
		return shape === undefined ? words : `${words} (shape ${shapeLink(shape)})`;
	}
	if ("const" in node) return `always ${code(JSON.stringify(node.const))}`;
	if (Array.isArray(node.enum)) return `one of ${orList(node.enum.map((value) => code(JSON.stringify(value))))}`;
	const branches = (node.oneOf ?? node.anyOf) as unknown[] | undefined;
	if (Array.isArray(branches)) {
		const objects = branches.filter((branch) => sharedName(m, branch) === undefined && hasObjectMembers(view(m.root, branch)));
		if (objects.length > 1) return `${noun("object", many)} of ${node.oneOf ? "exactly one" : "one or more"} of ${objects.length} shapes`;
		return orList([...new Set(branches.map((branch) => typeWords(m, branch, many)))]);
	}
	const types = typeof node.type === "string" ? [node.type] : Array.isArray(node.type) ? (node.type as string[]) : [];
	if (types.length === 0) {
		if (isObject(node.properties) || node.additionalProperties !== undefined || isObject(node.patternProperties)) types.push("object");
		else if (node.items !== undefined || Array.isArray(node.prefixItems)) types.push("array");
	}
	if (types.length !== 1) return types.length === 0 ? "any value" : orList(types.map((type) => noun(type, many)));
	const type = types[0] as string;
	const parts: string[] = [];
	if (type === "string") {
		let head = noun(type, many);
		if (typeof node.pattern === "string") head += node.pattern.length <= PATTERN_SHOWN ? ` matching ${code(node.pattern)}` : " matching the pattern its schema gives";
		if (node.minLength === 1) parts.push("not empty");
		else if (typeof node.minLength === "number") parts.push(`at least ${node.minLength} characters`);
		if (typeof node.maxLength === "number") parts.push(`at most ${node.maxLength} characters`);
		return [head, ...parts].join(", ");
	}
	if (type === "integer" || type === "number") {
		const min = node.minimum;
		const max = node.maximum;
		if (typeof min === "number" && typeof max === "number") parts.push(`${min} to ${max}`);
		else if (typeof min === "number") parts.push(`${min} or more`);
		else if (typeof max === "number") parts.push(`at most ${max}`);
		return [noun(type, many), ...parts].join(", ");
	}
	if (type === "array") {
		const limits: string[] = [];
		if (typeof node.minItems === "number" && node.minItems > 0 && !(Array.isArray(node.prefixItems) && node.items === false)) limits.push(`at least ${plural(node.minItems, "element")}`);
		if (typeof node.maxItems === "number") limits.push(`at most ${plural(node.maxItems, "element")}`);
		if (node.uniqueItems === true) limits.push("no element twice");
		const head = noun("array", many);
		if (Array.isArray(node.prefixItems) && node.items === false) return `${head} of exactly ${node.prefixItems.length}: ${node.prefixItems.map((item) => typeWords(m, item)).join(", ")}`;
		if (node.items === undefined) return [head, ...limits].join(", ");
		const items = typeWords(m, node.items, true);
		if (!items.includes(" or ") && !items.includes(", ")) return [`${head} of ${items}`, ...limits].join(", ");
		return `${head}${limits.length > 0 ? ` of ${limits.join(", ")}` : ""}, each element: ${typeWords(m, node.items)}`;
	}
	if (type === "object") {
		if (node.additionalProperties === false) parts.push("no other members");
		if (typeof node.minProperties === "number" && node.minProperties > 0) parts.push(`at least ${plural(node.minProperties, "member")}`);
		if (typeof node.maxProperties === "number") parts.push(`at most ${plural(node.maxProperties, "member")}`);
		if (isObject(node.propertyNames) && typeof node.propertyNames.pattern === "string") parts.push(`each member's name matching ${code(node.propertyNames.pattern)}`);
		return [noun(type, many), ...parts].join(", ");
	}
	return noun(type, many);
}

/** The definitions a node's $ref leads through, each with the name it is defined under: the node first. */
function refChain(root: Json, node: Json): Array<{ node: Json; name?: string }> {
	const chain: Array<{ node: Json; name?: string }> = [{ node }];
	let at = node;
	while (typeof at.$ref === "string" && chain.length < 16) {
		const target = resolveRef(root, at.$ref);
		if (!isObject(target)) break;
		chain.push({ node: target, name: definitionName(at.$ref) });
		at = target;
	}
	return chain;
}

/**
 * The words a field shows: its own description, or, without one, the first its $ref leads to;
 * beside its own, the description of a definition it names that is not a shared shape (whose
 * words are under its own heading), and of each definition its choices name; and what each
 * element of a list is.
 */
function wordsOf(m: Model, node: Json): Array<{ text: string; prefix?: string }> {
	const out: Array<{ text: string; prefix?: string }> = [];
	const push = (text: unknown, prefix?: string): void => {
		if (typeof text === "string" && text.trim() !== "" && !out.some((known) => known.text === text)) out.push({ text, prefix });
	};
	const chain = refChain(m.root, node);
	push(chain.find((link) => typeof link.node.description === "string")?.node.description);
	for (const link of chain.slice(1)) if (link.name === undefined || !m.shared.has(link.name)) push(link.node.description);
	const last = chain.at(-1)?.node as Json;
	const branchWords = (holder: Json, prefix?: string): void => {
		for (const branch of ((holder.oneOf ?? holder.anyOf) as unknown[] | undefined) ?? []) {
			if (!isObject(branch) || sharedName(m, branch) !== undefined) continue;
			for (const link of refChain(m.root, branch)) push(link.node.description, prefix);
		}
	};
	branchWords(last);
	if (isObject(last.items) && sharedName(m, last.items) === undefined) {
		for (const link of refChain(m.root, last.items)) push(link.node.description, "Each element: ");
		branchWords(refChain(m.root, last.items).at(-1)?.node as Json, "Each element: ");
	}
	return out;
}

const shapeList = (indices: readonly number[]): string => `${indices.length === 1 ? "shape" : "shapes"} ${orList(indices.map((i) => String(i + 1)), "and")}`;

/** One field's entry: its path as a heading, its type and whether it is required (REQUIRED, in words), its words, then the fields inside it. */
function emitField(m: Model, step: Step, schema: Json, path: readonly Step[], level: number, required: string): void {
	const at = [...path, step];
	m.blocks.push(`${"#".repeat(level)} ${code(renderPath(at))}`);
	m.blocks.push(`${typeWords(m, schema)} · ${required}`);
	for (const words of wordsOf(m, schema)) m.blocks.push(describe(words.text, words.prefix));
	describeInside(m, schema, at, level);
}

/** The fields inside a schema, at PATH: an object's members, the members of the one object a choice allows, each element of a list. */
function describeInside(m: Model, node: unknown, path: readonly Step[], level: number): void {
	if (!isObject(node)) return;
	const shape = sharedName(m, node);
	if (shape !== undefined) {
		use(m, shape, path);
		return;
	}
	const v = view(m.root, node);
	const objectBranches = (v.branches?.list ?? []).filter((branch) => sharedName(m, branch) === undefined && hasObjectMembers(view(m.root, branch)));
	if (hasObjectMembers(v) || objectBranches.length > 1) {
		walkObject(m, v, path, level);
		return;
	}
	for (const branch of v.branches?.list ?? []) describeInside(m, branch, path, level);
	if (v.items !== undefined) describeInside(m, v.items, [...path, ITEM], level);
	for (const item of v.prefixItems) describeInside(m, item, [...path, ITEM], level);
}

/** An object's fields: its members, those some of its shapes alone have, and those a condition gives. */
function walkObject(m: Model, v: View, path: readonly Step[], level: number): void {
	const shapes = (v.branches?.list ?? []).filter((branch) => sharedName(m, branch) === undefined && hasObjectMembers(view(m.root, branch)));
	const shapeViews = shapes.map((branch) => view(m.root, branch));
	if (shapes.length > 0) m.blocks.push(shapesIntro(v, shapeViews, path.length === 0 ? "A file" : "It"));
	const own = new Map(v.properties);
	for (const [name, schema] of v.properties) {
		if (typeof schema === "boolean") continue;
		emitField(m, { name }, schema, path, level, requiredWords(name, v, shapeViews));
	}
	for (const [pattern, schema] of v.patterns) emitField(m, { pattern }, schema, path, level, othersWords(v, false));
	if (isObject(v.additional)) emitField(m, ANY, v.additional, path, level, othersWords(v, true));
	const extra: Array<{ name: string; schema: Json; shapes: number[] }> = [];
	shapeViews.forEach((shape, i) => {
		for (const [name, schema] of shape.properties) {
			if (typeof schema === "boolean" || own.has(name)) continue;
			const same = extra.find((known) => known.name === name && deepEqual(known.schema, schema));
			if (same) same.shapes.push(i);
			else extra.push({ name, schema, shapes: [i] });
		}
	});
	for (const field of extra) {
		const requiring = field.shapes.filter((i) => shapeViews[i]?.required.has(field.name));
		const optional = field.shapes.filter((i) => !requiring.includes(i));
		const words = [requiring.length > 0 ? `required in ${shapeList(requiring)}` : "", optional.length > 0 ? `optional in ${shapeList(optional)}` : ""].filter((part) => part !== "");
		emitField(m, { name: field.name }, field.schema, path, level, words.join("; "));
	}
	for (const conditional of v.conditionals) emitConditional(m, conditional, path, level);
}

/**
 * How many members of names not fixed an object holds, and what their names must match: "one or
 * more of them, each named to match `^[a-z]…`". The count is the object's own (minProperties,
 * maxProperties) when it names no member, so that every member it holds is one of these; else
 * the type of the object says it. ANY: the members of every other name (`*`), whose names the
 * object's pattern (propertyNames) restricts; a pattern's members are named by their pattern.
 */
function othersWords(v: View, any: boolean): string {
	const alone = v.properties.length === 0 && v.patterns.length + (isObject(v.additional) ? 1 : 0) === 1;
	const min = alone ? (v.minProperties ?? 0) : 0;
	const max = alone ? v.maxProperties : undefined;
	let words = max !== undefined ? `${min} to ${max} of them` : min === 1 ? "one or more of them" : min > 1 ? `${min} or more of them` : "any number of them";
	if (any && v.namePattern !== undefined) words += `, each named to match ${code(v.namePattern)}`;
	return words;
}

/** Whether a member is required: always, never, or in which of the object's shapes, and in which it is absent. */
function requiredWords(name: string, v: View, shapes: readonly View[]): string {
	if (v.required.has(name)) return "required";
	if (shapes.length === 0) return "optional";
	const requiring = shapes.flatMap((shape, i) => (shape.required.has(name) ? [i] : []));
	if (requiring.length === shapes.length) return "required";
	const absent = shapes.flatMap((shape, i) => (shape.properties.some(([known, schema]) => known === name && schema === false) ? [i] : []));
	const words = [requiring.length > 0 ? `required in ${shapeList(requiring)}` : "optional"];
	if (absent.length > 0) words.push(`absent in ${shapeList(absent)}`);
	return words.join("; ");
}

/** What a value of one shape, or under one condition, has: "has `a`, may have `b`, and has no other member". */
function membersSentence(v: View, others: readonly string[] = []): string {
	const required = [...v.required].map(code);
	const optional = v.properties.filter(([name, schema]) => isObject(schema) && !v.required.has(name)).map(([name]) => code(name));
	const never = v.properties.filter(([, schema]) => schema === false).map(([name]) => code(name));
	const parts: string[] = [];
	if (required.length > 0) parts.push(`has ${orList(required, "and")}`);
	if (optional.length > 0) parts.push(`may have ${orList(optional, "and")}`);
	if (never.length > 0) parts.push(`never has ${orList(never)}`);
	if (v.additional === false) parts.push(others.length > 0 ? `has no other member but ${orList(others.map(code), "and")}` : "has no other member");
	if (parts.length === 0) return "";
	return parts.length === 1 ? parts[0] as string : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/** The list of an object's shapes (its oneOf or anyOf of objects), each with its words and what it has. */
function shapesIntro(v: View, shapes: readonly View[], subject: string): string {
	const which = v.branches?.word === "oneOf" ? "exactly one" : "one or more";
	const items = shapes.map((shape, i) => {
		const sentence = membersSentence(shape);
		const words = [shape.description === undefined ? "" : markdownText(shape.description), sentence === "" ? "" : `It ${sentence}.`].filter((part) => part !== "");
		return `- Shape ${i + 1}. ${words.join(" ")}`.trimEnd();
	});
	return `${subject} takes ${which} of these ${shapes.length} shapes:\n\n${items.join("\n")}`;
}

/** The words of an if: "When `event` is `"started"`". */
function conditionWords(condition: Json): string {
	const parts: string[] = [];
	if (isObject(condition.properties)) {
		for (const [name, schema] of Object.entries(condition.properties)) {
			if (isObject(schema) && "const" in schema) parts.push(`${code(name)} is ${code(JSON.stringify(schema.const))}`);
			else if (isObject(schema) && Array.isArray(schema.enum)) parts.push(`${code(name)} is ${orList(schema.enum.map((value) => code(JSON.stringify(value))))}`);
		}
	}
	if (Array.isArray(condition.required)) parts.push(`it has ${orList(condition.required.map((name) => code(String(name))), "and")}`);
	return parts.length > 0 ? `When ${orList(parts, "and")}` : "When the condition its schema gives holds";
}

function emitConditional(m: Model, conditional: { if: Json; then: unknown; else: unknown }, path: readonly Step[], level: number): void {
	const branch = (heading: string, node: unknown): void => {
		m.blocks.push(`${"#".repeat(level)} ${heading}`);
		if (node === false) {
			m.blocks.push("No value is valid then.");
			return;
		}
		if (!isObject(node)) return;
		const v = view(m.root, node);
		if (v.description !== undefined) m.blocks.push(describe(v.description));
		const allowed = v.properties.filter(([, schema]) => schema === true).map(([name]) => name);
		const sentence = membersSentence(v, allowed);
		if (sentence !== "") m.blocks.push(`It then ${sentence}.`);
		for (const [name, schema] of v.properties) {
			if (typeof schema === "boolean") continue;
			emitField(m, { name }, schema, path, level + 1, v.required.has(name) ? "required" : "optional");
		}
	};
	if (conditional.then !== undefined) branch(conditionWords(conditional.if), conditional.then);
	if (conditional.else !== undefined) branch(`Otherwise (${conditionWords(conditional.if).replace(/^When /, "when not: ")})`, conditional.else);
}

/** The blocks of the section "Shared shapes": each shape's heading, type, words, the places it is used, and its fields. */
function shapeSections(m: Model): string[] {
	const sections: Array<{ name: string; blocks: string[]; usesAt: number }> = [];
	for (let i = 0; i < m.queue.length; i++) {
		const name = m.queue[i] as string;
		const definition = resolveRef(m.root, `#/$defs/${name}`) as Json;
		m.blocks = [];
		m.shape = name;
		m.blocks.push(`### Shape ${code(name)}`);
		m.blocks.push(typeWords(m, definition));
		for (const words of wordsOf(m, definition)) m.blocks.push(describe(words.text, words.prefix));
		const usesAt = m.blocks.length;
		m.blocks.push("");
		describeInside(m, definition, [SHAPE], 4);
		sections.push({ name, blocks: m.blocks, usesAt });
	}
	m.shape = undefined;
	return sections.flatMap(({ name, blocks, usesAt }) => {
		const uses = m.uses.get(name) ?? [];
		const groups: string[] = [];
		const inFields = uses.filter((one) => one.shape === undefined).map((one) => code(one.path));
		if (inFields.length > 0) groups.push(orList(inFields, "and"));
		for (const holder of [...new Set(uses.flatMap((one) => (one.shape === undefined ? [] : [one.shape])))]) {
			groups.push(`${orList(uses.filter((one) => one.shape === holder).map((one) => code(one.path)), "and")} in ${shapeLink(holder)}`);
		}
		const filled = [...blocks];
		filled[usesAt] = `Used at ${groups.join("; ")}.`;
		return filled;
	});
}

// ---------------------------------------------------------------------------------------------
// Examples

interface Cut {
	path: string;
	what: string;
}

function typeMatches(type: unknown, value: unknown): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "boolean":
			return typeof value === "boolean";
		case "integer":
			return Number.isInteger(value);
		case "number":
			return typeof value === "number";
		case "string":
			return typeof value === "string";
		case "array":
			return Array.isArray(value);
		case "object":
			return isObject(value);
		default:
			return true;
	}
}

/** Whether a value fits a schema, as far as choosing a branch or a condition needs: its type, const, enum, required members and their own fit. */
function fits(root: Json, node: unknown, value: unknown, depth = 0): boolean {
	if (node === true || node === undefined) return true;
	if (node === false) return false;
	if (!isObject(node) || depth > 32) return true;
	if (typeof node.$ref === "string" && !fits(root, resolveRef(root, node.$ref), value, depth + 1)) return false;
	if ("const" in node && !deepEqual(node.const, value)) return false;
	if (Array.isArray(node.enum) && !node.enum.some((option) => deepEqual(option, value))) return false;
	if (node.type !== undefined && ![node.type].flat().some((type) => typeMatches(type, value))) return false;
	if (isObject(value)) {
		if (Array.isArray(node.required) && !node.required.every((name) => typeof name === "string" && Object.hasOwn(value, name))) return false;
		if (isObject(node.properties)) for (const [name, schema] of Object.entries(node.properties)) if (Object.hasOwn(value, name) && !fits(root, schema, value[name], depth + 1)) return false;
	}
	if (Array.isArray(node.allOf) && !node.allOf.every((branch) => fits(root, branch, value, depth + 1))) return false;
	if (Array.isArray(node.anyOf) && !node.anyOf.some((branch) => fits(root, branch, value, depth + 1))) return false;
	if (Array.isArray(node.oneOf) && node.oneOf.filter((branch) => fits(root, branch, value, depth + 1)).length !== 1) return false;
	return true;
}

/** Every schema that applies to a value at one place: the node, the definitions it names, its allOf branches, the then (or else) of each condition, and the branches of a choice that the value fits. */
function applicable(root: Json, node: unknown, value: unknown): Json[] {
	const out: Json[] = [];
	const add = (n: unknown): void => {
		if (!isObject(n) || out.includes(n)) return;
		out.push(n);
		if (typeof n.$ref === "string") add(resolveRef(root, n.$ref));
		const conditional = (c: Json): void => (fits(root, c.if, value) ? add(c.then) : add(c.else));
		if (isObject(n.if)) conditional(n);
		if (Array.isArray(n.allOf)) for (const branch of n.allOf) (isObject(branch) && isObject(branch.if) ? conditional(branch) : add(branch));
		for (const list of [n.anyOf, n.oneOf]) if (Array.isArray(list)) for (const branch of list) if (fits(root, branch, value)) add(branch);
	};
	add(node);
	return out;
}

function memberSchema(schemas: readonly Json[], key: string): unknown {
	for (const schema of schemas) if (isObject(schema.properties) && isObject(schema.properties[key])) return schema.properties[key];
	for (const schema of schemas) if (isObject(schema.patternProperties)) for (const [pattern, member] of Object.entries(schema.patternProperties)) if (new RegExp(pattern, "u").test(key)) return member;
	for (const schema of schemas) if (isObject(schema.additionalProperties)) return schema.additionalProperties;
	return undefined;
}

function elementSchema(schemas: readonly Json[], index: number): unknown {
	for (const schema of schemas) if (Array.isArray(schema.prefixItems) && index < schema.prefixItems.length) return schema.prefixItems[index];
	for (const schema of schemas) if (isObject(schema.items)) return schema.items;
	return undefined;
}

/** A member's schema that is nothing but a reference to a definition: { "$ref": … } and no other keyword. Members whose schemas are each such a reference, to one and the same definition, are alike, as a list's elements are. */
const shapeOnly = (schema: unknown): schema is Json => isObject(schema) && typeof schema.$ref === "string" && Object.keys(schema).length === 1;

/**
 * An excerpt of a value, made by one rule and noted in CUTS: a list keeps its first element
 * (a list of plain values whose JSON takes at most SHORT_LIST characters is kept whole); an
 * object keeps every member its schema names, but of members whose schemas are each nothing
 * but a reference to one and the same definition (a request's eight phases) it keeps the first,
 * and of its members whose names its schema does not fix the first, then each next while their
 * values take at most MEMBERS_BUDGET bytes of JSON; a string longer than STRING_CUT characters
 * keeps its first STRING_CUT and ends with "…". Nothing else changes. EXCERPT_RULE says this in
 * words, and the pages print it.
 */
export function excerpt(root: Json, value: unknown, schema: unknown, path: string, cuts: Cut[]): unknown {
	const place = path === "" ? "the file" : path;
	if (typeof value === "string") {
		const characters = Array.from(value);
		if (characters.length <= STRING_CUT) return value;
		cuts.push({ path: place, what: `its first ${STRING_CUT} of ${count(characters.length)} characters` });
		return `${characters.slice(0, STRING_CUT).join("")}…`;
	}
	if (Array.isArray(value)) {
		const schemas = applicable(root, schema, value);
		const plain = value.every((element) => element === null || typeof element !== "object");
		if (value.length <= 1 || (plain && Array.from(JSON.stringify(value)).length <= SHORT_LIST)) return value.map((element, i) => excerpt(root, element, elementSchema(schemas, i), memberPath(path, i), cuts));
		cuts.push({ path: place, what: `its first element of ${count(value.length)}` });
		return [excerpt(root, value[0], elementSchema(schemas, 0), memberPath(path, 0), cuts)];
	}
	if (isObject(value)) {
		const schemas = applicable(root, schema, value);
		const named = new Set(schemas.flatMap((one) => (isObject(one.properties) ? Object.keys(one.properties) : [])));
		const out: Json = {};
		const alike = new Map<string, number>();
		let anyName = 0;
		let kept = 0;
		let bytes = 0;
		let full = false;
		for (const [key, member] of Object.entries(value)) {
			const at = memberPath(path, key);
			const inner = memberSchema(schemas, key);
			if (named.has(key)) {
				if (shapeOnly(inner)) {
					const shape = JSON.stringify(inner);
					const before = alike.get(shape) ?? 0;
					alike.set(shape, before + 1);
					if (before > 0) continue;
				}
				out[key] = excerpt(root, member, inner, at, cuts);
				continue;
			}
			anyName++;
			if (full) continue;
			const size = new TextEncoder().encode(JSON.stringify(excerpt(root, member, inner, at, []))).length;
			if (kept > 0 && bytes + size > MEMBERS_BUDGET) {
				full = true;
				continue;
			}
			kept++;
			bytes += size;
			out[key] = excerpt(root, member, inner, at, cuts);
		}
		for (const members of alike.values()) if (members > 1) cuts.push({ path: place, what: `the first of its ${count(members)} members whose schemas are the same reference` });
		if (kept < anyName) cuts.push({ path: place, what: `${count(kept)} of its ${count(anyName)} members whose names its schema does not fix` });
		return out;
	}
	return value;
}

/** A file of the fixed sample, as an example's source. */
export interface ExampleSource {
	url: string;
	bytes: Uint8Array;
	/** The UTC date the sample was taken, yyyy-mm-dd. */
	takenOn: string;
	/** For a stream of events: the Run file whose stdout it is. */
	runUrl?: string;
}

const link = (url: string): string => `[${url}](${url})`;

/** The rule excerpt() follows, in words: what the page prints with every list of what an example left out. */
export const EXCERPT_RULE =
	`The excerpt is made by one rule, applied at every depth, and changes nothing else. A list of more than one element keeps its first, unless every element is a string, a number, true, false or null and the list takes at most ${SHORT_LIST} characters as JSON: then it is kept whole. ` +
	"An object keeps every member its schema names, but of members whose schemas are each nothing but a reference to one and the same definition (such as a request's eight phases), it keeps the first. " +
	`Of an object's members whose names its schema does not fix, it keeps the first, then each next one while the values kept, as excerpted, take at most ${MEMBERS_BUDGET} bytes as JSON, and none after the first that does not fit. ` +
	`A string longer than ${STRING_CUT} characters keeps its first ${STRING_CUT} and ends with …`;

function leftOut(cuts: readonly Cut[]): string {
	if (cuts.length === 0) return "The example is the whole file.";
	return `<details>\n<summary>${htmlText(`What the excerpt leaves out, in ${plural(cuts.length, "place")}`)}</summary>\n\n${EXCERPT_RULE}\n\n${cuts.map((cut) => `- ${code(cut.path)}: ${cut.what}`).join("\n")}\n\n</details>`;
}

/** An example longer than this many lines folds behind a line that says how long it is. */
export const EXAMPLE_FOLD_LINES = 150;
/** An example writes a list or an object on one line when it fits in this many columns, indentation included. */
export const JSON_WIDTH = 100;

/** JSON on one line, with a space after each comma and colon. */
function inlineJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
	if (isObject(value)) return `{${Object.entries(value).map(([key, member]) => `${JSON.stringify(key)}: ${inlineJson(member)}`).join(", ")}}`;
	return JSON.stringify(value);
}

/** JSON indented by two spaces a level, each list or object that fits in JSON_WIDTH columns on one line. */
export function formatJson(value: unknown, depth = 0, lead = 0): string {
	const flat = inlineJson(value);
	if (value === null || typeof value !== "object" || 2 * depth + lead + flat.length <= JSON_WIDTH) return flat;
	const inner = "  ".repeat(depth + 1);
	const outer = "  ".repeat(depth);
	if (Array.isArray(value)) return `[\n${value.map((element) => `${inner}${formatJson(element, depth + 1)}`).join(",\n")}\n${outer}]`;
	const members = Object.entries(value as Json).map(([key, member]) => `${inner}${JSON.stringify(key)}: ${formatJson(member, depth + 1, JSON.stringify(key).length + 2)}`);
	return `{\n${members.join(",\n")}\n${outer}}`;
}

function exampleCode(text: string, info: string, what: string): string {
	const block = codeBlock(text, info);
	const lines = text.split("\n").length;
	if (lines <= EXAMPLE_FOLD_LINES) return block;
	return `<details>\n<summary>${htmlText(`The example: ${plural(lines, "line")} of ${what}`)}</summary>\n\n${block}\n\n</details>`;
}

/** The six universal events, whose fields the events schema fixes; a stream need not hold all six (an observed event is optional, and a failed execution's stream can stop short). */
const UNIVERSAL_EVENTS = ["started", "observed", "sample_started", "sample_ended", "verified", "finished"];

function exampleBlocks(root: Json, page: FilePage, source: ExampleSource): string[] {
	const text = new TextDecoder().decode(source.bytes);
	const cuts: Cut[] = [];
	if (page.sample === "events") {
		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const events = lines.map((line) => JSON.parse(line) as Json);
		const picked = new Set<number>();
		for (const name of UNIVERSAL_EVENTS) {
			const at = events.findIndex((event) => event.event === name);
			if (at !== -1) picked.add(at);
		}
		const own = events.findIndex((event) => !UNIVERSAL_EVENTS.includes(String(event.event)));
		if (own !== -1) picked.add(own);
		const chosen = [...picked].sort((a, b) => a - b);
		const shown = chosen.map((at) => JSON.stringify(excerpt(root, events[at], root, `line ${at + 1}`, cuts)));
		const ownWords = own === -1 ? "" : `, and the first of the benchmark's own events (${code(String(events[own]?.event))})`;
		return [
			`${plural(chosen.length, "line")} of the ${count(lines.length)} of the stream at ${link(source.url)} (${count(source.bytes.length)} bytes), the stdout of the Run at ${source.runUrl === undefined ? "its Run file" : link(source.runUrl)}, as LedgerMath's fixed sample took it on ${source.takenOn}: the first line of each of the six universal events the stream holds${ownWords}, each an excerpt the generator made.`,
			exampleCode(shown.join("\n"), "jsonl", "JSON, one event a line"),
			leftOut(cuts),
		];
	}
	const shown = excerpt(root, JSON.parse(text), root, "", cuts);
	return [
		`An excerpt, made by the generator, of the file at ${link(source.url)} (${count(source.bytes.length)} bytes) as LedgerMath's fixed sample took it on ${source.takenOn}; that address serves the file as it is now.`,
		exampleCode(formatJson(shown), "json", "JSON"),
		leftOut(cuts),
	];
}

// ---------------------------------------------------------------------------------------------
// Pages

function schemaLink(page: FilePage, schema: Json): string {
	const title = markdownText(String(schema.title ?? page.schema));
	const served = API_SCHEMAS.find((one) => one.source === page.schema);
	if (served !== undefined) return `Schema: [${title}](${DEFAULT_BASE}/v1/schemas/${served.name}.schema.json), served by the API.`;
	return `Schema: [${title}](${REPOSITORY}/blob/main/${page.schema}), kept with LedgerMath's source; the API does not serve it.`;
}

/** A file page: its title and first paragraph, where the file is, the schema's own description, an example, every field, and the shared shapes. */
export function schemaPage(page: FilePage, schema: Json, source: ExampleSource): string {
	const m = model(schema);
	m.blocks = [];
	describeInside(m, schema, [], 3);
	const fields = m.blocks;
	const shapes = shapeSections(m);
	const legend = [
		`Each field is named by its path from the top of the ${page.sample === "events" ? "line" : "file"}: ` +
			"`a.b` is the member `b` of the object `a`, `[]` stands for each element of a list, `*` for a member whose name is not fixed (its object's type says when the names must match a pattern), and a name with a dot in it is written `[\"p99.9\"]`. Under each path are its type and whether it is required (present wherever the object holding it is) or optional (it may be absent).",
		"An object said to have no other members holds none but those listed for it; any other object may hold members this page does not list.",
	];
	if (schema.additionalProperties === false) legend.push("The file holds no top-level member but those below.");
	if (shapes.length > 0) legend.push("A shape used in more than one place is described once, under [Shared shapes](#shared-shapes), and each place links to it.");
	if (page.v1) legend.push("Version 1 only ever gains fields, so a file may hold a field this page does not list yet: a reader ignores it.");
	if (page.fieldsNote !== undefined) legend.push(page.fieldsNote);
	const blocks = [
		`# ${page.title}`,
		page.intro,
		"## Where it is",
		[...page.where, schemaLink(page, schema)].map((item) => `- ${item}`).join("\n"),
		"## What its schema says",
		describe(String(schema.description ?? "")),
		"## Example",
		...exampleBlocks(schema, page, source),
		"## Fields",
		legend.join(" "),
		...fields,
	];
	if (shapes.length > 0) {
		blocks.push("## Shared shapes", "`…` stands for the path at which the shape is used; each shape gives every place it is used.", ...shapes);
	}
	return `${blocks.join("\n\n")}\n`;
}

/** The overview, /docs/api/. */
export function overviewPage(): string {
	const quote = (text: string, from: string): string => `> ${markdownText(text)}\n>\n> (${from})`;
	const pages = FILE_PAGES.map((page) => `- [${markdownText(page.title)}](${page.address}): ${page.intro}`).join("\n");
	const body = overviewBody({ quote, quotes: { about: ABOUT, versioning: VERSIONING, figures: FIGURES, months: MONTHS, listUpdates: LIST_UPDATES, evidence: EVIDENCE }, pages });
	return `${[`# ${OVERVIEW.title}`, OVERVIEW.intro, ...body].join("\n\n")}\n`;
}

interface Schedule {
	targets: Array<{ instance_type: string; vcpus: number; zone: string; boots_utc: string[] }>;
	benchmarks: Array<{ name: string; params: unknown[]; instance_types?: string[] }>;
}

/** The machines page, /docs/machines, from schedule.json. */
export function machinesPage(schedule: Schedule): string {
	const rows = schedule.targets.map((target) => `| ${markdownText(target.instance_type)} | ${target.vcpus} | ${markdownText(target.zone)} | ${target.boots_utc.join(", ")} |`);
	const blocks = [`# ${MACHINES.title}`, MACHINES.intro(schedule.targets.length), MACHINES.boot, [MACHINES.columns, "|---|---:|---|---|", ...rows].join("\n"), MACHINES.after];
	const limited = schedule.benchmarks.filter((entry) => Array.isArray(entry.instance_types));
	if (limited.length > 0) {
		const items = limited.map((entry) => {
			const sets = entry.params.map((params) => `  - ${code(JSON.stringify(params))}`).join("\n");
			return `- [${markdownText(entry.name)}](/docs/benchmarks/${entry.name}), ${plural(entry.params.length, "parameter set")}, for ${orList((entry.instance_types ?? []).map(markdownText), "and")}:\n${sets}`;
		});
		blocks.push(MACHINES.someTypesHeading, MACHINES.someTypes, items.join("\n"));
	}
	return `${blocks.join("\n\n")}\n`;
}

/** The fixed sample: its manifest, and each file's bytes by kind. */
export function readSample(directory: string): { manifest: SampleManifest; files: Map<SampleKind, ExampleSource> } {
	const manifest = JSON.parse(readFileSync(join(directory, SAMPLE_MANIFEST), "utf8")) as SampleManifest;
	const takenOn = manifest.taken_at.slice(0, 10);
	const runUrl = manifest.files.find((file) => file.kind === "run")?.url;
	const files = new Map<SampleKind, ExampleSource>();
	for (const file of manifest.files) {
		files.set(file.kind, { url: file.url, bytes: new Uint8Array(readFileSync(join(directory, ...file.path.split("/")))), takenOn, runUrl: file.kind === "events" ? runUrl : undefined });
	}
	return { manifest, files };
}

/** Every page of the reference, by its file under the directory it is written to, in a fixed order. */
export function apiReference(root = ROOT): Map<string, string> {
	const { files } = readSample(join(root, SAMPLE_DIRECTORY));
	const pages = new Map<string, string>();
	pages.set(OVERVIEW.file, overviewPage());
	for (const page of FILE_PAGES) {
		const source = files.get(page.sample);
		if (source === undefined) throw new Error(`the sample in ${SAMPLE_DIRECTORY} has no file of the kind ${page.sample}, for ${page.file}`);
		pages.set(page.file, schemaPage(page, JSON.parse(readFileSync(join(root, page.schema), "utf8")) as Json, source));
	}
	pages.set(MACHINES.file, machinesPage(JSON.parse(readFileSync(join(root, "schedule.json"), "utf8")) as Schedule));
	return pages;
}

/** Writes every page under OUT, creating directories; refuses, writing nothing, when any of the files is already there. Returns the files written. */
export function writeApiReference(out: string, pages: ReadonlyMap<string, string> = apiReference()): string[] {
	const there = [...pages.keys()].filter((file) => existsSync(join(out, ...file.split("/"))));
	if (there.length > 0) throw new Error(`not written: ${there.map((file) => join(out, file)).join(", ")} already ${there.length === 1 ? "exists" : "exist"}`);
	for (const [file, text] of pages) {
		const path = join(out, ...file.split("/"));
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	}
	return [...pages.keys()];
}
