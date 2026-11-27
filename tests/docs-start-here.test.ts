/**
 * The documentation's start-here page, site/content/docs/index.md, served at
 * https://ledgermath.com/docs/: the how-to an agent reads first, and may be all it reads besides
 * the reference it links to. So its worked examples are held to the data, its links to pages that
 * exist, and its words to the rules every published word keeps.
 *
 * Each worked example is a <details> block whose summary begins "Example:".
 *
 * - Its inputs are a table, | Input | Value | From |, each row from the question, an assumption, or
 *   the fixed sample of the API kept in docs/api-sample/: a Series' figure (`Series <id>`, the
 *   Method's key, the figure's place, its count and its moment) from the list of every Series, or a
 *   price (the price file's path, the SKU, the rate code and the member) from the price file. A
 *   value is a number and its unit as written; a cited value must be the sample's, unit and all.
 * - Its arithmetic is its one fenced block, one operation per line, "label: expression = result
 *   unit", the result optionally followed by "→ N (rounded up)". Every operand is a number with its
 *   unit, held by an input or a line above; units are carried through, so a result's unit must be
 *   the one its operands give.
 * - Its answer states each result as a list item "- <label>: <result> <unit>", the label naming
 *   the line that works it out. Anywhere else in its words, a number is an input, as written or
 *   rounded, with the input's unit after it.
 * - A parameter or build it names for a Series it cites (`threads` `all`, build `static`), and a
 *   benchmark page it links, must be that Series'.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DOCS_BENCHMARK_ADDRESS, isDocsAddress } from "../scripts/lib/docs-addresses";
import { wordRules } from "../scripts/lib/published-words";

const ROOT = join(import.meta.dir, "..");
const PAGE = "site/content/docs/index.md";
const TEXT = readFileSync(join(ROOT, PAGE), "utf8");
const SAMPLE = join(ROOT, "docs/api-sample");

type Json = any;

interface Manifest {
	taken_at: string;
	files: Array<{ kind: string; path: string; url: string }>;
}

const MANIFEST = JSON.parse(readFileSync(join(SAMPLE, "sample.json"), "utf8")) as Manifest;
/** The sample's date: the day it was taken, as the examples name it. */
const SAMPLE_DATE = MANIFEST.taken_at.slice(0, 10);

function sampleFile(kind: string): { url: string; json: Json } {
	const entry = MANIFEST.files.find((file) => file.kind === kind);
	if (entry === undefined) throw new Error(`the sample holds no ${kind} file`);
	return { url: entry.url, json: JSON.parse(readFileSync(join(SAMPLE, entry.path), "utf8")) };
}

const SERIES_LIST = sampleFile("series-list");
const INDEX = sampleFile("index").json;

/** The sample's price file at a citation's path (prices/<yyyy>/<mm>/<dd>/aws.json), by the address the table of contents gives it. */
function priceFile(path: string): { url: string; json: Json } {
	const listed = (INDEX.prices.files as Array<{ path: string; url: string }>).find((file) => file.path === path);
	if (listed === undefined) throw new Error(`the table of contents lists no price file ${path}`);
	const entry = MANIFEST.files.find((file) => file.url === listed.url);
	if (entry === undefined) throw new Error(`the sample does not hold ${listed.url}`);
	return { url: entry.url, json: JSON.parse(readFileSync(join(SAMPLE, entry.path), "utf8")) };
}

/** A member of a JSON value by its dotted place, such as derivations.series_v1.percentiles.bytes_per_second.p50. */
function at(value: Json, place: string): Json {
	return place.split(".").reduce((node: Json, key) => (node === undefined || node === null ? undefined : node[key]), value);
}

/** The page's lines, each marked as inside a fenced code block or not. */
function linesOf(text: string): Array<{ line: string; fenced: boolean; fence: boolean }> {
	let fenced = false;
	return text.split("\n").map((line) => {
		if (line.trimStart().startsWith("```")) {
			fenced = !fenced;
			return { line, fenced: true, fence: true };
		}
		return { line, fenced, fence: false };
	});
}

/** A line as prose a reader sees, without its code spans and without its links' targets. */
const wordsOf = (line: string): string => line.replace(/(`+)[\s\S]*?\1/g, "").replace(/\]\([^)\s]*\)/g, "]");

// ---------------------------------------------------------------------------------------------
// Numbers and units as the page writes them.

/** A number as written: digits with an optional decimal part, or a power such as 10^12. */
function valueOf(text: string): number {
	const power = /^(\d+)\^(\d+)$/.exec(text);
	return power ? Number(power[1]) ** Number(power[2]) : Number(text);
}

const decimalsOf = (text: string): number => (text.includes(".") ? text.length - text.indexOf(".") - 1 : 0);

/** Whether a number stated to some digits is `computed`, rounded to those digits. */
function agrees(stated: string, computed: number): boolean {
	return Math.abs(Number(stated) - computed) <= 0.5 * 10 ** -decimalsOf(stated) + 1e-9 * Math.abs(computed);
}

const same = (a: number, b: number): boolean => a === b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));

/** A count rounded up, a computed value that is a whole number but for floating point staying as it is. */
function roundedUp(computed: number): number {
	const nearest = Math.round(computed);
	return Math.abs(computed - nearest) <= 1e-9 * Math.max(1, Math.abs(computed)) ? nearest : Math.ceil(computed);
}

/** A unit as the exponent of each word: "USD per GB" is USD^1 GB^-1; "per second" is second^-1. */
type Unit = Record<string, number>;

function unitOf(text: string): Unit {
	const unit: Unit = {};
	let sign = 1;
	for (const word of text.split(/\s+/).filter((one) => one !== "")) {
		if (word === "per") sign = -1;
		else unit[word] = (unit[word] ?? 0) + sign;
	}
	return unit;
}

/** A unit written one way only, so that two units can be compared: "" for none. */
const keyOf = (unit: Unit): string =>
	Object.entries(unit)
		.filter(([, power]) => power !== 0)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([word, power]) => `${word}^${power}`)
		.join(" ");

function combine(a: Unit, b: Unit, sign: 1 | -1): Unit {
	const unit: Unit = { ...a };
	for (const [word, power] of Object.entries(b)) unit[word] = (unit[word] ?? 0) + sign * power;
	return unit;
}

/** A number the example holds, with its unit: `text` as written after it, `key` for comparing. */
interface Quantity {
	value: number;
	key: string;
	text: string;
}

/** The numbers a line of words states: digits standing alone, not part of a name, a date, a time or an address; "million" after one scales it. */
const NUMBER = /(?<![\w.\/\-:^])(\d+(?:\.\d+)?)(?![\w\/\-:^]|\.\d)(\s+million\b)?/g;

/** Whether the words after a number start with a unit as written. */
const startsWithUnit = (after: string, text: string): boolean => text === "" || new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(after);

/** A cell's numbers, each with the unit written after the last of them: "0 to 100 GB" holds 0 GB and 100 GB. */
function quantitiesOf(cell: string): Quantity[] {
	const tokens = [...cell.matchAll(/(?<![\w.^])(\d+(?:\.\d+)?(?:\^\d+)?|Inf)(?![\w.^])/g)];
	const last = tokens[tokens.length - 1];
	if (last === undefined) return [];
	const text = cell.slice((last.index as number) + (last[0] as string).length).trim();
	return tokens.filter((token) => token[1] !== "Inf").map((token) => ({ value: valueOf(token[1] as string), key: keyOf(unitOf(text)), text }));
}

type Token = { kind: "number"; value: number; text: string; unit: Unit } | { kind: "op"; op: string };

/** An expression's numbers, each with the unit written after it, and its operators. */
function tokenize(expression: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < expression.length) {
		const rest = expression.slice(i);
		const char = expression[i] as string;
		if (/\s/.test(char)) {
			i++;
		} else if (rest.startsWith("max(")) {
			tokens.push({ kind: "op", op: "max" }, { kind: "op", op: "(" });
			i += 4;
		} else if ("+−×÷(),".includes(char)) {
			tokens.push({ kind: "op", op: char });
			i++;
		} else if (/^\d/.test(rest)) {
			const number = /^\d+(?:\.\d+)?(?:\^\d+)?/.exec(rest)?.[0] as string;
			i += number.length;
			if (/^[A-Za-z_]/.test(expression.slice(i))) throw new Error(`a number runs into a word in ${JSON.stringify(expression)}`);
			const words = /^(?:\s+[A-Za-z]+)*/.exec(expression.slice(i))?.[0] as string;
			i += words.length;
			tokens.push({ kind: "number", value: valueOf(number), text: number, unit: unitOf(words) });
		} else {
			throw new Error(`cannot read ${JSON.stringify(rest)} in ${JSON.stringify(expression)}`);
		}
	}
	return tokens;
}

/** The value and unit of an expression of + − × ÷, parentheses and max(…), in the usual order; adding unlike units is an error. */
function evaluate(tokens: Token[]): { value: number; unit: Unit } {
	let pos = 0;
	const isOp = (token: Token | undefined, ...ops: string[]): token is { kind: "op"; op: string } => token?.kind === "op" && ops.includes(token.op);
	const take = (op: string): void => {
		if (!isOp(tokens[pos++], op)) throw new Error(`expected ${op}`);
	};
	const alike = (a: Unit, b: Unit): void => {
		if (keyOf(a) !== keyOf(b)) throw new Error(`"${keyOf(a)}" and "${keyOf(b)}" are not the same unit`);
	};
	const sum = (): { value: number; unit: Unit } => {
		const left = product();
		while (isOp(tokens[pos], "+", "−")) {
			const plus = (tokens[pos++] as { op: string }).op === "+";
			const right = product();
			alike(left.unit, right.unit);
			left.value = plus ? left.value + right.value : left.value - right.value;
		}
		return left;
	};
	const product = (): { value: number; unit: Unit } => {
		let left = factor();
		while (isOp(tokens[pos], "×", "÷")) {
			const times = (tokens[pos++] as { op: string }).op === "×";
			const right = factor();
			left = { value: times ? left.value * right.value : left.value / right.value, unit: combine(left.unit, right.unit, times ? 1 : -1) };
		}
		return left;
	};
	const factor = (): { value: number; unit: Unit } => {
		const token = tokens[pos++];
		if (token?.kind === "number") return { value: token.value, unit: token.unit };
		if (isOp(token, "(")) {
			const inner = sum();
			take(")");
			return inner;
		}
		if (isOp(token, "max")) {
			take("(");
			const values = [sum()];
			while (isOp(tokens[pos], ",")) {
				pos++;
				values.push(sum());
			}
			take(")");
			for (const one of values) alike(one.unit, (values[0] as { unit: Unit }).unit);
			return { value: Math.max(...values.map((one) => one.value)), unit: (values[0] as { unit: Unit }).unit };
		}
		throw new Error("expected a number, ( or max(");
	};
	const result = sum();
	if (pos !== tokens.length) throw new Error("words left over after the expression");
	return result;
}

// ---------------------------------------------------------------------------------------------
// The worked examples.

interface Row {
	input: string;
	value: string;
	from: string;
}

interface Example {
	summary: string;
	/** Every line of the block, between <details> and </details>. */
	lines: Array<{ line: string; fenced: boolean; fence: boolean }>;
	rows: Row[];
	/** The lines of its one fenced block. */
	arithmetic: string[];
}

function examplesOf(text: string): Example[] {
	const lines = linesOf(text);
	const examples: Example[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.fenced || lines[i]?.line !== "<details>") continue;
		const summary = /^<summary>(Example: .*)<\/summary>$/.exec(lines[i + 1]?.line ?? "")?.[1];
		const end = lines.findIndex((entry, j) => j > i && !entry.fenced && entry.line === "</details>");
		if (summary === undefined || end < 0) continue;
		const block = lines.slice(i + 2, end);
		const table = block.filter((entry) => !entry.fenced && entry.line.startsWith("|"));
		const rows = table.slice(2).map(({ line }) => {
			const [input, value, from] = line.split("|").slice(1, -1).map((cell) => cell.trim()) as [string, string, string];
			return { input, value, from };
		});
		const arithmetic = block.filter((entry) => entry.fenced && !entry.fence).map((entry) => entry.line);
		examples.push({ summary, lines: block, rows, arithmetic });
	}
	return examples;
}

const EXAMPLES = examplesOf(TEXT);

/** The unit a Series' value is written with, by its place: whole cell equality holds the rest. */
function seriesUnit(place: string): string {
	if (/\.bytes_per_second\.p\d+$/.test(place)) return " bytes per second";
	if (/_ns\.p\d+$/.test(place)) return " ns";
	if (/_bytes$/.test(place)) return " bytes";
	return "";
}

interface Checked {
	problems: string[];
	/** The addresses of the files its citations read. */
	read: Set<string>;
	/** Whether it cites a tier: a price dimension's bounds, of a term with more than one. */
	tier: boolean;
}

/** One row's citation, found in the sample: a list of what does not agree with it. */
function checkRow(row: Row, read: Set<string>, cited: Json[], counts: Quantity[]): { problems: string[]; tier: boolean } {
	const problems: string[] = [];
	const codes = [...row.from.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
	const series = /^Series `([0-9a-f]{12})`/.exec(row.from)?.[1];
	const pricePath = codes.find((code) => /^prices\/\d{4}\/\d{2}\/\d{2}\/aws\.json$/.test(code));
	if (series !== undefined) {
		read.add(SERIES_LIST.url);
		const found = (SERIES_LIST.json.series as Json[]).find((one) => one.id === series);
		if (found === undefined) return { problems: [`${row.input}: no Series ${series} in ${SERIES_LIST.url}`], tier: false };
		if (!cited.includes(found)) cited.push(found);
		const key = ["series_v1", "requests_v1"].includes(codes[1] as string) ? codes[1] : undefined;
		const place = (key === undefined ? codes[1] : codes[2]) as string;
		const full = key === undefined ? place : `derivations.${key}.${place}`;
		const value = at(found, full);
		if (value === undefined || value === null || typeof value === "object") return { problems: [`${row.input}: Series ${series} has no value at ${full}`], tier: false };
		const expected = `${value}${seriesUnit(place)}`;
		if (row.value !== expected) problems.push(`${row.input}: the page says ${row.value}, ${full} is ${expected}`);
		const percentile = /^(percentiles\.\w+)\.p\d+$/.exec(place)?.[1];
		if (percentile !== undefined) {
			const count = /\bcount (\d+)\b/.exec(row.from)?.[1];
			const held = at(found, `derivations.${key}.${percentile}.count`);
			if (count === undefined || Number(count) !== held) problems.push(`${row.input}: the count behind it is ${held}, the page says ${count}`);
			else counts.push({ value: Number(count), key: "", text: "" });
		}
		if (key !== undefined) {
			const moment = /as of `([^`]+)`/.exec(row.from)?.[1];
			if (moment !== found.newest_run_started_at) problems.push(`${row.input}: the moment is ${found.newest_run_started_at}, the page says ${moment}`);
		}
		return { problems, tier: false };
	}
	if (pricePath !== undefined) {
		const file = priceFile(pricePath);
		read.add(file.url);
		const sku = /SKU `([^`]+)`/.exec(row.from)?.[1] as string;
		const rate = /rate code `([^`]+)`/.exec(row.from)?.[1];
		const source = (file.json.sources as Json[]).find((one) => one.products[sku] !== undefined);
		if (source === undefined) return { problems: [`${row.input}: no product ${sku} in ${pricePath}`], tier: false };
		if (!(source.selections as Json[]).some((selection) => selection.skus.includes(sku))) problems.push(`${row.input}: no rule selected ${sku}`);
		const members = codes.filter((code) => code !== pricePath && code !== sku && code !== rate);
		if (members.length === 1 && members[0]?.startsWith("attributes.")) {
			const words = source.products[sku].attributes[members[0].slice("attributes.".length)];
			if (row.value !== words) problems.push(`${row.input}: AWS's words are ${JSON.stringify(words)}, the page says ${JSON.stringify(row.value)}`);
			return { problems, tier: false };
		}
		if (rate === undefined || !rate.startsWith(`${sku}.`)) return { problems: [...problems, `${row.input}: no rate code of ${sku}`], tier: false };
		const term = source.terms.OnDemand[sku]?.[rate.split(".").slice(0, 2).join(".")];
		const dimension = term?.priceDimensions[rate];
		if (dimension === undefined) return { problems: [...problems, `${row.input}: no price dimension ${rate}`], tier: false };
		let expected: string | undefined;
		if (members.join(" ") === "pricePerUnit.USD") expected = `${dimension.pricePerUnit.USD} USD per ${dimension.unit}`;
		if (members.join(" ") === "beginRange endRange") expected = `${dimension.beginRange} to ${dimension.endRange} ${dimension.unit}`;
		if (expected === undefined) problems.push(`${row.input}: cites ${members.join(", ")}, which the test does not read`);
		else if (row.value !== expected) problems.push(`${row.input}: the price file says ${expected}, the page says ${row.value}`);
		return { problems, tier: expected !== undefined && members[0] === "beginRange" && Object.keys(term.priceDimensions).length > 1 };
	}
	if (/^the question\b/.test(row.from) || /^assumption: \S/.test(row.from)) return { problems, tier: false };
	return { problems: [`${row.input}: "${row.from}" is not the question, an assumption or a citation`], tier: false };
}

function checkExample(example: Example): Checked {
	const problems: string[] = [];
	const read = new Set<string>();
	const cited: Json[] = [];
	let tier = false;

	// The inputs: each found where its row says, each a number the example holds with its unit.
	const inputs: Quantity[] = [];
	if (example.rows.length === 0) problems.push("no table of inputs");
	for (const row of example.rows) {
		inputs.push(...quantitiesOf(row.value));
		const checked = checkRow(row, read, cited, inputs);
		problems.push(...checked.problems);
		tier ||= checked.tier;
	}

	// The arithmetic: every operand held, with its unit, by an input or a line above; every result worked again, its unit too.
	const held: Quantity[] = [...inputs];
	const results = new Map<string, { values: number[]; text: string }>();
	for (const line of example.arithmetic) {
		const label = line.indexOf(": ");
		const equals = line.lastIndexOf(" = ");
		const result = /^(\d+(?:\.\d+)?)((?: [A-Za-z]+)*)(?: → (\d+)( \(rounded up\))?)?$/.exec(line.slice(equals + 3));
		if (label < 0 || equals < label || result === null) {
			problems.push(`not "label: expression = result unit": ${line}`);
			continue;
		}
		const [, stated, written, rounded, up] = result as unknown as [string, string, string, string | undefined, string | undefined];
		const unitText = written.trim();
		let computed: { value: number; unit: Unit };
		try {
			const tokens = tokenize(line.slice(label + 2, equals));
			for (const token of tokens) {
				if (token.kind === "number" && !held.some((one) => same(one.value, token.value) && one.key === keyOf(token.unit))) {
					problems.push(`${token.text} ${keyOf(token.unit) || "(no unit)"} is from nowhere above: ${line}`);
				}
			}
			computed = evaluate(tokens);
		} catch (error) {
			problems.push(`${(error as Error).message}: ${line}`);
			continue;
		}
		if (!agrees(stated, computed.value)) problems.push(`works out to ${computed.value}, not ${stated}: ${line}`);
		if (keyOf(unitOf(unitText)) !== keyOf(computed.unit)) problems.push(`its unit is "${keyOf(computed.unit)}", not "${unitText}": ${line}`);
		const values = [Number(stated)];
		if (rounded !== undefined) {
			if (up === undefined ? !agrees(rounded, computed.value) : Number(rounded) !== roundedUp(computed.value)) problems.push(`${computed.value} is not ${up ? "rounded up" : "rounded"} to ${rounded}: ${line}`);
			values.push(Number(rounded));
		}
		for (const value of values) held.push({ value, key: keyOf(computed.unit), text: unitText });
		results.set(line.slice(0, label), { values, text: unitText });
	}

	// The words: a result only in the answer's item that names its line; any other number an input, with its unit.
	const isInput = (stated: string, scale: number, after: string): boolean => inputs.some((one) => agrees(stated, one.value / scale) && startsWithUnit(after, one.text));
	const answered = new Set<string>();
	const words = [example.summary, ...example.lines.filter((entry) => !entry.fenced && !entry.line.startsWith("|")).map((entry) => entry.line)];
	for (const line of words) {
		const item = /^- ([^:]+): /.exec(line);
		const result = item === null ? undefined : results.get(item[1] as string);
		const text = wordsOf(item === null || result === undefined ? line : line.slice(item[0].length));
		let first = result !== undefined;
		for (const match of text.matchAll(NUMBER)) {
			const [whole, stated, million] = match as unknown as [string, string, string | undefined];
			const scale = million === undefined ? 1 : 1e6;
			const after = text.slice((match.index as number) + whole.length);
			const isResult = result !== undefined && result.values.some((value) => agrees(stated, value / scale)) && startsWithUnit(after, result.text);
			if (first) {
				// The item's own result, as its line states it or rounds it, with its unit.
				if (million !== undefined || !result?.values.some((value) => value === Number(stated)) || !startsWithUnit(after, result.text)) {
					const unit = result?.text ? ` ${result.text}` : "";
					problems.push(`${item?.[1]} is ${result?.values.join(" → ")}${unit}, the answer says "${stated}${after.slice(0, unit.length).trimEnd()}": ${line}`);
				} else answered.add(item?.[1] as string);
				first = false;
			} else if (!isResult && !isInput(stated, scale, after)) {
				const said = `${stated}${million ?? ""}${/^\s*[^\s.,;:()]*/.exec(after)?.[0] ?? ""}`;
				problems.push(`"${said}" is no input of the example${result === undefined ? " (a result is stated only in the item that names its line)" : ", nor its item's result"}: ${line}`);
			}
		}
		if (result !== undefined && first) problems.push(`${item?.[1]}: the answer's item states no number: ${line}`);
	}
	const last = example.arithmetic[example.arithmetic.length - 1];
	if (last !== undefined && !answered.has(last.slice(0, last.indexOf(": ")))) problems.push(`the answer does not state the last line's result: ${last}`);

	// What it names of a Series it cites: each parameter, the build, the benchmark's page.
	const prose = example.lines.filter((entry) => !entry.fenced && !entry.line.startsWith("|")).map((entry) => entry.line);
	for (const line of prose) {
		for (const [, name, value] of line.matchAll(/`([a-z_][a-z0-9_]*)` `([^`]+)`/g)) {
			for (const row of cited) {
				if (row.params[name as string] !== undefined && String(row.params[name as string]) !== value) problems.push(`Series ${row.id}'s ${name} is ${row.params[name as string]}, the page says ${value}: ${line}`);
			}
		}
		for (const [, build] of line.matchAll(/\bbuild `([^`]+)`/g)) {
			for (const row of cited) if (row.build !== build) problems.push(`Series ${row.id}'s build is ${row.build}, the page says ${build}: ${line}`);
		}
		for (const [, benchmark] of line.matchAll(/\]\(\/docs\/benchmarks\/([a-z0-9_]+)\)/g)) {
			if (cited.length > 0 && !cited.some((row) => row.benchmark === benchmark)) problems.push(`it cites no Series of ${benchmark}: ${line}`);
		}
	}
	return { problems, read, tier };
}

describe("the worked examples of the start-here page", () => {
	test("there are three: a price with tiers, a fleet, and an answer not held", () => {
		expect(EXAMPLES.map((example) => example.summary)).toHaveLength(3);
		const checked = EXAMPLES.map(checkExample);
		expect(checked.filter((one) => one.tier)).toHaveLength(1);
		const fleet = EXAMPLES.filter((example) => example.arithmetic.some((line) => line.endsWith("(rounded up)")) && example.arithmetic.some((line) => line.includes("max(")));
		expect(fleet).toHaveLength(1);
		const notHeld = EXAMPLES.filter((example) => example.arithmetic.length === 0 && example.lines.some((entry) => entry.line.startsWith("**Answer.** Not held.")));
		expect(notHeld).toHaveLength(1);
	});

	for (const example of EXAMPLES) {
		test(`${example.summary}: every input is the question's, an assumption, or found in the sample where its row says, and every result is worked again`, () => {
			const { problems } = checkExample(example);
			expect(problems).toEqual([]);
		});

		test(`${example.summary}: names the sample's date and the address of every file it read`, () => {
			const { read } = checkExample(example);
			const text = example.lines.map((entry) => entry.line).join("\n");
			expect(read.size).toBeGreaterThan(0);
			expect(text).toContain(SAMPLE_DATE);
			for (const url of read) expect({ url, named: text.includes(url) }).toEqual({ url, named: true });
		});
	}

	describe("catch what is planted in them", () => {
		const fleet = EXAMPLES.find((example) => example.arithmetic.some((line) => line.includes("max("))) as Example;
		const tiered = EXAMPLES.find((example) => checkExample(example).tier) as Example;
		const notHeld = EXAMPLES.find((example) => example.arithmetic.length === 0) as Example;
		const edit = (example: Example, from: string, to: string): Example => {
			const text = (entry: { line: string }) => entry.line.replace(from, to);
			return {
				summary: example.summary,
				lines: example.lines.map((entry) => ({ ...entry, line: text(entry) })),
				rows: example.rows.map((row) => ({ input: row.input, value: row.value.replace(from, to), from: row.from.replace(from, to) })),
				arithmetic: example.arithmetic.map((line) => line.replace(from, to)),
			};
		};
		/** The problems a planted change makes the example show; the change must have changed something. */
		const planted = (example: Example, from: string, to: string): string[] => {
			const changed = edit(example, from, to);
			expect(JSON.stringify(changed)).not.toBe(JSON.stringify(example));
			return checkExample(changed).problems;
		};
		const cases: Array<[string, Example, string, string, RegExp]> = [
			["a figure", fleet, "145497618462.33847 bytes per second", "145497618462.3385 bytes per second", /is 145497618462\.33847 bytes per second|from nowhere/],
			["a count", fleet, "count 63", "count 64", /the count behind it is 63/],
			["a moment", fleet, "as of `2026-11-26T16:13:49.030665839Z`", "as of `2026-11-26T16:13:49Z`", /the moment is/],
			["a rounding up", fleet, "= 68.73 → 69", "= 68.73 → 68", /is not rounded up to 68/],
			["a result", fleet, "= 198.56 USD per Hrs", "= 198.57 USD per Hrs", /works out to/],
			["AWS's words", fleet, "`attributes.memory`", "`attributes.vcpu`", /AWS's words are "32"/],
			["a price", tiered, "0.0850000000 USD per GB", "0.0800000000 USD per GB", /the price file says 0\.0850000000 USD per GB/],
			["a tier's bounds", tiered, "10240 to 51200 GB", "10240 to 51300 GB", /the price file says 10240 to 51200 GB/],
			["an operand", tiered, "(153600 GB − 51200 GB) × 0.07", "(153600 GB − 51200 GB) × 0.071", /0\.071 .* is from nowhere above/],
			["a source", tiered, "the question", "a guess", /is not the question, an assumption or a citation/],
			// Item 12: an answer's result is held to its own line, not to any number the example holds.
			["an answer's result swapped for another the example holds", fleet, "- Boxes: 146", "- Boxes: 75", /^Boxes is 146, the answer says "75"/],
			["an answer's total swapped for the grand total", tiered, "- Transfer cost: 30003886.2 USD.", "- Transfer cost: 30003898.2 USD.", /^Transfer cost is 30003886\.2 USD, the answer says "30003898\.2 USD"/],
			["a result stated outside its item", fleet, "so few boxes cannot hold", "69 boxes cannot hold", /^"69 boxes" is no input of the example \(a result is stated only in the item that names its line\)/],
			// Item 13: units, on every row and through the arithmetic.
			["a Series value's unit", fleet, "1073741824 bytes", "1073741824 KiB", /Buffer: the page says 1073741824 KiB, params\.size_bytes is 1073741824 bytes/],
			["a result's unit", tiered, "= 921.6 USD", "= 921.6 GB", /its unit is "USD\^1", not "GB"/],
			["an operand's unit", tiered, "× 0.09 USD per GB", "× 0.09 USD per Hrs", /0\.09 GB\^-1|0\.09 Hrs\^-1 USD\^1 is from nowhere above/],
			["a unit in the words", fleet, "a 10 TB data set", "a 10 GB data set", /^"10 GB" is no input of the example/],
			// Item 14: what the example names of its Series.
			["a parameter", fleet, "`threads` `all`", "`threads` `1`", /Series a655ffb3e7dd's threads is all, the page says 1/],
			["a build", fleet, "build `static`", "build `dynamic`", /Series a655ffb3e7dd's build is static, the page says dynamic/],
			["a benchmark", notHeld, "[tcp_echo](/docs/benchmarks/tcp_echo)", "[memory_read](/docs/benchmarks/memory_read)", /it cites no Series of memory_read/],
		];
		for (const [what, example, from, to, finding] of cases) {
			test(`${what}: ${JSON.stringify(from)} made ${JSON.stringify(to)}`, () => {
				expect(checkExample(example).problems).toEqual([]);
				const problems = planted(example, from, to);
				expect({ what, caught: problems.some((problem) => finding.test(problem)), problems }).toMatchObject({ what, caught: true });
			});
		}
	});
});

// ---------------------------------------------------------------------------------------------
// The page as a page.

describe("the start-here page", () => {
	const lines = linesOf(TEXT);
	const prose = lines.filter((entry) => !entry.fenced).map((entry) => entry.line);
	const withoutCode = (line: string): string => line.replace(/(`+)[\s\S]*?\1/g, "");

	test("is plain Markdown: a title, an opening paragraph that stands alone, no front matter, no image, no HTML but <details> and <summary>", () => {
		expect(TEXT.startsWith("# ")).toBe(true);
		expect(TEXT.startsWith("---")).toBe(false);
		expect(TEXT.endsWith("\n") && !TEXT.endsWith("\n\n")).toBe(true);
		const [title, blank, opening, after] = TEXT.split("\n");
		expect(title).toMatch(/^# \S/);
		expect([blank, after]).toEqual(["", ""]);
		expect(opening).toMatch(/^[A-Z]/);
		expect((opening as string).split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2);
		expect(prose.some((line) => line.includes("!["))).toBe(false);
		const tags = prose.flatMap((line) => [...withoutCode(line).matchAll(/<\/?([A-Za-z][\w-]*)[^>]*>/g)].map((match) => match[1]));
		expect([...new Set(tags)].sort()).toEqual(["details", "summary"]);
		expect(prose.filter((line) => line === "<details>").length).toBe(prose.filter((line) => line === "</details>").length);
		prose.forEach((line, i) => {
			if (line === "<details>") expect(prose[i + 1]).toMatch(/^<summary>[^<]+<\/summary>$/);
		});
	});

	test("links only to documentation pages that exist and to the API", () => {
		const targets = prose.flatMap((line) => [...withoutCode(line).matchAll(/\[[^\]\n]*\]\(([^()\s]+)\)/g)].map((match) => match[1] as string));
		expect(targets.length).toBeGreaterThan(0);
		const problems: string[] = [];
		for (const target of targets) {
			if (target.startsWith("/")) {
				if (!isDocsAddress(target)) problems.push(`${target} is no documentation page's address`);
				const benchmark = DOCS_BENCHMARK_ADDRESS.test(target) ? target.slice("/docs/benchmarks/".length) : undefined;
				if (benchmark !== undefined && !existsSync(join(ROOT, "benchmarks", benchmark, "README.md"))) problems.push(`${target}: there is no benchmark ${benchmark}`);
				if (target === "/docs/") problems.push("the page links to itself");
			} else if (!target.startsWith("https://api.ledgermath.com/")) {
				problems.push(`${target} is neither a documentation page nor the API`);
			}
		}
		expect(problems).toEqual([]);
		// It sends the reader to each part of the reference.
		for (const page of ["/docs/api/", "/docs/methods", "/docs/prices", "/docs/glossary", "/docs/machines"]) expect({ page, linked: targets.includes(page) }).toEqual({ page, linked: true });
	});

	test("names no file, document, issue, pull request, ADR, function or option a reader of the published words cannot fetch", () => {
		const { referencesIn } = wordRules(ROOT);
		// A link's target is held to the documentation's addresses above; the words around it are scanned.
		const words = TEXT.replace(/\]\([^()\s]+\)/g, "]");
		expect(referencesIn(words)).toEqual([]);
	});
});
