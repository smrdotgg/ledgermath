/**
 * Where and when a -runs stage launches its boxes: the targets of
 * schedule.json, checked by infra/runs/schedule.ts. infra/runs/stack.ts makes
 * one launch schedule from each, and an invalid schedule.json stops the deploy
 * here. scripts/alarm.ts reads the same targets from the schedule it is given.
 * Nothing else names an instance type or a boot time.
 *
 * Plain data: no SST global is used, so tests and scripts can import it.
 * schedule.json is imported, not read, so the deploy's bundle holds the file
 * as committed.
 */

import scheduleFile from "../../schedule.json";

import { type ScheduledEvent, scheduledEvent } from "./launch-event";
import { parseSchedule, type Schedule, type Target } from "./schedule";

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

/** The stage's launch schedules. */
export const LAUNCH_SCHEDULES: readonly LaunchSchedule[] = launchSchedules(TARGETS);
