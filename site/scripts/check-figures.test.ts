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

type Built = { out: string; status: number; stdout: string; stderr: string; html: string; tree: Tree };

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
	let html = "";
	try {
		html = readFileSync(join(out, "index.html"), "utf8");
	} catch {}
	return { out, status: run.exitCode ?? -1, stdout, stderr, html, tree: readTree(tree) };
}

let fixture: Built;
let lacking: Built;
let failing: Built;
let hashOnM5 = HASH_ON_M5;

beforeAll(() => {
	const tree = readTree(FIXTURE);
	const row = tree.seriesList.series.find((r) => r.benchmark === "hash" && r.instance_type === "m5.large" && r.params.algorithm === "sha256" && r.params.size_bytes === 64 && r.build === "static")!;
	hashOnM5 = row.url;
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
	test("from the fixture tree: both pages, and nothing to say", () => {
		expect(fixture.status).toBe(0);
		expect(fixture.stdout).not.toContain("note:");
		expect(readFileSync(join(fixture.out, "docs", "index.html"), "utf8")).toContain("The documentation is being written.");
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

	test("and the output check passes each built site: words, links, budget", () => {
		for (const built of [fixture, lacking, failing]) expect(checkOutput(built.out).problems).toEqual([]);
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

	test("a region the price file does not give", () => {
		expect(problems(fixture.html.replace("AWS, us-east-2.", "AWS, us-west-2."))).toEqual(['index.html: the note says "AWS, us-west-2. Each number is a median and links to the Runs behind it."; the price file\'s region is us-east-2']);
	});

	test("a row whose stated unit is not its figures'", () => {
		const html = fixture.html.replace(/(Read memory sequentially<\/a><span class="unit">)GB\/s/, "$1MB/s");
		expect(html).not.toBe(fixture.html);
		expect(problems(html)).toEqual(['index.html: a row\'s figures are in GB/s, but it says "MB/s"']);
	});
});
