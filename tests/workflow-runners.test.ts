import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Where every job runs (README, "Where the workflows run"). The repository
// variable LEDGERMATH_RUNNER names the runner while the repository is private;
// unset or empty, every job runs on the hosted runner it named before, which
// is what a public repository must have.

const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");
const RUNS_ON = "${{ vars.LEDGERMATH_RUNNER || 'ubuntu-24.04' }}";

interface Workflow {
	jobs: Record<string, { "runs-on"?: unknown }>;
}

const files = readdirSync(WORKFLOWS)
	.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
	.sort();

describe("every job of every workflow takes its runner from LEDGERMATH_RUNNER", () => {
	test("there are workflows to check", () => {
		expect(files).toEqual(expect.arrayContaining(["check.yml", "prices.yml", "runs.yml", "site.yml"]));
	});

	for (const file of files) {
		test(file, () => {
			const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
			const jobs = Object.entries(workflow.jobs ?? {});
			expect(jobs.length).toBeGreaterThan(0);
			const runsOn = Object.fromEntries(jobs.map(([name, job]) => [name, job["runs-on"]]));
			expect(runsOn).toEqual(Object.fromEntries(jobs.map(([name]) => [name, RUNS_ON])));
		});
	}
});
