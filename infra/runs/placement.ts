/**
 * Where and when a -runs stage launches its boxes: the targets of
 * schedule.json, checked by infra/runs/schedule.ts. infra/runs/stack.ts makes
 * one launch schedule from each in the scheduled stage (infra/runs/stages.ts)
 * and none in any other, and an invalid schedule.json stops the deploy here. scripts/alarm.ts reads the same targets from the schedule it is given.
 * Nothing else names an instance type or a boot time.
 *
 * Plain data: no SST global is used, so tests and scripts can import it.
 * schedule.json is imported, not read, so the deploy's bundle holds the file
 * as committed.
 */

import scheduleFile from "../../schedule.json";

import { type ScheduledEvent, scheduledEvent } from "./launch-event";
import { parseSchedule, type Schedule, type Target } from "./schedule";
import { isScheduledStage } from "./stages";

/** schedule.json, checked. */
export const SCHEDULE: Schedule = parseSchedule(scheduleFile);

/** Every target the stage launches. */
export const TARGETS: readonly Target[] = SCHEDULE.targets;

/** The zone of every target; the schedule's check allows one. */
export const ZONE: string = SCHEDULE.targets[0]?.zone as string;

/** One EventBridge schedule: the boots of one target that fall at the same minute past the hour. */
export interface LaunchSchedule {
	/** The SST component's name, from the instance type and the minute: BoxLaunchC6i8xlargeAt10. */
	name: string;
	instanceType: string;
	zone: string;
	/** The boot times it covers, as HH:MM, in order. */
	boots: string[];
	/** An EventBridge Scheduler cron expression, read in UTC. */
	expression: `cron(${string})`;
	/** What the schedule invokes the launch Lambda with. */
	event: ScheduledEvent;
}

/** c6i.8xlarge as part of a name: C6i8xlarge. */
function pascal(instanceType: string): string {
	return instanceType
		.split(/[^a-z0-9]+/i)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/**
 * The launch schedules of some targets. A cron expression has one list of
 * minutes and one list of hours and fires at every pair, so a target's boots
 * are grouped by their minute, and each group is one schedule listing its
 * hours. A target whose boots all fall at one minute, as every target's do
 * today, has one schedule.
 */
export function launchSchedules(targets: readonly Target[]): LaunchSchedule[] {
	const schedules: LaunchSchedule[] = [];
	for (const target of targets) {
		const byMinute = new Map<string, string[]>();
		for (const time of [...target.boots_utc].sort()) {
			const minute = time.slice(3, 5);
			byMinute.set(minute, [...(byMinute.get(minute) ?? []), time]);
		}
		for (const [minute, boots] of [...byMinute].sort(([a], [b]) => a.localeCompare(b))) {
			const hours = boots.map((time) => Number(time.slice(0, 2)));
			schedules.push({
				name: `BoxLaunch${pascal(target.instance_type)}At${minute}`,
				instanceType: target.instance_type,
				zone: target.zone,
				boots,
				expression: `cron(${Number(minute)} ${hours.join(",")} * * ? *)`,
				event: scheduledEvent(target.instance_type),
			});
		}
	}
	return schedules;
}

/** The launch schedules of the targets: what the scheduled stage makes. */
export const LAUNCH_SCHEDULES: readonly LaunchSchedule[] = launchSchedules(TARGETS);

/**
 * The launch schedules a stage makes: every one for the scheduled stage
 * (infra/runs/stages.ts), none for any other, whose boxes start only by hand.
 */
export function stageLaunchSchedules(stage: string): readonly LaunchSchedule[] {
	return isScheduledStage(stage) ? LAUNCH_SCHEDULES : [];
}

/**
 * Stands in for the list of target types in a stage without launch
 * schedules. The launch refuses a scheduled launch of a type the list does
 * not name (unscheduledType, infra/runs/launch-event.ts), and this names
 * none, so even a schedule left behind in such a stage launches nothing; a
 * launch by hand names its type and is never refused for it. It is not empty
 * because the launch takes an empty value for one never set.
 */
export const NO_SCHEDULED_TYPES = "none (this stage is not the scheduled stage)";

/**
 * The launch function's LEDGERMATH_TARGET_INSTANCE_TYPES: the targets' types,
 * comma-separated, for the scheduled stage; NO_SCHEDULED_TYPES for any other.
 */
export function scheduledTargetTypes(stage: string): string {
	return isScheduledStage(stage) ? TARGETS.map((target) => target.instance_type).join(",") : NO_SCHEDULED_TYPES;
}
