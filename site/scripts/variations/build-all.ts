/**
 * Builds the whole preview of the home-page variations into dist/client: each design at
 * /v<n>/, each form at /forms/v<n>/<name>/, the picker at /, and site/public/ (the notices,
 * the frozen checkpoints) as it is.
 *
 *     bun run build
 *
 * Each design is built by build-one.ts in a process of its own, with a time limit, so a design
 * whose build fails, throws or hangs breaks nothing else: it is left out, and the picker shows
 * it as "does not build", with the error. The command still exits 0.
 *
 * The forms are the tags home/v<n>/form-<name> in this repository (`git fetch origin --tags`
 * first; the workflow fetches origin's), each built from its own commit by that commit's
 * build-one.ts, alongside the designs and in the same way (scripts/variations/frozen.ts says
 * why they are built afresh, not committed). A form that does not build is shown as such.
 * Every page the picker links to (design, form, checkpoint) has its words counted
 * (scripts/variations/words.ts) for the picker. It exits 1 only when
 * what is shared fails: the picker, or copying site/public/.
 *
 * The picker's input (each design's meta.json, whether it built, the scores in
 * site/variations/scores.json and the checkpoints under site/public/checkpoints/) is written
 * to dist/.variations/picker-input.json and handed to the picker's build. What each design's
 * build said is also served at /variations.json.
 */

import { availableParallelism } from "node:os";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Frozen, formTags, freezeDesign } from "./frozen";
import { buildPage, pageDir, SITE, SLOTS, type Slot } from "./lib";
import { countWords, type WordCount } from "./words";

const DIST = join(SITE, "dist");
const CLIENT = join(DIST, "client");
const WORK = join(DIST, ".variations");
const TIME_LIMIT_MS = 180_000;

import type { Checkpoint, DesignStatus, Form, PickerInput } from "../../src/picker/input";

function wordsOf(dir: string): WordCount | null {
	const page = join(dir, "index.html");
	return existsSync(page) ? countWords(readFileSync(page, "utf8")) : null;
}

function readMeta(slot: Slot): { name: string; idea: string; problem: string | null } {
	const fallback = { name: slot, idea: "" };
	const path = join(pageDir(slot), "meta.json");
	if (!existsSync(path)) return { ...fallback, problem: "meta.json is missing" };
	try {
		const meta = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; idea?: unknown };
		if (typeof meta.name !== "string" || meta.name.trim() === "" || meta.name.length > 40) return { ...fallback, problem: "meta.json's name must be text of 1 to 40 characters" };
		if (typeof meta.idea !== "string" || meta.idea.length > 200) return { ...fallback, name: meta.name, problem: "meta.json's idea must be text of up to 200 characters" };
		return { name: meta.name, idea: meta.idea, problem: null };
	} catch (error) {
		return { ...fallback, problem: `meta.json does not parse: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function buildDesign(slot: Slot): Promise<{ builds: boolean; error: string | null; ms: number }> {
	const started = performance.now();
	const out = join(WORK, "parts", slot);
	const child = Bun.spawn(["bun", join(SITE, "scripts", "variations", "build-one.ts"), slot, "--out", out, "--base", `/${slot}/`, "--quiet"], {
		cwd: SITE,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), TIME_LIMIT_MS);
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	clearTimeout(timer);
	const ms = Math.round(performance.now() - started);
	if (code === 0 && existsSync(join(out, "index.html"))) return { builds: true, error: null, ms };
	const said = `${stderr}\n${stdout}`.trim().split("\n").slice(-40).join("\n");
	const error = child.signalCode === "SIGKILL" ? `stopped after ${TIME_LIMIT_MS / 1000} s without finishing\n${said}` : said || `exited ${code}`;
	return { builds: false, error, ms };
}

async function inTurn<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await work(items[index]!);
			}
		}),
	);
	return results;
}

function checkpoints(): Checkpoint[] {
	const root = join(SITE, "public", "checkpoints");
	const found: Checkpoint[] = [];
	for (const slot of SLOTS) {
		const dir = join(root, slot);
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir).sort()) {
			const level = /^cp-(\d+(?:\.\d+)?)$/.exec(name)?.[1];
			if (level && existsSync(join(dir, name, "index.html"))) found.push({ design: slot, level, path: `/checkpoints/${slot}/${name}/`, words: wordsOf(join(dir, name)) });
		}
	}
	return found.sort((a, b) => a.design.localeCompare(b.design) || Number(a.level) - Number(b.level));
}

function commit(): string | null {
	if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
	const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: SITE, stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

if (import.meta.main) {
	const started = performance.now();
	rmSync(CLIENT, { recursive: true, force: true });
	rmSync(WORK, { recursive: true, force: true });
	mkdirSync(join(WORK, "parts"), { recursive: true });

	const limit = Math.max(1, Math.min(4, availableParallelism()));
	const tags = formTags();
	const formOut = (form: { design: Slot; name: string }) => join(WORK, "parts", "forms", form.design, form.name);
	type Job = { slot: Slot } | { form: (typeof tags.forms)[number] };
	const jobs: Job[] = [...SLOTS.map((slot) => ({ slot })), ...tags.forms.map((form) => ({ form }))];
	const done = await inTurn(jobs, limit, (job): Promise<Frozen | { builds: boolean; error: string | null; ms: number }> =>
		"slot" in job ? buildDesign(job.slot) : freezeDesign({ slot: job.form.design, commit: job.form.commit, out: formOut(job.form), base: job.form.path }),
	);
	const designs: DesignStatus[] = SLOTS.map((slot, i) => {
		const meta = readMeta(slot);
		const result = done[i]!;
		return { slot, name: meta.name, idea: meta.idea, metaProblem: meta.problem, ...result, words: result.builds ? wordsOf(join(WORK, "parts", slot)) : null };
	});
	const forms: Form[] = tags.forms.map((form, i) => {
		const result = done[SLOTS.length + i]!;
		return { ...form, builds: result.builds, error: result.error, words: result.builds ? wordsOf(formOut(form)) : null };
	});

	let scores: unknown = { rounds: [] };
	let scoresProblem: string | null = null;
	const scoresPath = join(SITE, "variations", "scores.json");
	try {
		scores = JSON.parse(readFileSync(scoresPath, "utf8"));
	} catch (error) {
		scoresProblem = `site/variations/scores.json does not read: ${error instanceof Error ? error.message : String(error)}`;
	}

	const input: PickerInput = { commit: commit(), designs, scores, scoresProblem, checkpoints: checkpoints(), forms, formsIgnored: tags.ignored };
	const inputPath = join(WORK, "picker-input.json");
	writeFileSync(inputPath, `${JSON.stringify(input, null, "\t")}\n`);

	// What is shared: a failure from here on fails the command.
	process.env.LM_PICKER_INPUT = inputPath;
	await buildPage("picker", { out: join(WORK, "parts", "picker"), base: "/", quiet: true });
	mkdirSync(CLIENT, { recursive: true });
	for (const entry of readdirSync(join(WORK, "parts", "picker"))) renameSync(join(WORK, "parts", "picker", entry), join(CLIENT, entry));
	for (const design of designs) if (design.builds) renameSync(join(WORK, "parts", design.slot), join(CLIENT, design.slot));
	for (const form of forms) {
		if (!form.builds) continue;
		mkdirSync(join(CLIENT, "forms", form.design), { recursive: true });
		renameSync(formOut(form), join(CLIENT, "forms", form.design, form.name));
	}
	cpSync(join(SITE, "public"), CLIENT, { recursive: true });
	writeFileSync(join(CLIENT, "variations.json"), `${JSON.stringify({ commit: input.commit, designs, forms }, null, "\t")}\n`);

	for (const design of designs) {
		const state = design.builds ? `built in ${design.ms} ms` : "DOES NOT BUILD";
		console.log(`${design.slot}  ${design.name.padEnd(20)} ${state}${design.metaProblem ? ` (${design.metaProblem})` : ""}`);
		if (!design.builds) console.log(design.error!.replace(/^/gm, "      "));
	}
	for (const form of forms) {
		console.log(`${form.design}  form ${form.name.padEnd(15)} ${form.builds ? `built in ${done[SLOTS.length + forms.indexOf(form)]!.ms} ms` : "DOES NOT BUILD"} (${form.tag} at ${form.commit.slice(0, 12)})`);
		if (!form.builds) console.log(form.error!.replace(/^/gm, "      "));
	}
	for (const why of tags.ignored) console.log(`ignored: ${why}`);
	if (scoresProblem) console.log(scoresProblem);
	const failed = designs.filter((d) => !d.builds).length;
	const formsFailed = forms.filter((f) => !f.builds).length;
	console.log(
		`dist/client: the picker, ${designs.length - failed} of ${designs.length} designs${failed ? ` (${failed} shown as not building)` : ""}, ${forms.length - formsFailed} of ${forms.length} forms${formsFailed ? ` (${formsFailed} shown as not building)` : ""}, ${input.checkpoints.length} checkpoints, in ${Math.round(performance.now() - started)} ms`,
	);
}
