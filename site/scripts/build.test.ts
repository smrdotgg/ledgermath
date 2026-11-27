// scripts/build.ts's guard on its output: what it refuses to replace, and how it replaces what
// it may. Run with `bun test` inside site/.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILD_AREA, BUILD_MARK, buildSite, option, outputProblem, REPOSITORY, SITE } from "./build";

const FIXTURE = join(SITE, "fixtures", "tree");
const work = mkdtempSync(join(tmpdir(), "site-build-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A copy of the fixture tree outside the repository. */
const outsideTree = join(work, "trees", "tree");
mkdirSync(dirname(outsideTree), { recursive: true });
cpSync(FIXTURE, outsideTree, { recursive: true });

/** The build's own directories left in DIR, and its two bundles and the documentation's modules left in site/dist/: none, after any build. */
const leftovers = (dir: string) => [
	...readdirSync(dir).filter((name) => name.includes(".building-")),
	...(existsSync(BUILD_AREA) ? readdirSync(BUILD_AREA).filter((name) => name.startsWith(".server-") || name.startsWith(".client-") || name.startsWith(".docs-")) : []),
];

describe("outputProblem refuses", () => {
	test("an empty output", () => {
		expect(outputProblem("", FIXTURE)).toContain("the output directory is empty");
		expect(outputProblem("  ", FIXTURE)).toContain("the output directory is empty");
	});

	test("the repository, or a directory that holds it", () => {
		expect(outputProblem(REPOSITORY, FIXTURE)).toContain("is or holds the repository");
		expect(outputProblem(dirname(REPOSITORY), FIXTURE)).toContain("is or holds the repository");
		expect(outputProblem("/", FIXTURE)).toContain("is or holds the repository");
	});

	test("anywhere in the repository but under site/dist/: the sources, the site, the scripts, the fixture tree", () => {
		for (const path of [SITE, join(SITE, "src"), join(SITE, "src", "home"), join(SITE, "scripts"), join(SITE, "public"), join(REPOSITORY, "docs"), join(SITE, "nothing-yet")]) {
			expect(outputProblem(path, outsideTree)).toContain("is inside the repository but not under site/dist/");
		}
		expect(outputProblem(FIXTURE, FIXTURE)).toContain("is inside the repository but not under site/dist/");
	});

	test("the tree it reads, a directory inside it, or one that holds it", () => {
		expect(outputProblem(outsideTree, outsideTree)).toContain("is, holds or is inside the tree");
		expect(outputProblem(join(outsideTree, "v1"), outsideTree)).toContain("is, holds or is inside the tree");
		expect(outputProblem(join(outsideTree, "site"), outsideTree)).toContain("is, holds or is inside the tree");
		expect(outputProblem(dirname(outsideTree), outsideTree)).toContain("is, holds or is inside the tree");
	});

	test("a directory that holds files and no build mark, or a file", () => {
		const dir = join(work, "someone-elses");
		mkdirSync(dir);
		writeFileSync(join(dir, "notes.txt"), "keep me");
		expect(outputProblem(dir, FIXTURE)).toContain(`was not written by this build (it has no ${BUILD_MARK})`);
		writeFileSync(join(work, "a-file"), "");
		expect(outputProblem(join(work, "a-file"), FIXTURE)).toContain("exists and is not a directory");
	});
});

describe("outputProblem allows", () => {
	test("site/dist/ and anything under it, a new directory, an empty one, one a build wrote", () => {
		expect(outputProblem(join(BUILD_AREA, "client-test-new"), FIXTURE)).toBeNull();
		expect(outputProblem(join(work, "new"), FIXTURE)).toBeNull();
		mkdirSync(join(work, "empty"));
		expect(outputProblem(join(work, "empty"), FIXTURE)).toBeNull();
		mkdirSync(join(work, "marked"));
		writeFileSync(join(work, "marked", BUILD_MARK), "");
		writeFileSync(join(work, "marked", "index.html"), "old");
		expect(outputProblem(join(work, "marked"), FIXTURE)).toBeNull();
	});
});

describe("the command line", () => {
	test("--out without a directory is refused, not taken for the default", () => {
		expect(option(["--out="], "out")).toBe("");
		expect(option(["--out"], "out")).toBe("");
		expect(option(["--out", "--tree", "x"], "out")).toBe("");
		expect(option(["--tree", "x"], "out")).toBeUndefined();
		for (const args of [["--out="], ["--out"]]) {
			const run = Bun.spawnSync(["bun", "scripts/build.ts", "--tree", FIXTURE, ...args], { cwd: SITE, stderr: "pipe", env: { ...process.env, LEDGERMATH_TREE: "" } });
			expect(run.exitCode).toBe(2);
			expect(run.stderr.toString()).toContain("--out was given without a directory");
		}
	});

	test("a refused output fails the build before it writes anything", () => {
		const run = Bun.spawnSync(["bun", "scripts/build.ts", "--tree", FIXTURE, "--out", join(SITE, "src")], { cwd: SITE, stderr: "pipe", env: { ...process.env, LEDGERMATH_TREE: "" } });
		expect(run.exitCode).toBe(1);
		expect(run.stderr.toString()).toContain("is inside the repository but not under site/dist/");
		expect(leftovers(SITE)).toEqual([]);
		expect(existsSync(join(SITE, "src", "Document.tsx"))).toBe(true);
	});
});

describe("buildSite", () => {
	test("leaves a directory that is not its own as it was", async () => {
		const dir = join(work, "keep");
		mkdirSync(dir);
		writeFileSync(join(dir, "notes.txt"), "keep me");
		await expect(buildSite({ tree: FIXTURE, out: dir, quiet: true })).rejects.toThrow("was not written by this build");
		expect(readdirSync(dir)).toEqual(["notes.txt"]);
		expect(leftovers(work)).toEqual([]);
	});

	test("writes into an empty directory, marks it, and leaves no directory of its own behind", async () => {
		const dir = join(work, "fresh");
		mkdirSync(dir);
		const result = await buildSite({ tree: FIXTURE, out: dir, quiet: true });
		expect(result.files).toContain("index.html");
		expect(result.files).toContain(BUILD_MARK);
		expect(readFileSync(join(dir, BUILD_MARK), "utf8")).toContain("written by the LedgerMath site's build");
		expect(leftovers(work)).toEqual([]);
	}, 60_000);

	test("replaces a directory it wrote, whole", async () => {
		const dir = join(work, "again");
		await buildSite({ tree: FIXTURE, out: dir, quiet: true });
		writeFileSync(join(dir, "stale.txt"), "from before");
		await buildSite({ tree: FIXTURE, out: dir, quiet: true });
		expect(existsSync(join(dir, "stale.txt"))).toBe(false);
		expect(existsSync(join(dir, "docs", "index.html"))).toBe(true);
		expect(leftovers(work)).toEqual([]);
	}, 60_000);

	test("writes the application, the runtime it shares with the documentation's chunks, and a chunk per documentation page; every page loads the application as a module from its <head>", () => {
		const dir = join(work, "fresh");
		const scripts = readdirSync(join(dir, "assets")).filter((name) => /\.m?js$/.test(name));
		const app = scripts.filter((name) => /^app-[\w-]+\.js$/.test(name));
		const chunks = scripts.filter((name) => name.startsWith("docs"));
		const pages = readFileSync(join(dir, "llms.txt"), "utf8").match(/^- \[/gm) ?? [];
		expect(app).toHaveLength(1);
		expect(chunks).toHaveLength(pages.length);
		expect(scripts.length - app.length - chunks.length).toBeLessThanOrEqual(1);
		for (const page of ["index.html", join("docs", "index.html"), join("docs", "glossary", "index.html")]) {
			const html = readFileSync(join(dir, page), "utf8");
			const head = html.slice(0, html.indexOf("</head>"));
			expect(head).toContain(`<script type="module" src="/assets/${app[0]}"></script>`);
			// No other script file is loaded: the inline ones (the flags and the font, Solid's hydration bootstrap) have no src.
			expect(html.match(/<script[^>]*\ssrc=/g)).toHaveLength(1);
		}
		// A documentation page asks for its own chunk ahead (hydration imports it), and no other.
		const glossary = readFileSync(join(dir, "docs", "glossary", "index.html"), "utf8");
		const preloaded = [...glossary.matchAll(/<link rel="modulepreload" href="\/assets\/(docs[^"]*)"/g)].map((match) => match[1]);
		expect(preloaded).toHaveLength(1);
		expect(preloaded[0]).toStartWith("docs-glossary-");
	});

	test("writes each documentation page's Markdown beside it, llms.txt, and the comment for agents at the top of every page", () => {
		const dir = join(work, "fresh");
		expect(readFileSync(join(dir, "docs", "glossary.md"), "utf8")).toBe(readFileSync(join(SITE, "content", "docs", "glossary.md"), "utf8"));
		expect(readFileSync(join(dir, "docs", "index.md"), "utf8")).toStartWith("# ");
		expect(readFileSync(join(dir, "docs", "api", "index.md"), "utf8")).toStartWith("# The data API\n");
		expect(existsSync(join(dir, "docs", "benchmarks", "memory_read.md"))).toBe(true);
		const llms = readFileSync(join(dir, "llms.txt"), "utf8");
		expect(llms).toStartWith("# LedgerMath\n\n> ");
		expect(llms).toContain("(https://ledgermath.com/docs/glossary.md)");
		for (const page of ["index.html", join("docs", "methods", "index.html")]) {
			expect(readFileSync(join(dir, page), "utf8")).toStartWith("<!DOCTYPE html><!-- For agents: https://ledgermath.com/llms.txt ");
		}
		const methods = readFileSync(join(dir, "docs", "methods", "index.html"), "utf8");
		expect(methods).toContain('<link rel="alternate" type="text/markdown" href="/docs/methods.md"');
	});

	test("ships nothing of the Markdown parser, which runs at build time only", () => {
		const dir = join(work, "fresh", "assets");
		for (const script of readdirSync(dir).filter((name) => name.endsWith(".js"))) {
			expect({ script, parser: readFileSync(join(dir, script), "utf8").includes("github.com/markedjs/marked") }).toEqual({ script, parser: false });
		}
	});

	test("points each benchmark's name on the home page at its page", () => {
		const home = readFileSync(join(work, "fresh", "index.html"), "utf8");
		expect(home).toContain('href="/docs/benchmarks/memory_read"');
		expect(home).toContain('href="/docs/benchmarks/http_get"');
	});

	test("the application holds the figures the pages were rendered from, and nothing of the tree beyond them", () => {
		const dir = join(work, "fresh");
		const script = readdirSync(join(dir, "assets")).find((name) => name.startsWith("app-"))!;
		const code = readFileSync(join(dir, "assets", script), "utf8");
		const home = readFileSync(join(dir, "index.html"), "utf8");
		// A Series file the home page links to is in the application too (pageData's seriesUrl) …
		const linked = /href="(https:\/\/api\.ledgermath\.com\/v1\/series\/[^"]+\.json)"/.exec(home)![1]!;
		expect(code).toContain(linked);
		// … and a Series the tree holds that no page shows is not (siteData's Series list stays at build time).
		const tree = JSON.parse(readFileSync(join(FIXTURE, "v1", "series.json"), "utf8")) as { series: { url: string }[] };
		const unshown = tree.series.map((row) => row.url).find((url) => !home.includes(url));
		if (unshown) expect(code).not.toContain(unshown);
	});

	test("the mark names nothing private: no path, no repository", () => {
		const mark = readFileSync(join(work, "fresh", BUILD_MARK), "utf8");
		expect(mark).not.toContain("/");
		expect(mark.toLowerCase()).not.toContain("github");
	});
});
