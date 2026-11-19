import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkLinks, pageLoads } from "./check-links";

const TEXT = `<p>${"Enough words to read as a page. ".repeat(10)}</p>`;
const page = (head: string, body = TEXT) => `<!DOCTYPE html><html><head>${head}</head><body><main>${body}</main></body></html>`;

let dirs: string[] = [];
function site(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "check-links-"));
	dirs.push(dir);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

const picker = (...hrefs: string[]) => page("", `${TEXT}${hrefs.map((href) => `<a href="${href}">x</a>`).join("")}`);

describe("checkLinks", () => {
	test("a page with absolute addresses that all exist passes, from either address", () => {
		const dir = site({
			"index.html": picker("/v1/", "https://example.com/elsewhere"),
			"v1/index.html": page(`<link rel="stylesheet" href="/v1/assets/a.css"><script type="module" src="/v1/assets/c.js"></script>`),
			"v1/assets/a.css": `@font-face { src: url("/v1/assets/f.woff2") } .x { background: url(./i.png) }`,
			"v1/assets/f.woff2": "",
			"v1/assets/i.png": "",
			"v1/assets/c.js": `import "./d.js";`,
			"v1/assets/d.js": "",
		});
		const report = checkLinks(dir);
		expect(report.problems).toEqual([]);
		expect(report.pages.map((p) => p.address)).toEqual(["/", "/v1/"]);
	});

	test("a link to a page that is not there fails", () => {
		const dir = site({ "index.html": picker("/forms/v1/lean/") });
		expect(checkLinks(dir).problems).toEqual(["the picker links to /forms/v1/lean/, but /forms/v1/lean/index.html is missing"]);
	});

	test("an empty page fails", () => {
		const dir = site({ "index.html": picker("/v1/"), "v1/index.html": page("", "<p>Hi</p>") });
		expect(checkLinks(dir).problems).toEqual(["/v1/ is empty: under 200 characters of text in its body outside its scripts"]);
	});

	test("a missing stylesheet, a missing font inside a stylesheet and a missing image fail", () => {
		const dir = site({
			"index.html": picker("/v1/"),
			"v1/index.html": page(`<link rel="stylesheet" href="/v1/a.css"><link rel="stylesheet" href="/v1/gone.css">`, `${TEXT}<img src="/v1/gone.png" alt="">`),
			"v1/a.css": `@font-face { src: url(fonts/gone.woff2) }`,
		});
		expect(checkLinks(dir).problems).toEqual([
			`/v1/: font "fonts/gone.woff2" (from /v1/a.css) -> /v1/fonts/gone.woff2: which the site lacks`,
			`/v1/: stylesheet "/v1/gone.css" -> /v1/gone.css: which the site lacks`,
			`/v1/: image "/v1/gone.png" -> /v1/gone.png: which the site lacks`,
		]);
	});

	test("a relative address breaks when the page is served without its slash, unless the host redirects", () => {
		const files = { "index.html": picker("/checkpoints/v2/cp-7/"), "checkpoints/v2/cp-7/index.html": page(`<link rel="stylesheet" href="assets/a.css">`), "checkpoints/v2/cp-7/assets/a.css": "" };
		const dir = site(files);
		expect(checkLinks(dir).problems).toEqual([`/checkpoints/v2/cp-7: stylesheet "assets/a.css" -> /checkpoints/v2/assets/a.css: which the site lacks`]);
		expect(checkLinks(dir, { hostRedirects: true }).problems).toEqual([]);
	});

	test("a frozen copy that points at the live design's assets is caught only if those are missing", () => {
		const dir = site({ "index.html": picker("/checkpoints/v1/cp-7/"), "checkpoints/v1/cp-7/index.html": page(`<link rel="stylesheet" href="/v1/assets/a.css">`) });
		expect(checkLinks(dir).problems).toEqual([`/checkpoints/v1/cp-7/: stylesheet "/v1/assets/a.css" -> /v1/assets/a.css: which the site lacks`]);
	});

	test("<base href> is honoured", () => {
		const dir = site({ "index.html": picker("/v1/"), "v1/index.html": page(`<base href="/v1/"><link rel="stylesheet" href="a.css">`), "v1/a.css": "" });
		expect(checkLinks(dir).problems).toEqual([]);
	});

	test("a link to a directory without its slash is a page", () => {
		const dir = site({ "index.html": picker("/v1"), "v1/index.html": page("") });
		expect(checkLinks(dir).pages.map((p) => p.address)).toEqual(["/", "/v1/"]);
	});
});

describe("pageLoads", () => {
	test("reads what a page loads, not links a reader follows", () => {
		const { base, loads } = pageLoads(
			`<base href="/x/"><link rel="canonical" href="https://a.example/"><link rel="preload" as="font" href="f.woff2" crossorigin><link rel="icon" href="i.svg">` +
				`<a href="/elsewhere/">a</a><img src="p.png" srcset="p1.png 1x, p2.png 2x"><svg><use href="#local"/><image href="s.png"/></svg><div style="background:url('b.jpg')"></div>` +
				`<!-- <link rel="stylesheet" href="commented.css"> --><script>import("./lazy.js")</script>`,
		);
		expect(base).toBe("/x/");
		expect(loads.map((l) => `${l.kind} ${l.url}`).sort()).toEqual(["font f.woff2", "image b.jpg", "image i.svg", "image p.png", "image p1.png", "image p2.png", "image s.png", "script ./lazy.js"].sort());
	});
});
