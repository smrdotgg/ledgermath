// deploy/fresh.ts against throwaway git repositories. Run with `bun test`
// inside site/.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freshness, SKIP, sitePaths, WORKFLOW } from "./fresh";

const PATHS = sitePaths(await Bun.file(WORKFLOW).text());

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.test", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

/** Overwrites COMMIT's loose object with bytes git cannot inflate. */
function corrupt(dir: string, commit: string) {
	const object = join(dir, ".git", "objects", commit.slice(0, 2), commit.slice(2));
	chmodSync(object, 0o644);
	writeFileSync(object, "not a zlib stream");
}

/** A repository on main; commit() writes files and returns the new commit. */
function repo() {
	const dir = mkdtempSync(join(tmpdir(), "fresh-test-"));
	made.push(dir);
	run(dir, "init", "-q", "-b", "main");
	const commit = (files: Record<string, string>) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), text);
		}
		run(dir, "add", "-A");
		run(dir, "commit", "-q", "-m", "change");
		return run(dir, "rev-parse", "HEAD");
	};
	return { dir, commit };
}

describe("sitePaths", () => {
	test("reads the push trigger's paths from the workflow", () => {
		expect(PATHS).toEqual([":(glob)site/**", ":(glob).github/workflows/site.yml"]);
	});

	test("refuses a pattern git cannot match the same way", () => {
		expect(() => sitePaths("on:\n  push:\n    paths: ['site/**', '!site/README.md']\n")).toThrow("!site/README.md");
		expect(() => sitePaths("on:\n  push:\n    branches: [main]\n")).toThrow("on.push.paths");
	});
});

describe("freshness", () => {
	test("deploys main's tip", () => {
		const { dir, commit } = repo();
		const a = commit({ "site/index.ts": "1" });
		expect(freshness(a, "main", PATHS, dir).deploy).toBe(true);
	});

	test("deploys a commit main has moved past only in files the site is not built from", () => {
		const { dir, commit } = repo();
		const a = commit({ "site/index.ts": "1", "README.md": "1" });
		const b = commit({ "README.md": "2", ".github/workflows/other.yml": "x", "sitemap/x": "y" });
		const verdict = freshness(a, "main", PATHS, dir);
		expect(verdict.deploy).toBe(true);
		expect(verdict.message).toContain(b);
	});

	test("skips a commit when a later one on main changed the site, naming both", () => {
		const { dir, commit } = repo();
		const a = commit({ "site/index.ts": "1" });
		const b = commit({ "site/deep/er/x.css": "2" });
		const verdict = freshness(a, "main", PATHS, dir);
		expect(verdict.deploy).toBe(false);
		expect(verdict.message).toContain("main has moved on");
		expect(verdict.message).toContain(a);
		expect(verdict.message).toContain(b);
		expect(verdict.message).toContain("site/deep/er/x.css");
	});

	test("skips a commit when a later one changed the workflow", () => {
		const { dir, commit } = repo();
		const a = commit({ "site/index.ts": "1", ".github/workflows/site.yml": "1" });
		commit({ ".github/workflows/site.yml": "2" });
		expect(freshness(a, "main", PATHS, dir).deploy).toBe(false);
	});

	test("deploys a commit whose site main changed and changed back", () => {
		const { dir, commit } = repo();
		const a = commit({ "site/index.ts": "1" });
		commit({ "site/index.ts": "2" });
		commit({ "site/index.ts": "1" });
		expect(freshness(a, "main", PATHS, dir).deploy).toBe(true);
	});

	test("skips a commit that is not on main, even with the same site", () => {
		const { dir, commit } = repo();
		commit({ "site/index.ts": "1" });
		run(dir, "checkout", "-q", "-b", "gone");
		const gone = commit({ "README.md": "elsewhere" });
		run(dir, "checkout", "-q", "main");
		const tip = commit({ "notes.txt": "x" });
		const verdict = freshness(gone, "main", PATHS, dir);
		expect(verdict.deploy).toBe(false);
		expect(verdict.message).toContain("is not on main");
		expect(verdict.message).toContain(gone);
		expect(verdict.message).toContain(tip);
	});

	test("skips a commit the clone lacks: a full clone of main has every commit on it", () => {
		const { dir, commit } = repo();
		const tip = commit({ "site/index.ts": "1" });
		const verdict = freshness("0".repeat(40), "main", PATHS, dir);
		expect(verdict.deploy).toBe(false);
		expect(verdict.message).toContain(`${"0".repeat(40)} is not on main (main's tip is ${tip})`);
	});

	test("throws with git's message when git cannot read the run's commit, rather than skip", () => {
		const { dir, commit } = repo();
		const a = commit({ "site/index.ts": "1" });
		commit({ "site/index.ts": "2" });
		corrupt(dir, a);
		expect(() => freshness(a, "main", PATHS, dir)).toThrow(/rev-parse.*exit 128.*corrupt/s);
	});

	test("throws, in a shallow clone, rather than guess", () => {
		const { dir, commit } = repo();
		const a = commit({ "site/index.ts": "1" });
		commit({ "README.md": "2" });
		const shallow = mkdtempSync(join(tmpdir(), "fresh-test-"));
		made.push(shallow);
		run(shallow, "clone", "-q", "--depth", "1", `file://${dir}`, ".");
		expect(() => freshness(a, "refs/remotes/origin/main", PATHS, shallow)).toThrow("shallow");
	});

	test("reads a blobless clone of main, as the workflow makes, without fetching", () => {
		const { dir, commit } = repo();
		const a = commit({ "site/index.ts": "1" });
		const b = commit({ "site/index.ts": "2" });
		run(dir, "config", "uploadpack.allowFilter", "true");
		const clone = mkdtempSync(join(tmpdir(), "fresh-test-"));
		made.push(clone);
		run(clone, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${dir}`, ".");
		// Nothing to fetch a missing blob from: the check must not need one.
		run(clone, "remote", "set-url", "origin", join(clone, "nowhere"));
		const verdict = freshness(a, "refs/remotes/origin/main", PATHS, clone);
		expect(verdict.deploy).toBe(false);
		expect(verdict.message).toContain(b);
		expect(freshness(b, "refs/remotes/origin/main", PATHS, clone).deploy).toBe(true);
	});
});

describe("the command", () => {
	const script = join(import.meta.dir, "fresh.ts");
	const command = (cwd: string, ...args: string[]) => {
		const result = Bun.spawnSync([process.execPath, script, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		return { status: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
	};

	test("exits 0 to deploy and SKIP to skip, saying why", () => {
		const { dir, commit } = repo();
		const a = commit({ "site/index.ts": "1" });
		expect(command(dir, a, "main").status).toBe(0);
		commit({ "site/index.ts": "2" });
		const skipped = command(dir, a, "main");
		expect(skipped.status).toBe(SKIP);
		expect(skipped.out).toContain("main has moved on");
	});

	test("fails, neither deploying nor skipping, when git fails on the run's commit", () => {
		const { dir, commit } = repo();
		const a = commit({ "site/index.ts": "1" });
		commit({ "site/index.ts": "2" });
		corrupt(dir, a);
		const result = command(dir, a, "main");
		expect(result.status).not.toBe(0);
		expect(result.status).not.toBe(SKIP);
		expect(result.err).toContain(`loose object ${a}`);
		expect(result.err).toContain("is corrupt");
	});

	test("fails, neither deploying nor skipping, when it cannot tell", () => {
		const { dir, commit } = repo();
		commit({ "site/index.ts": "1" });
		const result = command(dir, "HEAD", "refs/remotes/origin/main");
		expect(result.status).toBe(2);
		expect(result.err).toContain("main \"refs/remotes/origin/main\" is not a commit in this clone");
	});
});
