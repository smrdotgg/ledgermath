// The cases scripts/check-output.ts was written for, each as a tiny built
// site made in a temporary directory. Run with `bun test` inside site/.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkOutput } from "./check-output";

const TEXT = ["LedgerMath", "The site is on its way."];
const BODY = "<main><h1>LedgerMath</h1><p>The site is on its way.</p></main>";
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

const check = (files: Record<string, string>) => checkOutput(site(files), TEXT).problems;

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
			TEXT,
		);
		expect(result).toEqual({ problems: [], checked: 4 });
	});

	test("a data: URL in srcset, src, a style attribute and a <style> block, and a fragment-only href", () => {
		expect(
			check({
				"index.html": page(
					`<style>body{background:url("${PIXEL}")}</style>`,
					`${BODY}<img src="${PIXEL}" srcset="${PIXEL} 1x, ${PIXEL} 2x" alt=""><div style="background-image:url('${PIXEL}')"></div><a href="#top">top</a>`,
				),
			}),
		).toEqual([]);
	});

	test("a link a reader follows to another origin", () => {
		expect(check({ "index.html": page("", `${BODY}<a href="https://github.com/smrdotgg/ledgermath">source</a>`) })).toEqual([]);
	});
});

describe("fails", () => {
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
