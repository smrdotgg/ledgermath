/**
 * The documentation's start-here page, site/content/docs/index.md, served at
 * https://ledgermath.com/docs/: the how-to an agent reads first, and may be all it reads besides
 * the reference it links to. So its worked examples are held to the data, its links to pages that
 * exist, and its words to the rules every published word keeps.
 *
 * Each worked example is a <details> block whose summary begins "Example:". Its inputs are a table,
 * | Input | Value | From |, each row from the question, an assumption, or the fixed sample of the
 * API kept in docs/api-sample/: a Series' figure (`Series <id>`, the Method's key, the figure's
 * place, its count and its moment) from the list of every Series, or a price (the price file's
 * path, the SKU, the rate code and the member) from the price file. Its arithmetic is its one
 * fenced block, one operation per line, "label: expression = result", a result optionally followed
 * by "→ N (rounded up)". The test finds each figure in the sample at the place the row names, works
 * every line again from the numbers the table and the lines above it hold, and checks that every
 * number the example's words state is one of those, as written or rounded.
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

/** A line as prose a reader sees, without its code spans. */
const withoutCode = (line: string): string => line.replace(/(`+)[\s\S]*?\1/g, "");

// ---------------------------------------------------------------------------------------------
// Numbers as the page writes them.

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

/** The numbers a cell or a line of words holds: digits standing alone, not part of a name, a date, a time or an address. */
const NUMBER = /(?<![\w.\/\-:^])(\d+(?:\.\d+)?(?:\^\d+)?)(?![\w\/\-:^]|\.\d)(\s+million\b)?/g;

type Token = { kind: "number"; value: number; text: string } | { kind: "op"; op: string };

/** An expression's numbers and operators; words between them (units) are skipped. */
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
			if (/^[A-Za-z_]/.test(rest.slice(number.length))) throw new Error(`a number runs into a word in ${JSON.stringify(expression)}`);
			tokens.push({ kind: "number", value: valueOf(number), text: number });
			i += number.length;
		} else if (/^[A-Za-z]/.test(rest)) {
			i += (/^[A-Za-z][^\s+−×÷(),]*/.exec(rest)?.[0] as string).length;
		} else {
			throw new Error(`cannot read ${JSON.stringify(rest)} in ${JSON.stringify(expression)}`);
		}
	}
	return tokens;
}

/** The value of an expression of + − × ÷, parentheses and max(…), in the usual order. */
function evaluate(tokens: Token[]): number {
	let pos = 0;
	const isOp = (token: Token | undefined, ...ops: string[]): token is { kind: "op"; op: string } => token?.kind === "op" && ops.includes(token.op);
	const take = (op: string): void => {
		const token = tokens[pos++];
		if (!isOp(token, op)) throw new Error(`expected ${op}`);
	};
	const sum = (): number => {
		let value = product();
		while (isOp(tokens[pos], "+", "−")) value = (tokens[pos++] as { op: string }).op === "+" ? value + product() : value - product();
		return value;
	};
	const product = (): number => {
		let value = factor();
		while (isOp(tokens[pos], "×", "÷")) value = (tokens[pos++] as { op: string }).op === "×" ? value * factor() : value / factor();
		return value;
	};
	const factor = (): number => {
		const token = tokens[pos++];
		if (token?.kind === "number") return token.value;
		if (isOp(token, "(")) {
			const value = sum();
			take(")");
			return value;
		}
		if (isOp(token, "max")) {
			take("(");
			const values = [sum()];
			while (isOp(tokens[pos], ",")) {
				pos++;
				values.push(sum());
			}
			take(")");
			return Math.max(...values);
		}
		throw new Error("expected a number, ( or max(");
	};
	const value = sum();
	if (pos !== tokens.length) throw new Error("words left over after the expression");
	return value;
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

interface Checked {
	/** Every number the example holds: its inputs as the table writes them, the counts it cites, and each line's results. */
	known: number[];
	problems: string[];
	/** The addresses of the files its citations read. */
	read: Set<string>;
	/** Whether it cites a tier: a price dimension's bounds, of a term with more than one. */
	tier: boolean;
}

/** One row's citation, found in the sample: a list of what does not agree with it. */
function checkRow(row: Row, read: Set<string>, known: number[]): { problems: string[]; tier: boolean } {
	const problems: string[] = [];
	const codes = [...row.from.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
	const series = /^Series `([0-9a-f]{12})`/.exec(row.from)?.[1];
	const pricePath = codes.find((code) => /^prices\/\d{4}\/\d{2}\/\d{2}\/aws\.json$/.test(code));
	if (series !== undefined) {
		read.add(SERIES_LIST.url);
		const found = (SERIES_LIST.json.series as Json[]).find((one) => one.id === series);
		if (found === undefined) return { problems: [`${row.input}: no Series ${series} in ${SERIES_LIST.url}`], tier: false };
		const key = ["series_v1", "requests_v1"].includes(codes[1] as string) ? codes[1] : undefined;
		const place = (key === undefined ? codes[1] : codes[2]) as string;
		const full = key === undefined ? place : `derivations.${key}.${place}`;
		const value = at(found, full);
		if (value === undefined || value === null || typeof value === "object") return { problems: [`${row.input}: Series ${series} has no value at ${full}`], tier: false };
		const unit = /\.bytes_per_second\.p\d+$/.test(place) ? " bytes per second" : /\.time_per_repetition_ns\.p\d+$/.test(place) ? " ns" : undefined;
		if (unit !== undefined ? row.value !== `${value}${unit}` : row.value.split(" ")[0] !== String(value)) problems.push(`${row.input}: the page says ${row.value}, ${full} is ${value}`);
		const percentile = /^(percentiles\.\w+)\.p\d+$/.exec(place)?.[1];
		if (percentile !== undefined) {
			const count = /\bcount (\d+)\b/.exec(row.from)?.[1];
			const held = at(found, `derivations.${key}.${percentile}.count`);
			if (count === undefined || Number(count) !== held) problems.push(`${row.input}: the count behind it is ${held}, the page says ${count}`);
			else known.push(Number(count));
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
	const known: number[] = [];
	const read = new Set<string>();
	let tier = false;
	if (example.rows.length === 0) problems.push("no table of inputs");
	for (const row of example.rows) {
		for (const match of row.value.matchAll(NUMBER)) known.push(valueOf(match[1] as string));
		const checked = checkRow(row, read, known);
		problems.push(...checked.problems);
		tier ||= checked.tier;
	}
	for (const line of example.arithmetic) {
		const label = line.indexOf(": ");
		const equals = line.lastIndexOf(" = ");
		const result = /^(\d+(?:\.\d+)?)\b[^→]*?(?: → (\d+)( \(rounded up\))?)?$/.exec(line.slice(equals + 3));
		if (label < 0 || equals < label || result === null) {
			problems.push(`not "label: expression = result": ${line}`);
			continue;
		}
		let computed: number;
		try {
			const tokens = tokenize(line.slice(label + 2, equals));
			for (const token of tokens) if (token.kind === "number" && !known.some((value) => same(value, token.value))) problems.push(`${token.text} is from nowhere above: ${line}`);
			computed = evaluate(tokens);
		} catch (error) {
			problems.push(`${(error as Error).message}: ${line}`);
			continue;
		}
		const [, stated, rounded, up] = result as unknown as [string, string, string | undefined, string | undefined];
		if (!agrees(stated, computed)) problems.push(`works out to ${computed}, not ${stated}: ${line}`);
		known.push(Number(stated));
		if (rounded !== undefined) {
			if (up === undefined ? !agrees(rounded, computed) : Number(rounded) !== roundedUp(computed)) problems.push(`${computed} is not ${up ? "rounded up" : "rounded"} to ${rounded}: ${line}`);
			known.push(Number(rounded));
		}
	}
	// Every number the words state is one the table or the arithmetic holds, as written or rounded.
	const words = [example.summary, ...example.lines.filter((entry) => !entry.fenced && !entry.line.startsWith("|")).map((entry) => entry.line)];
	for (const line of words) {
		for (const match of withoutCode(line).replace(/\]\([^)\s]*\)/g, "]").matchAll(NUMBER)) {
			const [, stated, million] = match as unknown as [string, string, string | undefined];
			const scale = million === undefined ? 1 : 1e6;
			if (!known.some((value) => agrees(stated, value / scale))) problems.push(`${stated}${million ?? ""} is not a number the example holds: ${line}`);
		}
	}
	return { known, problems, read, tier };
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
		test(`${example.summary}: every input is the question's, an assumption, or found in the sample where its row says`, () => {
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

	test("the checks catch a figure, a count, a moment, a price or a line of arithmetic that is wrong, and a number from nowhere", () => {
		const fleet = EXAMPLES.find((example) => example.arithmetic.some((line) => line.includes("max("))) as Example;
		const tiered = EXAMPLES.find((example) => checkExample(example).tier) as Example;
		const edit = (example: Example, from: string, to: string): Example => {
			const text = (entry: { line: string }) => entry.line.replace(from, to);
			return {
				summary: example.summary,
				lines: example.lines.map((entry) => ({ ...entry, line: text(entry) })),
				rows: example.rows.map((row) => ({ input: row.input, value: row.value.replace(from, to), from: row.from.replace(from, to) })),
				arithmetic: example.arithmetic.map((line) => line.replace(from, to)),
			};
		};
		const caught = (example: Example, from: string, to: string): boolean => {
			const changed = edit(example, from, to);
			expect(JSON.stringify(changed)).not.toBe(JSON.stringify(example));
			return checkExample(changed).problems.length > 0;
		};
		expect(checkExample(fleet).problems).toEqual([]);
		expect(caught(fleet, "145497618462.33847 bytes per second", "145497618462.3385 bytes per second")).toBe(true);
		expect(caught(fleet, "count 63", "count 64")).toBe(true);
		expect(caught(fleet, "as of `2026-11-26T16:13:49.030665839Z`", "as of `2026-11-26T16:13:49Z`")).toBe(true);
		expect(caught(fleet, "= 68.73 → 69", "= 68.73 → 68")).toBe(true);
		expect(caught(fleet, "= 198.56 USD", "= 198.57 USD")).toBe(true);
		expect(caught(fleet, "146 boxes of AWS's", "147 boxes of AWS's")).toBe(true);
		expect(caught(fleet, "`attributes.memory`", "`attributes.vcpu`")).toBe(true);
		expect(caught(tiered, "0.0850000000 USD per GB", "0.0800000000 USD per GB")).toBe(true);
		expect(caught(tiered, "10240 to 51200 GB", "10240 to 51300 GB")).toBe(true);
		expect(caught(tiered, "(153600 − 51200) GB × 0.07", "(153600 − 51200) GB × 0.071")).toBe(true);
		expect(caught(tiered, "the question", "a guess")).toBe(true);
		expect(caught(tiered, "= 30003898.2 USD", "= 30003899.2 USD")).toBe(true);
		expect(caught(tiered, "Cost: 30003886.2 USD + 12 USD", "Cost: 30003886.2 USD + 13 USD")).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------
// The page as a page.

describe("the start-here page", () => {
	const lines = linesOf(TEXT);
	const prose = lines.filter((entry) => !entry.fenced).map((entry) => entry.line);

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
