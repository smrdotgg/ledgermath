/**
 * Which AWS account a -runs stage deploys to, and which one stage is the
 * scheduled one. sst.config.ts takes a -runs stage's app settings from
 * runsStageApp; infra/runs/placement.ts gives launch schedules to the
 * scheduled stage alone; scripts/check-targets.ts reads the account of the
 * stage it checks through stageProfile. Nothing else names a profile.
 *
 * Two accounts, each reached through a profile of the AWS CLI on the machine
 * that deploys:
 *
 *   - production (tabot-production): the stage production-runs, the
 *     scheduled stage since 2026-11-19, whose boxes boot on the schedule,
 *     whose bucket keeps the Runs and blobs for good, and which the runs
 *     workflow reads;
 *   - development (tabot-dev): every other -runs stage, for trying changes
 *     with boxes launched by hand, beside the dev machine.
 *
 * Plain data, imported by sst.config.ts's app(), so it imports nothing.
 */

/** The Region of every -runs stage, in either account. */
export const RUNS_REGION = "us-east-2";

/** The stage that deploys to the production account. */
export const PRODUCTION_STAGE = "production-runs";

/**
 * The one stage that gets launch schedules. Every other -runs stage gets the
 * launch function, the reaper, the buckets and the roles, and no schedule:
 * its boxes start only by hand. Changing it is the cutover (README, "Moving
 * the schedule to the production account"), which on 2026-11-19 made it
 * production-runs in place of smr-runs (issue #57, pull request #65).
 */
export const SCHEDULED_STAGE: string = "production-runs";

/** The AWS CLI profile of each account. */
export const PROFILES = {
	production: "tabot-production",
	development: "tabot-dev",
} as const;

export type Account = keyof typeof PROFILES;

/** What sst.config.ts's app() returns for a -runs stage. */
export interface RunsStageApp {
	name: "ledgermath";
	/** Its bucket holds Runs, which are kept forever: `sst remove` keeps it, in every -runs stage. */
	removal: "retain";
	/** True for the production stage: SST refuses `sst remove` on it outright. */
	protect: boolean;
	home: "aws";
	providers: { aws: { profile: string; region: string } };
}

export function isRunsStage(stage: string): boolean {
	return stage.endsWith("-runs");
}

function checkedRunsStage(stage: string): string {
	if (!isRunsStage(stage)) throw new Error(`${JSON.stringify(stage)} is not a -runs stage: its name must end in -runs`);
	return stage;
}

/** The account a -runs stage deploys to: production for PRODUCTION_STAGE, development for every other. */
export function stageAccount(stage: string): Account {
	return checkedRunsStage(stage) === PRODUCTION_STAGE ? "production" : "development";
}

/** The AWS CLI profile a -runs stage deploys with, and its scripts read with. */
export function stageProfile(stage: string): string {
	return PROFILES[stageAccount(stage)];
}

export function runsStageApp(stage: string): RunsStageApp {
	const production = stageAccount(stage) === "production";
	return {
		name: "ledgermath",
		removal: "retain",
		protect: production,
		home: "aws",
		providers: { aws: { profile: stageProfile(stage), region: RUNS_REGION } },
	};
}

/** Whether a stage gets launch schedules: SCHEDULED_STAGE alone. */
export function isScheduledStage(stage: string): boolean {
	return checkedRunsStage(stage) === SCHEDULED_STAGE;
}
