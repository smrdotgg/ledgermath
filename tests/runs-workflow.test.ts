import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

interface Workflow {
	on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown };
	permissions: Record<string, string>;
	concurrency: { group: string; "cancel-in-progress": boolean };
	jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
}

const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "runs.yml"), "utf8")) as Workflow;
const job = Object.values(workflow.jobs)[0] as { env?: Record<string, string>; steps: Step[] };
const steps = job.steps;
const runs = steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));

describe("the runs workflow", () => {
	test("runs at 22:40 UTC, every six hours, and by hand, one at a time", () => {
		expect(workflow.on.schedule.map((entry) => entry.cron)).toEqual(["40 22 * * *", "0 */6 * * *"]);
		expect("workflow_dispatch" in workflow.on).toBe(true);
		expect(workflow.concurrency).toEqual({ group: "runs", "cancel-in-progress": false });
		expect(Object.keys(workflow.jobs).length).toBe(1);
	});

	test("asks for an OIDC token and issues, and may read this repository's contents only", () => {
		expect(workflow.permissions).toEqual({ contents: "read", "id-token": "write", issues: "write" });
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
		// The alarm still runs whatever the Methods and the page did.
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts")) as Step;
		expect(alarm.if).toBe("${{ !cancelled() && steps.runs-repository.outcome == 'success' }}");
		expect(steps.indexOf(alarm)).toBeGreaterThan(steps.indexOf(page));
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
			"actions/upload-artifact",
			"aws-actions/configure-aws-credentials",
			"oven-sh/setup-bun",
		]);
	});
});
