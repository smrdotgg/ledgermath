/**
 * scripts/previous-api.ts: which tree the runs workflow compares its data API
 * with (the one kept by the latest successful run created before this one),
 * that it decides nothing about whether to compare, and that "there is none"
 * is never what a failure to fetch one, or a reply it cannot read, says. gh
 * is a stand-in here, answering as GitHub's API and `gh run download` do.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { apiJson, buildApi, DEFAULT_BASE, readApiSchemas, readBootSummaries, readPriceFiles } from "../scripts/lib/api";
import { CouldNotFetch, fetchPrevious, type Gh, type GhResult } from "../scripts/previous-api";
import { makeApiFixture } from "./api-fixtures";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const REPOSITORY = "owner/ledgermath";
/** This run, and when it was created. */
const SELF = { id: 300, created_at: "2026-11-19T22:40:00Z" };

let tree = "";
let kept = "";
let otherLayout = "";
/** The layout this build writes, as its table of contents gives it. */
let LAYOUT = 0;

function writeTree(files: Map<string, Uint8Array>): string {
	const directory = mkdtempSync(join(tmpdir(), "previous-api-tree-"));
	for (const [path, bytes] of files) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), bytes);
	}
	return directory;
}

beforeAll(async () => {
	const fixture = await makeApiFixture({ nextMonth: true });
	const sources = {
		base: DEFAULT_BASE,
		docs: "https://example.test/docs",
		series: fixture.series,
		requests: fixture.requests,
		prices: readPriceFiles(fixture.runs),
		boots: readBootSummaries(fixture.runs),
		schemas: readApiSchemas(),
	};
	tree = writeTree(buildApi(sources));
	kept = writeTree(buildApi(sources));
	// A tree of a later layout.
	const files = buildApi(sources);
	const index = JSON.parse(new TextDecoder().decode(files.get("v1/index.json")));
	LAYOUT = index.layout;
	const schema = JSON.parse(readFileSync(join(ROOT, "schemas/api/v1/index.schema.json"), "utf8"));
	files.set("v1/index.json", new TextEncoder().encode(apiJson({ ...index, layout: LAYOUT + 1 }, schema)));
	otherLayout = writeTree(files);
});

interface World {
	/** This run, as GitHub's API gives it; a GhResult when gh fails. */
	self?: unknown;
	runs?: unknown[] | GhResult;
	artifacts?: Record<number, unknown[]> | GhResult;
	/** What `gh run download` puts in --dir, by run id; a GhResult when it fails. */
	download?: Record<number, string | GhResult>;
}

/** A gh that answers from `world`, and records what it was asked. It returns every run it holds, whatever the filter: the script filters again. */
function fakeGh(world: World, asked: string[][] = []): Gh {
	const ok = (value: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
	return (args) => {
		asked.push(args);
		if (args[0] === "api" && args[1] === `repos/${REPOSITORY}/actions/runs/${SELF.id}`) {
			const self = world.self ?? SELF;
			return typeof self === "object" && self !== null && "code" in self ? (self as GhResult) : ok(self);
		}
		if (args[0] === "api" && args[3]?.endsWith("/actions/workflows/runs.yml/runs")) {
			return Array.isArray(world.runs) || world.runs === undefined ? ok({ total_count: world.runs?.length ?? 0, workflow_runs: world.runs ?? [] }) : world.runs;
		}
		const artifacts = /^repos\/owner\/ledgermath\/actions\/runs\/([0-9]+)\/artifacts$/.exec(args[3] ?? "");
		if (args[0] === "api" && artifacts !== null) {
			if (world.artifacts !== undefined && "code" in world.artifacts) return world.artifacts as GhResult;
			const list = (world.artifacts as Record<number, unknown[]> | undefined)?.[Number(artifacts[1])] ?? [];
			return ok({ total_count: list.length, artifacts: list });
		}
		if (args[0] === "run" && args[1] === "download") {
			const what = world.download?.[Number(args[2])];
			if (what === undefined) return { code: 1, stdout: "", stderr: "no valid artifacts found to download" };
			if (typeof what !== "string") return what;
			const dir = args[args.indexOf("--dir") + 1] as string;
			cpSync(what, dir, { recursive: true });
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `unknown command: ${args.join(" ")}` };
	};
}

const run = (id: number, createdAt: string, extra: Record<string, unknown> = {}) => ({
	id,
	head_branch: "main",
	status: "completed",
	conclusion: "success",
	created_at: createdAt,
	html_url: `https://github.example/runs/${id}`,
	...extra,
});
const artifact = (extra: Record<string, unknown> = {}) => ({ id: 7, name: "api", expired: false, expires_at: "2026-11-26T22:40:00Z", ...extra });
const NEW_BASELINE = "The check fails unless this run was started by hand with the input new_baseline, which declares this run's tree a new baseline.";

function previous(world: World, asked?: string[][]) {
	const out = join(mkdtempSync(join(tmpdir(), "previous-api-out-")), "api-previous");
	return { out, result: () => fetchPrevious({ repository: REPOSITORY, workflow: "runs.yml", branch: "main", runId: String(SELF.id), tree, out, gh: fakeGh(world, asked) }) };
}

describe("the previous tree", () => {
	test("is the artifact api of the latest successful run on main created before this one, downloaded, its layout named beside this tree's", () => {
		const asked: string[][] = [];
		const { out, result } = previous(
			{
				runs: [run(200, "2026-11-19T12:00:00Z"), run(SELF.id, SELF.created_at), run(250, "2026-11-19T18:00:00Z"), run(260, "2026-11-19T19:00:00Z", { head_branch: "other" })],
				artifacts: { 250: [artifact()] },
				download: { 250: kept },
			},
			asked,
		);
		expect(result()).toEqual({
			found: true,
			run: 250,
			url: "https://github.example/runs/250",
			summary: `The previous tree is the artifact api of the last successful run created before this one, https://github.example/runs/250: layout ${LAYOUT}, this tree's ${LAYOUT}. Of one layout, every past month is compared with it; of another, the check fails unless this run was started by hand with the input new_baseline.`,
		});
		expect(readFileSync(join(out, "v1/index.json"))).toEqual(readFileSync(join(kept, "v1/index.json")));
		expect(asked).toEqual([
			["api", `repos/${REPOSITORY}/actions/runs/${SELF.id}`],
			["api", "-X", "GET", `repos/${REPOSITORY}/actions/workflows/runs.yml/runs`, "-f", "branch=main", "-f", "status=success", "-f", `created=<${SELF.created_at}`, "-f", "per_page=20"],
			["api", "-X", "GET", `repos/${REPOSITORY}/actions/runs/250/artifacts`, "-f", "name=api", "-f", "per_page=10"],
			["run", "download", "250", "--repo", REPOSITORY, "--name", "api", "--dir", out],
		]);
	});

	test("on a re-run of an older run, is never a run created after it", () => {
		// This run was created at 18:30 and is being run again; 350 was created at 20:00 and succeeded since.
		const { result } = previous({
			self: { id: SELF.id, created_at: "2026-11-19T18:30:00Z" },
			runs: [run(350, "2026-11-19T20:00:00Z"), run(250, "2026-11-19T18:00:00Z"), run(200, "2026-11-19T12:00:00Z")],
			artifacts: { 250: [artifact()], 350: [artifact()] },
			download: { 250: kept, 350: kept },
		});
		expect(result()).toMatchObject({ found: true, run: 250 });
		// And with only later runs, there is no earlier one.
		expect(previous({ self: { id: SELF.id, created_at: "2026-11-19T18:30:00Z" }, runs: [run(350, "2026-11-19T20:00:00Z")] }).result()).toEqual({
			found: false,
			summary: `No successful run of runs.yml on main was created before this one (2026-11-19T18:30:00Z), so there is no previous tree. ${NEW_BASELINE}`,
		});
	});

	test("is none, said plainly with what the check then needs, when there is no earlier successful run, when that run kept no artifact api, or when its artifact expired", () => {
		expect(previous({ runs: [run(SELF.id, SELF.created_at)] }).result()).toEqual({
			found: false,
			summary: `No successful run of runs.yml on main was created before this one (${SELF.created_at}), so there is no previous tree. ${NEW_BASELINE}`,
		});
		expect(previous({ runs: [run(250, "2026-11-19T18:00:00Z")], artifacts: { 250: [artifact({ name: "page" })] } }).result()).toEqual({
			found: false,
			run: 250,
			url: "https://github.example/runs/250",
			summary: `The last successful run created before this one, https://github.example/runs/250, kept no artifact api (it ran before the data API was built), so there is no previous tree. ${NEW_BASELINE}`,
		});
		expect(previous({ runs: [run(250, "2026-11-19T18:00:00Z")], artifacts: { 250: [artifact({ expired: true, expires_at: "2026-11-12T18:00:00Z" })] } }).result()).toEqual({
			found: false,
			run: 250,
			url: "https://github.example/runs/250",
			summary: `The artifact api of the last successful run created before this one, https://github.example/runs/250, expired (2026-11-12T18:00:00Z), so there is no previous tree. ${NEW_BASELINE}`,
		});
	});

	test("of another layout, is downloaded and named as such: whether to compare is the check's, and a new baseline a human's", () => {
		const found = previous({ runs: [run(250, "2026-11-19T18:00:00Z")], artifacts: { 250: [artifact()] }, download: { 250: otherLayout } }).result();
		expect(found).toMatchObject({ found: true, run: 250 });
		expect(found.summary).toContain(`layout ${LAYOUT + 1}, this tree's ${LAYOUT}.`);
	});

	test("could not be fetched, which is never none: gh failing, a reply that is not theirs, a run or an artifact without what is needed, a download that fails", () => {
		const failed: GhResult = { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" };
		const listing = `the successful runs of runs.yml on main created before ${SELF.created_at}`;
		const cases: Array<[World, string]> = [
			[{ self: failed }, `could not fetch run ${SELF.id}: gh exited 1: HTTP 403: Resource not accessible by integration`],
			[{ self: { id: SELF.id } }, `could not fetch run ${SELF.id}: the reply gives no created_at as GitHub writes it`],
			[{ runs: failed }, `could not fetch ${listing}: gh exited 1: HTTP 403: Resource not accessible by integration`],
			[{ runs: { code: 0, stdout: "<html>", stderr: "" } }, `could not fetch ${listing}: gh's reply is not JSON: <html>`],
			[{ runs: { code: 0, stdout: "{}", stderr: "" } }, "could not fetch the successful runs of runs.yml: the reply holds no workflow_runs"],
			// A run without its creation time is not "no earlier run".
			[{ runs: [run(250, "2026-11-19T18:00:00Z"), { id: 240, head_branch: "main", conclusion: "success" }] }, "could not fetch the successful runs of runs.yml: entry 1 of the reply lacks its id, head_branch, conclusion or created_at"],
			[{ runs: [{ ...run(250, "2026-11-19T18:00:00Z"), id: "250" }] }, "could not fetch the successful runs of runs.yml: entry 0 of the reply lacks its id, head_branch, conclusion or created_at"],
			[{ runs: [run(250, "2026-11-19T18:00:00Z")], artifacts: failed }, "could not fetch the artifacts of run 250: gh exited 1: HTTP 403: Resource not accessible by integration"],
			[{ runs: [run(250, "2026-11-19T18:00:00Z")], artifacts: { 250: [{ id: 7, name: "api" }] } }, "could not fetch the artifacts of run 250: entry 0 of the reply lacks its name or expired"],
			[{ runs: [run(250, "2026-11-19T18:00:00Z")], artifacts: { 250: [artifact()] } }, "could not download the artifact api of run 250: gh exited 1: no valid artifacts found to download"],
			[{ runs: [run(250, "2026-11-19T18:00:00Z")], artifacts: { 250: [artifact()] }, download: { 250: { code: 1, stdout: "", stderr: "connection reset" } } }, "could not download the artifact api of run 250: gh exited 1: connection reset"],
		];
		for (const [world, message] of cases) {
			const { result } = previous(world);
			expect(result).toThrow(CouldNotFetch);
			expect(result).toThrow(message);
		}
	});
});

describe("the command", () => {
	/** A gh on disk that answers as fakeGh does, from a world written beside it. */
	function ghOnDisk(world: World): string {
		const directory = mkdtempSync(join(tmpdir(), "previous-api-gh-"));
		writeFileSync(join(directory, "world.json"), JSON.stringify(world));
		const script = join(directory, "gh");
		writeFileSync(
			script,
			[
				"#!/usr/bin/env bun",
				'const { cpSync, readFileSync } = require("node:fs");',
				`const world = JSON.parse(readFileSync(${JSON.stringify(join(directory, "world.json"))}, "utf8"));`,
				"const args = process.argv.slice(2);",
				`if (args[0] === "api" && args[1] === ${JSON.stringify(`repos/${REPOSITORY}/actions/runs/${SELF.id}`)}) { console.log(JSON.stringify(${JSON.stringify(SELF)})); process.exit(0); }`,
				'if (args[0] === "api" && args[3].endsWith("/runs")) { console.log(JSON.stringify({ workflow_runs: world.runs ?? [] })); process.exit(0); }',
				'if (args[0] === "api") { console.log(JSON.stringify({ artifacts: (world.artifacts ?? {})[args[3].split("/")[5]] ?? [] })); process.exit(0); }',
				'if (args[0] === "run") { const from = (world.download ?? {})[args[2]]; if (from === undefined) { console.error("no valid artifacts found to download"); process.exit(1); } cpSync(from, args[args.indexOf("--dir") + 1], { recursive: true }); process.exit(0); }',
				"process.exit(1);",
				"",
			].join("\n"),
		);
		chmodSync(script, 0o755);
		return script;
	}
	const command = (gh: string, env: Record<string, string>) => {
		const out = join(mkdtempSync(join(tmpdir(), "previous-api-cli-")), "api-previous");
		return Bun.spawnSync(
			[process.execPath, "scripts/previous-api.ts", "--repository", REPOSITORY, "--workflow", "runs.yml", "--branch", "main", "--run-id", String(SELF.id), "--tree", tree, "--out", out, "--gh", gh],
			{ cwd: ROOT, env: { ...process.env, ...env } },
		);
	};

	test("writes the step's summary when there is a tree, or none, and exits 0 with no step output to decide anything by; exits 1 when it could not fetch one", () => {
		const cases: Array<[World, string]> = [
			[{ runs: [run(250, "2026-11-19T18:00:00Z")], artifacts: { 250: [artifact()] }, download: { 250: kept } }, `layout ${LAYOUT}, this tree's ${LAYOUT}.`],
			[{ runs: [] }, `No successful run of runs.yml on main was created before this one (${SELF.created_at}), so there is no previous tree. ${NEW_BASELINE}`],
		];
		for (const [world, said] of cases) {
			const directory = mkdtempSync(join(tmpdir(), "previous-api-github-"));
			const output = join(directory, "output");
			const summary = join(directory, "summary");
			const done = command(ghOnDisk(world), { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary });
			expect([done.exitCode, done.stderr.toString()]).toEqual([0, ""]);
			expect(done.stdout.toString()).toContain(said);
			expect(existsSync(output)).toBe(false);
			expect(readFileSync(summary, "utf8")).toContain(said);
		}
		const directory = mkdtempSync(join(tmpdir(), "previous-api-github-"));
		const summary = join(directory, "summary");
		const failed = command(ghOnDisk({ runs: [run(250, "2026-11-19T18:00:00Z")], artifacts: { 250: [artifact()] } }), { GITHUB_STEP_SUMMARY: summary });
		expect(failed.exitCode).toBe(1);
		expect(failed.stderr.toString()).toContain("could not download the artifact api of run 250");
		expect(readFileSync(summary, "utf8")).toContain("Could not be fetched, so the check did not run: could not download the artifact api of run 250");
	});
});
