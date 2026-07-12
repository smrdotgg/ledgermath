import {
	DescribeInstancesCommand,
	EC2Client,
	TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { Resource } from "sst";

const ec2 = new EC2Client({});

/** Kill runner instances older than this (failed user-data must not bill all day). */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export async function handler() {
	const stage = Resource.Runner.stage;
	const cutoff = Date.now() - MAX_AGE_MS;

	const described = await ec2.send(
		new DescribeInstancesCommand({
			Filters: [
				{ Name: "tag:ledgermath-runner", Values: ["true"] },
				{ Name: "tag:ledgermath-stage", Values: [stage] },
				{
					Name: "instance-state-name",
					Values: ["pending", "running", "stopping", "stopped"],
				},
			],
		}),
	);

	const staleIds: string[] = [];
	for (const reservation of described.Reservations ?? []) {
		for (const instance of reservation.Instances ?? []) {
			const id = instance.InstanceId;
			const launch = instance.LaunchTime?.getTime();
			if (!id || launch === undefined) continue;
			if (launch < cutoff) {
				staleIds.push(id);
			}
		}
	}

	if (staleIds.length === 0) {
		console.log(
			JSON.stringify({
				message: "no stale ledgermath runners",
				stage,
			}),
		);
		return { terminated: [] as string[] };
	}

	console.log(
		JSON.stringify({
			message: "terminating stale ledgermath runners",
			stage,
			instanceIds: staleIds,
		}),
	);

	await ec2.send(
		new TerminateInstancesCommand({
			InstanceIds: staleIds,
		}),
	);

	return { terminated: staleIds };
}
