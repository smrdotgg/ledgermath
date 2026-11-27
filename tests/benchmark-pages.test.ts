import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/*
 * Each benchmark's README.md is also its page at
 * https://ledgermath.com/docs/benchmarks/<name>, rendered from the same file
 * (CONTRIBUTING.md, "Write a benchmark, in any language"). A reader who has a
 * number from the data API and no repository finds the same headings, in the
 * same order, on every page, and the paragraph under the title is the page's
 * description in the index.
 */

const ROOT = resolve(import.meta.dir, "..");

const PAGE_HEADINGS = [
	"What a figure means",
	"What a figure does not show",
	"Parameters",
	"Observed values",
	"Findings",
	"How it works",
	"Building and testing",
];

const SCHEDULE = JSON.parse(readFileSync(join(ROOT, "schedule.json"), "utf8")) as { benchmarks: Array<{ name: string }> };
const NAMES = [...new Set(SCHEDULE.benchmarks.map((entry) => entry.name))];

/** The README's lines outside fenced code blocks. */
function prose(text: string): string[] {
	let fenced = false;
	return text.split("\n").filter((line) => {
		if (line.trimStart().startsWith("```")) {
			fenced = !fenced;
			return false;
		}
		return !fenced;
	});
}

/*
 * What Markdown (CommonMark, as GitHub renders it) means by one paragraph: a
 * run of lines that are not blank, where a line holding only spaces or tabs is
 * blank, and where no line starts another block. A list item, a quote, a fence,
 * an HTML block, a heading or a thematic break starts a block of its own (only
 * an ordered item numbered 1 interrupts a paragraph, but an opening that starts
 * with any list item is a list); a line of = or - under the text makes it a
 * heading instead.
 */
const BLANK = /^[ \t]*$/;
const STARTS_BLOCK = /^ {0,3}([-+*][ \t]|[-+*]$|\d{1,9}[.)]([ \t]|$)|>|```|~~~|<|#{1,6}([ \t]|$)|(([-*_])[ \t]*){3,}$)/;
const INTERRUPTS_PARAGRAPH = /^ {0,3}([-+*][ \t]+\S|1[.)][ \t]+\S|>|```|~~~|<|#{1,6}([ \t]|$)|(=+|-+)[ \t]*$|(([-*_])[ \t]*){3,}$)/;
const INDENTED_CODE = /^( {4}|\t)/;

/** Why the page does not open with its title, one paragraph, then the first heading; empty when it does. */
function openingProblems(text: string, name: string): string[] {
	const lines = text.split("\n");
	const problems: string[] = [];
	if (lines[0] !== `# ${name}`) problems.push(`the first line is not "# ${name}"`);
	let i = 1;
	while (i < lines.length && BLANK.test(lines[i] as string)) i++;
	const start = i;
	while (i < lines.length && !BLANK.test(lines[i] as string)) {
		const line = lines[i] as string;
		if (i === start ? STARTS_BLOCK.test(line) || INDENTED_CODE.test(line) : INTERRUPTS_PARAGRAPH.test(line)) {
			problems.push(`line ${i + 1} starts a block of its own, not the opening paragraph: ${JSON.stringify(line)}`);
		}
		i++;
	}
	if (i === start) problems.push("there is no opening paragraph");
	while (i < lines.length && BLANK.test(lines[i] as string)) i++;
	if (lines[i] !== `## ${PAGE_HEADINGS[0]}`) {
		problems.push(`after the opening paragraph comes ${JSON.stringify(lines[i] ?? "the end")}, not "## ${PAGE_HEADINGS[0]}"`);
	}
	return problems;
}

describe("one opening paragraph, as Markdown means it", () => {
	const heading = `## ${PAGE_HEADINGS[0]}`;
	test("a paragraph of several lines is one paragraph", () => {
		expect(openingProblems(`# x\n\nIt measures this.\nAnd that.\n\n${heading}\n`, "x")).toEqual([]);
	});
	test("a line of spaces between two paragraphs makes two", () => {
		expect(openingProblems(`# x\n\nThe first.\n   \nThe second.\n\n${heading}\n`, "x")).not.toEqual([]);
		expect(openingProblems(`# x\n\nThe first.\n\t\nThe second.\n\n${heading}\n`, "x")).not.toEqual([]);
	});
	test("two list items are a list, not a paragraph", () => {
		expect(openingProblems(`# x\n\n- one\n- two\n\n${heading}\n`, "x")).not.toEqual([]);
		expect(openingProblems(`# x\n\n1. one\n2. two\n\n${heading}\n`, "x")).not.toEqual([]);
		expect(openingProblems(`# x\n\nIt measures this:\n- one\n- two\n\n${heading}\n`, "x")).not.toEqual([]);
	});
	test("a line of dashes under the text makes it a heading", () => {
		expect(openingProblems(`# x\n\nIt measures this.\n---\n\n${heading}\n`, "x")).not.toEqual([]);
	});
	test("the first heading must follow it", () => {
		expect(openingProblems(`# x\n\nIt measures this.\n\n## Something else\n`, "x")).not.toEqual([]);
		expect(openingProblems(`# x\n\n${heading}\n`, "x")).not.toEqual([]);
	});
});

describe("each benchmark's README, as its page", () => {
	test("there is one for every benchmark schedule.json runs", () => {
		expect(NAMES.length).toBeGreaterThan(0);
	});

	for (const name of NAMES) {
		const text = readFileSync(join(ROOT, "benchmarks", name, "README.md"), "utf8");

		test(`${name}: opens with its name as the title, then one paragraph before the first heading`, () => {
			expect(openingProblems(text, name)).toEqual([]);
		});

		test(`${name}: has the page's headings, in order, and no other at that level`, () => {
			const headings = prose(text)
				.filter((line) => line.startsWith("## "))
				.map((line) => line.slice(3));
			expect(headings).toEqual(PAGE_HEADINGS);
			expect(prose(text).filter((line) => line.startsWith("# "))).toEqual([`# ${name}`]);
		});

		test(`${name}: links its list of Series under "Parameters", where a reader finds its figures`, () => {
			const lines = prose(text);
			const start = lines.indexOf("## Parameters");
			const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
			expect(lines.slice(start, end).join("\n")).toContain(`](https://api.ledgermath.com/v1/benchmarks/${name}.json)`);
		});

		test(`${name}: names no directory of one machine of LedgerMath's own`, () => {
			expect(text).not.toContain("/mnt/local/");
		});

		test(`${name}: holds no HTML but <details> and <summary>, outside code`, () => {
			const outsideCode = prose(text)
				.map((line) => line.replace(/`[^`]*`/g, ""))
				.join("\n");
			const tags = [...outsideCode.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)[^>]*>/g)].map((match) => (match[1] as string).toLowerCase());
			expect(tags.filter((tag) => tag !== "details" && tag !== "summary")).toEqual([]);
		});
	}
});
