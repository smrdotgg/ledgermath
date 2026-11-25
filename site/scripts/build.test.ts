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

/** The build's own directories left in DIR, and its server bundles left in site/dist/: none, after any build. */
const leftovers = (dir: string) => [
	...readdirSync(dir).filter((name) => name.includes(".building-")),
	...(existsSync(BUILD_AREA) ? readdirSync(BUILD_AREA).filter((name) => name.startsWith(".server-")) : []),
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

	test("the mark names nothing private: no path, no repository", () => {
		const mark = readFileSync(join(work, "fresh", BUILD_MARK), "utf8");
		expect(mark).not.toContain("/");
		expect(mark.toLowerCase()).not.toContain("github");
	});
});
