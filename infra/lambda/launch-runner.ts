import {
	EC2Client,
	RunInstancesCommand,
	type _InstanceType,
} from "@aws-sdk/client-ec2";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Resource } from "sst";

const ec2 = new EC2Client({});

function buildUserData(): string {
	// Copied into the Lambda bundle via Function copyFiles (see sst.config.ts).
	const scriptPath = join(process.cwd(), "run-benchmarks.sh");
	const script = readFileSync(scriptPath, "utf8");
	const header = `#!/usr/bin/env bash
export LEDGERMATH_BUCKET=${JSON.stringify(Resource.Results.name)}
export LEDGERMATH_SOURCE_KEY=${JSON.stringify(Resource.Runner.sourceKey)}
export LEDGERMATH_STAGE=${JSON.stringify(Resource.Runner.stage)}
`;
	// Strip the script's own shebang; header already has one.
	const body = script.replace(/^#!.*\n/, "");
	return header + body;
}

export async function handler() {
	const userData = Buffer.from(buildUserData()).toString("base64");

	const result = await ec2.send(
		new RunInstancesCommand({
			ImageId: Resource.Runner.amiId,
			InstanceType: Resource.Runner.instanceType as _InstanceType,
			MinCount: 1,
			MaxCount: 1,
			IamInstanceProfile: { Name: Resource.Runner.instanceProfileName },
			// NetworkInterfaces (not top-level SubnetId/SGs) so we can force a public IP
			// for dnf + S3 without a NAT gateway.
			NetworkInterfaces: [
				{
					DeviceIndex: 0,
					AssociatePublicIpAddress: true,
					SubnetId: Resource.Runner.subnetId,
					Groups: [Resource.Runner.securityGroupId],
				},
			],
			UserData: userData,
			InstanceInitiatedShutdownBehavior: "terminate",
			MetadataOptions: {
				HttpTokens: "required",
				HttpEndpoint: "enabled",
			},
			BlockDeviceMappings: [
				{
					DeviceName: "/dev/xvda",
					Ebs: {
						VolumeSize: 40,
						VolumeType: "gp3",
						DeleteOnTermination: true,
					},
				},
			],
			TagSpecifications: [
				{
					ResourceType: "instance",
					Tags: [
						{
							Key: "Name",
							Value: `ledgermath-runner-${Resource.Runner.stage}`,
						},
						{ Key: "ledgermath-runner", Value: "true" },
						{ Key: "ledgermath-stage", Value: Resource.Runner.stage },
					],
				},
				{
					ResourceType: "volume",
					Tags: [
						{
							Key: "Name",
							Value: `ledgermath-runner-${Resource.Runner.stage}`,
						},
						{ Key: "ledgermath-runner", Value: "true" },
						{ Key: "ledgermath-stage", Value: Resource.Runner.stage },
					],
				},
			],
		}),
	);

	const instance = result.Instances?.[0];
	const instanceId = instance?.InstanceId;
	if (!instanceId) {
		throw new Error("RunInstances returned no instance id");
	}

	console.log(
		JSON.stringify({
			message: "launched ledgermath runner",
			instanceId,
			instanceType: Resource.Runner.instanceType,
			stage: Resource.Runner.stage,
		}),
	);

	return {
		instanceId,
		instanceType: Resource.Runner.instanceType,
		stage: Resource.Runner.stage,
	};
}
