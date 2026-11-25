import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { LATEST_START_MS } from "../infra/runs/launch-event";
import { MAX_AGE_MS } from "../infra/runs/reap-boxes";
import { MAX_PUBLISH_AGE_MS } from "../scripts/lib/api-freshness";
import { bootRounds, scheduledMinutes } from "./runs-schedule";

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
	concurrency?: { group: string; "cancel-in-progress"?: boolean; queue?: string };
	env?: Record<string, string>;
	outputs?: Record<string, string>;
	steps: Step[];
}

interface Workflow {
	on: { schedule: Array<{ cron: string }>; workflow_dispatch: { inputs?: Record<string, { description?: string; type?: string; default?: unknown }> } | null };
	permissions: Record<string, string>;
	concurrency?: Job["concurrency"];
	jobs: Record<string, Job>;
}

const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "runs.yml"), "utf8")) as Workflow;
const job = workflow.jobs.runs as Job;
const steps = job.steps;
const runs = steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
const publish = workflow.jobs.publish as Job;
const site = workflow.jobs.site as Job;
const siteWorkflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "site.yml"), "utf8")) as Workflow;

const RUNS_WORKFLOW = ".github/workflows/runs.yml";
const SITE_WORKFLOW = ".github/workflows/site.yml";

/** Every file under .github, at any depth: the workflows, and any action or workflow a later change adds. */
function githubFiles(): Array<{ name: string; text: string }> {
	return readdirSync(join(ROOT, ".github"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.map((path) => ({ name: relative(ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));
}

/**
 * Every way the files under .github let the Telegram secrets out of the alarm
 * step of runs.yml (ADR-0033): empty when none. Judged on the text (any
 * reference to a TELEGRAM_ secret, toJSON(secrets)) and on the parsed YAML
 * (a job's `secrets` that is not a mapping, which is `inherit` however it is
 * quoted; the two references being the alarm step's own `env`; runs.yml's
 * triggers; the alarm's command), so a spelling cannot slip past.
 */
function telegramSecretProblems(files: Array<{ name: string; text: string }>): string[] {
	const problems: string[] = [];
	for (const { name, text } of files) {
		// secrets.TELEGRAM_…, secrets['TELEGRAM_…'], in any case: twice in runs.yml (the two lines of the alarm step), nowhere else.
		const references = text.match(/secrets\s*(\.|\[\s*['"])\s*TELEGRAM/gi)?.length ?? 0;
		if (references !== (name === RUNS_WORKFLOW ? 2 : 0)) problems.push(`${name}: ${references} references to a TELEGRAM_ secret`);
		if (/toJSON\(\s*secrets\s*\)/i.test(text)) problems.push(`${name}: hands over every secret with toJSON(secrets)`);
		if (name !== RUNS_WORKFLOW && /TELEGRAM/i.test(text)) problems.push(`${name}: names TELEGRAM`);
		if (!/\.ya?ml$/.test(name)) continue;
		let parsed: { on?: unknown; env?: unknown; jobs?: Record<string, { secrets?: unknown; env?: unknown; steps?: Step[] }> };
		try {
			parsed = Bun.YAML.parse(text) as typeof parsed;
		} catch {
			problems.push(`${name}: not YAML this check can read`);
			continue;
		}
		const jobs = Object.entries(parsed?.jobs ?? {});
		for (const [id, each] of jobs) {
			// A job's secrets are a mapping of names, or the keyword inherit, which hands over every secret: by its parsed value, however it is quoted.
			const secrets = each?.secrets;
			if (secrets !== undefined && (typeof secrets !== "object" || secrets === null || Array.isArray(secrets))) problems.push(`${name}: job ${id} hands over its secrets as ${JSON.stringify(secrets)}`);
		}
		if (name !== RUNS_WORKFLOW) continue;
		const alarms = jobs.flatMap(([, each]) => (each?.steps ?? []).filter((step) => step.run?.includes("scripts/alarm.ts")));
		if (alarms.length !== 1) {
			problems.push(`${name}: ${alarms.length} alarm steps`);
			continue;
		}
		const alarm = alarms[0] as Step;
		const named = Object.entries(alarm.env ?? {}).filter(([key, value]) => /TELEGRAM/i.test(key) || /TELEGRAM/i.test(String(value)));
		if (JSON.stringify(named) !== JSON.stringify([["TELEGRAM_BOT_TOKEN", "${{ secrets.TELEGRAM_BOT_TOKEN }}"], ["TELEGRAM_CHAT_ID", "${{ secrets.TELEGRAM_CHAT_ID }}"]])) {
			problems.push(`${name}: the alarm step's environment holds ${JSON.stringify(named)}`);
		}
		// No other step, no job's environment, not the workflow's: the alarm step's own env holds them, or nothing does.
		if (/TELEGRAM/i.test(JSON.stringify(parsed.env ?? {}))) problems.push(`${name}: the workflow's environment names TELEGRAM`);
		for (const [id, each] of jobs) {
			if (/TELEGRAM/i.test(JSON.stringify({ ...each, steps: (each?.steps ?? []).filter((step) => step !== alarm) }))) problems.push(`${name}: job ${id} names TELEGRAM outside the alarm step`);
		}
		const { env: _env, ...alarmBesidesEnv } = alarm;
		if (/TELEGRAM/i.test(JSON.stringify(alarmBesidesEnv)) || /--telegram-/.test(alarm.run ?? "")) problems.push(`${name}: the alarm step names Telegram outside its environment, or passes a test's option`);
		// Started on its schedule and by hand, never by a pull request or anything else.
		const on = parsed.on;
		const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : Object.keys((on as object | null) ?? {});
		if (triggers.join(",") !== "schedule,workflow_dispatch") problems.push(`${name}: started by ${triggers.join(", ")}`);
	}
	return problems;
}

/** The jobs whose deploy step may hold the Vercel token and the project's IDs, by workflow, and nothing else may. */
const VERCEL_JOBS: Record<string, string[]> = { [RUNS_WORKFLOW]: ["site"], [SITE_WORKFLOW]: ["deploy-production", "deploy-preview"] };
/** That step's environment, as far as Vercel goes: the three, by these names, from these. */
const VERCEL_ENV: Array<[string, string]> = [
	["VERCEL_TOKEN", "${{ secrets.VERCEL_TOKEN }}"],
	["VERCEL_ORG_ID", "${{ vars.VERCEL_ORG_ID }}"],
	["VERCEL_PROJECT_ID", "${{ vars.VERCEL_PROJECT_ID }}"],
];

/**
 * Every way the files under .github let the Vercel token, or the project's
 * IDs, out of the deploy steps that need them (ADR-0035): in runs.yml, the
 * site job's deploy step alone; in site.yml, the deploy step of each of its
 * two deploy jobs; nowhere else. Judged on the text (any reference to a
 * VERCEL_ secret or variable, toJSON(secrets)) and on the parsed YAML (a job's
 * `secrets` that is not a mapping; which steps' `env` hold them, and nothing
 * else of a step, a job or a workflow naming them; runs.yml's triggers), so a
 * spelling cannot slip past. Empty when there is none.
 */
function vercelSecretProblems(files: Array<{ name: string; text: string }>): string[] {
	const problems: string[] = [];
	for (const { name, text } of files) {
		const allowed = VERCEL_JOBS[name] ?? [];
		// secrets.VERCEL_…, secrets['VERCEL_…'], vars.VERCEL_…, in any case: one token and two IDs per deploy step allowed, none elsewhere.
		const tokens = text.match(/secrets\s*(\.|\[\s*['"])\s*VERCEL/gi)?.length ?? 0;
		const ids = text.match(/vars\s*(\.|\[\s*['"])\s*VERCEL/gi)?.length ?? 0;
		if (tokens !== allowed.length) problems.push(`${name}: ${tokens} references to a VERCEL_ secret`);
		if (ids !== 2 * allowed.length) problems.push(`${name}: ${ids} references to a VERCEL_ variable`);
		if (/toJSON\(\s*(secrets|vars)\s*\)/i.test(text)) problems.push(`${name}: hands over every secret or variable with toJSON`);
		if (allowed.length === 0 && /VERCEL_(TOKEN|ORG_ID|PROJECT_ID)/i.test(text)) problems.push(`${name}: names the Vercel token or the project's IDs`);
		if (!/\.ya?ml$/.test(name)) continue;
		let parsed: { on?: unknown; env?: unknown; jobs?: Record<string, { secrets?: unknown; env?: unknown; steps?: Step[] }> };
		try {
			parsed = Bun.YAML.parse(text) as typeof parsed;
		} catch {
			problems.push(`${name}: not YAML this check can read`);
			continue;
		}
		const jobs = Object.entries(parsed?.jobs ?? {});
		for (const [id, each] of jobs) {
			const secrets = each?.secrets;
			if (secrets !== undefined && (typeof secrets !== "object" || secrets === null || Array.isArray(secrets))) problems.push(`${name}: job ${id} hands over its secrets as ${JSON.stringify(secrets)}`);
			if (secrets !== undefined && /VERCEL/i.test(JSON.stringify(secrets))) problems.push(`${name}: job ${id} hands a Vercel secret to a reusable workflow`);
		}
		if (allowed.length === 0) continue;
		if (/VERCEL/i.test(JSON.stringify(parsed.env ?? {}))) problems.push(`${name}: the workflow's environment names VERCEL`);
		for (const [id, each] of jobs) {
			const steps = each?.steps ?? [];
			if (/VERCEL/i.test(JSON.stringify(each?.env ?? {}))) problems.push(`${name}: job ${id}'s environment names VERCEL`);
			const naming = steps.filter((step) => /VERCEL_(TOKEN|ORG_ID|PROJECT_ID)/i.test(JSON.stringify(step)));
			const deploys = naming.filter((step) => /^site\/deploy\/deploy\.sh /.test(step.run ?? "") && JSON.stringify(Object.entries(step.env ?? {}).filter(([key, value]) => /VERCEL/i.test(key) || /VERCEL/i.test(String(value)))) === JSON.stringify(VERCEL_ENV));
			const { env: _env, ...rest } = deploys[0] ?? {};
			if (deploys.length === 1 && /VERCEL_(TOKEN|ORG_ID|PROJECT_ID)/i.test(JSON.stringify(rest))) problems.push(`${name}: job ${id}'s deploy step names the Vercel token or IDs outside its environment`);
			const expected = allowed.includes(id) ? 1 : 0;
			if (naming.length !== expected || deploys.length !== expected) problems.push(`${name}: job ${id} has ${naming.length} steps naming the Vercel token or IDs, ${deploys.length} of them a deploy step with exactly the three in its environment; ${expected} allowed`);
		}
		for (const id of allowed) if (!jobs.some(([each]) => each === id)) problems.push(`${name}: no job ${id}`);
		if (name === RUNS_WORKFLOW) {
			// Started on its schedule and by hand, never by a pull request, whose code could read the step's environment.
			const on = parsed.on;
			const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : Object.keys((on as object | null) ?? {});
			if (triggers.join(",") !== "schedule,workflow_dispatch") problems.push(`${name}: started by ${triggers.join(", ")}`);
		}
		if (/pull_request_target/.test(text)) problems.push(`${name}: started by pull_request_target, which hands a fork's code the secrets`);
	}
	return problems;
}

describe("the runs workflow", () => {
	test("runs at 00:05, 06:05, 12:05 and 18:05 UTC, and by hand; its first job holds the group runs, shared with prices.yml, the publish job only api-bucket, and the site job the production deploys' group", () => {
		expect(workflow.on.schedule.map((entry) => entry.cron)).toEqual(["5 0,6,12,18 * * *"]);
		expect(scheduledMinutes()).toEqual([5, 6 * 60 + 5, 12 * 60 + 5, 18 * 60 + 5]);
		expect("workflow_dispatch" in workflow.on).toBe(true);
		expect(Object.keys(workflow.jobs)).toEqual(["runs", "publish", "site"]);
		// No group for the workflow as a whole: then a run would hold runs, the lock prices.yml shares, through its publish job too.
		expect(workflow.concurrency).toBeUndefined();
		// The first job holds runs exactly as long as the workflow did before the publish job: for itself.
		expect(job.concurrency).toEqual({ group: "runs", "cancel-in-progress": false });
		// The publish job holds api-bucket alone, so the next run's first job, and prices.yml, can start while it uploads.
		expect(publish.concurrency).toEqual({ group: "api-bucket", "cancel-in-progress": false });
		// The site job holds the group of site.yml's production deploys, keeping every waiting job, exactly as they do.
		expect(site.concurrency).toEqual({ group: "site-deploy-production", queue: "max" });
		expect(site.concurrency).toEqual(siteWorkflow.jobs["deploy-production"]?.concurrency as Job["concurrency"]);
		const text = readFileSync(join(ROOT, ".github", "workflows", "runs.yml"), "utf8");
		expect(text.match(/^\s*group:/gm)?.length).toBe(3);
	});

	test("cuts a tree once after each round of boots has ended, never in the middle of one: after the latest a round's last box can end, before the next round's first boot", () => {
		// A launch is refused when it is more than LATEST_START_MS late; the reaper, every few minutes, ends any box older than MAX_AGE_MS.
		const reaper = Number(/const REAP_SCHEDULE = "rate\((\d+) minutes\)";/.exec(readFileSync(join(ROOT, "infra", "runs", "stack.ts"), "utf8"))?.[1]);
		expect(reaper).toBe(5);
		const latestEnd = (last: number) => last + (LATEST_START_MS + MAX_AGE_MS) / 60_000 + reaper;
		const rounds = bootRounds();
		expect(rounds).toEqual([4, 10, 16, 22].map((hour) => ({ first: hour * 60 + 10, last: hour * 60 + 50 })));
		const starts = scheduledMinutes();
		expect(starts.length).toBe(rounds.length);
		rounds.forEach((round, i) => {
			const next = (rounds[(i + 1) % rounds.length] as { first: number }).first + (i + 1 === rounds.length ? 1_440 : 0);
			const inGap = starts.map((start) => (start >= round.first ? start : start + 1_440)).filter((start) => start < next);
			expect({ round, starts: inGap.length }).toEqual({ round, starts: 1 });
			// HH+1:55 for a round whose last box is at :50; the cut comes after it.
			expect(inGap[0] as number).toBeGreaterThan(latestEnd(round.last));
		});
		expect(latestEnd(4 * 60 + 50)).toBe(5 * 60 + 55);
	});

	test("the words claim no more than the schedule gives: no tree is said to hold whole rounds, and each place names when one can still hold part of a round", () => {
		const places = {
			"runs.yml": readFileSync(join(ROOT, ".github", "workflows", "runs.yml"), "utf8").split("\n  workflow_dispatch:")[0] as string,
			README: readFileSync(join(ROOT, "README.md"), "utf8").split("### The workflow")[1]?.split("It checks out this")[0] ?? "",
			"ADR-0035": readFileSync(join(ROOT, "docs", "adr", "0035-the-home-page-is-rebuilt-after-every-publish.md"), "utf8"),
		};
		for (const [place, raw] of Object.entries(places)) {
			const text = raw.replace(/\s*#\s*/g, " ").replace(/\s+/g, " ");
			expect({ place, claims: /holds? whole rounds/.test(text) }).toEqual({ place, claims: false });
			for (const said of ["started by hand", "more than four hours late", "does not confirm", "arrives late"]) expect({ place, said, found: text.includes(said) }).toEqual({ place, said, found: true });
		}
	});

	test("gives the workflow no permission, and each job its own: the first may read contents and Actions, ask for an OIDC token and write issues", () => {
		expect(workflow.permissions).toEqual({});
		expect(job.permissions).toEqual({ contents: "read", "id-token": "write", issues: "write", actions: "read" });
	});

	test("takes AWS credentials through OIDC from the role in RUNS_AWS_ROLE_ARN, and the bucket from RUNS_BUCKET", () => {
		const aws = steps.find((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials@"));
		expect(aws?.with).toEqual({ "role-to-assume": "${{ vars.RUNS_AWS_ROLE_ARN }}", "aws-region": "us-east-2" });
		expect(job.env?.RUNS_BUCKET).toBe("${{ vars.RUNS_BUCKET }}");
		// Never a static key given to the action: OIDC only (the site job reads the keys the action gives as outputs).
		for (const each of Object.values(workflow.jobs)) {
			for (const step of each.steps) expect(Object.keys(step.with ?? {}).filter((input) => /^aws-(access-key-id|secret-access-key|session-token)$/.test(input))).toEqual([]);
		}
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
		// No step of the first job writes an output (the site job's own decision, whether to deploy, is its only one).
		expect(JSON.stringify(job)).not.toMatch(/GITHUB_OUTPUT/);
		expect(JSON.stringify(publish)).not.toMatch(/GITHUB_OUTPUT/);
		expect(build.id).toBe("api");
		expect(build.if).toBe("${{ !cancelled() && steps.derive.outcome == 'success' }}");
		expect(check.id).toBe("api-check");
		expect(check.if).toBe("${{ !cancelled() && steps.api.outcome == 'success' && steps.api-previous.outcome == 'success' }}");
		expect(upload.if).toBe("${{ !cancelled() && steps.api-check.outcome == 'success' }}");
		// Only the latest is needed, by the next run's check; the tree grows by about 1.8 GB a year.
		expect(upload.with).toEqual({ name: "api", path: "api/", "if-no-files-found": "error", "retention-days": 7 as unknown as string });
		// The same pinned action as the page's artifact.
		expect(upload.uses).toBe(pageUpload.uses as string);
		// No copy with the AWS CLI and no deploy of the stack anywhere in the workflow; Vercel only in the site job.
		expect(text).not.toMatch(/aws s3 (cp|sync)|s3:\/\/|sst deploy/i);
		expect(JSON.stringify({ runs: job, publish })).not.toMatch(/vercel/i);
	});

	test("the first job does not publish: no step of it uploads or checks a bucket of the tree, only the alarm names the API bucket, to read it, and the alarm is its last step, within its own 60 minutes", () => {
		const publishing = /upload-api|check-api-bucket|download-artifact|group: api-bucket/;
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts")) as Step;
		for (const step of steps) {
			const named = step === alarm ? publishing.test(JSON.stringify(step)) : /API_BUCKET|api-bucket/.test(JSON.stringify(step)) || publishing.test(JSON.stringify(step));
			expect({ step: step.name ?? step.uses ?? step.run, publishing: named }).toEqual({ step: step.name ?? step.uses ?? step.run, publishing: false });
		}
		// The alarm is given the bucket's name and nothing else of publishing; reading it never fails the step (tests/api-freshness.test.ts).
		expect(alarm.env?.API_BUCKET).toBe("${{ vars.API_BUCKET }}");
		expect(JSON.stringify(job.env)).not.toMatch(/API_BUCKET|api-bucket/);
		expect(JSON.stringify(job.env)).not.toMatch(publishing);
		expect(job.needs).toBeUndefined();
		// Room to reduce every stream again after the records' keys change (about 13 minutes on 2026-11-23): a job cut off saves no cache, and the next starts over.
		expect(job["timeout-minutes"]).toBe(60);
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

	test("the publish job takes this run's checked artifact api, asks the public edge whether it serves every kind of file in it, checks the bucket, uploads with the run's id, and checks what the bucket holds, each step only after the one before succeeded", () => {
		const command = (step: Step): string => (step.run as string).replace(/\s+/g, " ").trim();
		const p = publish.steps;
		expect(p.map((step) => step.uses?.split("@")[0] ?? command(step))).toEqual([
			"actions/checkout",
			"oven-sh/setup-bun",
			"bun install --frozen-lockfile",
			"actions/download-artifact",
			"bun scripts/check-api-edge.ts --tree api",
			"aws-actions/configure-aws-credentials",
			'bun scripts/upload-api.ts --tree api --bucket "$API_BUCKET" --run "$GITHUB_RUN_ID" --preflight',
			'bun scripts/upload-api.ts --tree api --bucket "$API_BUCKET" --run "$GITHUB_RUN_ID"',
			'bun scripts/check-api-bucket.ts --tree api --bucket "$API_BUCKET" --run "$GITHUB_RUN_ID"',
		]);
		expect(p[3]?.with).toEqual({ name: "api", path: "api" });
		expect(p[5]?.with).toEqual({ "role-to-assume": "${{ vars.RUNS_AWS_ROLE_ARN }}", "aws-region": "us-east-2" });
		// The edge is asked before any credentials exist in the job, and with no environment of its own: it needs none.
		expect(p[4]?.env).toBeUndefined();
		// No step runs after a failure (no if of its own), and nothing hides one.
		for (const step of p) expect(step.if).toBeUndefined();
		expect(JSON.stringify(publish)).not.toContain("continue-on-error");
		for (const script of ["check-api-edge", "upload-api", "check-api-bucket"]) expect(existsSync(join(ROOT, "scripts", `${script}.ts`))).toBe(true);
	});

	test("the next run's baseline is the artifact api, which the first job keeps only when its check passed, never how the run ended nor whether it has, so the publish job cannot change it", () => {
		const keep = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === "api") as Step;
		expect(keep.if).toBe("${{ !cancelled() && steps.api-check.outcome == 'success' }}");
		const source = readFileSync(join(ROOT, "scripts", "previous-api.ts"), "utf8");
		// Runs of every status are searched: the run before may still be publishing when this run's first job starts.
		expect(source).not.toContain("status=");
		expect(source).not.toMatch(/conclusion === "success"/);
		// tests/previous-api.test.ts: a run whose publish job failed, or is still going, is a baseline; one whose check failed is not.
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

	test("tells the alarm the API bucket, as API_BUCKET names it, empty when it is unset", () => {
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts")) as Step;
		expect(alarm.env?.API_BUCKET).toBe("${{ vars.API_BUCKET }}");
		expect(alarm.run).toContain('--api-bucket "$API_BUCKET"');
		// The same variable, by the same name, as the publish job's.
		expect(publish.env?.API_BUCKET).toBe(alarm.env?.API_BUCKET as string);
		// And no endpoint of its own: the tests' stand-in only.
		expect(alarm.run).not.toContain("--api-endpoint");
	});

	test("the first job has exactly main's steps, in main's order, and the alarm step main's condition: the bucket check added none", () => {
		const key = (step: Step): string => step.name ?? step.uses?.split("@")[0] ?? (step.run ?? "").trim();
		expect(steps.map(key)).toEqual([
			"actions/checkout",
			"oven-sh/setup-bun",
			"bun install --frozen-lockfile",
			"AWS credentials for the bucket, through OIDC",
			"Check out the Runs repository",
			"Copy new Run files and boot summaries from the bucket",
			"Commit and push them to the Runs repository",
			"Keep the dump blobs and the streams' reduced records",
			"Derive every Series (Method series v1) and every Series of requests (Method requests v1)",
			"Build the page",
			"Keep the page and the Derivations",
			"Build the data API's files",
			"Fetch the data API's files the last run that checked its tree kept",
			"Check the data API's files",
			"Keep the data API's files",
			"Check for watched Series with no Run, and price files, for 48 hours",
		]);
		const alarm = steps.at(-1) as Step;
		expect(alarm.if).toBe("${{ !cancelled() && steps.runs-repository.outcome == 'success' }}");
		// main's environment for the step, and four more: the bucket's name, the drill, and the two Telegram secrets (ADR-0033).
		expect(Object.keys(alarm.env ?? {})).toEqual(["GITHUB_TOKEN", "COPY", "API_BUCKET", "ALARM_DRILL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
	});

	test("the schedule's runs are at most 6 hours apart, which the alarm's 14 hours assume: two gaps, and two hours for a late start", () => {
		const minutes = scheduledMinutes();
		const gaps = minutes.map((minute, index) => (index === 0 ? minute + 1_440 - (minutes.at(-1) as number) : minute - (minutes[index - 1] as number)));
		expect(Math.max(...gaps) * 60_000).toBe(6 * 3_600_000);
		expect(MAX_PUBLISH_AGE_MS).toBe(2 * Math.max(...gaps) * 60_000 + 2 * 3_600_000);
	});

	test("the input alarm_drill: only on a run started by hand, off by default, reaching only the alarm step, never the publish job", () => {
		const text = readFileSync(join(ROOT, ".github", "workflows", "runs.yml"), "utf8");
		// Present only on dispatch: a scheduled run has no inputs.
		expect(workflow.on.workflow_dispatch?.inputs?.alarm_drill).toMatchObject({ type: "boolean", default: false });
		expect(workflow.on.workflow_dispatch?.inputs?.alarm_drill?.description).toContain("publishing is untouched");
		expect(Object.keys(workflow.on)).toEqual(["schedule", "workflow_dispatch"]);
		// Read in one place, the alarm step's environment, as yes only when true.
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts")) as Step;
		expect(alarm.env?.ALARM_DRILL).toBe("${{ inputs.alarm_drill == true && 'yes' || 'no' }}");
		expect(alarm.run).toContain('--drill "$ALARM_DRILL"');
		expect(text.match(/inputs\.alarm_drill/g)?.length).toBe(1);
		for (const step of steps) if (step !== alarm) expect(JSON.stringify(step)).not.toMatch(/alarm_drill|ALARM_DRILL|--drill/);
		expect(JSON.stringify(job.env ?? {})).not.toMatch(/alarm_drill|ALARM_DRILL/);
		// The publish job never sees it, and publishes to API_BUCKET as on any run.
		expect(JSON.stringify(publish)).not.toMatch(/alarm_drill|ALARM_DRILL|drill/i);
		expect(publish.env).toEqual({ API_BUCKET: "${{ vars.API_BUCKET }}" });
	});

	test("the Telegram secrets reach the alarm step alone, from its own environment: in no other step, job or workflow, and never in a workflow a pull request starts", () => {
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts")) as Step;
		expect(Object.fromEntries(Object.entries(alarm.env ?? {}).filter(([name]) => /TELEGRAM/i.test(name)))).toEqual({
			TELEGRAM_BOT_TOKEN: "${{ secrets.TELEGRAM_BOT_TOKEN }}",
			TELEGRAM_CHAT_ID: "${{ secrets.TELEGRAM_CHAT_ID }}",
		});
		const files = githubFiles();
		expect(files.map((file) => file.name)).toContain(RUNS_WORKFLOW);
		expect(files.filter((file) => /\.ya?ml$/.test(file.name)).length).toBeGreaterThanOrEqual(4);
		expect(telegramSecretProblems(files)).toEqual([]);
		// The workflow runs on its schedule and by hand, never for a pull request, whose code could read the step's environment.
		expect(Object.keys(workflow.on)).toEqual(["schedule", "workflow_dispatch"]);
	});

	test("the check of the Telegram secrets rejects every way of letting them out: by reference, by handing over every secret however the value is spelled, by trigger", () => {
		const files = githubFiles();
		const runsText = (files.find((file) => file.name === RUNS_WORKFLOW) as { text: string }).text;
		/** The repository's files, with runs.yml changed by `change`, and one more workflow, `extra`, when given. */
		const variant = (change: (text: string) => string, extra?: string) => [
			...files.map((file) => (file.name === RUNS_WORKFLOW ? { ...file, text: change(file.text) } : file)),
			...(extra === undefined ? [] : [{ name: ".github/workflows/extra.yml", text: extra }]),
		];
		const same = (text: string): string => text;
		/** Another workflow calling a reusable one, handing it `secrets` as written. */
		const caller = (secrets: string) => `name: extra\non: workflow_dispatch\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n    secrets: ${secrets}\n`;
		const replaced = (from: string, to: string) => (text: string) => {
			if (!text.includes(from)) throw new Error(`runs.yml no longer holds ${JSON.stringify(from)}: the fixture needs updating`);
			return text.replace(from, to);
		};
		const fixtures: Array<[string, Array<{ name: string; text: string }>]> = [
			["secrets: inherit", variant(same, caller("inherit"))],
			['secrets: "inherit"', variant(same, caller('"inherit"'))],
			["secrets: 'inherit'", variant(same, caller("'inherit'"))],
			["secrets: inherit in runs.yml's own jobs", variant(replaced("  publish:\n", "  handed:\n    uses: ./.github/workflows/reusable.yml\n    secrets: 'inherit'\n  publish:\n"))],
			["a secret passed by name to a reusable workflow", variant(same, caller("\n      token: ${{ secrets.TELEGRAM_BOT_TOKEN }}"))],
			["toJSON(secrets)", variant(same, "name: extra\non: workflow_dispatch\njobs:\n  dump:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n        env:\n          ALL: ${{ toJSON(secrets) }}\n")],
			["a reference in another workflow", variant(same, "name: extra\non: pull_request\njobs:\n  leak:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n        env:\n          T: ${{ secrets['TELEGRAM_BOT_TOKEN'] }}\n")],
			["a reference in runs.yml's job environment", variant(replaced("      RUNS_BUCKET: ${{ vars.RUNS_BUCKET }}\n", "      RUNS_BUCKET: ${{ vars.RUNS_BUCKET }}\n      TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}\n"))],
			["runs.yml started by a pull request", variant(replaced("on:\n  schedule:\n", "on:\n  pull_request:\n  schedule:\n"))],
			["runs.yml started by pull_request_target", variant(replaced("on:\n  schedule:\n", "on:\n  pull_request_target:\n  schedule:\n"))],
			["the alarm pointed at a stand-in for Telegram", variant(replaced('--drill "$ALARM_DRILL"', '--drill "$ALARM_DRILL" --telegram-endpoint http://127.0.0.1:1'))],
			["the alarm given a shorter Telegram deadline", variant(replaced('--drill "$ALARM_DRILL"', '--drill "$ALARM_DRILL" --telegram-budget-ms 100'))],
		];
		for (const [label, fixture] of fixtures) expect({ label, rejected: telegramSecretProblems(fixture).length > 0 }).toEqual({ label, rejected: true });
		// And the repository's own files, unchanged, pass.
		expect(telegramSecretProblems(variant(same))).toEqual([]);
		expect(runsText).toContain("secrets.TELEGRAM_BOT_TOKEN");
	});

	test("tells the alarm when the prices workflow first existed on main, from the whole history", () => {
		const alarm = steps.find((step) => step.run?.includes("scripts/alarm.ts"));
		expect(alarm?.run).toContain('prices_since="$(git log --first-parent --reverse --format=%cI -- .github/workflows/prices.yml | sed -n 1p)"');
		expect(alarm?.run).toContain('--prices-since "$prices_since"');
		expect(existsSync(join(ROOT, ".github", "workflows", "prices.yml"))).toBe(true);
	});
});

describe("the site job: the home page rebuilt and deployed after every publish (ADR-0035)", () => {
	const s = site.steps;
	/** An action by its name, a command by its first line. */
	const key = (step: Step): string => step.uses?.split("@")[0] ?? (step.run ?? "").trim().split("\n")[0]!;

	/** The production deploy's own steps, in order, as the rule names them: checkout, credentials, read, build, check, deploy, live check. */
	const READ = 'bun scripts/read-api-tree.ts --bucket "$API_BUCKET" --region us-east-2 --out "$RUNNER_TEMP/tree"';
	/** The read step's environment: the bucket, and the role's keys from the credentials step's outputs. */
	const READ_ENV = {
		API_BUCKET: "${{ vars.API_BUCKET }}",
		AWS_ACCESS_KEY_ID: "${{ steps.credentials.outputs.aws-access-key-id }}",
		AWS_SECRET_ACCESS_KEY: "${{ steps.credentials.outputs.aws-secret-access-key }}",
		AWS_SESSION_TOKEN: "${{ steps.credentials.outputs.aws-session-token }}",
	};
	const publishCredentials = () => publish.steps.find((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials@"))?.with as Record<string, string>;
	/** The credentials step of a production job: the publish job's role and Region, giving the keys as outputs, not to the environment. */
	const CREDENTIALS_WITH = () => ({ ...publishCredentials(), "output-env-credentials": false as unknown as string, "output-credentials": true as unknown as string });
	const ruleOrder = (steps: Step[]) =>
		[
			steps.findIndex((step) => step.uses?.startsWith("actions/checkout@")),
			steps.findIndex((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials@")),
			steps.findIndex((step) => step.run === READ),
			steps.findIndex((step) => step.run?.startsWith("bun run build --tree")),
			steps.findIndex((step) => step.run === "bun run check"),
			steps.findIndex((step) => step.run?.startsWith("site/deploy/deploy.sh site/dist/client ")),
			steps.findIndex((step) => step.run === "bun scripts/check-live.ts https://ledgermath.com/"),
		] as const;

	test("runs after the publish job, only when it succeeded and only on main, with its own 15 minutes, reading contents and asking for an OIDC token, nothing more", () => {
		expect(site.needs).toBe("publish");
		// Never when the publish job failed, was skipped or was cancelled. A scheduled run's ref is main.
		expect(site.if).toBe("${{ needs.publish.result == 'success' && github.ref == 'refs/heads/main' }}");
		expect(site["timeout-minutes"]).toBe(15);
		expect(site.permissions).toEqual({ contents: "read", "id-token": "write" });
		expect(site.env).toBeUndefined();
		expect(site.outputs).toBeUndefined();
		// The first job and the publish job are as they were: the site job adds no need to them.
		expect(job.needs).toBeUndefined();
		expect(publish.needs).toBe("runs");
	});

	test("inside the group, checks out main as it is now, takes the publish job's role, reads the tree from the API bucket, builds and checks the site from those bytes, deploys, and checks the live site, in that order, every step after the one before succeeded", () => {
		expect(s.map(key)).toEqual([
			"actions/checkout",
			"oven-sh/setup-bun",
			"bun install --frozen-lockfile",
			"aws-actions/configure-aws-credentials",
			READ,
			"bun install --frozen-lockfile",
			'bun run build --tree "$RUNNER_TEMP/tree"',
			"bun run check",
			"cmp public/third-party-notices.txt dist/client/third-party-notices.txt",
			"bun install --frozen-lockfile",
			'site/deploy/deploy.sh site/dist/client production >"$RUNNER_TEMP/deployment.json"',
			"url=$(jq -er '.url' \"$RUNNER_TEMP/deployment.json\")",
			"bun scripts/check-live.ts https://ledgermath.com/",
			'failed="the checkout of main, or setting up Bun"',
		]);
		const order = ruleOrder(s);
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual([...order]);
		// main as it is now, never this run's commit, which main may have left; no credential kept in the clone.
		expect(s[0]?.with).toEqual({ ref: "refs/heads/main", "persist-credentials": false as unknown as string });
		// The publish job's role and region, the keys as outputs; the bucket the variable names and the keys, in the read step alone.
		expect(s[3]?.with).toEqual(CREDENTIALS_WITH());
		expect(s[3]?.id).toBe("credentials");
		expect(s[4]?.env).toEqual(READ_ENV);
		expect(s.filter((step) => JSON.stringify(step).includes("API_BUCKET")).length).toBe(1);
		expect(s[7]?.env).toEqual({ LEDGERMATH_TREE: "${{ runner.temp }}/tree" });
		for (const step of [s[5], s[6], s[7], s[8], s[12]]) expect(step?.["working-directory"]).toBe("site");
		expect(s[9]?.["working-directory"]).toBe("site/deploy");
		// Bun's package cache in the job's temporary directory, as everywhere on the runner that persists.
		for (const step of [s[2], s[5], s[9]]) expect(step?.env).toEqual({ BUN_INSTALL_CACHE_DIR: "${{ runner.temp }}/bun-cache" });
		// Nothing skips and nothing hides a failure: every step runs only after the one before succeeded, but the notice.
		for (const step of s.slice(0, -1)) expect({ step: step.name ?? key(step), if: step.if }).toEqual({ step: step.name ?? key(step), if: undefined });
		expect(JSON.stringify(site)).not.toContain("continue-on-error");
		// Never the edge, never an artifact.
		expect(JSON.stringify(site)).not.toMatch(/fetch-tree|api\.ledgermath\.com\/v1|artifact/);
		for (const script of ["scripts/read-api-tree.ts", "site/deploy/deploy.sh", "site/scripts/build.ts", "site/scripts/check-live.ts"]) expect(existsSync(join(ROOT, script))).toBe(true);
	});

	test("site.yml's production deploy follows the same rule inside the same group, after its freshness check; its build job and its previews take no AWS credentials and build from the public API", () => {
		const build = siteWorkflow.jobs.build as Job;
		const deploy = siteWorkflow.jobs["deploy-production"] as Job;
		const preview = siteWorkflow.jobs["deploy-preview"] as Job;
		expect(deploy.if).toBe("github.ref == 'refs/heads/main' && github.event_name != 'pull_request'");
		expect(deploy.permissions).toEqual({ contents: "read", "id-token": "write" });
		const fresh = deploy.steps.findIndex((step) => step.id === "fresh");
		const order = ruleOrder(deploy.steps);
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual([...order]);
		// The freshness check comes before the role is taken; every step after it runs only when it said to deploy.
		expect(fresh).toBeGreaterThan(order[0]);
		expect(fresh).toBeLessThan(order[1]);
		for (const step of deploy.steps.slice(fresh + 1)) expect({ step: step.name, if: step.if }).toEqual({ step: step.name, if: "steps.fresh.outputs.deploy == 'true'" });
		expect(deploy.steps[order[1]]?.with).toEqual(CREDENTIALS_WITH());
		expect(deploy.steps[order[1]]?.id).toBe("credentials");
		expect(deploy.steps[order[2]]?.env).toEqual(READ_ENV);
		// It deploys what it built in its turn, not the build job's artifact.
		expect(JSON.stringify(deploy)).not.toMatch(/download-artifact|fetch-tree/);
		// No other job of site.yml asks for an OIDC token or names the role or the bucket: a pull request, from a fork or not, gets neither.
		for (const each of [build, preview]) {
			expect(each.permissions === undefined || each.permissions["id-token"] === undefined).toBe(true);
			expect(JSON.stringify(each)).not.toMatch(/RUNS_AWS_ROLE_ARN|API_BUCKET|configure-aws-credentials|read-api-tree/);
		}
		expect(siteWorkflow.permissions).toEqual({ contents: "read" });
		expect(build.steps.find((step) => step.run?.includes("fetch-tree.ts"))?.if).toBeUndefined();
	});

	test("in each production job the role's keys reach one step, the read, and no other: the action does not export them, the build, the checks and the deploy never hold them, and the read gets the Region they were taken for", () => {
		const keys = /AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|aws-(access-key-id|secret-access-key|session-token)/;
		for (const [name, each] of [
			["runs.yml site", site],
			["site.yml deploy-production", siteWorkflow.jobs["deploy-production"] as Job],
		] as const) {
			const credentials = each.steps.filter((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials@"));
			expect({ name, credentials: credentials.length }).toEqual({ name, credentials: 1 });
			const action = credentials[0] as Step;
			expect({ name, export: action.with?.["output-env-credentials"], outputs: action.with?.["output-credentials"] }).toEqual({ name, export: false as unknown as string, outputs: true as unknown as string });
			// The keys appear in exactly one step besides the action: the read, in its environment, from the action's outputs.
			const holding = each.steps.filter((step) => step !== action && keys.test(JSON.stringify(step)));
			expect({ name, holding: holding.map((step) => step.run) }).toEqual({ name, holding: [READ] });
			const read = holding[0] as Step;
			expect(Object.fromEntries(Object.entries(read.env ?? {}).filter(([key]) => key.startsWith("AWS_")))).toEqual({
				AWS_ACCESS_KEY_ID: `\${{ steps.${action.id}.outputs.aws-access-key-id }}`,
				AWS_SECRET_ACCESS_KEY: `\${{ steps.${action.id}.outputs.aws-secret-access-key }}`,
				AWS_SESSION_TOKEN: `\${{ steps.${action.id}.outputs.aws-session-token }}`,
			});
			expect(JSON.stringify(each.env ?? {})).not.toMatch(keys);
			// The Region the reader signs for is the one the credentials were taken for.
			expect({ name, region: /--region (\S+)/.exec(read.run ?? "")?.[1] }).toEqual({ name, region: action.with?.["aws-region"] });
		}
	});

	test("no workflow and no script decides a deploy from run ids or artifacts any more: the rule needs neither, and they cannot creep back", () => {
		const deploys = [site, siteWorkflow.jobs["deploy-production"] as Job];
		const decided = /artifact|run-id|run_id|GITHUB_RUN_ID|run_attempt|actions\/runs|gh (api|run)|published\.ts|GH_TOKEN/i;
		for (const each of deploys) {
			expect(JSON.stringify(each)).not.toMatch(decided);
			expect(each.permissions?.actions).toBeUndefined();
		}
		expect(existsSync(join(ROOT, "site", "deploy", "published.ts"))).toBe(false);
		const scripts = [
			join(ROOT, "scripts", "read-api-tree.ts"),
			...readdirSync(join(ROOT, "site", "deploy")).filter((name) => /\.(ts|sh)$/.test(name)).map((name) => join(ROOT, "site", "deploy", name)),
			...readdirSync(join(ROOT, "site", "scripts")).filter((name) => name.endsWith(".ts")).map((name) => join(ROOT, "site", "scripts", name)),
		];
		for (const path of scripts) {
			const text = readFileSync(path, "utf8");
			// GitHub's record of runs and artifacts, read by the API or the CLI, or a run's own ids: none of it.
			expect({ path: relative(ROOT, path), decides: /actions\/(runs|artifacts|workflows)|GITHUB_RUN_(ID|ATTEMPT)|run_attempt|\bgh (api|run)\b|artifact-ids|download-artifact/i.test(text) }).toEqual({
				path: relative(ROOT, path),
				decides: false,
			});
		}
	});

	test("the Vercel token and the project's IDs reach only the site job's deploy step in runs.yml, and the two deploy steps in site.yml", () => {
		const deploy = s.find((step) => step.id === "deploy") as Step;
		expect(Object.entries(deploy.env ?? {})).toEqual(VERCEL_ENV);
		const files = githubFiles();
		expect(files.map((file) => file.name)).toEqual(expect.arrayContaining([RUNS_WORKFLOW, SITE_WORKFLOW]));
		expect(vercelSecretProblems(files)).toEqual([]);
	});

	test("the check of the Vercel secrets rejects every way of letting them out: another step, the job's or workflow's environment, another job or workflow, every secret handed over, a pull request", () => {
		const files = githubFiles();
		const variant = (file: string, change: (text: string) => string, extra?: string) => [
			...files.map((each) => (each.name === file ? { ...each, text: change(each.text) } : each)),
			...(extra === undefined ? [] : [{ name: ".github/workflows/extra.yml", text: extra }]),
		];
		const same = (text: string): string => text;
		const replaced = (from: string, to: string) => (text: string) => {
			if (!text.includes(from)) throw new Error(`the workflow no longer holds ${JSON.stringify(from)}: the fixture needs updating`);
			return text.replace(from, to);
		};
		const token = "          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}\n";
		const fixtures: Array<[string, Array<{ name: string; text: string }>]> = [
			["the token in the build step", variant(RUNS_WORKFLOW, replaced('        run: bun run build --tree "$RUNNER_TEMP/tree"\n', `        env:\n${token}        run: bun run build --tree "$RUNNER_TEMP/tree"\n`))],
			["the token in the site job's environment", variant(RUNS_WORKFLOW, replaced("      group: site-deploy-production\n      queue: max\n", `      group: site-deploy-production\n      queue: max\n    env:\n  ${token}`))],
			["the token in the first job's environment", variant(RUNS_WORKFLOW, replaced("      RUNS_BUCKET: ${{ vars.RUNS_BUCKET }}\n", "      RUNS_BUCKET: ${{ vars.RUNS_BUCKET }}\n      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}\n"))],
			["a project ID in the live check", variant(RUNS_WORKFLOW, replaced("        run: bun scripts/check-live.ts https://ledgermath.com/\n\n", "        env:\n          VERCEL_PROJECT_ID: ${{ vars.VERCEL_PROJECT_ID }}\n        run: bun scripts/check-live.ts https://ledgermath.com/\n\n"))],
			["the token spelled another way, in a step's command", variant(RUNS_WORKFLOW, replaced("        run: bun scripts/check-live.ts https://ledgermath.com/\n\n", "        run: bun scripts/check-live.ts https://ledgermath.com/ ${{ secrets['VERCEL_TOKEN'] }}\n\n"))],
			["the deploy step given another name for the token", variant(RUNS_WORKFLOW, replaced(token, "          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN_OTHER }}\n"))],
			["the deploy step without the token", variant(RUNS_WORKFLOW, replaced(token, ""))],
			["the token in site.yml's build job", variant(SITE_WORKFLOW, replaced("      - name: Type-check\n        run: bun run typecheck\n", `      - name: Type-check\n        env:\n${token}        run: bun run typecheck\n`))],
			["a reference in another workflow", variant(RUNS_WORKFLOW, same, "name: extra\non: pull_request\njobs:\n  leak:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n        env:\n          T: ${{ secrets.VERCEL_TOKEN }}\n")],
			["a project ID in another workflow", variant(RUNS_WORKFLOW, same, "name: extra\non: workflow_dispatch\njobs:\n  leak:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ${{ vars.VERCEL_ORG_ID }}\n")],
			["secrets: inherit", variant(RUNS_WORKFLOW, same, "name: extra\non: workflow_dispatch\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n    secrets: inherit\n")],
			["the token handed to a reusable workflow", variant(RUNS_WORKFLOW, same, "name: extra\non: workflow_dispatch\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n    secrets:\n      token: ${{ secrets.VERCEL_TOKEN }}\n")],
			["toJSON(secrets)", variant(RUNS_WORKFLOW, same, "name: extra\non: workflow_dispatch\njobs:\n  dump:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n        env:\n          ALL: ${{ toJSON(secrets) }}\n")],
			["runs.yml started by a pull request", variant(RUNS_WORKFLOW, replaced("\non:\n", "\non:\n  pull_request:\n"))],
			["site.yml started by pull_request_target", variant(SITE_WORKFLOW, replaced("on:\n  pull_request:\n", "on:\n  pull_request_target:\n"))],
		];
		for (const [label, fixture] of fixtures) expect({ label, rejected: vercelSecretProblems(fixture).length > 0 }).toEqual({ label, rejected: true });
		expect(vercelSecretProblems(variant(RUNS_WORKFLOW, same))).toEqual([]);
	});

	test("when a step fails, the last step says which, and whether ledgermath.com serves the new build or the one it had", () => {
		const last = s.at(-1) as Step;
		expect(last.if).toBe("failure()");
		const ids = ["packages", "credentials", "tree", "site-packages", "build", "check", "notices", "cli", "deploy", "summary", "live"];
		const variable = (id: string) => id.toUpperCase().replace("-", "_");
		expect(s.slice(2, -1).map((step) => step.id)).toEqual(ids);
		expect(last.env).toEqual(Object.fromEntries(ids.map((id) => [variable(id), `\${{ steps.${id}.outcome }}`])));
		const dir = mkdtempSync(join(tmpdir(), "site-job-failure-"));
		const script = join(dir, "failure.sh");
		writeFileSync(script, last.run as string);
		/** The step's script, as Actions runs it (bash -e), with these outcomes. */
		const notice = (outcomes: Record<string, string>) => {
			const summary = join(dir, `summary-${Object.keys(outcomes).length}-${Object.values(outcomes).join("-")}.md`);
			writeFileSync(summary, "");
			const env: Record<string, string> = { PATH: process.env.PATH ?? "", GITHUB_STEP_SUMMARY: summary };
			for (const id of ids) env[variable(id)] = outcomes[id] ?? "skipped";
			const run = Bun.spawnSync(["bash", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
			expect(run.exitCode).toBe(0);
			return { stdout: run.stdout.toString().trim(), summary: readFileSync(summary, "utf8") };
		};
		const built = { packages: "success", credentials: "success", tree: "success", "site-packages": "success", build: "success", check: "success", notices: "success", cli: "success" };
		expect(notice({ packages: "success", credentials: "success", tree: "success", "site-packages": "success", build: "failure" }).stdout).toBe(
			"::error title=Site not rebuilt::The step that failed: building the site from the bucket's files. Nothing was deployed: ledgermath.com serves the build it had.",
		);
		// deploy.sh calls Vercel with --prod before it reads the receipt: a failure of that step cannot say nothing was deployed.
		const deployFailed = notice({ ...built, deploy: "failure" });
		expect(deployFailed.stdout).toBe(
			"::error title=Site not rebuilt::The step that failed: the deploy to Vercel. What ledgermath.com serves is not confirmed: Vercel may have moved production to the new deployment before its receipt was read. Check the project's deployments in Vercel.",
		);
		expect(deployFailed.stdout).not.toContain("Nothing was deployed");
		expect(notice({ ...built, notices: "failure" }).stdout).toContain("Nothing was deployed: ledgermath.com serves the build it had.");
		expect(notice({ packages: "success", credentials: "success", tree: "failure" }).stdout).toContain("The step that failed: reading the data API's files from the API bucket. Nothing was deployed");
		expect(notice({ packages: "success", credentials: "failure" }).stdout).toContain("The step that failed: taking AWS credentials for the API bucket. Nothing was deployed");
		const live = notice({ ...built, deploy: "success", summary: "success", live: "failure" });
		expect(live.stdout).toBe(
			"::error title=Site not rebuilt::The step that failed: the live check of https://ledgermath.com/. The deploy succeeded, so ledgermath.com serves the new build; a step after it failed.",
		);
		expect(live.summary).toBe("### Site not rebuilt\n\nThe step that failed: the live check of https://ledgermath.com/. The deploy succeeded, so ledgermath.com serves the new build; a step after it failed.\n");
		expect(notice({ packages: "failure" }).stdout).toContain("The step that failed: installing the repository's packages.");
		expect(notice({}).stdout).toContain("The step that failed: the checkout of main, or setting up Bun.");
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
		// These start at least two hours from any of the runs workflow's times, as its crons give them.
		const runsStarts = scheduledMinutes();
		expect(runsStarts.length).toBeGreaterThan(0);
		for (const cron of crons) {
			const [minute, hour] = cron.split(" ").map(Number) as [number, number];
			const at = hour * 60 + minute;
			for (const start of runsStarts) expect(Math.min(Math.abs(at - start), 1440 - Math.abs(at - start))).toBeGreaterThanOrEqual(120);
		}
	});

	test("shares the group of the runs workflow's first job, so the two never push to the Runs repository at once", () => {
		// A workflow's group and a job's of the same name are one: GitHub's groups are the repository's, for jobs and workflow runs alike.
		expect(prices.concurrency).toEqual(job.concurrency);
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
