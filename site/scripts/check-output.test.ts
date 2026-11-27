// The cases scripts/check-output.ts was written for, each as a tiny built
// site made in a temporary directory. Run with `bun test` inside site/.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkOutput } from "./check-output";

const TEXT = ["LedgerMath", "The site is on its way."];
const PAGES = [{ file: "index.html", text: TEXT }];
const BODY = '<main><h1 id="top">LedgerMath</h1><p>The site is on its way.</p></main>';
const PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes FILES (path -> contents) into a new directory and returns it. */
function site(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "check-output-"));
	made.push(dir);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), contents);
	}
	return dir;
}

function page(head: string, body = BODY): string {
	return `<!DOCTYPE html><html lang="en"><head><title>LedgerMath</title>${head}</head><body>${body}</body></html>`;
}

const check = (files: Record<string, string>, pages = PAGES, outside: readonly string[] = []) => checkOutput(site(files), pages, outside).problems;

describe("passes", () => {
	test("a page with its text, its CSS and its script", () => {
		const result = checkOutput(
			site({
				"index.html": page(`<link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script>`),
				"assets/app.css": "body{background:url(./bg.png)}",
				"assets/bg.png": "",
				"assets/app.js": 'import "./chunk.js";',
				"assets/chunk.js": "",
			}),
			PAGES,
		);
		expect(result).toMatchObject({ problems: [], checked: 4 });
	});

	test("links inside the site, to a page, a file and an id, and links under the data API", () => {
		expect(
			check(
				{
					"index.html": page(
						"",
						`${BODY}<a href="/docs/">docs</a><a href="/notices.txt" target="_self">notices</a><a href="/#top" target="_self">top</a><a href="docs/#intro">intro</a><a href="https://api.ledgermath.com/v1/index.json">API</a>`,
					),
					"docs/index.html": page("", `<main><h1 id="intro">Docs</h1><a href="../">home</a><a href="/#top">top</a></main>`),
					"notices.txt": "notices",
				},
				[...PAGES, { file: "docs/index.html", text: ["Docs"] }],
			),
		).toEqual([]);
	});

	test("weighs each page with what it loads, each file once, and gives the weights", () => {
		const result = checkOutput(
			site({
				"index.html": page(`<link rel="stylesheet" href="/a.css"><link rel="preload" href="/f.woff2" as="font">`),
				"a.css": "@font-face{src:url(/f.woff2)}",
				"f.woff2": "x".repeat(1000),
			}),
			PAGES,
		);
		expect(result.problems).toEqual([]);
		expect(result.weights).toHaveLength(1);
		// The font, not compressible as a binary file, counts as it is, once; the HTML and CSS gzipped.
		expect(result.weights[0]!.bytes).toBeGreaterThan(1000);
		expect(result.weights[0]!.bytes).toBeLessThan(1400);
		expect(result.weights[0]!.script).toBe(0);
	});

	test("weighs the JavaScript a page loads, and what that imports, apart", () => {
		const result = checkOutput(
			site({
				"index.html": page(`<script type="module" src="/app.js"></script>`),
				"app.js": `import "./part.js";${"let a=1;".repeat(50)}`,
				"part.js": "export const b = 2;",
			}),
			PAGES,
		);
		expect(result.problems).toEqual([]);
		expect(result.weights[0]!.script).toBeGreaterThan(40);
		expect(result.weights[0]!.script).toBeLessThan(result.weights[0]!.bytes);
	});

	test("links the router leaves to the browser: to a file that is not a page, and to a place on the same page, with target or download", () => {
		expect(
			check(
				{
					"index.html": page(
						"",
						`${BODY}<a href="/notices.txt" target="_self">notices</a><a href="/notices.txt" download>notices</a><a href="/notices.txt" download="">notices</a><a href="/notices.txt" rel="noopener external">notices</a><a href="#top" target="_self">top</a><a href="/#top" target="_self">top</a><a href="/docs/#intro">intro</a>`,
					),
					"docs/index.html": page("", `<main><h1 id="intro">Docs</h1><a href="/docs/#intro" target="_self">intro</a><a href="/#top">top</a></main>`),
					"notices.txt": "notices",
				},
				[...PAGES, { file: "docs/index.html", text: ["Docs"] }],
			),
		).toEqual([]);
	});

	test("a data: URL in srcset, src, a style attribute and a <style> block, and a fragment-only href", () => {
		expect(
			check({
				"index.html": page(
					`<style>body{background:url("${PIXEL}")}</style>`,
					`${BODY}<img src="${PIXEL}" srcset="${PIXEL} 1x, ${PIXEL} 2x" alt=""><div style="background-image:url('${PIXEL}')"></div><a href="#top" target="_self">top</a>`,
				),
			}),
		).toEqual([]);
	});

});

describe("links out of the site", () => {
	const NAMED = "https://github.com/sirupsen/napkin-math";

	test("a link that is exactly one the pages name passes", () => {
		expect(check({ "index.html": page("", `${BODY}<a href="${NAMED}">Napkin Math</a>`) }, PAGES, [NAMED])).toEqual([]);
	});

	test("any other address fails, of the same site too: a page under it, its owner, the same with a slash, a query or another scheme", () => {
		const others = [`${NAMED}/issues`, "https://github.com/sirupsen", `${NAMED}/`, `${NAMED}?tab=readme`, NAMED.replace("https:", "http:"), "https://github.com/smrdotgg/ledgermath"];
		expect(check({ "index.html": page("", BODY + others.map((href) => `<a href="${href}">x</a>`).join("")) }, PAGES, [NAMED])).toEqual(
			others.map((href) => `index.html links outside the site and the data API: ${href}`),
		);
	});

	test("the site's own list names Napkin Math's repository and nothing else", async () => {
		const { NAPKIN_MATH, OUTSIDE_LINKS } = await import("../src/pages.text");
		expect(OUTSIDE_LINKS).toEqual([NAPKIN_MATH]);
		expect(NAPKIN_MATH).toBe(NAMED);
	});

	test("a page may load nothing from an address it may link to", () => {
		expect(check({ "index.html": page(`<script src="${NAMED}"></script>`) }, PAGES, [NAMED])).toEqual([`index.html loads from another origin: ${NAMED}`]);
	});
});

describe("fails", () => {
	test("a link to another origin than the data API's, the source repository's above all", () => {
		expect(
			check({
				"index.html": page(
					"",
					`${BODY}<a href="https://github.com/smrdotgg/ledgermath">source</a><a href="https://ledgermath.com/docs/">docs</a><a href="//cdn.example.com/">cdn</a><a href="mailto:a@example.com">mail</a><a href="https://api.ledgermath.com.example.com/">lookalike</a>`,
				),
			}),
		).toEqual([
			"index.html links outside the site and the data API: https://github.com/smrdotgg/ledgermath",
			"index.html links outside the site and the data API: https://ledgermath.com/docs/",
			"index.html links outside the site and the data API: //cdn.example.com/",
			"index.html links outside the site and the data API: mailto:a@example.com",
			"index.html links outside the site and the data API: https://api.ledgermath.com.example.com/",
		]);
	});

	test("a link to a page or file the site lacks, or to an id its page lacks", () => {
		expect(
			check({
				"index.html": page("", `${BODY}<a href="/docs/">docs</a><a href="/docs/benchmarks/mutex">mutex</a><a href="#numbers">numbers</a><a href="/#numbers">numbers</a>`),
			}),
		).toEqual([
			"index.html links to /docs/, which the site lacks",
			"index.html links to /docs/benchmarks/mutex, which the site lacks",
			"index.html links to #numbers, an id it lacks",
			'index.html links to /#numbers, whose page has no id "numbers"',
		]);
	});

	test("a link inside the site that is not a page change and has no target: to a file that is not a page, to a place on its own page", () => {
		expect(
			check(
				{
					// target="" is no target to the router, which reads the property; so is rel="noopener".
					"index.html": page("", `${BODY}<a href="/notices.txt">notices</a><a href="#top" target="">top</a><a href="/#top" rel="noopener">top</a><a href="/old.html">old</a>`),
					"docs/index.html": page("", `<main><h1 id="intro">Docs</h1><a href="/docs/#intro">intro</a><a href="#intro">intro</a></main>`),
					"notices.txt": "notices",
					"old.html": page(""),
				},
				[...PAGES, { file: "docs/index.html", text: ["Docs"] }],
			)
				.map((problem) => problem.replace(/, without target.*/, ", without target"))
				.sort(),
		).toEqual(
			[
				`${join("docs", "index.html")} links to /docs/#intro, a place on its own page, without target`,
				`${join("docs", "index.html")} links to #intro, a place on its own page, without target`,
				"index.html links to /notices.txt, which is not one of the site's pages (src/pages.text.ts), without target",
				"index.html links to #top, a place on its own page, without target",
				"index.html links to /#top, a place on its own page, without target",
				"index.html links to /old.html, which is not one of the site's pages (src/pages.text.ts), without target",
			].sort(),
		);
	});

	test("a page loading more JavaScript than its budget", async () => {
		const { SCRIPT_BUDGET_BYTES } = await import("./check-output");
		// Random letters gzip to about three quarters of their length: well over the budget.
		const letters = Array.from(crypto.getRandomValues(new Uint8Array(SCRIPT_BUDGET_BYTES * 2)), (n) => String.fromCharCode(97 + (n % 26))).join("");
		expect(check({ "index.html": page(`<script type="module" src="/app.js"></script>`), "app.js": `const s="${letters}";` })).toEqual([
			expect.stringMatching(new RegExp(`^index\\.html loads \\d+ bytes of JavaScript, compressed: over the budget of ${SCRIPT_BUDGET_BYTES}$`)),
		]);
	});

	test("a page of PAGES that is missing, or misses its words", () => {
		expect(check({ "index.html": page("") }, [...PAGES, { file: "docs/index.html", text: ["Docs"] }])).toEqual(["docs/index.html is missing"]);
	});

	test("a page heavier than the budget, with what it loads", () => {
		// Random bytes in a binary file: counted as they are.
		const heavy = Buffer.from(crypto.getRandomValues(new Uint8Array(60_000))).toString("latin1").repeat(6);
		expect(check({ "index.html": page(`<link rel="preload" href="/f.woff2" as="font">`), "f.woff2": heavy })[0]).toMatch(
			/^index\.html weighs \d+ bytes with what it loads, compressed: over the budget of 300000$/,
		);
	});

	test("when the text is only inside a script", () => {
		expect(
			check({ "index.html": page(`<script>document.body.innerHTML="<h1>LedgerMath</h1><p>The site is on its way.</p>"</script>`, "") }),
		).toEqual([
			'index.html does not hold, in its body outside any script: "LedgerMath"',
			'index.html does not hold, in its body outside any script: "The site is on its way."',
		]);
	});

	test("when a CSS file is missing", () => {
		expect(check({ "index.html": page(`<link rel="stylesheet" href="/assets/app.css">`) })).toEqual([
			"index.html refers to /assets/app.css, which the site lacks",
		]);
	});

	test("when an import is missing", () => {
		expect(
			check({
				"index.html": page(`<script type="module" src="/assets/app.js"></script>`),
				"assets/app.js": 'import { a } from "./chunk.js"; import("./lazy.js");',
				"assets/chunk.js": "export const a = 1;",
			}),
		).toEqual([join("assets", "app.js") + " refers to ./lazy.js, which the site lacks"]);
	});

	test("when the page loads from another origin", () => {
		expect(check({ "index.html": page(`<script src="https://cdn.example.com/x.js"></script>`) })).toEqual([
			"index.html loads from another origin: https://cdn.example.com/x.js",
		]);
	});

	test("when there is no index.html", () => {
		expect(check({ "about.html": page("") })).toEqual(["index.html is missing"]);
	});

	test("when a <style> block or a style attribute refers to a missing file", () => {
		expect(
			check({
				"index.html": page(
					"<style>body{background-image:url(/missing.png)}</style>",
					`${BODY}<div style="background-image: url(&quot;/also-missing.png&quot;)"></div>`,
				),
			}),
		).toEqual([
			"index.html refers to /missing.png, which the site lacks",
			'index.html refers to /also-missing.png, which the site lacks',
		]);
	});

	test("when a srcset candidate beside a data: URL is missing", () => {
		expect(check({ "index.html": page("", `${BODY}<img src="${PIXEL}" srcset="${PIXEL} 1x, /big.png 2x" alt="">`) })).toEqual([
			"index.html refers to /big.png, which the site lacks",
		]);
	});
});
