/**
 * Says which tree of the data API was published last, from GitHub's record of the `runs`
 * workflow. A run of .github/workflows/runs.yml on main publishes its tree when its job
 * `publish` succeeds, and the API bucket never takes an older tree after a newer one (the upload
 * refuses a run lower than the one the bucket records: OlderTree in scripts/lib/api-upload.ts).
 * So the tree published last is the artifact `api` of the run with the highest id whose publish
 * job succeeded, the same bytes that job uploaded.
 *
 *     bun site/deploy/published.ts newest --repository OWNER/NAME [--out DIR] [--gh PATH]
 *     bun site/deploy/published.ts check RUN --repository OWNER/NAME [--gh PATH]
 *
 * newest: prints that run's id, alone, on stdout. With --out, it first downloads that run's
 * artifact `api` into DIR (a new or empty directory). The artifact is kept for a week; when the
 * newest published run's has expired, it fails rather than take an older tree.
 *
 * check: whether a production deploy of RUN's tree may go ahead. Exit 0 when no run of runs.yml
 * on main later than RUN (with a higher id) has published, so RUN's tree is the newest; exit 3
 * (SKIP) when one has, with stdout naming it: deploying RUN's tree would move ledgermath.com
 * back, and that run's own deploy (the `site` job of runs.yml) waits in the same queue and
 * deploys after this one, or already has.
 *
 * Both deploys to production run it inside their shared concurrency group, before Vercel is
 * called: the `site` job of runs.yml with its own run, and site.yml's `deploy-production` with the
 * run whose tree its build job took (README, "Where it is deployed").
 *
 * It reads GitHub's API through the GitHub CLI, which takes its token from GH_TOKEN (the job's
 * own, with `actions: read`). The runs searched are the RUNS_SEARCHED latest of runs.yml on main,
 * of every status: a run still going has not published. The publish job is found by the name
 * runs.yml gives it, read from that file in this checkout; a run of a commit whose runs.yml named
 * it otherwise is not seen to have published. Any failure on the way (gh, a reply it cannot read,
 * a run without its id or branch, a job without its name or conclusion, a download), and a check
 * that cannot see back to RUN, exits 1: nothing is deployed on the word of a check that failed.
 * Exit 2: a bad command line.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNS_WORKFLOW = fileURLToPath(new URL("../../.github/workflows/runs.yml", import.meta.url));
export const WORKFLOW = "runs.yml";
export const BRANCH = "main";
export const SKIP = 3;
/** How many of the latest runs of runs.yml on main are searched: 25 days of four runs a day. */
export const RUNS_SEARCHED = 100;

/** What gh did with the arguments it was given. */
export type GhResult = { code: number; stdout: string; stderr: string };
export type Gh = (args: string[]) => GhResult;

/** Why the record could not be read: never the same as there being nothing in it. */
export class CouldNotTell extends Error {}

/** The name runs.yml gives its publish job, which is how GitHub's API names the job of each run. */
export function publishJobName(workflowText: string): string {
	const workflow = Bun.YAML.parse(workflowText) as { jobs?: { publish?: { name?: unknown } } } | null;
	const name = workflow?.jobs?.publish?.name;
	if (typeof name !== "string" || name === "") throw new Error("runs.yml has no job publish with a name");
	return name;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function json(what: string, result: GhResult): unknown {
	if (result.code !== 0) throw new CouldNotTell(`could not read ${what}: gh exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new CouldNotTell(`could not read ${what}: gh's reply is not JSON: ${result.stdout.slice(0, 200)}`);
	}
}

export type Options = { repository: string; gh: Gh; publishJob: string };
type Run = { id: number; url: string };

/** The RUNS_SEARCHED latest runs of runs.yml on main, every status, highest id first; and whether that is every run there is. */
function latestRuns({ repository, gh }: Options): { runs: Run[]; whole: boolean } {
	const listed = json(
		`the runs of ${WORKFLOW} on ${BRANCH}`,
		gh(["api", "-X", "GET", `repos/${repository}/actions/workflows/${WORKFLOW}/runs`, "-f", `branch=${BRANCH}`, "-f", `per_page=${RUNS_SEARCHED}`]),
	);
	if (!isObject(listed) || !Array.isArray(listed.workflow_runs)) throw new CouldNotTell(`could not read the runs of ${WORKFLOW}: the reply holds no workflow_runs`);
	const runs = listed.workflow_runs.map((run, i) => {
		if (!isObject(run) || !Number.isSafeInteger(run.id) || typeof run.head_branch !== "string") {
			throw new CouldNotTell(`could not read the runs of ${WORKFLOW}: entry ${i} of the reply lacks its id or head_branch: ${JSON.stringify(run)?.slice(0, 200)}`);
		}
		return { id: run.id as number, branch: run.head_branch, url: typeof run.html_url === "string" ? run.html_url : `run ${run.id}` };
	});
	return {
		runs: runs
			.filter((run) => run.branch === BRANCH)
			.sort((a, b) => b.id - a.id)
			.map(({ id, url }) => ({ id, url })),
		whole: listed.workflow_runs.length < RUNS_SEARCHED,
	};
}

/** Whether RUN's publish job succeeded, in any attempt of the run. */
function published({ repository, gh, publishJob }: Options, run: Run): boolean {
	const listed = json(`the jobs of run ${run.id}`, gh(["api", "-X", "GET", `repos/${repository}/actions/runs/${run.id}/jobs`, "-f", "filter=all", "-f", "per_page=100"]));
	if (!isObject(listed) || !Array.isArray(listed.jobs)) throw new CouldNotTell(`could not read the jobs of run ${run.id}: the reply holds no jobs`);
	return listed.jobs.some((job, i) => {
		if (!isObject(job) || typeof job.name !== "string" || !("conclusion" in job)) {
			throw new CouldNotTell(`could not read the jobs of run ${run.id}: entry ${i} of the reply lacks its name or conclusion: ${JSON.stringify(job)?.slice(0, 200)}`);
		}
		return job.name === publishJob && job.conclusion === "success";
	});
}

/** The run of runs.yml on main that published last, highest id first; throws CouldNotTell when the record cannot say. */
export function newestPublished(options: Options): Run {
	const { runs } = latestRuns(options);
	for (const run of runs) if (published(options, run)) return run;
	throw new CouldNotTell(`none of the ${runs.length} latest runs of ${WORKFLOW} on ${BRANCH} published: there is no published tree to build from`);
}

export type Verdict = { deploy: boolean; message: string };

/** Whether a production deploy of RUN's tree may go ahead; see the comment at the top. */
export function checkRun(run: number, options: Options): Verdict {
	const { runs, whole } = latestRuns(options);
	for (const later of runs.filter((each) => each.id > run)) {
		if (published(options, later)) {
			return {
				deploy: false,
				message:
					`Production deploy skipped: a later run of ${WORKFLOW} has published, ${later.url} (run ${later.id}), so the tree of run ${run} is no longer the newest. ` +
					`That run's own site job deploys main's site with its tree after this one, or already has; if it failed, was cancelled or never ran, re-run it.`,
			};
		}
	}
	if (!whole && !runs.some((each) => each.id <= run)) {
		throw new CouldNotTell(`the ${runs.length} latest runs of ${WORKFLOW} on ${BRANCH} are all later than run ${run} and none published: whether one between them did cannot be told`);
	}
	return { deploy: true, message: `No run of ${WORKFLOW} on ${BRANCH} later than run ${run} has published: its tree is the newest.` };
}

/** Downloads RUN's artifact api into OUT, a new or empty directory. */
export function download(run: Run, out: string, { repository, gh }: Options): void {
	if (existsSync(out) && readdirSync(out).length > 0) throw new CouldNotTell(`${out} is not empty: the tree is put into a new or empty directory`);
	const result = gh(["run", "download", String(run.id), "--repo", repository, "--name", "api", "--dir", out]);
	if (result.code !== 0) {
		throw new CouldNotTell(
			`could not download the artifact api of run ${run.id}, the newest run that published (${run.url}): gh exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}. ` +
				"An artifact is kept for a week: if none has been published since, build from a tree fetched from the API (README, \"Where it is deployed\").",
		);
	}
	if (!existsSync(join(out, "v1", "index.json"))) throw new CouldNotTell(`the artifact api of run ${run.id} holds no v1/index.json`);
}

const USAGE = "usage: bun site/deploy/published.ts newest --repository OWNER/NAME [--out DIR] [--gh PATH]\n       bun site/deploy/published.ts check RUN --repository OWNER/NAME [--gh PATH]";

/** The words and the options (--NAME VALUE or --NAME=VALUE, each once, of NAMES) of a command line; null when it is not one. */
export function parseCommandLine(argv: readonly string[], names: readonly string[]): { words: string[]; options: Map<string, string> } | null {
	const words: string[] = [];
	const options = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) {
			words.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
		if (!names.includes(name) || value === undefined || value === "" || value.startsWith("--") || options.has(name)) return null;
		options.set(name, value);
	}
	return { words, options };
}

if (import.meta.main) {
	const parsed = parseCommandLine(process.argv.slice(2), ["repository", "out", "gh"]);
	const [mode, runText] = parsed?.words ?? [];
	const repository = parsed?.options.get("repository") ?? "";
	const out = parsed?.options.get("out");
	const executable = parsed?.options.get("gh") ?? "gh";
	const valid =
		parsed !== null &&
		/^[\w.-]+\/[\w.-]+$/.test(repository) &&
		(mode === "check" ? parsed.words.length === 2 && /^[1-9]\d*$/.test(runText ?? "") && out === undefined : mode === "newest" && parsed.words.length === 1);
	if (!valid) {
		console.error(USAGE);
		process.exit(2);
	}
	const gh: Gh = (args) => {
		const result = Bun.spawnSync([executable, ...args], { stdout: "pipe", stderr: "pipe" });
		return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};
	try {
		const options = { repository, gh, publishJob: publishJobName(await Bun.file(RUNS_WORKFLOW).text()) };
		if (mode === "newest") {
			const run = newestPublished(options);
			if (out !== undefined) download(run, out, options);
			console.error(`the newest run of ${WORKFLOW} on ${BRANCH} that published: ${run.url}${out !== undefined ? `; its artifact api is in ${out}` : ""}`);
			console.log(String(run.id));
		} else {
			const verdict = checkRun(Number(runText), options);
			console.log(verdict.message);
			process.exit(verdict.deploy ? 0 : SKIP);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
