/**
 * One round of the home-page variations, published: run by the orchestrator once per round,
 * from a checkout of the branch home-variations with nothing uncommitted.
 *
 *     bun run variations:publish --judging DIR [--shots DIR] [--round N] [--from origin|local] [--no-push] [--dry-run]
 *
 *  1. Brings home-variations up to date with origin's (fast-forward only), then merges each
 *     design branch home-v1 … home-v8 that exists (origin's after a fetch, or the local branch
 *     with --from local). A branch that changed anything outside its own directory
 *     (site/src/variations/v<n>/) is not merged, nor is one that conflicts; both are reported.
 *  2. Reads every DIR/*.json, one judgement per judge (scripts/variations-judgement.schema.json),
 *     all of the same round (--round, if given, must agree), a round not yet recorded, and adds
 *     the round to site/variations/scores.json (scripts/variations-scores.schema.json).
 *  3. Works out checkpoints. A design reaches checkpoint T (7, 8, 8.5, 9, 9.5, 10) when every
 *     judge of the round scored it and gave it at least T in every category. For each checkpoint
 *     a design reaches for the first time, it tags the design's commit home/v<n>/cp-<T> and
 *     builds that commit's design into site/public/checkpoints/v<n>/cp-<T>/, served in the
 *     preview at /checkpoints/v<n>/cp-<T>/. The design's commit is the one its screenshots were
 *     taken of (DIR given as --shots holds v<n>/shots.json, written by `bun run shots`), when
 *     that commit is in the branch merged and its design had no uncommitted changes; otherwise
 *     the tip of home-v<n> (or, with no such branch, the last commit that changed the design).
 *  4. Builds everything (`bun run build`: a design that does not build is shown as such; the
 *     command stops only if the picker fails), commits scores.json and the checkpoints, and
 *     pushes home-variations and the new tags in one push, so the round makes one preview
 *     deployment.
 *  5. Prints each subject's lowest and mean score per judge, and the new checkpoints.
 *
 * --no-push does everything but the push. --dry-run reads and checks the judgements, says what
 * would be merged, scored and tagged, and changes nothing.
 * Exit 0 when the round is published, 1 when it is not, 2 on a bad command line.
 */

import Ajv2020 from "ajv/dist/2020";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import judgementSchema from "./variations-judgement.schema.json";
import scoresSchema from "./variations-scores.schema.json";
import { parseArgs, SITE, SLOTS, type Slot } from "./variations/lib";

const REPO = resolve(SITE, "..");
const BRANCH = "home-variations";
const LEVELS = [7, 8, 8.5, 9, 9.5, 10];
const SCORES_PATH = join(SITE, "variations", "scores.json");
const USAGE = "usage: bun run variations:publish --judging DIR [--shots DIR] [--round N] [--from origin|local] [--no-push] [--dry-run]";

type Scores = Record<string, number>;
type Judgement = { schema: string; judge: string; round: number; subjects: { subject: string; scores: Scores; notes: string }[] };
type ScoresFile = {
	schema: string;
	categories: { key: string; name: string }[];
	levels: number[];
	rounds: {
		round: number;
		judges: string[];
		judgements: Record<string, Record<string, { scores: Scores; notes: string }>>;
		merged: Record<string, string | null>;
		new_checkpoints: { design: string; level: number }[];
	}[];
	checkpoints: { design: string; level: number; round: number; commit: string; tag: string; path: string }[];
};

function fail(message: string, code = 1): never {
	console.error(message);
	process.exit(code);
}

function git(args: string[], options: { allowFail?: boolean; cwd?: string } = {}): { ok: boolean; out: string; err: string } {
	const result = Bun.spawnSync(["git", ...args], { cwd: options.cwd ?? REPO, stdout: "pipe", stderr: "pipe" });
	const outcome = { ok: result.exitCode === 0, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
	if (!outcome.ok && !options.allowFail) fail(`git ${args.join(" ")} failed:\n${outcome.err || outcome.out}`);
	return outcome;
}

function levelName(level: number): string {
	return String(level);
}

// ---------------------------------------------------------------- the command line

const { flags } = parseArgs(process.argv.slice(2), ["no-push", "dry-run"]);
const judgingDir = flags.get("judging");
if (typeof judgingDir !== "string") fail(`--judging DIR is needed\n${USAGE}`, 2);
const shotsDir = flags.get("shots");
const from = flags.get("from") ?? "origin";
if (from !== "origin" && from !== "local") fail(`--from is origin or local\n${USAGE}`, 2);
const dryRun = flags.has("dry-run");
const push = !flags.has("no-push") && !dryRun;
const roundFlag = flags.get("round");

// ---------------------------------------------------------------- the judgements

const ajv = new Ajv2020({ allErrors: true });
const validJudgement = ajv.compile(judgementSchema);
const validScores = ajv.compile(scoresSchema);

const scores = JSON.parse(readFileSync(SCORES_PATH, "utf8")) as ScoresFile;
if (!validScores(scores)) fail(`site/variations/scores.json does not match its schema:\n${ajv.errorsText(validScores.errors, { separator: "\n" })}`);

const files = readdirSync(resolve(judgingDir))
	.filter((name) => name.endsWith(".json"))
	.sort();
if (files.length === 0) fail(`${judgingDir} holds no judgement (*.json)`);
const judgements: Judgement[] = [];
for (const name of files) {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(join(resolve(judgingDir), name), "utf8"));
	} catch (error) {
		fail(`${name} does not parse: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!validJudgement(value)) fail(`${name} does not match scripts/variations-judgement.schema.json:\n${ajv.errorsText(validJudgement.errors, { separator: "\n" })}`);
	const judgement = value as Judgement;
	const seen = new Set<string>();
	for (const s of judgement.subjects) {
		if (seen.has(s.subject)) fail(`${name} scores ${s.subject} twice`);
		seen.add(s.subject);
	}
	judgements.push(judgement);
}
const judges = judgements.map((j) => j.judge);
if (new Set(judges).size !== judges.length) fail(`two judgement files name the same judge: ${judges.join(", ")}`);
const rounds = new Set(judgements.map((j) => j.round));
if (rounds.size !== 1) fail(`the judgements are of different rounds: ${[...rounds].join(", ")}`);
const round = judgements[0]!.round;
if (roundFlag !== undefined && Number(roundFlag) !== round) fail(`--round ${roundFlag}, but the judgements are of round ${round}`);
if (scores.rounds.some((r) => r.round === round)) fail(`round ${round} is already in site/variations/scores.json`);

const table: Record<string, Record<string, { scores: Scores; notes: string }>> = {};
for (const j of judgements) table[j.judge] = Object.fromEntries(j.subjects.map((s) => [s.subject, { scores: s.scores, notes: s.notes }]));

function lowestOf(design: string): number | null {
	let lowest = Infinity;
	for (const judge of judges) {
		const entry = table[judge]?.[design];
		if (!entry) return null;
		lowest = Math.min(lowest, ...Object.values(entry.scores));
	}
	return lowest;
}

const reached = new Map<Slot, number[]>();
for (const slot of SLOTS) {
	const lowest = lowestOf(slot);
	if (lowest === null) continue;
	const before = new Set(scores.checkpoints.filter((c) => c.design === slot).map((c) => c.level));
	const fresh = LEVELS.filter((level) => level <= lowest && !before.has(level));
	if (fresh.length) reached.set(slot, fresh);
}

// ---------------------------------------------------------------- the branch

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;
if (branch !== BRANCH) fail(`this checkout is on ${branch}; run the publish script on ${BRANCH}`);
if (git(["status", "--porcelain", "--untracked-files=no"]).out !== "") fail(`${BRANCH} has uncommitted changes; commit or set them aside first`);

if (from === "origin") git(["fetch", "--prune", "--tags", "origin"]);
const remoteBranch = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${BRANCH}`], { allowFail: true });
if (remoteBranch.ok && !dryRun) {
	const ff = git(["merge", "--ff-only", `origin/${BRANCH}`], { allowFail: true });
	if (!ff.ok) fail(`${BRANCH} has diverged from origin/${BRANCH}; reconcile them first:\n${ff.err}`);
}

type MergeOutcome = { slot: Slot; ref: string | null; tip: string | null; state: string };
const merges: MergeOutcome[] = [];
for (const slot of SLOTS) {
	const ref = from === "origin" ? `refs/remotes/origin/home-${slot}` : `refs/heads/home-${slot}`;
	const tip = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
	if (!tip.ok) {
		merges.push({ slot, ref: null, tip: null, state: "no branch" });
		continue;
	}
	const base = git(["merge-base", "HEAD", tip.out], { allowFail: true });
	if (base.ok && base.out === tip.out) {
		merges.push({ slot, ref, tip: tip.out, state: "already merged" });
		continue;
	}
	const changed = git(["diff", "--name-only", base.ok ? base.out : "HEAD", tip.out]).out.split("\n").filter(Boolean);
	const outside = changed.filter((path) => !path.startsWith(`site/src/variations/${slot}/`));
	if (outside.length) {
		merges.push({ slot, ref, tip: null, state: `NOT MERGED: it changes files outside site/src/variations/${slot}/: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", …" : ""}` });
		continue;
	}
	if (dryRun) {
		merges.push({ slot, ref, tip: tip.out, state: `would merge ${changed.length} changed files` });
		continue;
	}
	const merged = git(["merge", "--no-ff", "--no-edit", "-m", `Merge home-${slot} into ${BRANCH} (round ${round})`, tip.out], { allowFail: true });
	if (!merged.ok) {
		git(["merge", "--abort"], { allowFail: true });
		merges.push({ slot, ref, tip: null, state: `NOT MERGED: the merge conflicts:\n${merged.out || merged.err}` });
		continue;
	}
	merges.push({ slot, ref, tip: tip.out, state: `merged ${changed.length} changed files` });
}

// ---------------------------------------------------------------- checkpoints

function shotsCommit(slot: Slot): { commit: string; dirty: boolean } | null {
	if (typeof shotsDir !== "string") return null;
	const path = join(resolve(shotsDir), slot, "shots.json");
	if (!existsSync(path)) return null;
	try {
		const shots = JSON.parse(readFileSync(path, "utf8")) as { commit?: string; dirty?: boolean };
		return typeof shots.commit === "string" ? { commit: shots.commit, dirty: shots.dirty === true } : null;
	} catch {
		return null;
	}
}

function designCommit(slot: Slot): { commit: string; why: string } {
	const merge = merges.find((m) => m.slot === slot)!;
	const tip = merge.tip ?? git(["log", "-1", "--format=%H", "HEAD", "--", `site/src/variations/${slot}`]).out;
	const shots = shotsCommit(slot);
	if (shots && !shots.dirty && git(["merge-base", "--is-ancestor", shots.commit, tip], { allowFail: true }).ok) return { commit: shots.commit, why: "the commit its screenshots were taken of" };
	if (shots?.dirty) return { commit: tip, why: "the branch's tip (its screenshots were taken with uncommitted changes)" };
	return { commit: tip, why: merge.tip ? `the tip of home-${slot}` : "the last commit that changed it" };
}

type NewCheckpoint = { design: Slot; level: number; commit: string; why: string; tag: string; path: string; tagged: string };
const newCheckpoints: NewCheckpoint[] = [];
for (const [slot, levels] of reached) {
	const { commit, why } = designCommit(slot);
	for (const level of levels) {
		const name = `cp-${levelName(level)}`;
		newCheckpoints.push({ design: slot, level, commit, why, tag: `home/${slot}/${name}`, path: `/checkpoints/${slot}/${name}/`, tagged: "" });
	}
}

function buildFrozen(checkpoint: NewCheckpoint): void {
	const work = mkdtempSync(join(tmpdir(), `ledgermath-${checkpoint.design}-${checkpoint.level}-`));
	try {
		git(["worktree", "add", "--detach", work, checkpoint.commit]);
		symlinkSync(join(SITE, "node_modules"), join(work, "site", "node_modules"), "dir");
		const out = join(SITE, "public", "checkpoints", checkpoint.design, `cp-${levelName(checkpoint.level)}`);
		const built = Bun.spawnSync(["bun", "scripts/variations/build-one.ts", checkpoint.design, "--out", out, "--base", checkpoint.path, "--quiet"], {
			cwd: join(work, "site"),
			stdout: "pipe",
			stderr: "pipe",
		});
		if (built.exitCode !== 0) fail(`${checkpoint.design} at ${checkpoint.commit} does not build, so checkpoint ${checkpoint.level} cannot be frozen:\n${built.stderr}`);
	} finally {
		git(["worktree", "remove", "--force", work], { allowFail: true });
		rmSync(work, { recursive: true, force: true });
	}
}

if (!dryRun) {
	for (const checkpoint of newCheckpoints) {
		buildFrozen(checkpoint);
		const exists = git(["rev-parse", "--verify", "--quiet", `refs/tags/${checkpoint.tag}`], { allowFail: true });
		if (exists.ok) {
			checkpoint.tagged = exists.out === checkpoint.commit ? "tag already there" : `TAG ALREADY THERE, on ${exists.out.slice(0, 12)}: left as it is`;
		} else {
			git(["tag", "-a", checkpoint.tag, "-m", `${checkpoint.design} reached checkpoint ${checkpoint.level} in round ${round} of the home-page variations`, checkpoint.commit]);
			checkpoint.tagged = "tagged";
		}
	}

	scores.rounds.push({
		round,
		judges,
		judgements: table,
		merged: Object.fromEntries(merges.map((m) => [m.slot, m.state.startsWith("merged") ? m.tip : null])),
		new_checkpoints: newCheckpoints.map((c) => ({ design: c.design, level: c.level })),
	});
	scores.checkpoints.push(...newCheckpoints.map((c) => ({ design: c.design, level: c.level, round, commit: c.commit, tag: c.tag, path: c.path })));
	if (!validScores(scores)) fail(`the new scores.json would not match its schema:\n${ajv.errorsText(validScores.errors, { separator: "\n" })}`);
	writeFileSync(SCORES_PATH, `${JSON.stringify(scores, null, "\t")}\n`);

	const build = Bun.spawnSync(["bun", "run", "build"], { cwd: SITE, stdout: "pipe", stderr: "pipe" });
	console.log(build.stdout.toString().trim());
	if (build.exitCode !== 0) fail(`bun run build failed; nothing is committed or pushed (the merges are, locally):\n${build.stderr}`);

	git(["add", "site/variations/scores.json", ...(existsSync(join(SITE, "public", "checkpoints")) ? ["site/public/checkpoints"] : [])]);
	git([
		"commit",
		"-m",
		`Round ${round} of the home-page variations: scores from ${judges.join(", ")}${newCheckpoints.length ? `, ${newCheckpoints.length} new checkpoint${newCheckpoints.length === 1 ? "" : "s"}` : ""}`,
	]);

	if (push) {
		const refs = [`refs/heads/${BRANCH}:refs/heads/${BRANCH}`, ...newCheckpoints.filter((c) => c.tagged === "tagged").map((c) => `refs/tags/${c.tag}`)];
		const pushed = git(["push", "--atomic", "origin", ...refs], { allowFail: true });
		if (!pushed.ok) fail(`the push failed; everything is committed and tagged locally:\n${pushed.err}`);
	}
}

// ---------------------------------------------------------------- the report

const names = Object.fromEntries(
	SLOTS.map((slot) => {
		try {
			return [slot, (JSON.parse(readFileSync(join(SITE, "src", "variations", slot, "meta.json"), "utf8")) as { name: string }).name];
		} catch {
			return [slot, ""];
		}
	}),
);
console.log(`\nRound ${round}${dryRun ? " (dry run: nothing changed)" : ""}: judges ${judges.join(", ")}`);
for (const m of merges) console.log(`  home-${m.slot}: ${m.state}`);
const subjects = [...new Set(judgements.flatMap((j) => j.subjects.map((s) => s.subject)))].sort(
	(a, b) => Number(a.startsWith("ref:")) - Number(b.startsWith("ref:")) || a.localeCompare(b, "en", { numeric: true }),
);
const header = ["subject".padEnd(32), ...judges.map((j) => `${j} lowest/mean`.padEnd(24)), "checkpoint"].join("");
console.log(`\n${header}`);
for (const subject of subjects) {
	const cells = judges.map((judge) => {
		const entry = table[judge]?.[subject];
		if (!entry) return "–".padEnd(24);
		const values = Object.values(entry.scores);
		return `${Math.min(...values)} / ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)}`.padEnd(24);
	});
	const fresh = newCheckpoints.filter((c) => c.design === subject).map((c) => c.level);
	const label = subject.startsWith("ref:") ? subject : `${subject} ${names[subject] ?? ""}`;
	console.log([label.slice(0, 31).padEnd(32), ...cells, fresh.length ? `new: ${fresh.join(", ")}` : ""].join(""));
}
if (newCheckpoints.length) {
	console.log(`\nNew checkpoints${dryRun ? " (would be)" : ""}:`);
	for (const c of newCheckpoints) console.log(`  ${c.tag} at ${c.commit.slice(0, 12)} (${c.why})${c.tagged ? `: ${c.tagged}` : ""}; frozen at ${c.path}`);
} else {
	console.log("\nNo new checkpoint.");
}
if (!dryRun) console.log(push ? `\nPushed ${BRANCH}${newCheckpoints.length ? " and the new tags" : ""} to origin in one push.` : "\nCommitted locally; not pushed (--no-push).");
