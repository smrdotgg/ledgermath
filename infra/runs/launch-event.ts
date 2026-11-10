import { createHash } from "node:crypto";

/**
 * What the launch Lambda is invoked with, and what it makes of it. No AWS SDK
 * here: infra/runs/stack.ts imports SCHEDULED_EVENT.
 */

/**
 * The payload the schedule invokes the launch Lambda with. EventBridge
 * Scheduler replaces the placeholder with the time the invocation was
 * scheduled for, such as 2026-11-12T22:10:00Z.
 */
export const SCHEDULED_EVENT = { scheduledTime: "<aws.scheduler.scheduled-time>" };

const SCHEDULED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * A scheduled launch this late is not started. Lambda can hold an asynchronous
 * event for a while after throttling or an error of its own, and a box started
 * long after 22:10 could still hold 32 vCPUs when July's pipeline launches at
 * 23:10, which the account's 64-vCPU quota cannot fit.
 */
export const LATEST_START_MS = 10 * 60 * 1000;
const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;

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
 * The RunInstances ClientToken. A scheduled launch's token comes from the stage
 * and the scheduled time, so however often one slot's invocation is repeated,
 * EC2 starts at most one box for it. A launch by hand has no scheduled time;
 * then this is undefined and the SDK makes a fresh token.
 */
export function clientToken(stage: string, event: unknown): string | undefined {
	const scheduledTime = scheduledTimeOf(event);
	if (scheduledTime === undefined) return undefined;
	// 64 hex characters, EC2's limit for a client token.
	return createHash("sha256").update(`ledgermath-box ${stage} ${scheduledTime}`).digest("hex");
}

/**
 * The instance type the payload asks for, such as {"instanceType": "c6i.large"}
 * for a smoke test, or the configured one.
 */
export function chooseInstanceType(event: unknown, configured: string): string {
	const requested = field(event, "instanceType");
	if (requested === undefined) return configured;
	if (typeof requested !== "string" || !INSTANCE_TYPE.test(requested)) {
		throw new Error(`instanceType must be an EC2 instance type such as "c6i.large", got ${JSON.stringify(requested)}`);
	}
	return requested;
}
