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

describe("each benchmark's README, as its page", () => {
	test("there is one for every benchmark schedule.json runs", () => {
		expect(NAMES.length).toBeGreaterThan(0);
	});

	for (const name of NAMES) {
		const text = readFileSync(join(ROOT, "benchmarks", name, "README.md"), "utf8");
		const lines = text.split("\n");

		test(`${name}: opens with its name as the title, then one paragraph before the first heading`, () => {
			expect(lines[0]).toBe(`# ${name}`);
			expect(lines[1]).toBe("");
			const firstHeading = lines.findIndex((line, index) => index > 0 && line.startsWith("#"));
			const opening = lines.slice(2, firstHeading);
			while (opening.at(-1) === "") opening.pop();
			expect(opening.length, "an opening paragraph").toBeGreaterThan(0);
			expect(opening.includes(""), "one paragraph, no blank line inside it").toBe(false);
			expect(lines[firstHeading]).toBe(`## ${PAGE_HEADINGS[0]}`);
		});

		test(`${name}: has the page's headings, in order, and no other at that level`, () => {
			const headings = prose(text)
				.filter((line) => line.startsWith("## "))
				.map((line) => line.slice(3));
			expect(headings).toEqual(PAGE_HEADINGS);
			expect(prose(text).filter((line) => line.startsWith("# "))).toEqual([`# ${name}`]);
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
