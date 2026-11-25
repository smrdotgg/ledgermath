/**
 * Says which tree of the data API was published last, from GitHub's record of the `runs`
 * workflow, and downloads a published tree by its identity.
 *
 *     bun site/deploy/published.ts newest --repository OWNER/NAME [--gh PATH]
 *     bun site/deploy/published.ts check TREE --repository OWNER/NAME [--github-output FILE] [--gh PATH]
 *     bun site/deploy/published.ts download TREE --repository OWNER/NAME --out DIR [--gh PATH]
 *
 * **A tree's identity** is RUN/ARTIFACT: the run of .github/workflows/runs.yml that published it,
 * and the id of the very artifact `api` its job `publish` uploaded. A run run again in full keeps
 * its id and keeps an artifact `api` of each attempt, so the run alone does not say which tree;
 * the artifact's id does. The publish job takes the artifact by its name, and for a name a run
 * holds more than once the download takes the one with the highest id (actions/download-artifact,
 * through @actions/artifact). So the tree a successful publish job uploaded is, of the run's
 * artifacts named `api` created when that job started, the one with the highest id (artifact ids
 * do not follow the order the artifacts were made in).
 *
 * **The newest published tree.** The API bucket never takes a lower run after a higher one (the
 * upload refuses it: OlderTree in scripts/lib/api-upload.ts), and a run's attempts come one after
 * another. So the tree published last is that of the latest successful publish job of the run
 * with the highest id that has one: a later attempt of a run is newer than an earlier one.
 *
 * newest: prints the newest published tree's identity, alone, on stdout.
 *
 * check: whether a production deploy of TREE may go ahead. TREE is RUN/ARTIFACT, the tree a build
 * took (site.yml), or a bare RUN, for the tree that run published (the `site` job of runs.yml,
 * of its own run). Exit 0 when it is the newest published tree; with --github-output, the line
 * tree=RUN/ARTIFACT is appended to FILE, so the job downloads exactly that tree. Exit 3 (SKIP)
 * when a newer tree has been published, with stdout naming both: deploying TREE would move
 * ledgermath.com back, and the newer tree's own site job deploys it after this one, or already
 * has. Exit 1 when the record cannot say, or shows TREE as no published tree.
 *
 * download: puts the artifact of TREE (RUN/ARTIFACT) into DIR, a new or empty directory: never
 * "the artifact named api" of a run. It checks that the artifact is the run's and is named `api`,
 * that the bytes are the ones whose digest GitHub gives, and that every file in the archive lies
 * under v1/; the archive is unpacked with unzip beside DIR, which then takes DIR's name. An
 * artifact is kept for a week; an expired one is refused.
 *
 * Both deploys to production run `check` inside their shared concurrency group, before Vercel is
 * called (README, "Where it is deployed"). It reads GitHub's API through the GitHub CLI, which
 * takes its token from GH_TOKEN (the job's own, with `actions: read`). Every list it reads (the
 * runs, a run's jobs, a run's artifacts) is read whole, page by page, up to a bound: when a count
 * GitHub gives is more than the entries it was given, it fetches the rest, and refuses when a
 * page comes back short or the bound is reached. What it was not given is never taken not to
 * exist. The publish job is known by the names it has had (PUBLISH_JOB_NAMES), not by reading the
 * caller's runs.yml. Any failure (gh, a reply it cannot read, a list it cannot read in full, an
 * entry without what it needs) exits 1: nothing is deployed on the word of a check that failed.
 * Exit 2: a bad command line.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WORKFLOW = "runs.yml";
export const BRANCH = "main";
export const SKIP = 3;
/** Entries asked for in each page of a list: GitHub's most. */
export const PER_PAGE = 100;
/** The most pages read of each list: 300 runs (75 days of four a day), 500 jobs of a run, 300 artifacts of a run. */
export const MAX_PAGES = { runs: 3, jobs: 5, artifacts: 3 } as const;

/**
 * Every name runs.yml has given its job `publish`, the name it has now first. GitHub's record
 * names a job by its display name, so a run made with an older runs.yml is known by an older one.
 * Renaming the job means adding the new name first and keeping the old ones: a test holds the
 * first to runs.yml's.
 */
export const PUBLISH_JOB_NAMES: readonly string[] = ["publish the data API's checked files to the private API bucket"];

/** What gh did with the arguments it was given: its stdout as text, and as bytes. */
export type GhResult = { code: number; stdout: string; stderr: string; bytes?: Uint8Array };
export type Gh = (args: string[]) => GhResult;

/** Why the record could not be read: never the same as there being nothing in it. */
export class CouldNotTell extends Error {}

export type Options = { repository: string; gh: Gh };
/** A published tree: the run that published it and the artifact it uploaded. */
export type Tree = { run: number; artifact: number };
type Run = { id: number; url: string };

export const treeId = (tree: Tree) => `${tree.run}/${tree.artifact}`;

/** RUN/ARTIFACT as a Tree, a bare RUN as { run } alone; null when it is neither. */
export function parseTree(text: string): Tree | { run: number; artifact?: undefined } | null {
	const m = /^([1-9]\d*)(?:\/([1-9]\d*))?$/.exec(text);
	if (!m) return null;
	const run = Number(m[1]);
	const artifact = m[2] === undefined ? undefined : Number(m[2]);
	if (!Number.isSafeInteger(run) || (artifact !== undefined && !Number.isSafeInteger(artifact))) return null;
	return artifact === undefined ? { run } : { run, artifact };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A time as GitHub's API writes it, in UTC to the second: compared as text, it is in time order. */
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

function json(what: string, result: GhResult): unknown {
	if (result.code !== 0) throw new CouldNotTell(`could not read ${what}: gh exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new CouldNotTell(`could not read ${what}: gh's reply is not JSON: ${result.stdout.slice(0, 200)}`);
	}
}

/**
 * Every entry of a list GitHub pages, read page by page while the count it gives is more than the
 * entries read, up to `pages` pages. `stop` may end the reading early once it has what it needs,
 * and then what is left unread is not claimed to be anything. Throws CouldNotTell when a page
 * holds no count, comes back short, or the bound is reached.
 */
function readList(gh: Gh, what: string, path: string, key: string, fields: string[], pages: number, stop: (entry: unknown) => boolean = () => false): { entries: unknown[]; whole: boolean } {
	const entries: unknown[] = [];
	for (let page = 1; ; page++) {
		if (page > pages) throw new CouldNotTell(`could not read ${what} in full: GitHub lists more than the ${pages * PER_PAGE} this reads`);
		const reply = json(`${what}, page ${page}`, gh(["api", "-X", "GET", path, ...fields.flatMap((field) => ["-f", field]), "-f", `per_page=${PER_PAGE}`, "-f", `page=${page}`]));
		if (!isObject(reply) || !Array.isArray(reply[key]) || !Number.isSafeInteger(reply.total_count) || (reply.total_count as number) < 0) {
			throw new CouldNotTell(`could not read ${what}: page ${page} of the reply holds no ${key} with a total_count`);
		}
		const total = reply.total_count as number;
		const got = reply[key] as unknown[];
		for (const entry of got) {
			entries.push(entry);
			if (stop(entry)) return { entries, whole: false };
		}
		if (entries.length >= total) return { entries, whole: true };
		if (got.length < PER_PAGE) {
			throw new CouldNotTell(`could not read ${what} in full: GitHub counts ${total}, and gave ${entries.length} before a page came back with ${got.length} of ${PER_PAGE}`);
		}
	}
}

/** The latest successful publish job of RUN, in any attempt, or null when it has none; every job read. */
function latestPublish({ repository, gh }: Options, run: Run): { attempt: number; startedAt: string } | null {
	const { entries } = readList(gh, `the jobs of run ${run.id}`, `repos/${repository}/actions/runs/${run.id}/jobs`, "jobs", ["filter=all"], MAX_PAGES.jobs);
	const publishes: Array<{ attempt: number; startedAt: string }> = [];
	for (const [i, job] of entries.entries()) {
		if (!isObject(job) || typeof job.name !== "string" || !("conclusion" in job)) {
			throw new CouldNotTell(`could not read the jobs of run ${run.id}: entry ${i} lacks its name or conclusion: ${JSON.stringify(job)?.slice(0, 200)}`);
		}
		if (!PUBLISH_JOB_NAMES.includes(job.name) || job.conclusion !== "success") continue;
		if (!Number.isSafeInteger(job.run_attempt) || typeof job.started_at !== "string" || !TIME.test(job.started_at)) {
			throw new CouldNotTell(`could not read the jobs of run ${run.id}: its successful publish job lacks its run_attempt or started_at: ${JSON.stringify(job).slice(0, 200)}`);
		}
		publishes.push({ attempt: job.run_attempt as number, startedAt: job.started_at });
	}
	// The latest attempt; of one attempt listed twice (a job a re-run kept), the later start.
	publishes.sort((a, b) => b.attempt - a.attempt || (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
	return publishes[0] ?? null;
}

/** The artifact `api` that RUN's publish job started at STARTED took: of those made by then, the highest id. */
function publishedArtifact({ repository, gh }: Options, run: Run, startedAt: string): number {
	const { entries } = readList(gh, `the artifacts of run ${run.id}`, `repos/${repository}/actions/runs/${run.id}/artifacts`, "artifacts", ["name=api"], MAX_PAGES.artifacts);
	const made = entries
		.map((artifact, i) => {
			if (!isObject(artifact) || !Number.isSafeInteger(artifact.id) || typeof artifact.name !== "string" || typeof artifact.created_at !== "string" || !TIME.test(artifact.created_at)) {
				throw new CouldNotTell(`could not read the artifacts of run ${run.id}: entry ${i} lacks its id, name or created_at: ${JSON.stringify(artifact)?.slice(0, 200)}`);
			}
			return { id: artifact.id as number, name: artifact.name, createdAt: artifact.created_at };
		})
		.filter((artifact) => artifact.name === "api" && artifact.createdAt <= startedAt);
	if (made.length === 0) throw new CouldNotTell(`run ${run.id} published at ${startedAt}, but GitHub lists no artifact api it had made by then`);
	return Math.max(...made.map((artifact) => artifact.id));
}

/** The newest published tree, and the run's address; throws CouldNotTell when the record cannot say. */
export function newestPublished(options: Options): Tree & { url: string } {
	const { repository, gh } = options;
	const result: { found: (Tree & { url: string }) | null; previous: number | null } = { found: null, previous: null };
	// GitHub lists a workflow's runs newest first, so the first that published is the newest, as the
	// upload's rule makes it; a list out of that order is refused rather than read.
	const { entries } = readList(gh, `the runs of ${WORKFLOW} on ${BRANCH}`, `repos/${repository}/actions/workflows/${WORKFLOW}/runs`, "workflow_runs", [`branch=${BRANCH}`], MAX_PAGES.runs, (entry) => {
		if (!isObject(entry) || !Number.isSafeInteger(entry.id) || typeof entry.head_branch !== "string") {
			throw new CouldNotTell(`could not read the runs of ${WORKFLOW}: an entry lacks its id or head_branch: ${JSON.stringify(entry)?.slice(0, 200)}`);
		}
		const id = entry.id as number;
		if (result.previous !== null && id >= result.previous) throw new CouldNotTell(`could not read the runs of ${WORKFLOW}: GitHub did not list them newest first (${id} after ${result.previous})`);
		result.previous = id;
		if (entry.head_branch !== BRANCH) return false;
		const run = { id, url: typeof entry.html_url === "string" ? entry.html_url : `run ${id}` };
		const publish = latestPublish(options, run);
		if (publish === null) return false;
		result.found = { run: id, artifact: publishedArtifact(options, run, publish.startedAt), url: run.url };
		return true;
	});
	if (result.found !== null) return result.found;
	throw new CouldNotTell(`none of the ${entries.length} runs of ${WORKFLOW} on ${BRANCH} published: there is no published tree to build from`);
}

export type Verdict = { deploy: true; tree: Tree; message: string } | { deploy: false; message: string };

/** Whether a production deploy of TREE (RUN/ARTIFACT, or a bare RUN for that run's tree) may go ahead; see the comment at the top. */
export function checkTree(tree: Tree | { run: number; artifact?: undefined }, options: Options): Verdict {
	const newest = newestPublished(options);
	const asked = tree.artifact === undefined ? `the tree of run ${tree.run}` : `the tree ${treeId(tree)}`;
	if (newest.run === tree.run && (tree.artifact === undefined || tree.artifact === newest.artifact)) {
		return { deploy: true, tree: { run: newest.run, artifact: newest.artifact }, message: `The newest published tree is ${treeId(newest)} (${newest.url}): ${asked}. It may be deployed.` };
	}
	if (newest.run < tree.run) {
		throw new CouldNotTell(`GitHub's record shows no publish of run ${tree.run}: the newest published tree is ${treeId(newest)}, of an earlier run`);
	}
	return {
		deploy: false,
		message:
			`Production deploy skipped: the newest published tree is ${treeId(newest)} (${newest.url}), not ${asked}, so deploying ${asked} could move ledgermath.com back. ` +
			`The newest tree's own site job deploys main's site with it after this one, or already has; if it failed, was cancelled or never ran, re-run it.`,
	};
}

/** The names of the files in a zip archive, from unzip; throws when unzip cannot list it. */
function zipEntries(zip: string): string[] {
	const listed = Bun.spawnSync(["unzip", "-Z1", zip], { stdout: "pipe", stderr: "pipe" });
	if (listed.exitCode !== 0) throw new CouldNotTell(`unzip could not list the artifact's archive: ${listed.stderr.toString().trim()}`);
	return listed.stdout.toString().split("\n").filter((line) => line !== "");
}

/** Puts the artifact of TREE into OUT, a new or empty directory; see the comment at the top. */
export function download(tree: Tree, out: string, { repository, gh }: Options): void {
	const dir = resolve(out);
	if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) throw new CouldNotTell(`${out} exists and is not an empty directory: the tree is put into a new one`);
	const meta = json(`artifact ${tree.artifact}`, gh(["api", `repos/${repository}/actions/artifacts/${tree.artifact}`]));
	if (!isObject(meta) || meta.id !== tree.artifact || typeof meta.name !== "string" || typeof meta.expired !== "boolean" || !isObject(meta.workflow_run)) {
		throw new CouldNotTell(`could not read artifact ${tree.artifact}: the reply lacks its id, name, expired or workflow_run`);
	}
	if (meta.name !== "api") throw new CouldNotTell(`artifact ${tree.artifact} is named ${JSON.stringify(meta.name)}, not api: it is no tree`);
	if (meta.workflow_run.id !== tree.run) throw new CouldNotTell(`artifact ${tree.artifact} belongs to run ${String(meta.workflow_run.id)}, not ${tree.run}`);
	if (meta.expired) throw new CouldNotTell(`artifact ${tree.artifact} of run ${tree.run} has expired (an artifact is kept for a week): build from a tree fetched from the API (README, "Where it is deployed")`);
	const digest = typeof meta.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(meta.digest)?.[1] : undefined;
	if (digest === undefined) throw new CouldNotTell(`artifact ${tree.artifact} has no sha256 digest to check its bytes against`);
	const zipped = gh(["api", `repos/${repository}/actions/artifacts/${tree.artifact}/zip`]);
	if (zipped.code !== 0) throw new CouldNotTell(`could not download artifact ${tree.artifact}: gh exited ${zipped.code}: ${zipped.stderr.trim()}`);
	const bytes = zipped.bytes ?? new TextEncoder().encode(zipped.stdout);
	const got = createHash("sha256").update(bytes).digest("hex");
	if (got !== digest) throw new CouldNotTell(`artifact ${tree.artifact}'s bytes have sha256 ${got}, not the ${digest} GitHub gives`);

	mkdirSync(dirname(dir), { recursive: true });
	const work = `${dir}.downloading-${process.pid}`;
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work);
	try {
		const zip = join(work, "artifact.zip");
		writeFileSync(zip, bytes);
		const names = zipEntries(zip);
		const outside = names.filter((name) => !/^v1\//.test(name) || name.split("/").some((part) => part === ".." || part === "."));
		if (outside.length > 0) throw new CouldNotTell(`artifact ${tree.artifact} holds files outside v1/: ${outside.slice(0, 5).join(", ")}`);
		const unpacked = join(work, "tree");
		const unzip = Bun.spawnSync(["unzip", "-q", zip, "-d", unpacked], { stdout: "pipe", stderr: "pipe" });
		if (unzip.exitCode !== 0) throw new CouldNotTell(`unzip could not unpack artifact ${tree.artifact}: ${unzip.stderr.toString().trim()}`);
		if (!existsSync(join(unpacked, "v1", "index.json"))) throw new CouldNotTell(`artifact ${tree.artifact} holds no v1/index.json`);
		if (existsSync(dir)) rmSync(dir, { recursive: true });
		renameSync(unpacked, dir);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

const USAGE = [
	"usage: bun site/deploy/published.ts newest --repository OWNER/NAME [--gh PATH]",
	"       bun site/deploy/published.ts check RUN[/ARTIFACT] --repository OWNER/NAME [--github-output FILE] [--gh PATH]",
	"       bun site/deploy/published.ts download RUN/ARTIFACT --repository OWNER/NAME --out DIR [--gh PATH]",
].join("\n");

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

/** What a command line asks for, or null when it is not one this script takes. */
export function command(argv: readonly string[]):
	| { mode: "newest"; repository: string; gh: string }
	| { mode: "check"; tree: Tree | { run: number; artifact?: undefined }; repository: string; githubOutput?: string; gh: string }
	| { mode: "download"; tree: Tree; repository: string; out: string; gh: string }
	| null {
	const parsed = parseCommandLine(argv, ["repository", "out", "github-output", "gh"]);
	if (parsed === null) return null;
	const { words, options } = parsed;
	const repository = options.get("repository") ?? "";
	const gh = options.get("gh") ?? "gh";
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) return null;
	const allowed = (...names: string[]) => [...options.keys()].every((name) => name === "repository" || name === "gh" || names.includes(name));
	const tree = words[1] === undefined ? null : parseTree(words[1]);
	if (words[0] === "newest" && words.length === 1 && allowed()) return { mode: "newest", repository, gh };
	if (words[0] === "check" && words.length === 2 && tree !== null && allowed("github-output")) return { mode: "check", tree, repository, githubOutput: options.get("github-output"), gh };
	if (words[0] === "download" && words.length === 2 && tree?.artifact !== undefined && options.has("out") && allowed("out")) {
		return { mode: "download", tree: tree as Tree, repository, out: options.get("out")!, gh };
	}
	return null;
}

if (import.meta.main) {
	const asked = command(process.argv.slice(2));
	if (asked === null) {
		console.error(USAGE);
		process.exit(2);
	}
	const gh: Gh = (args) => {
		const result = Bun.spawnSync([asked.gh, ...args], { stdout: "pipe", stderr: "pipe" });
		return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString(), bytes: new Uint8Array(result.stdout) };
	};
	const options = { repository: asked.repository, gh };
	try {
		if (asked.mode === "newest") {
			const newest = newestPublished(options);
			console.error(`the newest published tree: the artifact api ${newest.artifact} of ${newest.url}`);
			console.log(treeId(newest));
		} else if (asked.mode === "check") {
			const verdict = checkTree(asked.tree, options);
			console.log(verdict.message);
			if (!verdict.deploy) process.exit(SKIP);
			if (asked.githubOutput !== undefined) writeFileSync(asked.githubOutput, `tree=${treeId(verdict.tree)}\n`, { flag: "a" });
		} else {
			download(asked.tree, asked.out, options);
			console.log(`put the artifact api ${asked.tree.artifact} of run ${asked.tree.run} into ${asked.out}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
