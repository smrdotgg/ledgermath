/**
 * Fetches the data API's tree that the `runs` workflow kept last, for the
 * check against the tree before (scripts/check-api.ts --previous; ADR-0030,
 * rule 9):
 *
 *     bun scripts/previous-api.ts --repository OWNER/NAME --workflow FILE --branch NAME
 *                                 --run-id ID --tree DIR --out DIR [--gh PATH]
 *
 *   --repository OWNER/NAME  the repository whose workflow runs are searched
 *   --workflow FILE          the workflow's file name, runs.yml
 *   --branch NAME            the branch its runs ran on, main
 *   --run-id ID              this run, which is never the previous one
 *   --tree DIR               the tree this run built, whose layout the previous one must have
 *   --out DIR                where the previous tree is put; a new or empty directory
 *   --gh PATH                the GitHub CLI (default gh), which reads its token from GH_TOKEN
 *
 * It takes the most recent successful run of the workflow on the branch,
 * other than this one, and downloads that run's artifact api into --out.
 * Then it says which of two cases it is, on stdout, in the step's summary
 * ($GITHUB_STEP_SUMMARY) and as the step's output comparable ($GITHUB_OUTPUT):
 *
 *   comparable=true   a tree of this layout (the same schemas, byte for byte,
 *                     and the same base: layoutDifference()), to compare with;
 *   comparable=false  there is none of this layout: no earlier successful
 *                     run; or that run kept no artifact api (it ran before the
 *                     data API was built); or its artifact has expired; or the
 *                     tree it kept is of another layout, which only the first
 *                     build after a change of layout meets. The check is then
 *                     told there may be none (--allow-no-previous), and says so.
 *
 * Anything that fails on the way exits 1 and outputs nothing: gh, the API, a
 * reply it cannot read, the download. A tree that could not be fetched is not
 * a tree that does not exist, and is never treated as one.
 */

import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";

import { layoutDifference } from "./lib/api-check";

/** What gh did with the arguments it was given. */
export interface GhResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type Gh = (args: string[]) => GhResult;

export interface PreviousOptions {
	repository: string;
	workflow: string;
	branch: string;
	runId: string;
	tree: string;
	out: string;
	gh: Gh;
}

export type Previous =
	| { comparable: true; run: number; url: string; summary: string }
	| { comparable: false; run?: number; url?: string; summary: string };

/** Why the previous tree could not be fetched: not the same as there being none. */
export class CouldNotFetch extends Error {}

const json = (what: string, result: GhResult): unknown => {
	if (result.code !== 0) throw new CouldNotFetch(`could not fetch ${what}: gh exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new CouldNotFetch(`could not fetch ${what}: gh's reply is not JSON: ${result.stdout.slice(0, 200)}`);
	}
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Finds and downloads the previous tree, and says whether it is one to
 * compare with; throws CouldNotFetch when any step fails.
 */
export function fetchPrevious(options: PreviousOptions): Previous {
	const { repository, workflow, branch, runId, tree, out, gh } = options;
	if (existsSync(out) && readdirSync(out).length > 0) throw new CouldNotFetch(`${out} is not empty: the previous tree is put into a new or empty directory`);
	const none = (summary: string, run?: { id: number; url: string }): Previous => ({ comparable: false, ...(run === undefined ? {} : { run: run.id, url: run.url }), summary });

	const listed = json(
		`the successful runs of ${workflow} on ${branch}`,
		gh(["api", "-X", "GET", `repos/${repository}/actions/workflows/${workflow}/runs`, "-f", `branch=${branch}`, "-f", "status=success", "-f", "per_page=20"]),
	);
	if (!isObject(listed) || !Array.isArray(listed.workflow_runs)) throw new CouldNotFetch(`could not fetch the successful runs of ${workflow}: the reply holds no workflow_runs`);
	const runs = listed.workflow_runs
		.filter(isObject)
		.filter((run) => String(run.id) !== runId && run.head_branch === branch && run.conclusion === "success" && typeof run.id === "number" && typeof run.created_at === "string")
		.sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : String(a.created_at) > String(b.created_at) ? -1 : 0));
	const last = runs[0];
	if (last === undefined) return none(`No earlier successful run of ${workflow} on ${branch}, so no previous tree: past months are not compared.`);
	const run = { id: last.id as number, url: typeof last.html_url === "string" ? last.html_url : `run ${last.id}` };

	const kept = json(`the artifacts of run ${run.id}`, gh(["api", "-X", "GET", `repos/${repository}/actions/runs/${run.id}/artifacts`, "-f", "name=api", "-f", "per_page=10"]));
	if (!isObject(kept) || !Array.isArray(kept.artifacts)) throw new CouldNotFetch(`could not fetch the artifacts of run ${run.id}: the reply holds no artifacts`);
	const artifacts = kept.artifacts.filter(isObject).filter((artifact) => artifact.name === "api");
	if (artifacts.length === 0) return none(`The last successful run, ${run.url}, kept no artifact api (it ran before the data API was built), so there is no previous tree: past months are not compared.`, run);
	const live = artifacts.find((artifact) => artifact.expired !== true);
	if (live === undefined) {
		const expiry = artifacts.map((artifact) => String(artifact.expires_at)).join(", ");
		return none(`The artifact api of the last successful run, ${run.url}, expired (${expiry}), so there is no previous tree: past months are not compared.`, run);
	}

	const download = gh(["run", "download", String(run.id), "--repo", repository, "--name", "api", "--dir", out]);
	if (download.code !== 0) throw new CouldNotFetch(`could not download the artifact api of run ${run.id}: gh exited ${download.code}: ${download.stderr.trim() || download.stdout.trim()}`);
	const differs = layoutDifference(out, tree);
	if (differs !== null) return none(`The tree the last successful run, ${run.url}, kept is not one to compare with: ${differs}. This is the first build of a new layout: past months are not compared.`, run);
	return { comparable: true, run: run.id, url: run.url, summary: `The previous tree is the artifact api of the last successful run, ${run.url}, a tree of this layout: every past month is compared with it.` };
}

const USAGE = "usage: bun scripts/previous-api.ts --repository OWNER/NAME --workflow FILE --branch NAME --run-id ID --tree DIR --out DIR [--gh PATH]";

function main(): void {
	const { values } = parseArgs({
		options: {
			repository: { type: "string" },
			workflow: { type: "string" },
			branch: { type: "string" },
			"run-id": { type: "string" },
			tree: { type: "string" },
			out: { type: "string" },
			gh: { type: "string" },
		},
	});
	const { repository, workflow, branch, tree, out } = values;
	const runId = values["run-id"];
	if (!repository || !workflow || !branch || !runId || !tree || !out) {
		console.error(USAGE);
		process.exit(2);
	}
	const executable = values.gh ?? "gh";
	const gh: Gh = (args) => {
		const result = Bun.spawnSync([executable, ...args], { stdout: "pipe", stderr: "pipe" });
		return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};
	let previous: Previous;
	try {
		previous = fetchPrevious({ repository, workflow, branch, runId, tree, out, gh });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### The data API's previous tree\n\nCould not be fetched, so the check did not run: ${message}\n`);
		process.exit(1);
	}
	console.log(previous.summary);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### The data API's previous tree\n\n${previous.summary}\n`);
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `comparable=${previous.comparable}\n`);
}

if (import.meta.main) main();
