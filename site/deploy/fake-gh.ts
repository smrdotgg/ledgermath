// A stand-in for the GitHub CLI, for deploy/published.test.ts: it answers from a world of runs as
// GitHub's API and `gh run download` do, and asks nothing of the network. Not a test file.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Gh, type GhResult, RUNS_SEARCHED } from "./published";

export const REPOSITORY = "owner/ledgermath";

export type Job = { name: string; conclusion: string | null; run_attempt?: number };
/** A run as GitHub keeps it: its jobs (or what gh says when asked for them), and what its artifact api holds (or what gh says). */
export type Run = { id: number; head_branch?: string; jobs?: Job[] | GhResult; artifact?: Record<string, string> | GhResult };
/** The runs of runs.yml; `list`, when given, is what gh says when asked for them. */
export type World = { runs: Run[]; list?: GhResult };

export const ok = (value: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const isResult = (value: unknown): value is GhResult => typeof value === "object" && value !== null && "code" in value;
export const runUrl = (id: number) => `https://github.com/${REPOSITORY}/actions/runs/${id}`;

/** A gh that answers from WORLD, as GitHub does (the latest runs first, at most per_page of them), and records what it was asked in ASKED. */
export function fakeGh(world: World, asked: string[][] = []): Gh {
	return (args) => {
		asked.push(args);
		const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
		if (args[0] === "api" && path === `repos/${REPOSITORY}/actions/workflows/runs.yml/runs`) {
			if (world.list) return world.list;
			const latest = [...world.runs].sort((a, b) => b.id - a.id).slice(0, RUNS_SEARCHED);
			return ok({ total_count: world.runs.length, workflow_runs: latest.map((run) => ({ id: run.id, head_branch: run.head_branch ?? "main", html_url: runUrl(run.id), status: "completed" })) });
		}
		const jobsOf = new RegExp(`^repos/${REPOSITORY}/actions/runs/(\\d+)/jobs$`).exec(path);
		if (args[0] === "api" && jobsOf) {
			const run = world.runs.find((each) => each.id === Number(jobsOf[1]));
			if (isResult(run?.jobs)) return run.jobs;
			return ok({ total_count: run?.jobs?.length ?? 0, jobs: (run?.jobs ?? []).map((job) => ({ run_attempt: 1, ...job })) });
		}
		if (args[0] === "run" && args[1] === "download") {
			const run = world.runs.find((each) => each.id === Number(args[2]));
			if (isResult(run?.artifact)) return run.artifact;
			if (!run?.artifact) return { code: 1, stdout: "", stderr: "no valid artifacts found to download" };
			const dir = args[args.indexOf("--dir") + 1]!;
			for (const [file, text] of Object.entries(run.artifact)) {
				mkdirSync(dirname(join(dir, file)), { recursive: true });
				writeFileSync(join(dir, file), text);
			}
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `the stand-in does not know: gh ${args.join(" ")}` };
	};
}

/** What the stand-in executable answers to ARGS, with its world read from the JSON file at STATE. */
export function fakeGhForScript(state: string, args: string[]): GhResult {
	return fakeGh(JSON.parse(readFileSync(state, "utf8")) as World)(args);
}
