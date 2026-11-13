import { createHash } from "node:crypto";

import { INSTANCE_TYPE } from "./schedule";

/**
 * What the launch Lambda is invoked with, and what it makes of it. No AWS SDK
 * here: infra/runs/placement.ts and the tests import it.
 *
 * A scheduled launch's payload is {"scheduledTime": ..., "instanceType": ...}
 * (scheduledEvent). A launch by hand has no scheduledTime and names any
 * instance type: {"instanceType": "c6i.large"}.
 */

/** EventBridge Scheduler replaces this with the time an invocation was scheduled for, such as 2026-11-12T22:10:00Z. */
export const SCHEDULED_TIME_PLACEHOLDER = "<aws.scheduler.scheduled-time>";

export interface ScheduledEvent {
	scheduledTime: string;
	instanceType: string;
}

/** The payload one target's schedule invokes the launch Lambda with. */
export function scheduledEvent(instanceType: string): ScheduledEvent {
	return { scheduledTime: SCHEDULED_TIME_PLACEHOLDER, instanceType };
}

const SCHEDULED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * A scheduled launch this late is not started. Lambda can hold an asynchronous
 * event for a while after throttling or an error of its own, and a box started
 * long after its slot wastes money and could overlap its own target's next
 * boot, which the schedule's times are kept apart to avoid
 * (infra/runs/schedule.ts).
 */
export const LATEST_START_MS = 10 * 60 * 1000;

function field(event: unknown, name: string): unknown {
	if (typeof event !== "object" || event === null) return undefined;
	return (event as Record<string, unknown>)[name];
}

/** The payload's scheduled time; undefined for a launch by hand. */
function scheduledTimeOf(event: unknown): string | undefined {
	const scheduledTime = field(event, "scheduledTime");
	if (scheduledTime === undefined) return undefined;
	if (typeof scheduledTime !== "string" || !SCHEDULED_TIME.test(scheduledTime)) {
		throw new Error(
			`scheduledTime must be a time such as 2026-11-12T22:10:00Z, got ${JSON.stringify(scheduledTime)}`,
		);
	}
	return scheduledTime;
}

/**
 * The instance type the payload asks for. Every launch names one: there is no
 * default, so a launch by hand never starts a 32-vCPU box by omission.
 */
export function requestedInstanceType(event: unknown): string {
	const requested = field(event, "instanceType");
	if (typeof requested !== "string" || !INSTANCE_TYPE.test(requested)) {
		throw new Error(
			`the payload must name an EC2 instance type, such as {"instanceType": "c6i.large"}; got ${JSON.stringify(requested ?? null)}`,
		);
	}
	return requested;
}

/**
 * Why a scheduled launch is too late to start at `now`, or undefined when it is
 * not. A launch by hand is never too late.
 */
export function lateness(event: unknown, now: Date): string | undefined {
	const scheduledTime = scheduledTimeOf(event);
	if (scheduledTime === undefined) return undefined;
	const late = now.getTime() - Date.parse(scheduledTime);
	if (late <= LATEST_START_MS) return undefined;
	return `scheduled for ${scheduledTime} and invoked at ${now.toISOString()}, ${Math.round(late / 1000)} s late; a scheduled launch more than ${LATEST_START_MS / 60_000} minutes late is not started`;
}

/**
 * Why a scheduled launch names an instance type the stage does not schedule,
 * or undefined when it does not. `targets` are the instance types of
 * schedule.json's targets, as deployed. A launch by hand may name any type.
 */
export function unscheduledType(event: unknown, targets: readonly string[]): string | undefined {
	const scheduledTime = scheduledTimeOf(event);
	if (scheduledTime === undefined) return undefined;
	const instanceType = requestedInstanceType(event);
	if (targets.includes(instanceType)) return undefined;
	return `a launch scheduled for ${scheduledTime} names ${instanceType}, which is not a target of the deployed schedule (${targets.join(", ")}); only a launch by hand, without scheduledTime, may name another type`;
}

/**
 * The RunInstances ClientToken. A scheduled launch's token comes from the
 * stage, the instance type and the scheduled time, so however often one
 * slot's invocation is repeated, EC2 starts at most one box for it, and two
 * targets booting at the same minute are two slots. A launch by hand has no
 * scheduled time; then this is undefined and the SDK makes a fresh token.
 */
export function clientToken(stage: string, event: unknown): string | undefined {
	const scheduledTime = scheduledTimeOf(event);
	if (scheduledTime === undefined) return undefined;
	const instanceType = requestedInstanceType(event);
	// 64 hex characters, EC2's limit for a client token.
	return createHash("sha256").update(`ledgermath-box ${stage} ${instanceType} ${scheduledTime}`).digest("hex");
}
