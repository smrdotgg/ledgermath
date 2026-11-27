// scripts/docs.ts on a small repository made here: the pages it makes, their links, the contract
// it holds the Markdown to, /docs/'s contents and llms.txt. Run with `bun test` inside site/.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DOCS_ADDRESSES } from "../../scripts/lib/docs-addresses";
import { addressOf, buildDocs, CONTENTS_HEADING, chunkName, DocsError, headingSlug, llmsTxt, markdownFile, pageFile, readLlmsTxt, type DocsPage } from "./docs";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The API reference as the generator would write it, each page a title and a paragraph. */
const GENERATED = new Map(
	DOCS_ADDRESSES.filter((address) => address.startsWith("/docs/api/") || address === "/docs/machines").map((address) => [markdownFile(address), `# Page ${address}\n\nAbout ${address}.\n`]),
);

const SORT = [
	"# sort",
	"",
	"How fast one thread sorts keys.",
	"",
	"## What a figure means",
	"",
	"See [Methods](https://ledgermath.com/docs/methods), [the source](sort.c), [the log](../../docs/dev-log.md#step-4) and [the same log][log].",
	"",
	"| | Per request |",
	"|---|---|",
	"| New | 3 KB |",
	"",
	"| Key | What it is |",
	"|---|---|",
	"| `a` | one |",
	"",
	"| Key | What it is |",
	"|---|---|",
	"| `b` | two |",
	"",
	"## Notes",
	"",
	"## Notes",
	"",
	"Back to [the first notes](#notes) and [the second](#notes-1).",
	"",
	"[log]: ../../docs/dev-log.md",
	"",
].join("\n");

/** A repository: schedule.json naming sort, its README, the files it links, and the hand-written pages FILES. */
function repository(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "docs-repository-"));
	made.push(dir);
	const all: Record<string, string> = {
		"schedule.json": JSON.stringify({ benchmarks: [{ name: "sort" }] }),
		"benchmarks/sort/README.md": SORT,
		"benchmarks/sort/sort.c": "int main(void) { return 0; }\n",
		"docs/dev-log.md": "# Log\n",
		"site/content/docs/glossary.md": "# Glossary\n\nThe words.\n\n## Run\n\nOne execution. See [Methods](/docs/methods#which-runs) and [prices](/docs/prices).\n",
		"site/content/docs/methods.md": "# Methods\n\nHow the numbers are made.\n\n## Which Runs\n\nThe [glossary](/docs/glossary).\n",
		"site/content/docs/prices.md": "# Prices\n\nA day's prices.\n",
		...files,
	};
	for (const [file, text] of Object.entries(all)) {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
	return dir;
}

const pageAt = (pages: readonly DocsPage[], address: string) => pages.find((page) => page.address === address)!;
const problemsOf = (dir: string): string[] => {
	try {
		buildDocs(dir, GENERATED);
		return [];
	} catch (error) {
		if (error instanceof DocsError) return [...error.problems];
		throw error;
	}
};

describe("addresses", () => {
	test("a file's address, its HTML file, its Markdown and its chunk", () => {
		expect(addressOf("glossary.md")).toBe("/docs/glossary");
		expect(addressOf("index.md")).toBe("/docs/");
		expect(addressOf("guides/index.md")).toBe("/docs/guides/");
		expect(pageFile("/docs/glossary")).toBe("docs/glossary/index.html");
		expect(pageFile("/docs/api/")).toBe("docs/api/index.html");
		expect(markdownFile("/docs/glossary")).toBe("docs/glossary.md");
		expect(markdownFile("/docs/")).toBe("docs/index.md");
		expect(chunkName("/docs/api/series")).toBe("docs-api-series");
		expect(chunkName("/docs/")).toBe("docs");
	});

	test("a heading's anchor, as GitHub makes it", () => {
		expect(headingSlug("Shape stat")).toBe("shape-stat");
		expect(headingSlug("derivations.series_v1.counted_runs")).toBe("derivationsseries_v1counted_runs");
		expect(headingSlug("What a figure does not show")).toBe("what-a-figure-does-not-show");
		expect(headingSlug("When `event` is \"started\"")).toBe("when-event-is-started");
	});
});

describe("buildDocs", () => {
	test("every page, in the navigation's order: /docs/'s contents, the API reference, the benchmarks, then machines, Methods, prices, the glossary", () => {
		const pages = buildDocs(repository(), GENERATED);
		expect(pages.map((page) => page.address)).toEqual([
			"/docs/",
			...DOCS_ADDRESSES.filter((address) => address.startsWith("/docs/api/")),
			"/docs/benchmarks/sort",
			"/docs/machines",
			"/docs/methods",
			"/docs/prices",
			"/docs/glossary",
		]);
		expect(pageAt(pages, "/docs/glossary")).toMatchObject({ title: "Glossary", description: "The words.", file: "docs/glossary/index.html", markdownFile: "docs/glossary.md", markdownAddress: "/docs/glossary.md", section: "reference" });
	});

	test("links become the site's own: the site's address dropped, a fragment on the page left to the browser, a file of the repository on GitHub, in the HTML and in the served Markdown", () => {
		const pages = buildDocs(repository(), GENERATED);
		const sort = pageAt(pages, "/docs/benchmarks/sort");
		expect(sort.html).toContain('<a href="/docs/methods">Methods</a>');
		expect(sort.html).toContain('<a href="https://github.com/smrdotgg/ledgermath/blob/main/benchmarks/sort/sort.c">the source</a>');
		expect(sort.html).toContain('<a href="https://github.com/smrdotgg/ledgermath/blob/main/docs/dev-log.md#step-4">the log</a>');
		expect(sort.html).toContain('<a href="https://github.com/smrdotgg/ledgermath/blob/main/docs/dev-log.md">the same log</a>');
		expect(sort.html).toContain('<a href="#notes" target="_self">the first notes</a>');
		expect(sort.html).toContain('<a href="#notes-1" target="_self">the second</a>');
		expect(sort.markdown).toContain("[the source](https://github.com/smrdotgg/ledgermath/blob/main/benchmarks/sort/sort.c)");
		expect(sort.markdown).toContain("[log]: https://github.com/smrdotgg/ledgermath/blob/main/docs/dev-log.md");
		expect(sort.markdown).toContain("[Methods](https://ledgermath.com/docs/methods)");
		expect(pageAt(pages, "/docs/glossary").html).toContain('<a href="/docs/methods#which-runs">Methods</a>');
		// A page with no relative link is served as it is written.
		expect(pageAt(pages, "/docs/glossary").markdown).toBe("# Glossary\n\nThe words.\n\n## Run\n\nOne execution. See [Methods](/docs/methods#which-runs) and [prices](/docs/prices).\n");
	});

	test("a link is rewritten where it is a link, never where code shows one: in a code span, a fenced block, a fenced block in a list, an indented block", () => {
		const code = [
			"# sort",
			"",
			"How fast one thread sorts keys, from [the source](sort.c).",
			"",
			"## What a figure means",
			"",
			"Write `[the source](sort.c)` to link it.",
			"",
			"```markdown",
			"See [the source](sort.c).",
			"```",
			"",
			"- An item:",
			"",
			"  ~~~",
			"  [the source](sort.c)",
			"  ~~~",
			"",
			"      [the source](sort.c) indented",
			"",
			"And [the source](sort.c) once more.",
			"",
		].join("\n");
		const sort = pageAt(buildDocs(repository({ "benchmarks/sort/README.md": code }), GENERATED), "/docs/benchmarks/sort");
		const github = "https://github.com/smrdotgg/ledgermath/blob/main/benchmarks/sort/sort.c";
		expect(sort.markdown).toBe(code.replace("from [the source](sort.c).", `from [the source](${github}).`).replace("And [the source](sort.c)", `And [the source](${github})`));
		expect(sort.html.match(/<a href="https:\/\/github\.com[^"]*sort\.c">the source<\/a>/g)).toHaveLength(2);
		expect(sort.html.match(/\[the source\]\(sort\.c\)/g)).toHaveLength(4);
	});

	test("headings get GitHub's anchors, a repeated one numbered; tables scroll in a box named for them, a first column with no heading its rows' headings", () => {
		const sort = pageAt(buildDocs(repository(), GENERATED), "/docs/benchmarks/sort");
		expect(sort.ids).toEqual(["sort", "what-a-figure-means", "notes", "notes-1"]);
		expect(sort.html).toContain('<h2 id="notes-1">Notes</h2>');
		expect(sort.html).toContain('<div class="table" role="region" tabindex="0" aria-label="Table: Per request">');
		expect(sort.html).toContain('<th scope="row">New</th><td>3 KB</td>');
		expect(sort.html).toContain('aria-label="Table: Key, What it is"');
		expect(sort.html).toContain('aria-label="Table: Key, What it is (2)"');
	});

	test("/docs/ lists every other page by section until the start-here page exists, and follows that page once it does", () => {
		const contents = pageAt(buildDocs(repository(), GENERATED), "/docs/");
		expect(contents.title).toBe("Documentation");
		expect(contents.markdown).toContain("## Benchmarks\n\n- [sort](/docs/benchmarks/sort): How fast one thread sorts keys.");
		expect(contents.markdown).toContain("- [Glossary](/docs/glossary): The words.");
		// A description's links are left as their words there: a relative one would lead nowhere from /docs/.
		const linked = pageAt(buildDocs(repository({ "site/content/docs/prices.md": "# Prices\n\nA day's [prices](../../../benchmarks/sort/sort.c), `cut` by [rules](/docs/methods).\n" }), GENERATED), "/docs/");
		expect(linked.markdown).toContain("- [Prices](/docs/prices): A day's prices, `cut` by rules.");
		const start = pageAt(buildDocs(repository({ "site/content/docs/index.md": "# Start here\n\nWhat LedgerMath is.\n" }), GENERATED), "/docs/");
		expect(start).toMatchObject({ title: "Start here", description: "What LedgerMath is.", section: "start", source: "site/content/docs/index.md" });
		expect(start.markdown).toStartWith(`# Start here\n\nWhat LedgerMath is.\n\n## ${CONTENTS_HEADING}\n\n### API reference\n`);
	});

	test("llms.txt: the site's name, what LedgerMath is, then each section's pages, each its Markdown and its description", () => {
		const pages = buildDocs(repository(), GENERATED);
		const text = llmsTxt(pages);
		expect(text).toStartWith("# LedgerMath\n\n> Open-source benchmarks, run on real cloud machines every day.");
		expect(text).toContain("\n## Benchmarks\n\n- [sort](https://ledgermath.com/docs/benchmarks/sort.md): How fast one thread sorts keys.\n");
		expect(text).toContain("- [Documentation](https://ledgermath.com/docs/index.md): Every page");
		expect(readLlmsTxt(text).map((link) => link.url)).toEqual(pages.map((page) => `https://ledgermath.com${page.markdownAddress}`));
		// No heading but the title and the sections', as the convention has it.
		expect(text.split("\n").filter((line) => line.startsWith("#"))).toEqual(["# LedgerMath", "## Start here", "## API reference", "## Benchmarks", "## Machines, Methods, prices and the glossary"]);
	});
});

describe("buildDocs fails, naming the file and why", () => {
	test("a link to a page the site lacks, to a heading a page lacks, to a file the repository lacks, out of the site, or relative in a generated page", () => {
		const problems = problemsOf(
			repository({
				"site/content/docs/prices.md": "# Prices\n\nA day's prices. [Nothing](/docs/nothing), [no heading](/docs/methods#nowhere), [no file](missing.md), [elsewhere](https://example.com/), [here](#nope).\n",
			}),
		);
		expect(problems).toEqual([
			"site/content/docs/prices.md: a link with no target, /docs/nothing: no page of the site is at /docs/nothing",
			"site/content/docs/prices.md: a link with no target, /docs/methods#nowhere: /docs/methods has no heading #nowhere",
			"site/content/docs/prices.md: a link with no target, missing.md: the repository has no site/content/docs/missing.md",
			"site/content/docs/prices.md: a link with no target, https://example.com/: the site links outside itself only to https://api.ledgermath.com/ and to the repository's files (https://github.com/smrdotgg/ledgermath/blob/main/, https://github.com/smrdotgg/ledgermath/tree/main/)",
			"site/content/docs/prices.md: a link with no target, #nope: this page has no heading #nope",
		]);
	});

	test("Markdown that breaks the contract: front matter, no title, no description, an image, HTML but <details> and <summary>", () => {
		const problems = problemsOf(
			repository({
				"site/content/docs/prices.md": "---\ntitle: x\n---\n# Prices\n",
				"site/content/docs/methods.md": "# Methods\n\n## Straight to a heading\n\n![a chart](chart.png)\n\n<div>no</div>\n\n<details open>\n<summary>Fine</summary>\n\nFolded.\n\n</details>\n",
			}),
		);
		expect(problems).toContain("site/content/docs/prices.md: starts with front matter, which the documentation has none of");
		expect(problems).toContain("site/content/docs/prices.md: its first line is not a title (`# Title`)");
		expect(problems).toContain("site/content/docs/methods.md: the block after the title is not a paragraph, the page's description");
		expect(problems).toContain('site/content/docs/methods.md: has an image ("chart.png"): the documentation has none');
		expect(problems).toContain('site/content/docs/methods.md: holds HTML other than <details> and <summary>: "<div>"');
		expect(problems.filter((problem) => /: "<\/?(details|summary)[^"]*"$/.test(problem))).toEqual([]);
	});

	test("a page the address list knows that is not there, a generated page it does not know, and two pages at one address", () => {
		const generated = new Map(GENERATED);
		generated.delete("docs/api/events.md");
		generated.set("docs/api/extra.md", "# Extra\n\nMore.\n");
		const dir = repository({ "site/content/docs/machines.md": "# Machines\n\nBy hand.\n" });
		let problems: string[] = [];
		try {
			buildDocs(dir, generated);
		} catch (error) {
			problems = [...(error as DocsError).problems];
		}
		expect(problems).toContain("scripts/api-reference.ts wrote docs/api/extra.md, whose address scripts/lib/docs-addresses.ts does not list");
		expect(problems).toContain("/docs/api/events is listed in scripts/lib/docs-addresses.ts, and no page is there");
		expect(problems).toContain("site/content/docs/machines.md and docs/machines.md, written by scripts/api-reference.ts are both at /docs/machines");
	});

	test("a hand-written page at an address the list does not know", () => {
		expect(problemsOf(repository({ "site/content/docs/guides.md": "# Guides\n\nHow to.\n" }))).toEqual(["site/content/docs/guides.md is at /docs/guides, which scripts/lib/docs-addresses.ts does not list: add it there"]);
	});
});
