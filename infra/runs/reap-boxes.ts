import {
	EC2Client,
	type Instance,
	paginateDescribeInstances,
	TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

/**
 * Terminates boxes of this -runs stage that are still up long after they should
 * have ended themselves. A box sets a 45-minute shutdown timer as its first
 * act; one still up at 50 minutes has failed to end, and would otherwise bill
 * all day and still hold its vCPUs of the quota when its target's next boot
 * comes, which could then be refused.
 *
 * It only ever touches this stage's boxes: the describe filter, the check in
 * staleBoxes, and its IAM policy (infra/runs/stack.ts) each require the tags
 * ledgermath-box=true and ledgermath-stage=<this stage>.
 */

export const MAX_AGE_MS = 50 * 60 * 1000;

/** The ids of this stage's boxes launched more than MAX_AGE_MS before `now`. */
export function staleBoxes(instances: Instance[], stage: string, now: number): string[] {
	const stale: string[] = [];
	for (const instance of instances) {
		const tags = new Map((instance.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
		if (tags.get("ledgermath-box") !== "true" || tags.get("ledgermath-stage") !== stage) continue;
		const launched = instance.LaunchTime?.getTime();
		if (instance.InstanceId && launched !== undefined && now - launched > MAX_AGE_MS) {
			stale.push(instance.InstanceId);
		}
	}
	return stale;
}

const ec2 = new EC2Client({});

export async function handler(): Promise<{ stage: string; terminated: string[] }> {
	const stage = process.env.LEDGERMATH_STAGE;
	if (!stage) throw new Error("LEDGERMATH_STAGE is not set");

	const instances: Instance[] = [];
	const pages = paginateDescribeInstances(
		{ client: ec2 },
		{
			Filters: [
				{ Name: "tag:ledgermath-box", Values: ["true"] },
				{ Name: "tag:ledgermath-stage", Values: [stage] },
				{ Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
			],
		},
	);
	for await (const page of pages) {
		for (const reservation of page.Reservations ?? []) instances.push(...(reservation.Instances ?? []));
	}

	const terminated = staleBoxes(instances, stage, Date.now());
	if (terminated.length > 0) {
		await ec2.send(new TerminateInstancesCommand({ InstanceIds: terminated }));
	}
	console.log(JSON.stringify({ message: "reaped ledgermath boxes", stage, seen: instances.length, terminated }));
	return { stage, terminated };
}
