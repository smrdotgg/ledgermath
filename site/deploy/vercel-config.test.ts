// deploy/vercel-config.ts: which pages it finds, the routes it writes, and which Accept headers
// they take for a request for Markdown. Run with `bun test` inside site/.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ACCEPTS_MARKDOWN, documentationPages, vercelConfig } from "./vercel-config";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function site(files: readonly string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "vercel-config-"));
	made.push(dir);
	for (const file of ["index.html", ...files]) {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), "x");
	}
	return dir;
}

describe("documentationPages", () => {
	test("finds each page's Markdown: in its directory for an address that ends in a slash, beside it otherwise", () => {
		const found = documentationPages(site(["docs/index.html", "docs/index.md", "docs/api/index.html", "docs/api/index.md", "docs/glossary/index.html", "docs/glossary.md", "assets/app.js", "llms.txt"]));
		expect(found).toEqual({
			pages: [
				{ address: "/docs/api/", markdown: "/docs/api/index.md" },
				{ address: "/docs/glossary", markdown: "/docs/glossary.md" },
				{ address: "/docs/", markdown: "/docs/index.md" },
			],
			missing: [],
		});
	});

	test("names a page without its Markdown, which would answer an agent with 404", () => {
		expect(documentationPages(site(["docs/methods/index.html", "docs/prices.md"])).missing).toEqual(["docs/methods/index.html"]);
	});
});

describe("vercelConfig", () => {
	const config = vercelConfig([
		{ address: "/docs/", markdown: "/docs/index.md" },
		{ address: "/docs/glossary", markdown: "/docs/glossary.md" },
	]);
	const re = (route: Record<string, unknown>) => new RegExp(route.src as string);

	test("serves the Markdown as text/markdown, and varies every page on Accept", () => {
		expect(config.version).toBe(3);
		const [markdown, vary] = config.routes;
		expect(markdown).toMatchObject({ headers: { "Content-Type": "text/markdown; charset=utf-8" }, continue: true });
		expect(re(markdown!).test("/docs/glossary.md")).toBe(true);
		expect(re(markdown!).test("/docs/glossary")).toBe(false);
		expect(vary).toMatchObject({ headers: { Vary: "Accept" }, continue: true });
		for (const path of ["/docs", "/docs/", "/docs/index.html", "/docs/glossary", "/docs/glossary/", "/docs/glossary/index.html"]) expect(re(vary!).test(path)).toBe(true);
		for (const path of ["/", "/docs/glossary.md", "/docs/glossaryx", "/assets/app.js", "/docs/methods"]) expect(re(vary!).test(path)).toBe(false);
	});

	test("gives each page's Markdown at each of its addresses to a request for Markdown, with its type and Vary", () => {
		const routes = config.routes.filter((route) => "dest" in route);
		expect(routes.map((route) => route.dest)).toEqual(["/docs/index.md", "/docs/glossary.md"]);
		for (const route of routes) expect(route).toMatchObject({ has: [{ type: "header", key: "accept", value: { re: ACCEPTS_MARKDOWN } }], headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept" } });
		expect(["/docs", "/docs/", "/docs/index.html"].every((path) => re(routes[0]!).test(path))).toBe(true);
		expect(["/docs/glossary", "/docs/glossary/", "/docs/glossary/index.html"].every((path) => re(routes[1]!).test(path))).toBe(true);
		expect(re(routes[0]!).test("/docs/glossary")).toBe(false);
	});

	test("writes no route for a site without documentation", () => {
		expect(vercelConfig([])).toEqual({ version: 3, routes: [] });
	});
});

describe("ACCEPTS_MARKDOWN: text/markdown at full weight, as a media range of its own", () => {
	const accepts = new RegExp(ACCEPTS_MARKDOWN);
	test("an agent's request for Markdown: alone, first or later, with any parameters but a lower weight, in any case", () => {
		for (const accept of [
			"text/markdown",
			"text/markdown;q=1",
			"text/markdown; q=1.0",
			"text/markdown;q=1.000",
			"text/markdown; charset=utf-8",
			"text/markdown;charset=UTF-8;q=1",
			'text/markdown; variant="GFM, CommonMark"',
			"text/markdown; qs=0.5",
			"text/markdown, text/html;q=0.9",
			"text/markdown;q=1.0, text/html;q=0.5",
			"text/markdown, text/html, */*",
			"text/html, text/markdown",
			"text/html;q=0.9, text/markdown; charset=utf-8",
			'application/json; note="a, b", text/markdown',
			"TEXT/MARKDOWN",
			"Text/Markdown; Charset=utf-8",
			" text/markdown ",
			// A ";" with no parameter after it (RFC 9110, section 5.6.6).
			"text/markdown;",
			"text/markdown; charset=utf-8;",
			"text/markdown ;",
			"text/markdown;;q=1",
			"text/markdown; ; charset=utf-8",
			"text/markdown;\t",
			"text/markdown;, text/html;q=0.9",
			"text/html;q=0.9, text/markdown; charset=utf-8; ",
		]) {
			expect([accept, accepts.test(accept)]).toEqual([accept, true]);
		}
	});

	test("not a browser's, nor any type at all, nor Markdown below full weight, nor text/markdown inside a quoted value", () => {
		for (const accept of [
			"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"*/*",
			"text/*",
			"",
			"text/html, text/markdown;q=0.5",
			"text/markdown;q=0.9, text/html;q=0.8",
			"text/markdown; charset=utf-8; q=0.5",
			"text/markdown;q=0",
			"text/markdown;Q=0.99",
			"text/markdownx",
			"text/markdown-x; charset=utf-8",
			"xtext/markdown",
			'application/json; note="text/markdown, plain"',
			'application/json; note="a, text/markdown", text/html',
			'application/json; note="text/markdown"',
			"text/markdown; q=0.5;",
			"text/markdown;; q=0",
			"text/markdown; charset = utf-8",
			"text/markdown; q = 1",
		]) {
			expect([accept, accepts.test(accept)]).toEqual([accept, false]);
		}
	});

	test("answers at once a long header made to send a backtracking engine down many ways", () => {
		// Each fails at its end, where an expression that could match some text in two ways would try
		// every way: an empty value then spaces (the earlier expression's "=\s*" and "\s*" overlapped),
		// empty parameters between spaces, white space around ";", ranges with an unclosed quote.
		for (const accept of [
			`text/markdown${"; a=   ".repeat(400)};q=0`,
			`text/markdown${";  ".repeat(2000)};q=0.5`,
			`text/markdown${" ; a=b ".repeat(1000)}; q=0`,
			`${"text/markdown;q=0, ".repeat(500)}text/markdown;q=0`,
			`${'a="b, '.repeat(1001)}text/markdown`,
			`${"text/markdown ;".repeat(1000)}`,
		]) {
			const started = performance.now();
			const found = accepts.test(accept);
			const took = performance.now() - started;
			expect([accept.slice(0, 40), found, took < 100]).toEqual([accept.slice(0, 40), false, true]);
		}
	});
});
