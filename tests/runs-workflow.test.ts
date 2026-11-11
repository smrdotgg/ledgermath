import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

interface Step {
	name?: string;
	id?: string;
	uses?: string;
	run?: string;
	if?: string;
	with?: Record<string, string>;
	env?: Record<string, string>;
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

	test("tells the alarm whether this pass's copy and push succeeded", () => {
		expect(steps.find((step) => step.run?.includes("scripts/copy-runs.ts"))?.id).toBe("copy");
		expect(steps.find((step) => step.run?.includes("git push"))?.id).toBe("push");
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts"));
		expect(alarm?.run).toContain('--copy "$COPY"');
		expect(alarm?.env?.COPY).toBe("${{ steps.copy.outcome == 'success' && steps.push.outcome == 'success' && 'succeeded' || 'failed' }}");
	});
});
