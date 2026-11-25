// deploy/deploy.sh against a stand-in Vercel CLI, no network: each test copies
// the script into a temporary directory beside a stub at
// node_modules/.bin/vercel that records its arguments and prints what the test
// gives it. Run with `bun test` inside site/.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "deploy.sh");
const BASH = Bun.which("bash") ?? "/bin/bash";
const URL = "https://ledgermath-abc123-team.vercel.app";
const READY = { id: "dpl_1", url: URL, readyState: "READY", target: "production" };

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A git command in DIR, its output. */
function git(dir: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.test", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

/** deploy.sh, with a stub CLI that prints OUTPUT, run on a one-file site; with `checkout`, the script's directory is a git checkout of one commit. */
function deploy(output: string, { target = "production", path = process.env.PATH ?? "", checkout = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "deploy-test-"));
	made.push(dir);
	copyFileSync(SCRIPT, join(dir, "deploy.sh"));
	if (checkout) {
		git(dir, "init", "-q", "-b", "main");
		git(dir, "add", "deploy.sh");
		git(dir, "commit", "-q", "-m", "the site's sources");
	}
	mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
	writeFileSync(join(dir, "output.json"), output);
	const stub = join(dir, "node_modules/.bin/vercel");
	writeFileSync(stub, `#!${BASH}\nprintf '%s\\n' "$@" >"${dir}/args"\ncat "${dir}/output.json"\n`);
	chmodSync(stub, 0o755);
	mkdirSync(join(dir, "site"));
	writeFileSync(join(dir, "site/index.html"), "<!DOCTYPE html>");
	const result = Bun.spawnSync([BASH, join(dir, "deploy.sh"), join(dir, "site"), target], {
		env: { PATH: path, VERCEL_TOKEN: "t", VERCEL_ORG_ID: "o", VERCEL_PROJECT_ID: "p", GITHUB_SHA: "abc" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const args = existsSync(join(dir, "args")) ? readFileSync(join(dir, "args"), "utf8").trim().split("\n") : undefined;
	return { status: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), args, dir };
}

describe("deploy.sh", () => {
	test("prints a READY deployment and deploys production with --prod", () => {
		const result = deploy(JSON.stringify(READY));
		expect(result.status).toBe(0);
		expect(JSON.parse(result.out)).toEqual(READY);
		expect(result.args).toContain("--prebuilt");
		expect(result.args).toContain("--prod");
		expect(result.args).toContain("commit=abc");
	});

	test("records the commit of the checkout it runs from, not GITHUB_SHA: the site job checks out main, which can be newer than the run's commit", () => {
		const result = deploy(JSON.stringify(READY), { checkout: true });
		expect(result.status).toBe(0);
		const head = git(result.dir, "rev-parse", "HEAD");
		expect(head).toMatch(/^[0-9a-f]{40}$/);
		expect(result.args).toContain(`commit=${head}`);
		expect(result.args).not.toContain("commit=abc");
	});

	test("prints the deployment the same way when the CLI nests it under deployment", () => {
		const result = deploy(JSON.stringify({ status: "ok", deployment: READY }));
		expect(result.status).toBe(0);
		expect(JSON.parse(result.out)).toEqual(READY);
	});

	test("deploys a preview without --prod", () => {
		const result = deploy(JSON.stringify({ ...READY, target: null }), { target: "preview" });
		expect(result.status).toBe(0);
		expect(result.args).not.toContain("--prod");
	});

	const fails = (name: string, output: string, says: string) =>
		test(`fails ${name}`, () => {
			const result = deploy(output);
			expect(result.status).not.toBe(0);
			expect(result.out).toBe("");
			expect(result.err).toContain(says);
		});

	fails("a deployment that is not READY", JSON.stringify({ ...READY, readyState: "ERROR" }), 'readyState is "ERROR", not READY');
	fails("a READY deployment with an empty url", JSON.stringify({ ...READY, url: "" }), 'url "" is not an absolute https:// URL');
	fails("a READY deployment whose url is not a URL", JSON.stringify({ ...READY, url: "garbage" }), 'url "garbage" is not an absolute https:// URL');
	fails("a READY deployment with a bare host", JSON.stringify({ ...READY, url: "ledgermath.vercel.app" }), "is not an absolute https:// URL");
	fails("a READY deployment over http", JSON.stringify({ ...READY, url: "http://ledgermath.vercel.app" }), "is not an absolute https:// URL");
	fails("a READY deployment without a url", JSON.stringify({ id: "dpl_1", readyState: "READY" }), "url null is not an absolute https:// URL");
	fails("two READY deployments", JSON.stringify(READY) + "\n" + JSON.stringify(READY), "2 JSON values, not one deployment object");
	fails("no output", "", "0 JSON values, not one deployment object");
	fails("a list of deployments", JSON.stringify([READY]), "something other than a deployment object");
	fails("a deployment field that is not an object", JSON.stringify({ deployment: "dpl_1" }), "something other than a deployment object");
	fails("output that is not JSON", "Error: something went wrong", "parse error");

	test("fails, before the CLI runs, without jq", () => {
		const bin = mkdtempSync(join(tmpdir(), "deploy-test-bin-"));
		made.push(bin);
		for (const tool of ["dirname", "mktemp", "rm", "mkdir", "cp", "cat"]) {
			const found = Bun.which(tool);
			if (found) symlinkSync(found, join(bin, tool));
		}
		expect(Bun.which("jq", { PATH: bin })).toBeNull();
		const result = deploy(JSON.stringify(READY), { path: bin });
		expect(result.status).toBe(2);
		expect(result.err).toContain("jq is not installed");
		expect(result.args).toBeUndefined();
	});
});
