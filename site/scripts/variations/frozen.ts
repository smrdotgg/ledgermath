/**
 * Frozen copies of a design: the design as it was at some commit, built by that commit's own
 * build-one.ts and served at a base path of its own. One mechanism for both kinds:
 *
 *  - checkpoints, `home/v<n>/cp-<T>`: frozen by the publish script when a design's scores pass
 *    level T, and committed under site/public/checkpoints/v<n>/cp-<T>/ (served at
 *    /checkpoints/v<n>/cp-<T>/), the record of what was judged;
 *  - forms, `home/v<n>/form-<name>`: the same design with a different amount of text, tagged by a
 *    design worker, built afresh by every `bun run build` into dist/client/forms/v<n>/<name>/
 *    (served at /forms/v<n>/<name>/). They are not committed: a form's tag may move while a
 *    worker refines it, and two dozen copies of ~300 KB each, rewritten every time one moves,
 *    would bloat the branch's history. A build takes about two seconds each, four at a time.
 *
 * The commit's tree under site/ is written to a temporary directory with `git archive` (so the
 * commit need not be an ancestor of HEAD, nor checked out; it must only be in the repository),
 * node_modules is linked in from this checkout, and the commit's own build-one.ts builds the
 * design. A commit whose design does not build gives the error; nothing else is affected.
 */

import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSlot, SITE, type Slot } from "./lib";

export const REPO = resolve(SITE, "..");
const TIME_LIMIT_MS = 180_000;

export type Frozen = { builds: true; error: null; ms: number } | { builds: false; error: string; ms: number };

/** Builds design SLOT as it is at COMMIT into OUT, served at BASE. Never throws for a design that does not build. */
export async function freezeDesign(options: { slot: Slot; commit: string; out: string; base: string }): Promise<Frozen> {
	const started = performance.now();
	const work = mkdtempSync(join(tmpdir(), `ledgermath-${options.slot}-`));
	const elapsed = () => Math.round(performance.now() - started);
	try {
		const archive = Bun.spawn(["git", "archive", "--format=tar", options.commit, "site"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		const untar = Bun.spawn(["tar", "-x", "-C", work], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
		const [archived, untarred, archiveErr, untarErr] = await Promise.all([archive.exited, untar.exited, new Response(archive.stderr).text(), new Response(untar.stderr).text()]);
		if (archived !== 0 || untarred !== 0) return { builds: false, error: `the commit's files could not be read: ${(archiveErr || untarErr).trim()}`, ms: elapsed() };
		const site = join(work, "site");
		if (!existsSync(join(site, "scripts", "variations", "build-one.ts"))) return { builds: false, error: `commit ${options.commit.slice(0, 12)} has no site/scripts/variations/build-one.ts`, ms: elapsed() };
		symlinkSync(join(SITE, "node_modules"), join(site, "node_modules"), "dir");
		const child = Bun.spawn(["bun", "scripts/variations/build-one.ts", options.slot, "--out", resolve(options.out), "--base", options.base, "--quiet"], { cwd: site, stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => child.kill("SIGKILL"), TIME_LIMIT_MS);
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		clearTimeout(timer);
		if (code === 0 && existsSync(join(options.out, "index.html"))) return { builds: true, error: null, ms: elapsed() };
		const said = `${stderr}\n${stdout}`.trim().split("\n").slice(-40).join("\n");
		return { builds: false, error: child.signalCode === "SIGKILL" ? `stopped after ${TIME_LIMIT_MS / 1000} s without finishing\n${said}` : said || `exited ${code}`, ms: elapsed() };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

export type FormTag = { design: Slot; name: string; tag: string; commit: string; path: string };

const FORM_TAG = /^home\/(v\d+)\/form-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * The form tags in this repository (`git fetch origin --tags` first to have origin's), each with
 * the commit it names and the address its copy is served at. Tags that look like forms but name
 * no design or an unusable name are returned in `ignored`, with why.
 */
export function formTags(): { forms: FormTag[]; ignored: string[] } {
	const listed = Bun.spawnSync(["git", "for-each-ref", "--format=%(refname:strip=2) %(objectname) %(*objectname)", "refs/tags/home/"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
	if (listed.exitCode !== 0) return { forms: [], ignored: [`git for-each-ref failed: ${listed.stderr.toString().trim()}`] };
	const forms: FormTag[] = [];
	const ignored: string[] = [];
	for (const line of listed.stdout.toString().split("\n")) {
		const [tag, object, peeled] = line.trim().split(" ");
		if (!tag || !object || !/^home\/[^/]+\/form-/.test(tag)) continue;
		const match = FORM_TAG.exec(tag);
		if (!match || !isSlot(match[1]!)) {
			ignored.push(`${tag}: a form tag is home/v<1-8>/form-<name>, the name of lowercase letters, digits and single dashes`);
			continue;
		}
		const design = match[1] as Slot;
		const name = match[2]!;
		forms.push({ design, name, tag, commit: peeled || object, path: `/forms/${design}/${name}/` });
	}
	forms.sort((a, b) => a.design.localeCompare(b.design, "en", { numeric: true }) || a.name.localeCompare(b.name));
	return { forms, ignored };
}
