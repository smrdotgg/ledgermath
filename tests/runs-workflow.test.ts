import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// They read the workflows; on a loaded machine even that can take longer than bun's five-second default.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");

interface Step {
	name?: string;
	id?: string;
	uses?: string;
	run?: string;
	if?: string;
	with?: Record<string, string>;
	env?: Record<string, string>;
	"working-directory"?: string;
}

interface Job {
	name?: string;
	needs?: string | string[];
	if?: string;
	"timeout-minutes"?: number;
	permissions?: Record<string, string>;
	concurrency?: { group: string; "cancel-in-progress": boolean };
	env?: Record<string, string>;
	steps: Step[];
}

interface Workflow {
	on: { schedule: Array<{ cron: string }>; workflow_dispatch: { inputs?: Record<string, { description?: string; type?: string; default?: unknown }> } | null };
	permissions: Record<string, string>;
	concurrency: { group: string; "cancel-in-progress": boolean };
	jobs: Record<string, Job>;
}

const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "runs.yml"), "utf8")) as Workflow;
const job = workflow.jobs.runs as Job;
const steps = job.steps;
const runs = steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
const publish = workflow.jobs.publish as Job;

describe("the runs workflow", () => {
	test("runs at 22:40 UTC, every six hours, and by hand, one run at a time, both its jobs", () => {
		expect(workflow.on.schedule.map((entry) => entry.cron)).toEqual(["40 22 * * *", "0 */6 * * *"]);
		expect("workflow_dispatch" in workflow.on).toBe(true);
		// The workflow's group holds a run, its publish job included, until the run ends.
		expect(workflow.concurrency).toEqual({ group: "runs", "cancel-in-progress": false });
		expect(Object.keys(workflow.jobs)).toEqual(["runs", "publish"]);
	});

	test("gives the workflow no permission, and each job its own: the first may read contents and Actions, ask for an OIDC token and write issues", () => {
		expect(workflow.permissions).toEqual({});
		expect(job.permissions).toEqual({ contents: "read", "id-token": "write", issues: "write", actions: "read" });
	});

	test("takes AWS credentials through OIDC from the role in RUNS_AWS_ROLE_ARN, and the bucket from RUNS_BUCKET", () => {
		const aws = steps.find((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials@"));
		expect(aws?.with).toEqual({ "role-to-assume": "${{ vars.RUNS_AWS_ROLE_ARN }}", "aws-region": "us-east-2" });
		expect(job.env?.RUNS_BUCKET).toBe("${{ vars.RUNS_BUCKET }}");
		expect(JSON.stringify(workflow)).not.toMatch(/aws-access-key-id|aws-secret-access-key/);
	});

	test("checks out the Runs repository with the deploy key", () => {
		const checkout = steps.find((step) => step.with?.repository === "smrdotgg/ledgermath-runs");
		expect(checkout?.uses?.startsWith("actions/checkout@")).toBe(true);
		expect(checkout?.with?.["ssh-key"]).toBe("${{ secrets.RUNS_REPO_DEPLOY_KEY }}");
		expect(checkout?.with?.path).toBe("ledgermath-runs");
	});

	test("copies, pushes, derives, builds the page, keeps it, then raises the alarm with its own token", () => {
		const order = [
			"bun scripts/copy-runs.ts --bucket",
			"git push origin HEAD:main",
			"bun scripts/derive.ts --runs ledgermath-runs --bucket",
			"bun scripts/build-page.ts page/derivations.json page/index.html",
			"bun scripts/alarm.ts --runs ledgermath-runs",
		];
		const positions = order.map((text) => runs.findIndex((run) => run.includes(text)));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		for (const script of ["copy-runs", "derive", "build-page", "alarm"]) expect(existsSync(join(ROOT, "scripts", `${script}.ts`))).toBe(true);

		const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
		expect(upload?.with?.path).toBe("page/");
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts"));
		expect(alarm?.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
		expect(alarm?.if).toContain("steps.runs-repository.outcome == 'success'");
	});

	test("derives with both Methods into one page, and keeps dump blobs and reduced records between runs, never stdout blobs", () => {
		const derive = steps.find((step) => step.run?.includes("scripts/derive.ts")) as Step;
		const command = (derive.run as string).replace(/\s+/g, " ");
		expect(command).toContain("--out page/derivations.json");
		expect(command).toContain("--requests-out page/requests-derivations.json");
		expect(command).toContain("--cache .cache/blobs");
		expect(command).toContain("--records .cache/records");
		const page = steps.find((step) => step.run?.includes("scripts/build-page.ts")) as Step;
		expect(page.run).toContain("--requests page/requests-derivations.json");
		const cache = steps.find((step) => step.uses?.startsWith("actions/cache@")) as Step;
		expect((cache.with?.path ?? "").trim().split("\n").map((line) => line.trim())).toEqual([".cache/blobs", ".cache/records"]);
		expect(cache.with?.key).toBe("derive-${{ github.run_id }}");
		// Caches made before the records held stdout blobs: their prefix is never restored.
		expect(cache.with?.["restore-keys"]).toBe("derive-");
		expect(steps.indexOf(cache)).toBeLessThan(steps.indexOf(derive));
		// A failed Method still leaves the other's Derivations, the page and the artifact; the run ends failed all the same.
		const ran = "${{ !cancelled() && (steps.derive.outcome == 'success' || steps.derive.outcome == 'failure') }}";
		expect(derive.id).toBe("derive");
		expect(derive.if).toBeUndefined();
		expect(page.if).toBe(ran);
		const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@")) as Step;
		expect(upload.if).toBe(ran);
		expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(page));
		expect(JSON.stringify(workflow)).not.toContain("continue-on-error");
		// The alarm still runs whatever the Methods and the page did.
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts")) as Step;
		expect(alarm.if).toBe("${{ !cancelled() && steps.runs-repository.outcome == 'success' }}");
		expect(steps.indexOf(alarm)).toBeGreaterThan(steps.indexOf(page));
	});

	test("builds the data API's files after the page when both Methods succeeded, checks them against the tree the latest earlier run that checked its own kept, and keeps only a checked tree, as the artifact api, for a week", () => {
		const text = readFileSync(join(ROOT, ".github", "workflows", "runs.yml"), "utf8");
		const derive = steps.find((step) => step.id === "derive") as Step;
		const pageUpload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === "page") as Step;
		const build = steps.find((step) => step.run?.includes("scripts/build-api.ts")) as Step;
		const previous = steps.find((step) => step.run?.includes("scripts/previous-api.ts")) as Step;
		const check = steps.find((step) => step.run?.includes("scripts/check-api.ts")) as Step;
		const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === "api") as Step;
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts")) as Step;
		for (const script of ["build-api", "previous-api", "check-api"]) expect(existsSync(join(ROOT, "scripts", `${script}.ts`))).toBe(true);
		const order = [derive, pageUpload, build, previous, check, upload, alarm].map((step) => steps.indexOf(step));
		expect(order.every((position) => position >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);

		const command = (step: Step): string => (step.run as string).replace(/\s+/g, " ").trim();
		expect(command(build)).toBe(
			"bun scripts/build-api.ts --derivations page/derivations.json --requests-derivations page/requests-derivations.json --runs ledgermath-runs --out api",
		);
		// The previous tree: the artifact api of the latest earlier run on main that kept one, with this run's token; said to be comparable or not as the step's output.
		expect(command(previous)).toBe('bun scripts/previous-api.ts --repository "$GITHUB_REPOSITORY" --workflow runs.yml --branch main --run-id "$GITHUB_RUN_ID" --tree api --out api-previous');
		expect(previous.id).toBe("api-previous");
		expect(previous.if).toBe("${{ !cancelled() && steps.api.outcome == 'success' }}");
		expect(previous.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
		// The check compares with it. It is told a new baseline is declared only by a human, through the workflow_dispatch input new_baseline: no step's output, nothing automatic.
		expect(command(check)).toBe(
			"bun scripts/check-api.ts --tree api --derivations page/derivations.json --requests-derivations page/requests-derivations.json --runs ledgermath-runs " +
				"--previous api-previous ${{ inputs.new_baseline == true && '--allow-no-previous' || '' }}",
		);
		expect(workflow.on.workflow_dispatch?.inputs?.new_baseline).toMatchObject({ type: "boolean", default: false });
		expect(workflow.on.workflow_dispatch?.inputs?.new_baseline?.description).toContain("new baseline");
		// The only command the flag is written in, and no step decides it.
		expect(runs.join("\n").split("--allow-no-previous").length).toBe(2);
		expect(text).not.toContain("outputs.comparable");
		expect(text).not.toMatch(/GITHUB_OUTPUT/);
		expect(build.id).toBe("api");
		expect(build.if).toBe("${{ !cancelled() && steps.derive.outcome == 'success' }}");
		expect(check.id).toBe("api-check");
		expect(check.if).toBe("${{ !cancelled() && steps.api.outcome == 'success' && steps.api-previous.outcome == 'success' }}");
		expect(upload.if).toBe("${{ !cancelled() && steps.api-check.outcome == 'success' }}");
		// Only the latest is needed, by the next run's check; the tree grows by about 1.8 GB a year.
		expect(upload.with).toEqual({ name: "api", path: "api/", "if-no-files-found": "error", "retention-days": 7 as unknown as string });
		// The same pinned action as the page's artifact.
		expect(upload.uses).toBe(pageUpload.uses as string);
		// No copy with the AWS CLI, no deploy, anywhere in the workflow.
		expect(text).not.toMatch(/aws s3 (cp|sync)|s3:\/\/|sst deploy|vercel/i);
	});

	test("the first job knows nothing of publishing: no step of it names the API bucket, uploads or checks a bucket of the tree, and the alarm is its last step, within its own 30 minutes", () => {
		const forbidden = /API_BUCKET|upload-api|check-api-bucket|download-artifact|api-bucket/;
		for (const step of steps) expect({ step: step.name ?? step.uses ?? step.run, publishing: forbidden.test(JSON.stringify(step)) }).toEqual({ step: step.name ?? step.uses ?? step.run, publishing: false });
		expect(JSON.stringify(job.env)).not.toMatch(forbidden);
		expect(job.needs).toBeUndefined();
		expect(job["timeout-minutes"]).toBe(30);
		expect(steps.at(-1)?.run).toContain("bun scripts/alarm.ts");
		// Its caches are saved by its own success, whatever any other job does.
		expect(steps.some((step) => step.uses?.startsWith("actions/cache@"))).toBe(true);
	});

	test("the publish job runs after the first, only when it succeeded and API_BUCKET is set, with its own 15 minutes, its own minimal permissions, and one at a time against the bucket", () => {
		expect(publish.needs).toBe("runs");
		expect(publish.if).toBe("${{ needs.runs.result == 'success' && vars.API_BUCKET != '' }}");
		expect(publish["timeout-minutes"]).toBe(15);
		expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" });
		expect(publish.concurrency).toEqual({ group: "api-bucket", "cancel-in-progress": false });
		expect(publish.env).toEqual({ API_BUCKET: "${{ vars.API_BUCKET }}" });
	});

	test("the publish job takes this run's checked artifact api, checks the bucket, uploads with the run's id, and checks what the bucket holds, each step only after the one before succeeded", () => {
		const command = (step: Step): string => (step.run as string).replace(/\s+/g, " ").trim();
		const p = publish.steps;
		expect(p.map((step) => step.uses?.split("@")[0] ?? command(step))).toEqual([
			"actions/checkout",
			"oven-sh/setup-bun",
			"bun install --frozen-lockfile",
			"actions/download-artifact",
			"aws-actions/configure-aws-credentials",
			'bun scripts/upload-api.ts --tree api --bucket "$API_BUCKET" --run "$GITHUB_RUN_ID" --preflight',
			'bun scripts/upload-api.ts --tree api --bucket "$API_BUCKET" --run "$GITHUB_RUN_ID"',
			'bun scripts/check-api-bucket.ts --tree api --bucket "$API_BUCKET"',
		]);
		expect(p[3]?.with).toEqual({ name: "api", path: "api" });
		expect(p[4]?.with).toEqual({ "role-to-assume": "${{ vars.RUNS_AWS_ROLE_ARN }}", "aws-region": "us-east-2" });
		// No step runs after a failure (no if of its own), and nothing hides one.
		for (const step of p) expect(step.if).toBeUndefined();
		expect(JSON.stringify(publish)).not.toContain("continue-on-error");
		for (const script of ["upload-api", "check-api-bucket"]) expect(existsSync(join(ROOT, "scripts", `${script}.ts`))).toBe(true);
	});

	test("the next run's baseline is the artifact api, which the first job keeps only when its check passed, and never how the run ended, so the publish job cannot change it", () => {
		const keep = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === "api") as Step;
		expect(keep.if).toBe("${{ !cancelled() && steps.api-check.outcome == 'success' }}");
		const source = readFileSync(join(ROOT, "scripts", "previous-api.ts"), "utf8");
		expect(source).toContain('"status=completed"');
		expect(source).not.toContain("status=success");
		expect(source).not.toMatch(/conclusion === "success"/);
		// tests/previous-api.test.ts: a run whose publish job failed is a baseline; one whose check failed is not.
	});

	test("tells the alarm whether this pass's copy and push succeeded", () => {
		expect(steps.find((step) => step.run?.includes("scripts/copy-runs.ts"))?.id).toBe("copy");
		expect(steps.find((step) => step.run?.includes("git push"))?.id).toBe("push");
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts"));
		expect(alarm?.run).toContain('--copy "$COPY"');
		expect(alarm?.env?.COPY).toBe("${{ steps.copy.outcome == 'success' && steps.push.outcome == 'success' && 'succeeded' || 'failed' }}");
	});

	test("tells the alarm when main last changed schedule.json, from the whole history", () => {
		const checkout = steps[0];
		expect(checkout?.uses?.startsWith("actions/checkout@")).toBe(true);
		expect(checkout?.with?.["fetch-depth"]).toBe(0 as unknown as string);
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts"));
		expect(alarm?.run).toContain('changed="$(git log -1 --first-parent --format=%cI -- schedule.json)"');
		expect(alarm?.run).toContain('--schedule-changed-at "$changed"');
	});

	test("tells the alarm when the prices workflow first existed on main, from the whole history", () => {
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts"));
		expect(alarm?.run).toContain('prices_since="$(git log --first-parent --reverse --format=%cI -- .github/workflows/prices.yml | sed -n 1p)"');
		expect(alarm?.run).toContain('--prices-since "$prices_since"');
		expect(existsSync(join(ROOT, ".github", "workflows", "prices.yml"))).toBe(true);
	});
});

describe("the check workflow", () => {
	const check = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "check.yml"), "utf8")) as Workflow;
	const testJob = check.jobs.test as { steps: Step[] };

	test("installs SST's platform, type-checks the -runs stage's wiring against it, and requires the public API's resource graph in bun test", () => {
		const install = testJob.steps.findIndex((step) => step.run === "bunx sst install");
		const types = testJob.steps.findIndex((step) => step.run === "bun scripts/check-stack-types.ts");
		const tests = testJob.steps.findIndex((step) => step.run === "bun test");
		expect(install).toBeGreaterThan(testJob.steps.findIndex((step) => step.run === "bun install --frozen-lockfile"));
		expect(types).toBeGreaterThan(install);
		expect(tests).toBeGreaterThan(install);
		expect(testJob.steps[tests]?.env?.LM_STACK_REQUIRED).toBe("1");
		expect(existsSync(join(ROOT, "scripts", "check-stack-types.ts"))).toBe(true);
		expect(existsSync(join(ROOT, "tsconfig.stack.json"))).toBe(true);
		// No AWS credentials: installing SST's platform asks AWS nothing.
		expect(readFileSync(join(ROOT, ".github", "workflows", "check.yml"), "utf8")).not.toMatch(/aws-actions|id-token|aws-access-key-id/);
	});
});

describe("the stack's type check", () => {
	test("fails on an error in this project's files, or one tied to no file, and leaves SST's own sources' errors aside", async () => {
		const { sortErrors } = await import("../scripts/check-stack-types");
		const output = [
			".sst/platform/src/components/aws/bucket.ts(999,15): error TS2322: Type 'x' is not assignable to type 'y'.",
			"  more of that message",
			"infra/runs/public-blobs-stack.ts(12,3): error TS2304: Cannot find name 'nope'.",
			"error TS2688: Cannot find type definition file for 'bun'.",
			`${ROOT}/.sst/platform/src/components/aws/cdn.ts(1,1): error TS1000: SST's own.`,
		].join("\n");
		expect(sortErrors(output, ROOT)).toEqual({
			ours: ["infra/runs/public-blobs-stack.ts(12,3): error TS2304: Cannot find name 'nope'.", "error TS2688: Cannot find type definition file for 'bun'."],
			sst: 2,
			unread: [],
		});
		expect(sortErrors("", ROOT)).toEqual({ ours: [], sst: 0, unread: [] });
		expect(sortErrors("FATAL ERROR: Reached heap limit\n    at something", ROOT).unread).toEqual(["FATAL ERROR: Reached heap limit", "    at something"]);
	});

	test("passes a compiler run only when it ended by itself, with its status accounted for by SST's diagnostics alone, and nothing else in its output", async () => {
		const { judge } = await import("../scripts/check-stack-types");
		const sst = ".sst/platform/src/components/aws/bucket.ts(999,15): error TS2322: Type 'x' is not assignable to type 'y'.\n  more of it";
		const ours = "infra/runs/stack.ts(1,1): error TS2304: Cannot find name 'x'.";
		const cases: Array<[Parameters<typeof judge>[0], string | null]> = [
			[{ status: 0, signal: null, output: "" }, null],
			[{ status: 2, signal: null, output: sst }, null],
			[{ status: 2, signal: null, output: `${sst}\n${ours}` }, ours],
			[{ status: null, signal: "SIGKILL", output: sst }, "the compiler was ended by SIGKILL"],
			[{ status: 1, signal: null, output: "" }, "the compiler exited 1 with no diagnostic to account for it"],
			[{ status: 134, signal: null, output: "FATAL ERROR: Reached heap limit" }, "output that is no diagnostic: FATAL ERROR: Reached heap limit"],
			[{ status: 2, signal: null, output: `${sst}\nSegmentation fault` }, "output that is no diagnostic: Segmentation fault"],
			[{ status: 0, signal: null, output: sst }, "the compiler exited 0 and printed 1 error"],
			[{ status: null, signal: null, output: "", error: "spawn ENOENT" }, "the compiler could not be started: spawn ENOENT"],
		];
		for (const [ended, problem] of cases) {
			const problems = judge(ended, ROOT).problems;
			if (problem === null) expect(problems).toEqual([]);
			else expect(problems).toContainEqual(expect.stringContaining(problem));
		}
	});

	test("the script fails, through a stand-in compiler, when the compiler is killed, fails silently, prints what it cannot read, or finds an error of ours; and passes on SST's errors alone", async () => {
		const directory = mkdtempSync(join(tmpdir(), "stack-types-"));
		const fake = join(directory, "tsc");
		writeFileSync(
			fake,
			[
				"#!/usr/bin/env bun",
				"const args = process.argv.slice(2);",
				`if (args.includes("--listFilesOnly")) { console.log(${JSON.stringify(["infra/runs/stack.ts", "infra/runs/public-blobs-stack.ts"].map((file) => join(ROOT, file)).join("\n"))}); process.exit(0); }`,
				"const mode = process.env.LM_FAKE_TSC;",
				'if (mode === "killed") process.kill(process.pid, "SIGKILL");',
				'if (mode === "silent") process.exit(2);',
				'if (mode === "garbage") { console.log("Segmentation fault (core dumped)"); process.exit(1); }',
				'if (mode === "ours") { console.log("infra/runs/stack.ts(1,1): error TS2304: Cannot find name \'x\'."); process.exit(2); }',
				'if (mode === "sst") { console.log(".sst/platform/src/a.ts(1,1): error TS1000: SST\'s own."); process.exit(2); }',
				"process.exit(0);",
				"",
			].join("\n"),
		);
		chmodSync(fake, 0o755);
		const check = async (mode: string) => {
			const child = Bun.spawn(["bun", join(ROOT, "scripts", "check-stack-types.ts"), "--tsc", fake], { cwd: ROOT, env: { ...process.env, LM_FAKE_TSC: mode }, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			return { exitCode, output: `${stdout}${stderr}` };
		};
		for (const [mode, said] of [
			["killed", "the compiler was ended by SIGKILL"],
			["silent", "the compiler exited 2 with no diagnostic to account for it"],
			["garbage", "output that is no diagnostic: Segmentation fault (core dumped)"],
			["ours", "infra/runs/stack.ts(1,1): error TS2304"],
		] as const) {
			const done = await check(mode);
			expect({ mode, exitCode: done.exitCode }).toEqual({ mode, exitCode: 1 });
			expect(done.output).toContain(said);
		}
		for (const mode of ["sst", "clean"]) expect((await check(mode)).exitCode).toBe(0);
	});

	test("checks the stack files, which tsconfig.json leaves out, as strictly as the rest", () => {
		const stack = Bun.JSONC.parse(readFileSync(join(ROOT, "tsconfig.stack.json"), "utf8")) as { extends: string; include: string[] };
		const root = Bun.JSONC.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as { exclude: string[] };
		expect(stack.extends).toBe("./tsconfig.json");
		expect(stack.include).toEqual(["infra/runs/stack.ts", "infra/runs/public-blobs-stack.ts"]);
		for (const file of stack.include) expect(root.exclude).toContain(file);
	});
});

describe("the prices workflow", () => {
	const prices = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "prices.yml"), "utf8")) as Workflow;
	const pricesJob = Object.values(prices.jobs)[0] as { env?: Record<string, string>; steps: Step[] };
	const pricesSteps = pricesJob.steps;
	const pricesRuns = pricesSteps.flatMap((step) => (step.run === undefined ? [] : [step.run]));

	test("runs daily, with a second chance the same day, and by hand, hours away from the runs workflow's times", () => {
		const crons = prices.on.schedule.map((entry) => entry.cron);
		expect(crons).toEqual(["17 3 * * *", "17 15 * * *"]);
		expect("workflow_dispatch" in prices.on).toBe(true);
		expect(Object.keys(prices.jobs).length).toBe(1);
		// The runs workflow starts at 22:40 and on the hour every six hours; these start at least two hours from any of them.
		const runsStarts = [22 * 60 + 40, 0, 6 * 60, 12 * 60, 18 * 60];
		for (const cron of crons) {
			const [minute, hour] = cron.split(" ").map(Number) as [number, number];
			const at = hour * 60 + minute;
			for (const start of runsStarts) expect(Math.min(Math.abs(at - start), 1440 - Math.abs(at - start))).toBeGreaterThanOrEqual(120);
		}
	});

	test("shares the runs workflow's concurrency group, so the two never push to the Runs repository at once", () => {
		expect(prices.concurrency).toEqual(workflow.concurrency);
		expect(prices.concurrency).toEqual({ group: "runs", "cancel-in-progress": false });
	});

	test("may read this repository's contents only, and takes no AWS credentials", () => {
		expect(prices.permissions).toEqual({ contents: "read" });
		const text = readFileSync(join(ROOT, ".github", "workflows", "prices.yml"), "utf8");
		expect(text).not.toMatch(/aws-actions|aws-access-key-id|aws-secret-access-key|id-token|RUNS_AWS_ROLE_ARN/);
	});

	test("checks out the Runs repository with the deploy key, fetches the day's prices into it, then commits and pushes only new files", () => {
		const checkout = pricesSteps.find((step) => step.with?.repository === "smrdotgg/ledgermath-runs");
		expect(checkout?.uses?.startsWith("actions/checkout@")).toBe(true);
		expect(checkout?.with?.["ssh-key"]).toBe("${{ secrets.RUNS_REPO_DEPLOY_KEY }}");
		expect(checkout?.with?.path).toBe("ledgermath-runs");
		expect(checkout?.with?.ref).toBe("main");

		const order = ["bun install --frozen-lockfile", 'bun scripts/fetch-prices.ts --work "$RUNNER_TEMP/prices" ledgermath-runs', "git push origin HEAD:main"];
		const positions = order.map((text) => pricesRuns.findIndex((run) => run.includes(text)));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(pricesSteps.indexOf(checkout as Step)).toBeLessThan(pricesSteps.findIndex((step) => step.run?.includes("fetch-prices.ts")));
		expect(existsSync(join(ROOT, "scripts", "fetch-prices.ts"))).toBe(true);

		const push = pricesSteps.find((step) => step.run?.includes("git push")) as Step;
		expect(push["working-directory"]).toBe("ledgermath-runs");
		expect(push.run).toContain("git add -- prices");
		expect(push.run).toContain("git diff --cached --name-only --diff-filter=a");
		// The bot identity the runs workflow commits as.
		const identity = (run: string): string[] => run.match(/user\.(name|email)="[^"]+"/g) ?? [];
		const runsPush = steps.find((step) => step.run?.includes("git push"))?.run as string;
		expect(identity(push.run as string)).toEqual(identity(runsPush));
		expect(identity(push.run as string).length).toBe(2);
	});
});

describe("every action in the workflows", () => {
	const files = ["runs.yml", "check.yml", "prices.yml"].map((name) => ({ name, text: readFileSync(join(ROOT, ".github", "workflows", name), "utf8") }));

	test("is pinned to a full commit SHA, with its version in a trailing comment", () => {
		const pins = new Map<string, string>();
		for (const { name, text } of files) {
			const uses = text.split("\n").filter((line) => /^\s*(-\s+)?uses:/.test(line));
			expect(uses.length).toBeGreaterThan(0);
			for (const line of uses) {
				const match = /^\s*(?:-\s+)?uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(line);
				if (match === null) throw new Error(`${name}: not pinned to a commit with its version: ${line.trim()}`);
				const [, action, sha, version] = match as unknown as [string, string, string, string];
				// One action, one pin, across every file.
				expect(pins.get(action) ?? `${sha} ${version}`).toBe(`${sha} ${version}`);
				pins.set(action, `${sha} ${version}`);
			}
		}
		expect([...pins.keys()].sort()).toEqual([
			"actions/cache",
			"actions/checkout",
			"actions/download-artifact",
			"actions/upload-artifact",
			"aws-actions/configure-aws-credentials",
			"oven-sh/setup-bun",
		]);
	});
});
