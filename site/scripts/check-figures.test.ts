// The site built for real from the fixture tree and from changed copies of it, and the
// figures on each held to its tree by scripts/check-figures.ts; then pages changed by hand,
// each of which the check must refuse. Run with `bun test` inside site/.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readTree, type Tree } from "../src/data/tree";
import { NO_TREE } from "./build";
import { checkFigures } from "./check-figures";
import { checkOutput } from "./check-output";

const SITE = join(import.meta.dir, "..");
const FIXTURE = join(SITE, "fixtures", "tree");
const HASH_ON_M5 = "https://api.ledgermath.com/v1/series/"; // completed below, from the fixture

const work = mkdtempSync(join(tmpdir(), "site-figures-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A copy of the fixture tree in a new directory, each file as CHANGE leaves its JSON. */
function treeCopy(name: string, change: (path: string, json: Record<string, any>) => void = () => {}): string {
	const dir = join(work, `tree-${name}`);
	for (const path of ["v1/index.json", "v1/series.json", "v1/prices/2026-11-19.json"]) {
		const json = JSON.parse(readFileSync(join(FIXTURE, path), "utf8")) as Record<string, any>;
		change(path, json);
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), JSON.stringify(json, null, 1));
	}
	return dir;
}

/**
 * A built site. `raw` is the home page as the build wrote it; `html` is the same with what Solid
 * adds for hydration taken out (its <!--…--> markers and _hk keys), the HTML the changes by hand
 * below are written against. The check reads both the same (a test below holds that).
 */
type Built = { out: string; status: number; stdout: string; stderr: string; raw: string; html: string; tree: Tree };

/** HTML without Solid's hydration markers and keys, which say nothing a reader sees. */
const withoutHydration = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/ _hk=\w+/g, "");

function build(tree: string, name: string, env: Record<string, string> = {}): Built {
	const out = join(work, `site-${name}`);
	const run = Bun.spawnSync(["bun", "scripts/build.ts", "--tree", tree, "--out", out], {
		cwd: SITE,
		env: { ...process.env, LEDGERMATH_TREE: "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = run.stdout.toString();
	const stderr = run.stderr.toString();
	let raw = "";
	try {
		raw = readFileSync(join(out, "index.html"), "utf8");
	} catch {}
	return { out, status: run.exitCode ?? -1, stdout, stderr, raw, html: withoutHydration(raw), tree: readTree(tree) };
}

let fixture: Built;
let lacking: Built;
let failing: Built;
let nulls: Built;
let hashOnM5 = HASH_ON_M5;

/** The headline Series of hash (SHA-256, 64 bytes) and of sort on a machine type. */
const hashOn = (tree: Tree, type: string) => tree.seriesList.series.find((r) => r.benchmark === "hash" && r.instance_type === type && r.params.algorithm === "sha256" && r.params.size_bytes === 64 && r.build === "static")!;
const sortOn = (tree: Tree, type: string) => tree.seriesList.series.find((r) => r.benchmark === "sort" && r.instance_type === type && r.build === "static")!;

beforeAll(() => {
	const tree = readTree(FIXTURE);
	const row = hashOn(tree, "m5.large");
	hashOnM5 = row.url;
	const p95Gone = hashOn(tree, "c8i.2xlarge");
	const untyped = sortOn(tree, "i4i.2xlarge");
	const unused = tree.seriesList.series.find((r) => r.benchmark === "memory_read" && r.build === "dynamic")!;
	// Every null the Series list's schema allows, in Series the page uses and in one it does not.
	nulls = build(
		treeCopy("nulls", (path, json) => {
			if (path !== "v1/series.json") return;
			const find = (id: string) => json.series.find((r: { id: string }) => r.id === id);
			find(row.id).derivations.series_v1.percentiles.time_per_repetition_ns.p50 = null;
			find(p95Gone.id).derivations.series_v1.percentiles.time_per_repetition_ns.p95 = null;
			find(untyped.id).instance_type = null;
			find(unused.id).derivations.series_v1.percentiles.bytes_per_second.p50 = null;
		}),
		"nulls",
	);
	fixture = build(FIXTURE, "fixture");
	lacking = build(
		treeCopy("lacking", (path, json) => {
			if (path === "v1/index.json") {
				delete json.recent_rounds;
				json.series.count -= 1;
			}
			if (path === "v1/series.json") {
				json.series = json.series.filter((r: { id: string }) => r.id !== row.id);
				json.count -= 1;
			}
		}),
		"lacking",
	);
	failing = build(
		treeCopy("failing", (path, json) => {
			if (path === "v1/index.json") json.recent_rounds.rounds[0].failed_runs = 3;
		}),
		"failing",
	);
}, 180_000);

describe("the build", () => {
	test("from the fixture tree: the home page and the documentation, and nothing to say", () => {
		expect(fixture.status).toBe(0);
		expect(fixture.stdout).not.toContain("note:");
		// /docs/ lists every page: after the start-here page, under "All pages", or, without it, alone.
		expect(readFileSync(join(fixture.out, "docs", "index.html"), "utf8")).toMatch(/>All pages<\/h2>|Every page of LedgerMath's documentation, by section\./);
	});

	test("with no tree given, fails and says so, never building from old numbers", () => {
		const run = Bun.spawnSync(["bun", "scripts/build.ts", "--out", join(work, "site-none")], { cwd: SITE, env: { ...process.env, LEDGERMATH_TREE: "" }, stderr: "pipe" });
		expect(run.exitCode).toBe(2);
		expect(run.stderr.toString()).toContain(NO_TREE);
	});

	test("from a directory that is not a tree, fails, saying why", () => {
		const run = Bun.spawnSync(["bun", "scripts/build.ts", "--out", join(work, "site-nothing")], { cwd: SITE, env: { ...process.env, LEDGERMATH_TREE: join(work, "nothing") }, stderr: "pipe" });
		expect(run.exitCode).toBe(1);
		expect(run.stderr.toString()).toContain("is not a directory");
	});

	test("from a tree without recent_rounds and without one headline Series: builds, says so in one line each, and invents nothing", () => {
		expect(lacking.status).toBe(0);
		expect(lacking.stdout).toContain('note: v1/index.json has no recent_rounds: the page is built without "Latest runs"');
		expect(lacking.stdout).toContain("note: no Series for hash on m5.large: its cell shows no figure");
		expect(lacking.html).not.toContain("Latest runs");
		expect(lacking.html).not.toContain('class="latest"');
		expect(lacking.html).not.toContain(hashOnM5);
		// Solid's renderer writes the dash as a character reference.
		expect(lacking.html.match(/<span title="No figure: the data have no Series for this on m5\.large\.">&#8212;<\/span>/g)).toHaveLength(2);
	});

	test("from a tree with every null the Series list's schema allows: builds, says what it leaves out, and puts the reasons in the titles", () => {
		expect(nulls.status).toBe(0);
		const p95Gone = hashOn(nulls.tree, "c8i.2xlarge");
		expect(nulls.stdout).toContain("has no time median (the data give this Series' median as null: infinite or undefined): its cell shows none");
		expect(nulls.stdout).toContain(`note: Series ${p95Gone.id} (hash on c8i.2xlarge) has a percentile given as null: its title says so`);
		expect(nulls.stdout).toContain("Series name no instance type");
		expect(nulls.stdout).toContain("note: no Series for sort on i4i.2xlarge: its cell shows no figure");
		// Solid's renderer writes the apostrophe as a character reference.
		expect(nulls.html.match(/<span title="No figure: the data give this Series(&#39;|') median as null: infinite or undefined\.">&#8212;<\/span>/g)).toHaveLength(2);
		expect(nulls.html).toMatch(new RegExp(`href="${p95Gone.url.replaceAll(".", "\\.")}" title="Median [^"]+\\. 5th percentile [\\d.]+, 95th infinite or undefined\\. \\d+ Runs\\."`));
	});

	test("a round with failed Runs says how many; the others say 0 because the tree does", () => {
		expect(failing.status).toBe(0);
		expect(failing.html).toContain("5 machines · 187 Runs · 3 failed");
		expect(failing.html.match(/187 Runs · 0 failed/g)).toHaveLength(2);
	});
});

describe("checkFigures passes", () => {
	test("the page built from the fixture tree: every figure, price and round", () => {
		expect(checkFigures(fixture.html, fixture.tree)).toEqual({ problems: [], figures: 85, prices: 20, rounds: 3, dashes: 0 });
	});

	test("the page built from a tree that lacks things, with a dash where the Series is missing", () => {
		expect(checkFigures(lacking.html, lacking.tree)).toEqual({ problems: [], figures: 83, prices: 20, rounds: 0, dashes: 2 });
	});

	test("the page with a round's failed Runs", () => {
		expect(checkFigures(failing.html, failing.tree).problems).toEqual([]);
	});

	test("the page built from a tree with nulls: two dashes for the null median, one for the Series with no machine type", () => {
		expect(checkFigures(nulls.html, nulls.tree)).toEqual({ problems: [], figures: 82, prices: 20, rounds: 3, dashes: 3 });
	});

	test("each page as the build wrote it, hydration markers and keys in, reads as without them", () => {
		for (const built of [fixture, lacking, failing, nulls]) {
			expect(built.raw).toContain(" _hk=");
			expect(checkFigures(built.raw, built.tree)).toEqual(checkFigures(built.html, built.tree));
		}
	});

	test("and the output check passes each built site: words, links, budget", () => {
		for (const built of [fixture, lacking, failing, nulls]) expect(checkOutput(built.out).problems).toEqual([]);
	});
});

describe("checkFigures refuses", () => {
	const problems = (html: string, tree = fixture.tree) => checkFigures(html, tree).problems;

	test("a figure shown with a digit changed", () => {
		const html = fixture.html.replace(/(<a class="figure" href="[^"]+" title="[^"]+">)([\d.]+)</, (_, open: string, figure: string) => `${open}${figure.replace(/\d$/, (d) => String((Number(d) + 1) % 10))}<`);
		expect(html).not.toBe(fixture.html);
		expect(problems(html)).toEqual([expect.stringMatching(/figure shows ".*"; its median .* to four significant digits is/)]);
	});

	test("a percentile in a title with a digit changed", () => {
		const html = fixture.html.replace(/(title="Median [^"]*?5th percentile \d+\.\d)(\d)/, (_, head: string, d: string) => `${head}${(Number(d) + 1) % 10}`);
		expect(html).not.toBe(fixture.html);
		expect(problems(html)).toEqual([expect.stringMatching(/the 5th percentile of Series \w+ is shown as .*; the tree holds/)]);
	});

	test("a count of Runs changed", () => {
		const html = fixture.html.replace(/\. (\d+) Runs\."/, (_, n: string) => `. ${Number(n) + 1} Runs."`);
		expect(problems(html)).toEqual([expect.stringMatching(/figure says \d+ Runs; the tree counts \d+/)]);
	});

	test("a price changed", () => {
		const html = fixture.html.replace('<span class="price">$0.096/h</span>', '<span class="price">$0.095/h</span>');
		expect(html).not.toBe(fixture.html);
		expect(problems(html)[0]).toBe('index.html: m5.large\'s price is shown as "$0.095/h"; the price file gives $0.096/h');
	});

	test("a figure moved under another machine type", () => {
		const other = fixture.tree.seriesList.series.find((r) => r.benchmark === "hash" && r.instance_type === "c8i.2xlarge" && r.params.algorithm === "sha256" && r.params.size_bytes === 64 && r.build === "static")!;
		const html = fixture.html.replace(`href="${hashOnM5}"`, `href="${other.url}"`);
		expect(problems(html).some((p) => p.includes(`is of Series ${other.id}, which ran on c8i.2xlarge`))).toBe(true);
	});

	test("a link to a Series the tree does not hold", () => {
		expect(problems(fixture.html, lacking.tree).some((p) => p.includes("a Series the tree does not hold"))).toBe(true);
	});

	test("a dash where the tree has a figure", () => {
		const html = fixture.html.replace(/<a href="https:\/\/api\.ledgermath\.com\/v1\/series\/\w+\.json" title="[^"]+">[^<]+<\/a>/, "<span>—</span>");
		expect(problems(html).some((p) => /a dash in the table's row ".*", column "m5\.large", where the tree has a figure/.test(p))).toBe(true);
	});

	test("a figure the check does not know, in the text or in a title", () => {
		expect(problems(fixture.html.replace("</main>", "<p>Up to 42% faster.</p></main>"))).toEqual(['index.html: a figure this check does not know, in <p>: "Up to 42% faster."']);
		expect(problems(fixture.html.replace('<h2 id="numbers">', '<h2 id="numbers" title="Since 2026">'))).toEqual([
			'index.html: a title this check does not know holds a digit, on <h2>: "Since 2026"',
		]);
	});

	test("a round's counts or start changed, a round more, or \"Latest runs\" missing while the tree gives rounds", () => {
		expect(problems(fixture.html.replace("187 Runs · 0 failed", "187 Runs · 1 failed"))).toEqual([
			'index.html: "Latest runs" item 1 says "5 machines · 187 Runs · 1 failed"; the tree gives "5 machines · 187 Runs · 0 failed"',
		]);
		expect(problems(fixture.html.replace(">19 Nov 2026, 16:11 UTC<", ">19 Nov 2026, 16:12 UTC<"))[0]).toContain('"Latest runs" item 1 says "19 Nov 2026, 16:12 UTC"');
		expect(problems(fixture.html.replace(/<section class="latest"[\s\S]*?<\/section>/, ""))).toEqual(['index.html: the tree gives recent_rounds, but the page has no "Latest runs"']);
		expect(problems(fixture.html, lacking.tree).some((p) => p.includes('"Latest runs" is on the page, but the tree gives no recent_rounds'))).toBe(true);
	});

	test("a blank cell, where the headline selection has a figure (the verifier's case)", () => {
		const html = fixture.html.replace(/(<td>)<a href="https:[^"]+" title="Median [^"]+">[^<]+<\/a>(<\/td>)/, "$1$2");
		expect(html).not.toBe(fixture.html);
		expect(problems(html)).toEqual(['index.html: the table\'s row "Read memory sequentially", column "m5.large" holds 0 figures and 0 dashes, not exactly one figure or one dash']);
	});

	test("a blank line in a graph, a cell with two figures, a row missing, a column missing", () => {
		const line = fixture.html.replace(/(<\/span><\/span>)<a class="figure" href="[^"]+" title="[^"]+">[^<]+<\/a><svg class="bar"[\s\S]*?<\/svg>/, "$1");
		expect(line).not.toBe(fixture.html);
		expect(problems(line)).toEqual(['index.html: the graph "Read memory sequentially", machine "m5.large" holds 0 figures and 0 dashes, not exactly one figure or one dash']);
		const two = fixture.html.replace(/(<td>)(<a href="https:[^"]+" title="Median [^"]+">[^<]+<\/a>)(<\/td>)/, "$1$2$2$3");
		expect(problems(two)).toEqual(['index.html: the table\'s row "Read memory sequentially", column "m5.large" holds 2 figures and 0 dashes, not exactly one figure or one dash']);
		const row = fixture.html.replace(/<tr><th scope="row" title="[^"]*"><span class="head"><a href="\/docs\/benchmarks\/http_get">GET 4 KiB from S3<\/a>[\s\S]*?<\/tr>/, "");
		expect(row).not.toBe(fixture.html);
		expect(problems(row)).toEqual(['index.html: the table has no row for "GET 4 KiB from S3"']);
		const column = fixture.html.replace(/<th scope="col" title="[^"]*">c6i\.8xlarge<span class="price">[^<]*<\/span><\/th>/, "");
		expect(problems(column)).toContain('index.html: the table\'s columns are ["m5.large","c8i.2xlarge","c8a.2xlarge","i4i.2xlarge"]; the machine types are ["m5.large","c8i.2xlarge","c8a.2xlarge","i4i.2xlarge","c6i.8xlarge"]');
	});

	test("a graph missing whole, one more, or two swapped: every figure left on the page is right, but the graphs are not the page's three", () => {
		const graph = (label: string) => new RegExp(`<section class="graph"><h2>${label}</h2>[\\s\\S]*?</section>`);
		const meant = '["Read memory sequentially","Hash 64 bytes with SHA-256","Make a system call"]';
		const hash = fixture.html.match(graph("Hash 64 bytes with SHA-256"))?.[0] ?? "";
		const memory = fixture.html.match(graph("Read memory sequentially"))?.[0] ?? "";
		expect(hash).not.toBe("");
		expect(memory).not.toBe("");

		const missing = fixture.html.replace(hash, "");
		expect(problems(missing)).toEqual([`index.html: the page's graphs are ["Read memory sequentially","Make a system call"]; it is meant to have ${meant}, in that order`]);
		const none = fixture.html.replace(/<div class="graphs">[\s\S]*?<\/div>(?=\s*<section class="numbers")/, '<div class="graphs"></div>');
		expect(none).not.toBe(fixture.html);
		expect(problems(none)).toEqual([`index.html: the page's graphs are []; it is meant to have ${meant}, in that order`]);
		const swapped = fixture.html.replace(memory, "\u0000").replace(hash, memory).replace("\u0000", hash);
		expect(problems(swapped)).toEqual([`index.html: the page's graphs are ["Hash 64 bytes with SHA-256","Read memory sequentially","Make a system call"]; it is meant to have ${meant}, in that order`]);
		const more = fixture.html.replace(hash, `${hash}${hash}`);
		expect(problems(more)).toEqual([
			`index.html: the page's graphs are ["Read memory sequentially","Hash 64 bytes with SHA-256","Hash 64 bytes with SHA-256","Make a system call"]; it is meant to have ${meant}, in that order`,
		]);
	});

	test("a dash whose title does not give the tree's reason", () => {
		const html = lacking.html.replace("No figure: the data have no Series for this on m5.large.", "No figure: not measured.");
		expect(checkFigures(html, lacking.tree).problems.some((p) => p.includes('says "No figure: not measured."; why the tree gives no figure there is "the data have no Series for this on m5.large"'))).toBe(true);
	});

	test("a null percentile shown as a number, or a number said to be null", () => {
		const shown = nulls.html.replace("95th infinite or undefined.", "95th 76.7.");
		expect(shown).not.toBe(nulls.html);
		expect(checkFigures(shown, nulls.tree).problems).toEqual([expect.stringMatching(/the 95th percentile of Series \w+ is shown as 76\.7 ns; the tree gives it as null$/)]);
		const hidden = fixture.html.replace(/(title="Median [^"]*?5th percentile )[\d.]+,/, "$1infinite or undefined,");
		expect(problems(hidden)).toEqual([expect.stringMatching(/the 5th percentile of Series \w+ is said to be infinite or undefined; the tree holds [\d.]+$/)]);
	});

	test("a region the price file does not give", () => {
		expect(problems(fixture.html.replace("AWS, us-east-2.", "AWS, us-west-2."))).toEqual(['index.html: the note says "AWS, us-west-2. Each number is a median and links to the Runs behind it."; the price file\'s region is us-east-2']);
	});

	test("a row whose stated unit is not its figures'", () => {
		const html = fixture.html.replace(/(Read memory sequentially<\/a><span class="unit">)GB\/s/, "$1MB/s");
		expect(html).not.toBe(fixture.html);
		expect(problems(html)).toEqual(['index.html: a row\'s figures are in GB/s, but it says "MB/s"']);
	});
});
