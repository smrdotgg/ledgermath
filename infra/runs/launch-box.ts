import { EC2Client, RunInstancesCommand, type _InstanceType, type Tag } from "@aws-sdk/client-ec2";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildUserData } from "./user-data";

/**
 * Launches one box of a -runs stage: invoked daily by the stage's schedule, or
 * by hand. Its configuration is the function's environment, set in
 * infra/runs/stack.ts. For a smoke test the payload may name another instance
 * type, such as {"instanceType": "c6i.large"}; its Runs are real Runs of that
 * type.
 */

export interface LaunchResult {
	instanceId: string;
	instanceType: string;
	imageId: string;
	sourceCommit: string;
	stage: string;
}

const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;

/** The instance type the payload asks for, or the configured one. */
export function chooseInstanceType(event: unknown, configured: string): string {
	if (typeof event !== "object" || event === null) return configured;
	const requested = (event as { instanceType?: unknown }).instanceType;
	if (requested === undefined) return configured;
	if (typeof requested !== "string" || !INSTANCE_TYPE.test(requested)) {
		throw new Error(`instanceType must be an EC2 instance type such as "c6i.large", got ${JSON.stringify(requested)}`);
	}
	return requested;
}

/**
 * The tags on a box and its volume. infra/runs/reap-boxes.ts finds boxes by
 * ledgermath-box and ledgermath-stage. July's reaper requires
 * ledgermath-runner=true, which a box never carries.
 */
export function boxTags(stage: string, sourceCommit: string): Tag[] {
	return [
		{ Key: "Name", Value: `ledgermath-box-${stage}` },
		{ Key: "ledgermath-box", Value: "true" },
		{ Key: "ledgermath-stage", Value: stage },
		{ Key: "ledgermath-source-commit", Value: sourceCommit },
	];
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

const ec2 = new EC2Client({});

export async function handler(event: unknown): Promise<LaunchResult> {
	const stage = required("LEDGERMATH_STAGE");
	const imageId = required("LEDGERMATH_IMAGE_ID");
	const sourceCommit = required("LEDGERMATH_SOURCE_COMMIT");
	const instanceType = chooseInstanceType(event, required("LEDGERMATH_INSTANCE_TYPE"));

	// Copied into the bundle from runner/box.sh (copyFiles in infra/runs/stack.ts).
	const userData = buildUserData(readFileSync(join(process.cwd(), "box.sh"), "utf8"), {
		bucket: required("LEDGERMATH_BUCKET"),
		stage,
		sourceKey: required("LEDGERMATH_SOURCE_KEY"),
		sourceCommit,
		region: required("AWS_REGION"),
	});

	const tags = boxTags(stage, sourceCommit);

	const result = await ec2.send(
		new RunInstancesCommand({
			ImageId: imageId,
			InstanceType: instanceType as _InstanceType,
			MinCount: 1,
			MaxCount: 1,
			IamInstanceProfile: { Name: required("LEDGERMATH_INSTANCE_PROFILE") },
			// A public address reaches the package repository and S3 without a NAT gateway.
			NetworkInterfaces: [
				{
					DeviceIndex: 0,
					AssociatePublicIpAddress: true,
					SubnetId: required("LEDGERMATH_SUBNET_ID"),
					Groups: [required("LEDGERMATH_SECURITY_GROUP_ID")],
				},
			],
			UserData: Buffer.from(userData, "utf8").toString("base64"),
			InstanceInitiatedShutdownBehavior: "terminate",
			MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
			TagSpecifications: [
				{ ResourceType: "instance", Tags: tags },
				{ ResourceType: "volume", Tags: tags },
			],
		}),
	);

	const instanceId = result.Instances?.[0]?.InstanceId;
	if (!instanceId) throw new Error("RunInstances returned no instance id");
	const launched: LaunchResult = { instanceId, instanceType, imageId, sourceCommit, stage };
	console.log(JSON.stringify({ message: "launched a ledgermath box", ...launched }));
	return launched;
}
