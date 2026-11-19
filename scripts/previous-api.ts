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
 *   --run-id ID              this run: the previous tree is the one kept by the latest
 *                            successful run created before it was
 *   --tree DIR               the tree this run built, whose layout the summary names
 *   --out DIR                where the previous tree is put; a new or empty directory
 *   --gh PATH                the GitHub CLI (default gh), which reads its token from GH_TOKEN
 *
 * It reads when this run was created, takes the latest successful run of the
 * workflow on the branch created before that (so a re-run of an older run
 * takes the run before it, never one made after it), and downloads that run's
 * artifact api into --out. It says what it found, on stdout and in the step's
 * summary ($GITHUB_STEP_SUMMARY): a tree, with its layout beside this one's;
 * or none, because there is no such run, that run kept no artifact api, or
 * its artifact expired. It decides nothing: with no tree, or one of another
 * layout, the check fails unless a human declared a new baseline (the
 * workflow's input new_baseline, the only source of --allow-no-previous).
 *
 * Anything that fails on the way exits 1: gh, the API, a reply it cannot
 * read or that lacks what it needs (a run without its id, branch, conclusion
 * or creation time; an artifact without its name or whether it expired), the
 * download. A tree that could not be fetched is not a tree that does not
 * exist, and is never treated as one.
 */

import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";

import { readLayout } from "./lib/api-check";

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

export type Previous = { found: true; run: number; url: string; summary: string } | { found: false; run?: number; url?: string; summary: string };

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

/** A creation time as GitHub's API writes it, in UTC to the second: compared as text, it is in time order. */
const CREATED_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

/** A layout as the summary names it. */
const layoutOf = (directory: string): string => {
	const read = readLayout(directory);
	if (typeof read === "string") return `none to read (${read})`;
	return read.layout === null ? "none (written before layout was)" : String(read.layout);
};

const NEW_BASELINE = "The check fails unless this run was started by hand with the input new_baseline, which declares this run's tree a new baseline.";

/**
 * Finds and downloads the previous tree, and says what it found; throws
 * CouldNotFetch when any step fails.
 */
export function fetchPrevious(options: PreviousOptions): Previous {
	const { repository, workflow, branch, runId, tree, out, gh } = options;
	if (existsSync(out) && readdirSync(out).length > 0) throw new CouldNotFetch(`${out} is not empty: the previous tree is put into a new or empty directory`);
	const none = (summary: string, run?: { id: number; url: string }): Previous => ({ found: false, ...(run === undefined ? {} : { run: run.id, url: run.url }), summary: `${summary} ${NEW_BASELINE}` });

	const self = json(`run ${runId}`, gh(["api", `repos/${repository}/actions/runs/${runId}`]));
	if (!isObject(self) || typeof self.created_at !== "string" || !CREATED_AT.test(self.created_at)) throw new CouldNotFetch(`could not fetch run ${runId}: the reply gives no created_at as GitHub writes it`);
	const createdAt = self.created_at;

	const listed = json(
		`the successful runs of ${workflow} on ${branch} created before ${createdAt}`,
		gh(["api", "-X", "GET", `repos/${repository}/actions/workflows/${workflow}/runs`, "-f", `branch=${branch}`, "-f", "status=success", "-f", `created=<${createdAt}`, "-f", "per_page=20"]),
	);
	if (!isObject(listed) || !Array.isArray(listed.workflow_runs)) throw new CouldNotFetch(`could not fetch the successful runs of ${workflow}: the reply holds no workflow_runs`);
	const runs = listed.workflow_runs.map((run, i) => {
		if (!isObject(run) || typeof run.id !== "number" || typeof run.head_branch !== "string" || typeof run.conclusion !== "string" || typeof run.created_at !== "string" || !CREATED_AT.test(run.created_at)) {
			throw new CouldNotFetch(`could not fetch the successful runs of ${workflow}: entry ${i} of the reply lacks its id, head_branch, conclusion or created_at: ${JSON.stringify(run)?.slice(0, 200)}`);
		}
		return { id: run.id, branch: run.head_branch, conclusion: run.conclusion, createdAt: run.created_at, url: typeof run.html_url === "string" ? run.html_url : `run ${run.id}` };
	});
	const earlier = runs
		.filter((run) => String(run.id) !== runId && run.branch === branch && run.conclusion === "success" && run.createdAt < createdAt)
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
	const last = earlier[0];
	if (last === undefined) return none(`No successful run of ${workflow} on ${branch} was created before this one (${createdAt}), so there is no previous tree.`);
	const run = { id: last.id, url: last.url };

	const kept = json(`the artifacts of run ${run.id}`, gh(["api", "-X", "GET", `repos/${repository}/actions/runs/${run.id}/artifacts`, "-f", "name=api", "-f", "per_page=10"]));
	if (!isObject(kept) || !Array.isArray(kept.artifacts)) throw new CouldNotFetch(`could not fetch the artifacts of run ${run.id}: the reply holds no artifacts`);
	const artifacts = kept.artifacts.map((artifact, i) => {
		if (!isObject(artifact) || typeof artifact.name !== "string" || typeof artifact.expired !== "boolean") {
			throw new CouldNotFetch(`could not fetch the artifacts of run ${run.id}: entry ${i} of the reply lacks its name or expired: ${JSON.stringify(artifact)?.slice(0, 200)}`);
		}
		return { name: artifact.name, expired: artifact.expired, expiresAt: String(artifact.expires_at) };
	});
	const api = artifacts.filter((artifact) => artifact.name === "api");
	if (api.length === 0) return none(`The last successful run created before this one, ${run.url}, kept no artifact api (it ran before the data API was built), so there is no previous tree.`, run);
	if (!api.some((artifact) => !artifact.expired)) {
		return none(`The artifact api of the last successful run created before this one, ${run.url}, expired (${api.map((artifact) => artifact.expiresAt).join(", ")}), so there is no previous tree.`, run);
	}

	const download = gh(["run", "download", String(run.id), "--repo", repository, "--name", "api", "--dir", out]);
	if (download.code !== 0) throw new CouldNotFetch(`could not download the artifact api of run ${run.id}: gh exited ${download.code}: ${download.stderr.trim() || download.stdout.trim()}`);
	return {
		found: true,
		run: run.id,
		url: run.url,
		summary:
			`The previous tree is the artifact api of the last successful run created before this one, ${run.url}: layout ${layoutOf(out)}, this tree's ${layoutOf(tree)}. ` +
			"Of one layout, every past month is compared with it; of another, the check fails unless this run was started by hand with the input new_baseline.",
	};
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
}

if (import.meta.main) main();
