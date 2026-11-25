// deploy/published.ts: which tree of the data API was published last, by its identity (the run
// and the artifact api its publish job uploaded); whether a production deploy of a tree may go
// ahead; and the download of a tree by that identity. gh is a stand-in here (./fake-gh.ts),
// answering as GitHub's API does; nothing is fetched from the network. Run with `bun test` inside
// site/.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Artifact, fakeGh, type Job, ok, PUBLISH_STARTED, REPOSITORY, type Run, runUrl as url, type World } from "./fake-gh";
import { checkTree, command, CouldNotTell, download, MAX_PAGES, newestPublished, PER_PAGE, PUBLISH_JOB_NAMES, parseCommandLine, SKIP, type Tree } from "./published";

const PUBLISH = PUBLISH_JOB_NAMES[0]!;
const FIRST = "copy the Runs, derive, build the page and the data API, check for stale Series";
const SCRIPT = join(import.meta.dir, "published.ts");
const RUNS_YML = join(import.meta.dir, "..", "..", ".github", "workflows", "runs.yml");

const work = mkdtempSync(join(tmpdir(), "published-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The jobs of an attempt whose first job succeeded and whose publish job ended so ("none": it has no publish job). */
const attempt = (publish: string | null, number = 1, startedAt = PUBLISH_STARTED): Job[] => [
	{ name: FIRST, conclusion: "success", run_attempt: number },
	...(publish === "none" ? [] : [{ name: PUBLISH, conclusion: publish, run_attempt: number, started_at: startedAt }]),
];
/** A run that published once, its artifact api ARTIFACT made before its publish job started. */
const publishedRun = (id: number, artifact = id * 10): Run => ({ id, jobs: attempt("success"), artifacts: [{ id: artifact }] });
const options = (world: World, asked: string[][] = []) => ({ repository: REPOSITORY, gh: fakeGh(world, asked) });
const tree = (run: number, artifact: number): Tree => ({ run, artifact });

describe("the publish job's names", () => {
	test("the first is the name runs.yml gives its job publish now: renaming the job fails this until the new name is added first", () => {
		const workflow = Bun.YAML.parse(readFileSync(RUNS_YML, "utf8")) as { jobs: { publish: { name: string } } };
		expect(workflow.jobs.publish.name).toBe(PUBLISH);
		expect(PUBLISH_JOB_NAMES).toEqual(["publish the data API's checked files to the private API bucket"]);
		expect(new Set(PUBLISH_JOB_NAMES).size).toBe(PUBLISH_JOB_NAMES.length);
	});

	test("a later run that published under any of them counts, whatever the caller's runs.yml says (the verifier's renamed case); another name does not", () => {
		for (const name of PUBLISH_JOB_NAMES) {
			const world: World = { runs: [publishedRun(300), { id: 301, jobs: [{ name, conclusion: "success" }], artifacts: [{ id: 3011 }] }] };
			expect(checkTree({ run: 300 }, options(world)).deploy).toBe(false);
			expect(newestPublished(options(world))).toMatchObject({ run: 301, artifact: 3011 });
		}
		const other: World = { runs: [publishedRun(300), { id: 301, jobs: [{ name: "publish", conclusion: "success" }], artifacts: [{ id: 3011 }] }] };
		expect(newestPublished(options(other))).toMatchObject({ run: 300, artifact: 3000 });
	});
});

describe("a published tree's identity: the run and the artifact api its publish job uploaded", () => {
	test("the newest is the latest successful publish of the run with the highest id that has one: a run still going, or whose publish failed or was skipped, has not published", () => {
		const world: World = {
			runs: [
				publishedRun(300),
				publishedRun(301),
				{ id: 302, jobs: attempt("failure"), artifacts: [{ id: 3020 }] },
				{ id: 303, jobs: attempt("skipped") },
				{ id: 304, jobs: attempt(null), artifacts: [{ id: 3040 }] },
				{ id: 305, jobs: attempt("none") },
				{ id: 306, head_branch: "elsewhere", jobs: attempt("success"), artifacts: [{ id: 3060 }] },
			],
		};
		expect(newestPublished(options(world))).toEqual({ run: 301, artifact: 3010, url: url(301) });
	});

	test("the verifier's sequence: a push takes run 301's first tree; 301 is run again in full and publishes another; the push's deploy is refused, and the site job deploys the second", () => {
		const first: Artifact = { id: 9001, created_at: "2026-11-25T00:16:03Z" };
		const once: World = { runs: [publishedRun(300), { id: 301, jobs: attempt("success", 1, "2026-11-25T00:16:10Z"), artifacts: [first] }] };
		// The push's build takes the newest published tree.
		const taken = newestPublished(options(once));
		expect(taken).toMatchObject({ run: 301, artifact: 9001 });
		// All of 301's jobs run again, after new data: a second artifact api, and a second successful publish, under the same run id.
		const again: World = {
			runs: [
				publishedRun(300),
				{
					id: 301,
					jobs: [...attempt("success", 1, "2026-11-25T00:16:10Z"), ...attempt("success", 2, "2026-11-25T03:02:10Z")],
					artifacts: [first, { id: 9002, created_at: "2026-11-25T03:02:01Z" }],
				},
			],
		};
		const delayed = checkTree(tree(taken.run, taken.artifact), options(again));
		expect(delayed.deploy).toBe(false);
		expect(delayed.message).toContain("the newest published tree is 301/9002");
		expect(delayed.message).toContain("not the tree 301/9001");
		// The second attempt's site job asks for its run's tree, and is given the second.
		expect(checkTree({ run: 301 }, options(again))).toMatchObject({ deploy: true, tree: { run: 301, artifact: 9002 } });
		expect(checkTree(tree(301, 9002), options(again)).deploy).toBe(true);
	});

	test("a later attempt whose publish failed published nothing: its artifact is not the tree, the earlier attempt's still is", () => {
		const world: World = {
			runs: [{ id: 301, jobs: [...attempt("success", 1, "2026-11-25T00:16:10Z"), ...attempt("failure", 2, "2026-11-25T03:02:10Z")], artifacts: [{ id: 9001 }, { id: 9002, created_at: "2026-11-25T03:02:01Z" }] }],
		};
		expect(newestPublished(options(world))).toMatchObject({ run: 301, artifact: 9001 });
		expect(checkTree(tree(301, 9002), options(world)).deploy).toBe(false);
	});

	test("of the artifacts made when the publish job started, the one with the highest id, as the publish job's download takes it (ids do not follow the order the artifacts were made in)", () => {
		const world: World = {
			runs: [{ id: 301, jobs: [...attempt("success", 1, "2026-11-25T00:16:10Z"), ...attempt("success", 2, "2026-11-25T03:02:10Z")], artifacts: [{ id: 9005 }, { id: 9002, created_at: "2026-11-25T03:02:01Z" }] }],
		};
		expect(newestPublished(options(world))).toMatchObject({ run: 301, artifact: 9005 });
	});

	test("a later attempt counts as newer even when only its publish job ran again: it took the newest artifact made by then", () => {
		const world: World = {
			runs: [{ id: 301, jobs: [...attempt("failure", 1, "2026-11-25T00:16:10Z"), ...attempt("success", 2, "2026-11-25T03:02:10Z")], artifacts: [{ id: 9001 }] }],
		};
		expect(newestPublished(options(world))).toMatchObject({ run: 301, artifact: 9001 });
	});
});

describe("checkTree", () => {
	const world: World = { runs: [publishedRun(300), publishedRun(301), { id: 302, jobs: attempt(null) }] };

	test("deploys the newest published tree, asked by its identity or by its run; and says which tree, so the job downloads exactly that one", () => {
		expect(checkTree(tree(301, 3010), options(world))).toEqual({ deploy: true, tree: tree(301, 3010), message: `The newest published tree is 301/3010 (${url(301)}): the tree 301/3010. It may be deployed.` });
		expect(checkTree({ run: 301 }, options(world))).toMatchObject({ deploy: true, tree: tree(301, 3010) });
	});

	test("skips an older run's tree, or another tree of the newest run, naming the newest", () => {
		for (const asked of [tree(300, 3000), { run: 300 }, tree(301, 3011)]) {
			const verdict = checkTree(asked, options(world));
			expect(verdict.deploy).toBe(false);
			expect(verdict.message).toContain(`Production deploy skipped: the newest published tree is 301/3010 (${url(301)})`);
			expect(verdict.message).toContain("re-run it");
		}
	});

	test("refuses, as a failure and never a deploy, the tree of a run the record shows no publish of", () => {
		expect(() => checkTree({ run: 302 }, options(world))).toThrow(new CouldNotTell("GitHub's record shows no publish of run 302: the newest published tree is 301/3010, of an earlier run"));
		expect(() => checkTree(tree(303, 1), options(world))).toThrow(CouldNotTell);
	});
});

describe("an incomplete answer from GitHub is never read as a complete one", () => {
	const fill = (count: number, conclusion = "failure"): Job[] => Array.from({ length: count }, (_, i) => ({ name: `step ${i}`, conclusion }));

	test("the verifier's case: a publish that succeeded on the second page of a run's jobs is found, by reading that page", () => {
		const asked: string[][] = [];
		const world: World = { runs: [publishedRun(300), { id: 301, jobs: [...fill(PER_PAGE), ...attempt("success")], artifacts: [{ id: 3010 }] }] };
		expect(newestPublished(options(world, asked))).toMatchObject({ run: 301, artifact: 3010 });
		expect(checkTree({ run: 300 }, options(world)).deploy).toBe(false);
		expect(asked.filter((args) => args.includes(`repos/${REPOSITORY}/actions/runs/301/jobs`)).map((args) => args.at(-1))).toEqual(["page=1", "page=2"]);
	});

	test("a page of jobs that comes back short while GitHub counts more refuses; so does a list longer than the bound", () => {
		const short: World = { runs: [publishedRun(300), { id: 301, jobPages: { 1: ok({ total_count: PER_PAGE + 1, jobs: fill(PER_PAGE) }), 2: ok({ total_count: PER_PAGE + 1, jobs: [] }) } }] };
		expect(() => newestPublished(options(short))).toThrow("could not read the jobs of run 301 in full: GitHub counts 101, and gave 100 before a page came back with 0 of 100");
		expect(() => checkTree({ run: 300 }, options(short))).toThrow(CouldNotTell);
		const long: World = { runs: [publishedRun(300), { id: 301, jobs: [...fill(MAX_PAGES.jobs * PER_PAGE), ...attempt("success")], artifacts: [{ id: 3010 }] }] };
		expect(() => newestPublished(options(long))).toThrow(`could not read the jobs of run 301 in full: GitHub lists more than the ${MAX_PAGES.jobs * PER_PAGE} this reads`);
	});

	test("the verifier's case: an empty page of runs that claims two results refuses, never finding nothing", () => {
		const absent: World = { runs: [], listPages: { 1: ok({ total_count: 2, workflow_runs: [] }) } };
		expect(() => newestPublished(options(absent))).toThrow("could not read the runs of runs.yml on main in full: GitHub counts 2, and gave 0 before a page came back with 0 of 100");
		expect(() => checkTree({ run: 300 }, options(absent))).toThrow(CouldNotTell);
	});

	test("runs are read page after page until one published, and refused past the bound", () => {
		const unpublished = (from: number, count: number): Run[] => Array.from({ length: count }, (_, i) => ({ id: from + i, jobs: attempt("failure") }));
		const asked: string[][] = [];
		const deep: World = { runs: [publishedRun(100), ...unpublished(1000, PER_PAGE + 20)] };
		expect(newestPublished(options(deep, asked))).toMatchObject({ run: 100 });
		expect(asked.filter((args) => args.includes(`repos/${REPOSITORY}/actions/workflows/runs.yml/runs`)).length).toBe(2);
		const beyond: World = { runs: [publishedRun(100), ...unpublished(1000, MAX_PAGES.runs * PER_PAGE)] };
		expect(() => newestPublished(options(beyond))).toThrow(`could not read the runs of runs.yml on main in full: GitHub lists more than the ${MAX_PAGES.runs * PER_PAGE} this reads`);
		// Every run read, none published: said so, as a failure.
		expect(() => newestPublished(options({ runs: unpublished(1000, 3) }))).toThrow("none of the 3 runs of runs.yml on main published");
	});

	test("an artifact listed on a second page is found; a published run with no artifact api made by then refuses", () => {
		const many: Artifact[] = Array.from({ length: PER_PAGE }, (_, i) => ({ id: 5000 + i, name: "api", created_at: "2026-11-25T09:00:00Z" }));
		const world: World = { runs: [{ id: 301, jobs: attempt("success"), artifacts: [...many, { id: 3010 }] }] };
		expect(newestPublished(options(world))).toMatchObject({ run: 301, artifact: 3010 });
		expect(() => newestPublished(options({ runs: [{ id: 301, jobs: attempt("success"), artifacts: [{ id: 3010, created_at: "2026-11-25T09:00:00Z" }] }] }))).toThrow(
			`run 301 published at ${PUBLISH_STARTED}, but GitHub lists no artifact api it had made by then`,
		);
	});

	test("a list of runs out of order, a publish job without its start or attempt, gh failing, a reply it cannot read: each refuses", () => {
		const failing = { code: 1, stdout: "", stderr: "HTTP 502" };
		const cases: World[] = [
			{ runs: [], listPages: { 1: ok({ total_count: 2, workflow_runs: [{ id: 300, head_branch: "main" }, { id: 301, head_branch: "main" }] }) } },
			{ runs: [{ id: 301, jobs: [{ name: PUBLISH, conclusion: "success", started_at: null }], artifacts: [{ id: 1 }] }] },
			{ runs: [], listPages: { 1: failing } },
			{ runs: [], listPages: { 1: { code: 0, stdout: "<html>", stderr: "" } } },
			{ runs: [], listPages: { 1: ok({ workflow_runs: [] }) } },
			{ runs: [], listPages: { 1: ok({ total_count: 1, workflow_runs: [{ head_branch: "main" }] }) } },
			{ runs: [publishedRun(300), { id: 301, jobs: failing }] },
			{ runs: [publishedRun(300), { id: 301, jobs: ok({ total_count: 1, jobs: [{ conclusion: "success" }] }) }] },
		];
		for (const world of cases) {
			expect(() => newestPublished(options(world))).toThrow(CouldNotTell);
			expect(() => checkTree({ run: 300 }, options(world))).toThrow(CouldNotTell);
		}
	});
});

describe("download: the artifact of a tree's identity, never the artifact named api of a run", () => {
	const A = { "v1/index.json": '{"attempt":1}', "v1/series.json": "{}" };
	const B = { "v1/index.json": '{"attempt":2}', "v1/series.json": "{}" };
	const rerun: World = { runs: [{ id: 301, artifacts: [{ id: 9001, files: A }, { id: 9002, files: B, created_at: "2026-11-25T03:02:01Z" }] }] };
	let made = 0;
	const fresh = () => join(work, `download-${++made}`);

	test("each attempt's tree comes from its own artifact, by id: neither can be given the other's", () => {
		for (const [artifact, files] of [[9001, A], [9002, B]] as const) {
			const asked: string[][] = [];
			const out = fresh();
			download(tree(301, artifact), out, options(rerun, asked));
			expect(readFileSync(join(out, "v1", "index.json"), "utf8")).toBe(files["v1/index.json"]);
			expect(readdirSync(out)).toEqual(["v1"]);
			expect(asked).toEqual([
				["api", `repos/${REPOSITORY}/actions/artifacts/${artifact}`],
				["api", `repos/${REPOSITORY}/actions/artifacts/${artifact}/zip`],
			]);
		}
	});

	test("refuses an artifact of another run, of another name, expired, without a digest, whose bytes are not its digest's, or holding files outside v1/ or no table of contents", () => {
		const refused = (artifact: Artifact, asked: Tree, says: string) => {
			const world: World = { runs: [{ id: 301, artifacts: [artifact] }, { id: 302, artifacts: [] }] };
			const out = fresh();
			expect(() => download(asked, out, options(world))).toThrow(says);
			expect(existsSync(out)).toBe(false);
		};
		refused({ id: 9001 }, tree(302, 9001), "artifact 9001 belongs to run 301, not 302");
		refused({ id: 9001, name: "page" }, tree(301, 9001), 'artifact 9001 is named "page", not api');
		refused({ id: 9001, expired: true }, tree(301, 9001), "artifact 9001 of run 301 has expired");
		refused({ id: 9001, digest: null }, tree(301, 9001), "artifact 9001 has no sha256 digest");
		refused({ id: 9001, digest: `sha256:${"0".repeat(64)}` }, tree(301, 9001), `not the ${"0".repeat(64)} GitHub gives`);
		refused({ id: 9001, files: { "v1/index.json": "{}", "../escape": "x" } }, tree(301, 9001), "holds files outside v1/: ../escape");
		refused({ id: 9001, files: { "v1/index.json": "{}", "other/x": "x" } }, tree(301, 9001), "holds files outside v1/: other/x");
		refused({ id: 9001, files: { "v1/series.json": "{}" } }, tree(301, 9001), "holds no v1/index.json");
		refused({ id: 9001, zip: { code: 1, stdout: "", stderr: "HTTP 410" } }, tree(301, 9001), "could not download artifact 9001: gh exited 1: HTTP 410");
		refused({ id: 9001 }, tree(301, 9999), "could not read artifact 9999");
	});

	test("refuses a directory that holds anything", () => {
		const full = fresh();
		mkdirSync(full);
		writeFileSync(join(full, "old"), "x");
		expect(() => download(tree(301, 9001), full, options(rerun))).toThrow("is not an empty directory");
	});
});

describe("the command line", () => {
	test("reads each option once, as --NAME VALUE or --NAME=VALUE, and refuses anything else", () => {
		expect(parseCommandLine(["check", "301", "--repository", "a/b"], ["repository"])).toEqual({ words: ["check", "301"], options: new Map([["repository", "a/b"]]) });
		expect(parseCommandLine(["--repository=a/b", "newest"], ["repository"])?.options.get("repository")).toBe("a/b");
		for (const bad of [["--repository"], ["--repository", "--out", "x"], ["--other", "x"], ["--repository", "a/b", "--repository", "c/d"], ["--repository="]]) {
			expect(parseCommandLine(bad, ["repository", "out"])).toBeNull();
		}
		expect(command(["check", "301/9001", "--repository", "a/b", "--github-output", "f"])).toMatchObject({ mode: "check", tree: { run: 301, artifact: 9001 }, githubOutput: "f" });
		expect(command(["check", "301", "--repository", "a/b"])).toMatchObject({ mode: "check", tree: { run: 301 } });
		expect(command(["download", "301/9001", "--repository", "a/b", "--out", "d"])).toMatchObject({ mode: "download", tree: { run: 301, artifact: 9001 }, out: "d" });
		for (const bad of [["download", "301", "--repository", "a/b", "--out", "d"], ["download", "301/9001", "--repository", "a/b"], ["newest", "--repository", "a/b", "--out", "d"], ["check", "301/x", "--repository", "a/b"], ["check", "0", "--repository", "a/b"]]) {
			expect({ bad, parsed: command(bad) }).toEqual({ bad, parsed: null });
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
				"await Bun.write(Bun.stdout, result.bytes ?? result.stdout);",
				"await Bun.write(Bun.stderr, result.stderr);",
				"process.exit(result.code);",
				"",
			].join("\n"),
		);
		chmodSync(gh, 0o755);
		const run = Bun.spawnSync(["bun", SCRIPT, ...args, "--gh", gh], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_TOKEN: "" } });
		return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString(), dir };
	}

	const world: World = { runs: [publishedRun(301), publishedRun(302)] };

	test("check: exits 0 to deploy, writing the tree to --github-output, and SKIP to skip, saying why on stdout", () => {
		const deploy = script(world, "check", "302", "--repository", REPOSITORY, "--github-output", join(work, "output-302"));
		expect({ code: deploy.code, stdout: deploy.stdout.trim() }).toEqual({ code: 0, stdout: `The newest published tree is 302/3020 (${url(302)}): the tree of run 302. It may be deployed.` });
		expect(readFileSync(join(work, "output-302"), "utf8")).toBe("tree=302/3020\n");
		const skip = script(world, "check", "301/3010", "--repository", REPOSITORY, "--github-output", join(work, "output-301"));
		expect(skip.code).toBe(SKIP);
		expect(skip.stdout).toContain(`the newest published tree is 302/3020 (${url(302)}), not the tree 301/3010`);
		expect(existsSync(join(work, "output-301"))).toBe(false);
	});

	test("newest prints the identity alone on stdout; download puts that artifact's files in --out", () => {
		const newest = script(world, "newest", "--repository", REPOSITORY);
		expect({ code: newest.code, stdout: newest.stdout }).toEqual({ code: 0, stdout: "302/3020\n" });
		const out = join(work, "cli-download");
		const got = script(world, "download", "302/3020", "--repository", REPOSITORY, "--out", out);
		expect(got.code).toBe(0);
		expect(readFileSync(join(out, "v1", "index.json"), "utf8")).toBe('{"schema":"ledgermath.api.index/1"}');
	});

	test("exits 1, neither deploying nor skipping, when the record cannot be read; 2 on a bad command line", () => {
		const broken = script({ runs: [], listPages: { 1: { code: 1, stdout: "", stderr: "HTTP 502" } } }, "check", "301", "--repository", REPOSITORY);
		expect(broken.code).toBe(1);
		expect(broken.stderr).toContain("HTTP 502");
		for (const args of [["check", "--repository", REPOSITORY], ["check", "abc", "--repository", REPOSITORY], ["check", "301"], ["newest", "301", "--repository", REPOSITORY], ["check", "301", "--repository", REPOSITORY, "--out", "x"], ["publish", "--repository", REPOSITORY]]) {
			expect({ args, code: script(world, ...args).code }).toEqual({ args, code: 2 });
		}
	});
});
