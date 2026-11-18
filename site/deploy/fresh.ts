/**
 * Says whether a production deploy of COMMIT may go ahead: only if COMMIT is
 * on main and nothing the site is built from differs between COMMIT and MAIN,
 * main's tip. What the site is built from is the paths that start a push run
 * of .github/workflows/site.yml (its `on.push.paths`), read from that file, so
 * the list lives in one place.
 *
 *     bun site/deploy/fresh.ts COMMIT MAIN    (in the clone)
 *
 * Run it in a clone that holds all of main's history (not shallow); a
 * blobless one will do, since the comparison reads commits and trees alone.
 * The workflow runs it inside the production concurrency group, before Vercel
 * is called, in a second checkout of main made there, with MAIN that clone's
 * refs/remotes/origin/main. (The job's own checkout cannot serve: when main
 * has moved since the run began, actions/checkout points its origin/main at
 * the run's commit.)
 *
 * If those paths differ, main has a newer commit that started a run of its
 * own, which deploys after this one or already has (production deploy jobs
 * wait their turn in one queue); deploying COMMIT would move ledgermath.com
 * back. If they do not differ, COMMIT's site is main's,
 * even when main has moved on in files the site is not built from (which
 * start no run). A COMMIT that is not on main (force-pushed away) is never
 * deployed to production.
 *
 * Exit 0: deploy. Exit 3: skip; stdout says why, naming both commits. Any
 * other exit: the check itself failed (a git command did, say), and the
 * deploy must not go ahead.
 */

import { fileURLToPath } from "node:url";

export const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/site.yml", import.meta.url));
export const SKIP = 3;

/**
 * The workflow's `on.push.paths` as git pathspecs. GitHub's filter patterns
 * and git's glob pathspecs agree on `*` (not across `/`), `**`, `?` and
 * `[...]`; a pattern using GitHub's `!` or `+` has no such twin and throws.
 */
export function sitePaths(workflowText: string): string[] {
	const workflow = Bun.YAML.parse(workflowText) as { on?: { push?: { paths?: unknown } } } | null;
	const paths = workflow?.on?.push?.paths;
	if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => typeof path === "string" && path !== "")) {
		throw new Error("the workflow has no on.push.paths list of patterns");
	}
	return paths.map((pattern: string) => {
		if (pattern.startsWith("!") || pattern.includes("+")) {
			throw new Error(`fresh.ts does not translate the path pattern ${JSON.stringify(pattern)} into a git pathspec`);
		}
		return `:(glob)${pattern}`;
	});
}

function git(cwd: string | undefined, ...args: string[]): { status: number; out: string; err: string } {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return { status: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

/**
 * REV's commit, or undefined if the clone has no such commit. With --quiet,
 * git says that by exiting 1 and printing nothing; any other failure (a
 * corrupt object exits 128) is git failing, not an answer, and throws with
 * git's message.
 */
function resolve(cwd: string | undefined, rev: string): string | undefined {
	const result = git(cwd, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
	if (result.status === 0) return result.out;
	if (result.status === 1 && result.err === "") return undefined;
	throw new Error(`git rev-parse --verify ${rev}^{commit} failed (exit ${result.status}): ${result.err}`);
}

const notOnMain = (commit: string, tip: string): Verdict => ({
	deploy: false,
	message: `Production deploy skipped: this run's commit ${commit} is not on main (main's tip is ${tip}), so it is not deployed to production.`,
});

export type Verdict = { deploy: boolean; message: string };

/** Whether COMMIT may be deployed to production, with MAIN main's tip and PATHSPECS what the site is built from. */
export function freshness(commit: string, main: string, pathspecs: readonly string[], cwd?: string): Verdict {
	const tip = resolve(cwd, main);
	if (tip === undefined) throw new Error(`main ${JSON.stringify(main)} is not a commit in this clone`);
	const shallow = git(cwd, "rev-parse", "--is-shallow-repository");
	if (shallow.status !== 0 || shallow.out !== "false") {
		throw new Error("this clone is shallow (or not a git repository): it may lack the history that links the commits");
	}
	const ours = resolve(cwd, commit);
	// The clone holds every commit main's history has, so one it lacks is not on main.
	if (ours === undefined) return notOnMain(commit, tip);
	const ancestor = git(cwd, "merge-base", "--is-ancestor", ours, tip);
	if (ancestor.status === 1) return notOnMain(ours, tip);
	if (ancestor.status !== 0) throw new Error(`git merge-base --is-ancestor failed: ${ancestor.err}`);
	// Trees only, no rename detection: a blobless clone has everything this reads.
	const diff = git(cwd, "diff", "--name-only", "--no-renames", ours, tip, "--", ...pathspecs);
	if (diff.status !== 0) throw new Error(`git diff failed: ${diff.err}`);
	const changed = diff.out === "" ? [] : diff.out.split("\n");
	if (changed.length > 0) {
		const shown = changed.slice(0, 10).join(", ") + (changed.length > 10 ? `, and ${changed.length - 10} more` : "");
		return {
			deploy: false,
			message:
				`Production deploy skipped: main has moved on. What the site is built from differs between this run's commit ${ours} ` +
				`and main's tip ${tip} (${shown}). The newer commit's own run deploys main's site after this one, or already has; ` +
				`if that run failed, was cancelled or never started, run this workflow by hand on main.`,
		};
	}
	return {
		deploy: true,
		message:
			ours === tip
				? `This run's commit ${ours} is main's tip.`
				: `This run's commit ${ours} is on main, and what the site is built from is the same at main's tip ${tip}.`,
	};
}

if (import.meta.main) {
	const [commit, main] = process.argv.slice(2);
	if (commit === undefined || main === undefined || process.argv.length !== 4) {
		console.error("usage: bun site/deploy/fresh.ts COMMIT MAIN");
		process.exit(2);
	}
	try {
		const verdict = freshness(commit, main, sitePaths(await Bun.file(WORKFLOW).text()));
		console.log(verdict.message);
		process.exit(verdict.deploy ? 0 : SKIP);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}
}
