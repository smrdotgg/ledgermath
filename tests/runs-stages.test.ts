import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FOREIGN_CREDENTIALS } from "../infra/runs/deploy-account";
import { watchedSeries } from "../scripts/alarm";
import { launch } from "../infra/runs/launch-box";
import { SCHEDULED_TIME_PLACEHOLDER, scheduledEvent, unscheduledType } from "../infra/runs/launch-event";
import { LAUNCH_SCHEDULES, NO_SCHEDULED_TYPES, SCHEDULE, scheduledTargetTypes, stageLaunchSchedules, TARGETS } from "../infra/runs/placement";
import {
	isScheduledStage,
	PRODUCTION_STAGE,
	PROFILES,
	RUNS_REGION,
	runsStageApp,
	SCHEDULED_STAGE,
	stageAccount,
	stageProfile,
} from "../infra/runs/stages";

const ROOT = join(import.meta.dir, "..");
const STACK = readFileSync(join(ROOT, "infra", "runs", "stack.ts"), "utf8");
const CONFIG = readFileSync(join(ROOT, "sst.config.ts"), "utf8");

interface AppSettings {
	name: string;
	removal: string;
	protect?: boolean;
	home: string;
	providers: { aws: { profile: string; region?: string } };
}

/** A checkout's directory with no .env: what app() reads, as SST evaluates it, for a config there. */
const CHECKOUT = mkdtempSync(join(tmpdir(), "runs-stages-test-"));
afterAll(() => rmSync(CHECKOUT, { recursive: true, force: true }));

/**
 * sst.config.ts's app(), as SST calls it: the file is imported with $config
 * standing in for SST's (which returns what it is given), and app() is
 * awaited with the stage, with process.argv[1] the file SST 4.17.0 would
 * evaluate it in for a config in CHECKOUT. run() is never called. The
 * variables that would make app() refuse a -runs stage
 * (infra/runs/deploy-account.ts) are out of the environment while it runs,
 * whatever the shell running the tests holds.
 */
async function appOf(stage: string | undefined): Promise<AppSettings> {
	const globals = globalThis as unknown as { $config?: (config: unknown) => unknown };
	globals.$config = (config: unknown) => config;
	// A path held in a variable, so tsc does not follow it into a file that needs SST's types.
	const path = join(ROOT, "sst.config.ts");
	const config = (await import(path)).default as { app: (input: { stage?: string }) => AppSettings | Promise<AppSettings> };
	const read = ["AWS_PROFILE", ...Object.keys(FOREIGN_CREDENTIALS)];
	const saved = Object.fromEntries(read.map((name) => [name, process.env[name]]));
	const argv1 = process.argv[1];
	for (const name of read) delete process.env[name];
	process.argv[1] = join(CHECKOUT, ".sst", "platform", "sst.config.1794675310918.mjs");
	try {
		return await config.app({ stage });
	} finally {
		process.argv[1] = argv1 as string;
		for (const name of read) if (saved[name] !== undefined) process.env[name] = saved[name];
	}
}

describe("which account a -runs stage deploys to", () => {
	test("production-runs: the production account, retained on removal and protected against it", async () => {
		const expected: AppSettings = {
			name: "ledgermath",
			removal: "retain",
			protect: true,
			home: "aws",
			providers: { aws: { profile: "tabot-production", region: "us-east-2" } },
		};
		expect(runsStageApp("production-runs") as AppSettings).toEqual(expected);
		expect(await appOf("production-runs")).toEqual(expected);
		expect(PRODUCTION_STAGE).toBe("production-runs");
		expect(stageAccount("production-runs")).toBe("production");
		expect(stageProfile("production-runs")).toBe("tabot-production");
	});

	test("every other -runs stage: the development account, as smr-runs always has, retained and not protected", async () => {
		for (const stage of ["smr-runs", "alice-runs", "production-runs-runs", "dev-runs", "-runs"]) {
			const expected: AppSettings = {
				name: "ledgermath",
				removal: "retain",
				protect: false,
				home: "aws",
				providers: { aws: { profile: "tabot-dev", region: "us-east-2" } },
			};
			expect(runsStageApp(stage) as AppSettings).toEqual(expected);
			expect(await appOf(stage)).toEqual(expected);
			expect(stageProfile(stage)).toBe("tabot-dev");
		}
		// What smr-runs had before the production account: the same, with protect false spelt out.
		const { protect, ...rest } = await appOf("smr-runs");
		expect(rest).toEqual({ name: "ledgermath", removal: "retain", home: "aws", providers: { aws: { profile: "tabot-dev", region: "us-east-2" } } });
		expect(protect).toBe(false);
	});

	test("is decided in infra/runs/stages.ts alone: sst.config.ts names no profile for a -runs stage", () => {
		expect(PROFILES).toEqual({ production: "tabot-production", development: "tabot-dev" });
		expect(RUNS_REGION).toBe("us-east-2");
		const runsBranch = CONFIG.slice(CONFIG.indexOf('if (input?.stage?.endsWith("-runs")) {'), CONFIG.indexOf("return {"));
		expect(runsBranch).toContain('const { runsStageApp } = await import("./infra/runs/stages");');
		expect(runsBranch).toContain("return runsStageApp(input.stage);");
		expect(runsBranch).not.toContain("tabot");
		expect(() => runsStageApp("production")).toThrow("is not a -runs stage");
		expect(() => stageProfile("smr")).toThrow("is not a -runs stage");
	});

	test("leaves July's stack as it was: every stage not ending in -runs gets the same settings as before", async () => {
		expect(await appOf("smr")).toEqual({ name: "ledgermath", removal: "remove", protect: false, home: "aws", providers: { aws: { profile: "tabot-dev" } } });
		expect(await appOf("production")).toEqual({ name: "ledgermath", removal: "retain", protect: true, home: "aws", providers: { aws: { profile: "tabot-production" } } });
		expect(await appOf(undefined)).toEqual({ name: "ledgermath", removal: "remove", protect: false, home: "aws", providers: { aws: { profile: "tabot-dev" } } });
		// Its branch and its run(), word for word.
		expect(CONFIG).toContain(
			[
				"\t\treturn {",
				'\t\t\tname: "ledgermath",',
				'\t\t\tremoval: input?.stage === "production" ? "retain" : "remove",',
				'\t\t\tprotect: ["production"].includes(input?.stage),',
				'\t\t\thome: "aws",',
				"\t\t\tproviders: {",
				"\t\t\t\taws: {",
				"\t\t\t\t\tprofile:",
				'\t\t\t\t\t\tinput?.stage === "production" ? "tabot-production" : "tabot-dev",',
				"\t\t\t\t},",
				"\t\t\t},",
				"\t\t};",
			].join("\n"),
		);
		expect(CONFIG).toContain('\t\tif ($app.stage.endsWith("-runs")) {\n\t\t\tconst { runsStack } = await import("./infra/runs/stack");\n\t\t\treturn runsStack();\n\t\t}');
		expect(CONFIG).toContain('const instanceType = process.env.LEDGERMATH_INSTANCE_TYPE ?? "c6i.8xlarge";');
		expect(CONFIG).toContain('schedule: "cron(10 23 * * ? *)",');
	});
});

/** One target's payload as EventBridge Scheduler delivers it at `time`. */
const delivered = (time: string, instanceType: string): unknown =>
	JSON.parse(JSON.stringify(scheduledEvent(instanceType)).replace(SCHEDULED_TIME_PLACEHOLDER, time));

/** -runs stages other than the scheduled one, whichever that is. */
const UNSCHEDULED = ["smr-runs", "production-runs", "alice-runs", "dev-runs"].filter((stage) => stage !== SCHEDULED_STAGE);

describe("the one scheduled stage", () => {
	test("is smr-runs until the cutover", () => {
		// The cutover changes SCHEDULED_STAGE to production-runs, and this line with it
		// (README, "Moving the schedule to the production account"). No other test names it.
		expect(SCHEDULED_STAGE).toBe("production-runs");
		expect(isScheduledStage(SCHEDULED_STAGE)).toBe(true);
		for (const stage of UNSCHEDULED) expect(isScheduledStage(stage)).toBe(false);
	});

	test("gets every launch schedule, exactly those smr-runs has had, so deploying it changes none", () => {
		expect(stageLaunchSchedules(SCHEDULED_STAGE)).toBe(LAUNCH_SCHEDULES);
		expect(stageLaunchSchedules(SCHEDULED_STAGE).map((schedule) => [schedule.name, schedule.expression, schedule.event])).toEqual([
			["BoxLaunchC6i8xlargeAt10", "cron(10 4,10,16,22 * * ? *)", { scheduledTime: "<aws.scheduler.scheduled-time>", instanceType: "c6i.8xlarge" }],
			["BoxLaunchM5LargeAt20", "cron(20 4,10,16,22 * * ? *)", { scheduledTime: "<aws.scheduler.scheduled-time>", instanceType: "m5.large" }],
			["BoxLaunchC8i2xlargeAt30", "cron(30 4,10,16,22 * * ? *)", { scheduledTime: "<aws.scheduler.scheduled-time>", instanceType: "c8i.2xlarge" }],
			["BoxLaunchC8a2xlargeAt40", "cron(40 4,10,16,22 * * ? *)", { scheduledTime: "<aws.scheduler.scheduled-time>", instanceType: "c8a.2xlarge" }],
			["BoxLaunchI4i2xlargeAt50", "cron(50 4,10,16,22 * * ? *)", { scheduledTime: "<aws.scheduler.scheduled-time>", instanceType: "i4i.2xlarge" }],
		]);
		// The launch function's list of targets, as deployed to smr-runs before this change.
		expect(scheduledTargetTypes(SCHEDULED_STAGE)).toBe("c6i.8xlarge,m5.large,c8i.2xlarge,c8a.2xlarge,i4i.2xlarge");
		expect(scheduledTargetTypes(SCHEDULED_STAGE)).toBe(TARGETS.map((target) => target.instance_type).join(","));
	});

	test("is the only stage with launch schedules: every other gets none", () => {
		expect(UNSCHEDULED.length).toBe(3);
		for (const stage of UNSCHEDULED) {
			expect(stageLaunchSchedules(stage)).toEqual([]);
			expect(scheduledTargetTypes(stage)).toBe(NO_SCHEDULED_TYPES);
		}
	});

	test("in any other stage the launch refuses every scheduled payload, so a schedule left behind launches nothing; by hand, any type", async () => {
		const unscheduled = scheduledTargetTypes(UNSCHEDULED[0] as string).split(",");
		for (const target of TARGETS) {
			const reason = unscheduledType(delivered("2026-11-15T10:10:00Z", target.instance_type), unscheduled);
			expect(reason).toContain(`names ${target.instance_type}, which is not a target of the deployed schedule (none (this stage is not the scheduled stage))`);
		}
		expect(unscheduledType({ instanceType: "c6i.8xlarge" }, unscheduled)).toBeUndefined();
		expect(unscheduledType({ instanceType: "c6i.large" }, unscheduled)).toBeUndefined();

		// The handler, with the environment such a stage's function gets: refused before any AWS call.
		const before = process.env.LEDGERMATH_TARGET_INSTANCE_TYPES;
		process.env.LEDGERMATH_TARGET_INSTANCE_TYPES = scheduledTargetTypes(UNSCHEDULED[1] as string);
		try {
			const outcome = await launch(delivered("2026-11-15T10:10:00Z", "c6i.8xlarge"), new Date("2026-11-15T10:10:01Z"));
			expect(outcome.launched).toBe(false);
			expect(outcome.launched === false && outcome.reason).toContain("this stage is not the scheduled stage");
		} finally {
			if (before === undefined) delete process.env.LEDGERMATH_TARGET_INSTANCE_TYPES;
			else process.env.LEDGERMATH_TARGET_INSTANCE_TYPES = before;
		}
	});

	test("is what the stack builds from: its launch schedules, their outputs and the launch's list of targets are the stage's", () => {
		expect(STACK).toContain('import { scheduledTargetTypes, stageLaunchSchedules, TARGETS, ZONE } from "./placement";');
		expect(STACK).toContain("const launchSchedules = stageLaunchSchedules($app.stage);\n\tfor (const schedule of launchSchedules) {");
		expect(STACK).toContain("schedules: launchSchedules.filter((schedule) => schedule.instanceType === target.instance_type)");
		expect(STACK).toContain("LEDGERMATH_TARGET_INSTANCE_TYPES: scheduledTargetTypes($app.stage),");
		expect(STACK).not.toContain("LAUNCH_SCHEDULES");
		// The reaper, the buckets and the roles are made in every -runs stage: nothing else in the stack asks which stage it is.
		expect(STACK.match(/stageLaunchSchedules|scheduledTargetTypes|isScheduledStage|SCHEDULED_STAGE/g)).toEqual([
			"scheduledTargetTypes",
			"stageLaunchSchedules",
			"scheduledTargetTypes",
			"stageLaunchSchedules",
		]);
	});

	test("launches what the alarm watches: the alarm's Series are on exactly the scheduled stage's targets", () => {
		const watchedTypes = new Set(watchedSeries(SCHEDULE).map((series) => series.instanceType));
		const scheduledTypes = new Set(stageLaunchSchedules(SCHEDULED_STAGE).map((schedule) => schedule.instanceType));
		expect([...watchedTypes].sort()).toEqual([...scheduledTypes].sort());
		expect(new Set(watchedSeries(SCHEDULE).map((series) => series.zone))).toEqual(new Set(["us-east-2c"]));
	});
});
