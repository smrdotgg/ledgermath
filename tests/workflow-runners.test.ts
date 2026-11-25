import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Where every job runs (README, "Where the workflows run"). The repository is
// public, so every job of every workflow runs on GitHub's hosted runner, named
// by exactly the plain string below. A public repository must never route a
// job to a self-hosted runner, because a stranger's pull request could then
// run on that machine. So this test refuses anything that could name another
// runner: an expression (a variable could name any runner), a list or an
// object of labels or a runner group, the word self-hosted, and any other
// label. A job with no runs-on must be a call to a reusable workflow in this
// directory, whose own jobs this test checks; a reusable workflow kept
// anywhere else is refused, since this test cannot see where its jobs run.

const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");
const RUNS_ON = "ubuntu-24.04";
const LOCAL_CALL = /^\.\/\.github\/workflows\/[^/]+\.ya?ml$/;

/** What is wrong with where a workflow's jobs run; empty when every job runs on RUNS_ON. */
function runnerProblems(text: string): string[] {
	const workflow = Bun.YAML.parse(text) as { jobs?: unknown } | null;
	const jobs = workflow?.jobs;
	if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs) || Object.keys(jobs).length === 0) {
		return ["the workflow has no jobs"];
	}
	const problems: string[] = [];
	for (const [name, job] of Object.entries(jobs as Record<string, unknown>)) {
		if (job === null || typeof job !== "object" || Array.isArray(job)) {
			problems.push(`job ${name} is not a mapping`);
			continue;
		}
		const fields = job as Record<string, unknown>;
		if ("uses" in fields) {
			if (typeof fields.uses !== "string" || !LOCAL_CALL.test(fields.uses)) {
				problems.push(`job ${name} calls a reusable workflow outside .github/workflows/ of this repository`);
			}
			if ("runs-on" in fields) problems.push(`job ${name} calls a reusable workflow and also names a runner`);
			continue;
		}
		if (!("runs-on" in fields)) {
			problems.push(`job ${name} has no runs-on and calls no reusable workflow`);
			continue;
		}
		const runsOn = fields["runs-on"];
		if (Array.isArray(runsOn)) {
			problems.push(`job ${name}: runs-on is a list of labels`);
		} else if (runsOn !== null && typeof runsOn === "object") {
			problems.push(`job ${name}: runs-on is an object (a runner group or labels)`);
		} else if (typeof runsOn !== "string") {
			problems.push(`job ${name}: runs-on is not a string`);
		} else if (runsOn.includes("${{")) {
			problems.push(`job ${name}: runs-on is an expression`);
		} else if (/self-hosted/i.test(runsOn)) {
			problems.push(`job ${name}: runs-on names a self-hosted runner`);
		} else if (runsOn !== RUNS_ON) {
			problems.push(`job ${name}: runs-on is ${JSON.stringify(runsOn)}, not ${RUNS_ON}`);
		}
	}
	return problems;
}

const files = readdirSync(WORKFLOWS)
	.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
	.sort();

describe("every job of every workflow runs on GitHub's hosted runner ubuntu-24.04", () => {
	test("there are workflows to check", () => {
		expect(files).toEqual(expect.arrayContaining(["check.yml", "prices.yml", "runs.yml", "site.yml"]));
	});

	for (const file of files) {
		test(file, () => {
			expect(runnerProblems(readFileSync(join(WORKFLOWS, file), "utf8"))).toEqual([]);
		});
	}
});

describe("the check refuses every other way to say where a job runs", () => {
	const workflow = (job: string) => `name: made-up\non: pull_request\njobs:\n  build:\n${job}    steps:\n      - run: echo hi\n`;

	test("a job on ubuntu-24.04, and a call to a reusable workflow in this directory, pass", () => {
		expect(runnerProblems(workflow("    runs-on: ubuntu-24.04\n"))).toEqual([]);
		expect(runnerProblems(workflow("    runs-on: 'ubuntu-24.04'\n"))).toEqual([]);
		expect(runnerProblems("on: push\njobs:\n  call:\n    uses: ./.github/workflows/check.yml\n")).toEqual([]);
	});

	const refused: [string, string, RegExp][] = [
		["an expression", workflow("    runs-on: ${{ vars.LEDGERMATH_RUNNER || 'ubuntu-24.04' }}\n"), /expression/],
		["an expression from a matrix", workflow("    runs-on: ${{ matrix.os }}\n"), /expression/],
		["a list", workflow("    runs-on: [ubuntu-24.04]\n"), /list/],
		["a list naming self-hosted", workflow("    runs-on: [self-hosted, linux, x64]\n"), /list/],
		["an object with group:", workflow("    runs-on:\n      group: ubuntu-runners\n"), /object/],
		["an object with labels:", workflow("    runs-on:\n      labels: ubuntu-24.04\n"), /object/],
		["the word self-hosted", workflow("    runs-on: self-hosted\n"), /self-hosted/],
		["another label", workflow("    runs-on: ubuntu-latest\n"), /not ubuntu-24\.04/],
		["a runner's name", workflow("    runs-on: ledgermath-dev-box\n"), /not ubuntu-24\.04/],
		["a job with no runs-on", workflow(""), /no runs-on/],
		["a reusable workflow from another repository", "on: push\njobs:\n  call:\n    uses: someone/else/.github/workflows/x.yml@main\n", /outside/],
		["no jobs", "on: push\njobs: {}\n", /no jobs/],
	];
	for (const [what, text, says] of refused) {
		test(`refused: ${what}`, () => {
			const problems = runnerProblems(text);
			expect(problems.length).toBe(1);
			expect(problems[0]).toMatch(says);
		});
	}
});
