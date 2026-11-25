// deploy/published.ts: which run of runs.yml published last, and whether a production deploy of a
// run's tree may go ahead. gh is a stand-in here, answering as GitHub's API and `gh run download`
// do; nothing is fetched from the network. Run with `bun test` inside site/.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGh, type Job, ok, REPOSITORY, type Run, runUrl as url, type World } from "./fake-gh";
import { checkRun, CouldNotTell, download, type GhResult, newestPublished, parseCommandLine, publishJobName, RUNS_SEARCHED, RUNS_WORKFLOW, SKIP } from "./published";

const PUBLISH = publishJobName(readFileSync(RUNS_WORKFLOW, "utf8"));
const FIRST = "copy the Runs, derive, build the page and the data API, check for stale Series";
const SCRIPT = join(import.meta.dir, "published.ts");

const work = mkdtempSync(join(tmpdir(), "published-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The jobs of a run whose first job succeeded and whose publish job ended so ("none": it has no publish job). */
const jobs = (publish: string | null, ...more: Job[]): Job[] => [{ name: FIRST, conclusion: "success" }, ...(publish === "none" ? [] : [{ name: PUBLISH, conclusion: publish }]), ...more];

const options = (world: World, asked: string[][] = []) => ({ repository: REPOSITORY, gh: fakeGh(world, asked), publishJob: PUBLISH });

describe("the publish job's name", () => {
	test("is read from runs.yml, where its job publish names it", () => {
		expect(PUBLISH).toBe("publish the data API's checked files to the private API bucket");
		expect(() => publishJobName("jobs:\n  runs:\n    name: x\n")).toThrow("no job publish with a name");
	});
});

describe("newestPublished", () => {
	test("is the run with the highest id whose publish job succeeded: a run still going, or whose publish failed or was skipped, has not published", () => {
		const world: World = {
			runs: [
				{ id: 300, jobs: jobs("success") },
				{ id: 301, jobs: jobs("success") },
				{ id: 302, jobs: jobs("failure") },
				{ id: 303, jobs: jobs("skipped") },
				{ id: 304, jobs: jobs(null) },
				{ id: 305, jobs: jobs("none") },
			],
		};
		expect(newestPublished(options(world))).toEqual({ id: 301, url: url(301) });
	});

	test("takes no run of another branch, and counts a publish that succeeded in any attempt of a run", () => {
		const world: World = {
			runs: [
				{ id: 300, jobs: jobs("success") },
				{ id: 301, jobs: jobs("success", { name: PUBLISH, conclusion: "failure", run_attempt: 2 }) },
				{ id: 302, head_branch: "elsewhere", jobs: jobs("success") },
			],
		};
		expect(newestPublished(options(world)).id).toBe(301);
	});

	test("asks for the latest runs of runs.yml on main, of every status, and each run's jobs of every attempt, only until it finds one", () => {
		const asked: string[][] = [];
		newestPublished(options({ runs: [{ id: 300, jobs: jobs("success") }, { id: 301, jobs: jobs("success") }] }, asked));
		expect(asked).toEqual([
			["api", "-X", "GET", `repos/${REPOSITORY}/actions/workflows/runs.yml/runs`, "-f", "branch=main", "-f", `per_page=${RUNS_SEARCHED}`],
			["api", "-X", "GET", `repos/${REPOSITORY}/actions/runs/301/jobs`, "-f", "filter=all", "-f", "per_page=100"],
		]);
	});

	test("with none published, says so; it never answers a run that did not publish", () => {
		expect(() => newestPublished(options({ runs: [{ id: 300, jobs: jobs("failure") }] }))).toThrow(new CouldNotTell("none of the 1 latest runs of runs.yml on main published: there is no published tree to build from"));
		expect(() => newestPublished(options({ runs: [] }))).toThrow(CouldNotTell);
	});
});

describe("checkRun", () => {
	test("deploys the newest published tree: no later run, or later runs still going, failed, or skipped", () => {
		expect(checkRun(301, options({ runs: [{ id: 300, jobs: jobs("success") }, { id: 301, jobs: jobs("success") }] }))).toEqual({
			deploy: true,
			message: "No run of runs.yml on main later than run 301 has published: its tree is the newest.",
		});
		const world: World = { runs: [{ id: 301, jobs: jobs("success") }, { id: 302, jobs: jobs(null) }, { id: 303, jobs: jobs("failure") }, { id: 304, jobs: jobs("skipped") }] };
		expect(checkRun(301, options(world)).deploy).toBe(true);
	});

	test("skips the tree of a run when a later one has published, naming it, whatever lies between", () => {
		const world: World = { runs: [{ id: 301, jobs: jobs("success") }, { id: 302, jobs: jobs("success") }, { id: 303, jobs: jobs(null) }] };
		const verdict = checkRun(301, options(world));
		expect(verdict.deploy).toBe(false);
		expect(verdict.message).toBe(
			`Production deploy skipped: a later run of runs.yml has published, ${url(302)} (run 302), so the tree of run 301 is no longer the newest. ` +
				"That run's own site job deploys main's site with its tree after this one, or already has; if it failed, was cancelled or never ran, re-run it.",
		);
	});

	test("judges by run id, as the upload does: an earlier run publishing again (a re-run) is not later", () => {
		const world: World = { runs: [{ id: 300, jobs: jobs("success", { name: PUBLISH, conclusion: "success", run_attempt: 2 }) }, { id: 301, jobs: jobs("success") }] };
		expect(checkRun(301, options(world)).deploy).toBe(true);
	});

	test("reads only the runs later than the run it is asked of", () => {
		const asked: string[][] = [];
		checkRun(301, options({ runs: [{ id: 299, jobs: jobs("success") }, { id: 300, jobs: jobs("success") }, { id: 301, jobs: jobs("success") }, { id: 302, jobs: jobs("failure") }] }, asked));
		expect(asked.filter((args) => args.some((arg) => arg.endsWith("/jobs"))).map((args) => args[3])).toEqual([`repos/${REPOSITORY}/actions/runs/302/jobs`]);
	});

	test("cannot tell, and says so, when every run it can see is later than the run and none of them published", () => {
		const runs = Array.from({ length: RUNS_SEARCHED + 5 }, (_, i): Run => ({ id: 1000 + i, jobs: jobs("failure") }));
		expect(() => checkRun(1002, options({ runs }))).toThrow(CouldNotTell);
		// A run older than the whole history it can see, when that is the whole history: nothing later published.
		expect(checkRun(5, options({ runs: [{ id: 300, jobs: jobs("failure") }] })).deploy).toBe(true);
	});

	test("a failure to read is never a verdict: gh failing, a reply it cannot read, a run or job without what it needs", () => {
		const failing: GhResult = { code: 1, stdout: "", stderr: "HTTP 502" };
		const cases: World[] = [
			{ runs: [], list: failing },
			{ runs: [], list: { code: 0, stdout: "<html>", stderr: "" } },
			{ runs: [], list: ok({ total_count: 1 }) },
			{ runs: [], list: ok({ workflow_runs: [{ head_branch: "main" }] }) },
			{ runs: [{ id: 301, jobs: jobs("success") }, { id: 302, jobs: failing }] },
			{ runs: [{ id: 301, jobs: jobs("success") }, { id: 302, jobs: ok({ jobs: [{ conclusion: "success" }] }) }] },
			{ runs: [{ id: 301, jobs: jobs("success") }, { id: 302, jobs: ok({ jobs: [{ name: PUBLISH }] }) }] },
		];
		for (const world of cases) {
			expect(() => checkRun(301, options(world))).toThrow(CouldNotTell);
			expect(() => newestPublished(options(world))).toThrow(CouldNotTell);
		}
	});
});

describe("download", () => {
	const tree = { "v1/index.json": '{"schema":"ledgermath.api.index/1"}', "v1/series.json": "{}" };

	test("puts the run's artifact api, as gh downloads it, into a new directory", () => {
		const asked: string[][] = [];
		const out = join(work, "download-new");
		download({ id: 301, url: url(301) }, out, options({ runs: [{ id: 301, artifact: tree }] }, asked));
		expect(asked).toEqual([["run", "download", "301", "--repo", REPOSITORY, "--name", "api", "--dir", out]]);
		expect(readFileSync(join(out, "v1", "index.json"), "utf8")).toBe(tree["v1/index.json"]);
	});

	test("refuses a directory that holds anything, an artifact gh cannot download (expired after a week), and one without a table of contents", () => {
		const full = join(work, "download-full");
		mkdirSync(full, { recursive: true });
		writeFileSync(join(full, "old"), "x");
		expect(() => download({ id: 301, url: url(301) }, full, options({ runs: [{ id: 301, artifact: tree }] }))).toThrow("is not empty");
		expect(() => download({ id: 301, url: url(301) }, join(work, "download-expired"), options({ runs: [{ id: 301 }] }))).toThrow("An artifact is kept for a week");
		expect(() => download({ id: 301, url: url(301) }, join(work, "download-bare"), options({ runs: [{ id: 301, artifact: { "v1/series.json": "{}" } }] }))).toThrow("holds no v1/index.json");
	});
});

describe("the command line", () => {
	test("reads each option once, as --NAME VALUE or --NAME=VALUE, and refuses anything else", () => {
		expect(parseCommandLine(["check", "301", "--repository", "a/b"], ["repository"])).toEqual({ words: ["check", "301"], options: new Map([["repository", "a/b"]]) });
		expect(parseCommandLine(["--repository=a/b", "newest"], ["repository"])?.options.get("repository")).toBe("a/b");
		for (const bad of [["--repository"], ["--repository", "--out", "x"], ["--other", "x"], ["--repository", "a/b", "--repository", "c/d"], ["--repository="]]) {
			expect(parseCommandLine(bad, ["repository", "out"])).toBeNull();
		}
	});

	/** The script, run with a stand-in gh that answers from WORLD. */
	function script(world: World, ...args: string[]) {
		const dir = mkdtempSync(join(work, "cli-"));
		const state = join(dir, "world.json");
		writeFileSync(state, JSON.stringify(world));
		const gh = join(dir, "gh");
		writeFileSync(
			gh,
			[
				"#!/usr/bin/env bun",
				`import { fakeGhForScript } from ${JSON.stringify(join(import.meta.dir, "fake-gh.ts"))};`,
				`const result = fakeGhForScript(${JSON.stringify(state)}, process.argv.slice(2));`,
				"await Bun.write(Bun.stdout, result.stdout);",
				"await Bun.write(Bun.stderr, result.stderr);",
				"process.exit(result.code);",
				"",
			].join("\n"),
		);
		chmodSync(gh, 0o755);
		const run = Bun.spawnSync(["bun", SCRIPT, ...args, "--gh", gh], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_TOKEN: "" } });
		return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
	}

	const world: World = { runs: [{ id: 301, jobs: jobs("success"), artifact: { "v1/index.json": "{}" } }, { id: 302, jobs: jobs("success"), artifact: { "v1/index.json": "{}" } }] };

	test("check: exits 0 to deploy and SKIP to skip, saying why on stdout", () => {
		const deploy = script(world, "check", "302", "--repository", REPOSITORY);
		expect({ code: deploy.code, stdout: deploy.stdout.trim() }).toEqual({ code: 0, stdout: "No run of runs.yml on main later than run 302 has published: its tree is the newest." });
		const skip = script(world, "check", "301", "--repository", REPOSITORY);
		expect(skip.code).toBe(SKIP);
		expect(skip.stdout).toContain(`a later run of runs.yml has published, ${url(302)} (run 302)`);
	});

	test("newest: prints the run's id alone on stdout, and with --out puts its artifact api there", () => {
		const out = join(work, "cli-newest-tree");
		const newest = script(world, "newest", "--repository", REPOSITORY, "--out", out);
		expect({ code: newest.code, stdout: newest.stdout }).toEqual({ code: 0, stdout: "302\n" });
		expect(newest.stderr).toContain(url(302));
		expect(existsSync(join(out, "v1", "index.json"))).toBe(true);
	});

	test("exits 1, neither deploying nor skipping, when the record cannot be read; 2 on a bad command line", () => {
		const broken = script({ runs: [], list: { code: 1, stdout: "", stderr: "HTTP 502" } }, "check", "301", "--repository", REPOSITORY);
		expect(broken.code).toBe(1);
		expect(broken.stderr).toContain("HTTP 502");
		for (const args of [["check", "--repository", REPOSITORY], ["check", "abc", "--repository", REPOSITORY], ["check", "301"], ["newest", "301", "--repository", REPOSITORY], ["check", "301", "--repository", REPOSITORY, "--out", "x"], ["publish", "--repository", REPOSITORY]]) {
			expect({ args, code: script(world, ...args).code }).toEqual({ args, code: 2 });
		}
	});
});
