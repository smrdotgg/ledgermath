/// <reference path="./.sst/platform/config.d.ts" />

/**
 * LedgerMath daily EC2 runner
 *
 * Flow: CronV2 → launch-runner Lambda → RunInstances
 *       → user-data builds + runs benchmarks/c/run-all.sh → S3 → terminate
 *
 * Override instance type: LEDGERMATH_INSTANCE_TYPE=c6i.metal sst deploy
 */
export default $config({
	app(input) {
		return {
			name: "ledgermath",
			removal: input?.stage === "production" ? "retain" : "remove",
			protect: ["production"].includes(input?.stage),
			home: "aws",
			providers: {
				aws: {
					profile:
						input?.stage === "production" ? "tabot-production" : "tabot-dev",
				},
			},
		};
	},
	async run() {
		// Account vCPU quota is 32 for standard On-Demand (L-1216C47A).
		// c6i.metal needs 128 — use 8xlarge until the quota is raised.
		// Override: LEDGERMATH_INSTANCE_TYPE=c6i.metal sst deploy
		const instanceType =
			process.env.LEDGERMATH_INSTANCE_TYPE ?? "c6i.8xlarge";
		const sourceKey = "source/benchmarks-c.zip";

		const results = new sst.aws.Bucket("Results");

		// Bundle benchmarks/c for the runner to build on-instance (-march=native).
		new aws.s3.BucketObjectv2("BenchSource", {
			bucket: results.name,
			key: sourceKey,
			source: $asset("benchmarks/c"),
			contentType: "application/zip",
		});

		const ami = aws.ec2.getAmiOutput({
			mostRecent: true,
			owners: ["amazon"],
			filters: [
				{
					name: "name",
					values: ["al2023-ami-2023*-kernel-6.1-x86_64"],
				},
				{ name: "state", values: ["available"] },
				{ name: "architecture", values: ["x86_64"] },
				{ name: "root-device-type", values: ["ebs"] },
			],
		});

		const vpc = aws.ec2.getVpcOutput({ default: true });
		const subnets = aws.ec2.getSubnetsOutput({
			filters: [
				{ name: "vpc-id", values: [vpc.id] },
				{ name: "default-for-az", values: ["true"] },
			],
		});

		const securityGroup = new aws.ec2.SecurityGroup("RunnerSg", {
			vpcId: vpc.id,
			description: "LedgerMath bench runner - egress only",
			egress: [
				{
					protocol: "-1",
					fromPort: 0,
					toPort: 0,
					cidrBlocks: ["0.0.0.0/0"],
					ipv6CidrBlocks: ["::/0"],
				},
			],
			ingress: [],
		});

		const runnerRole = new aws.iam.Role("RunnerRole", {
			assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
				Service: "ec2.amazonaws.com",
			}),
		});

		new aws.iam.RolePolicy("RunnerS3Policy", {
			role: runnerRole.id,
			policy: results.arn.apply((arn) =>
				JSON.stringify({
					Version: "2012-10-17",
					Statement: [
						{
							Effect: "Allow",
							Action: ["s3:GetObject"],
							Resource: [`${arn}/source/*`],
						},
						{
							Effect: "Allow",
							Action: ["s3:PutObject"],
							Resource: [`${arn}/results/*`],
						},
					],
				}),
			),
		});

		const instanceProfile = new aws.iam.InstanceProfile("RunnerProfile", {
			role: runnerRole.name,
		});

		const runner = new sst.Linkable("Runner", {
			properties: {
				instanceType,
				amiId: ami.id,
				securityGroupId: securityGroup.id,
				subnetId: subnets.ids.apply((ids) => {
					const id = ids[0];
					if (!id) {
						throw new Error(
							"No default-VPC subnet found; create a default VPC or set subnets",
						);
					}
					return id;
				}),
				instanceProfileName: instanceProfile.name,
				sourceKey,
				stage: $app.stage,
			},
		});

		const launchPermissions = [
			{
				actions: [
					"ec2:RunInstances",
					"ec2:CreateTags",
					"ec2:DescribeInstances",
					"ec2:DescribeImages",
					"ec2:DescribeSubnets",
					"ec2:DescribeSecurityGroups",
					// Needed when RunInstances uses NetworkInterfaces (public IP).
					"ec2:CreateNetworkInterface",
					"ec2:DescribeNetworkInterfaces",
					"ec2:DeleteNetworkInterface",
				],
				resources: ["*"],
			},
			{
				actions: ["iam:PassRole"],
				resources: [runnerRole.arn],
			},
		];

		const reapPermissions = [
			{
				actions: ["ec2:DescribeInstances", "ec2:TerminateInstances"],
				resources: ["*"],
			},
		];

		const functionDefaults = {
			link: [results, runner],
			copyFiles: [
				{
					from: "infra/ec2/run-benchmarks.sh",
					to: "run-benchmarks.sh",
				},
			],
			nodejs: {
				install: ["@aws-sdk/client-ec2"],
			},
		};

		new sst.aws.CronV2("DailyLaunch", {
			// TEMP: 23:10 UTC smoke-test; restore to cron(0 6 * * ? *) after.
			schedule: "cron(10 23 * * ? *)",
			timezone: "UTC",
			function: {
				handler: "infra/lambda/launch-runner.handler",
				timeout: "60 seconds",
				permissions: launchPermissions,
				...functionDefaults,
			},
		});

		// Safety net: kill runners older than 2h (see reap-stale.ts).
		new sst.aws.CronV2("ReapStale", {
			schedule: "rate(1 hour)",
			timezone: "UTC",
			function: {
				handler: "infra/lambda/reap-stale.handler",
				timeout: "60 seconds",
				permissions: reapPermissions,
				link: [runner],
				nodejs: {
					install: ["@aws-sdk/client-ec2"],
				},
			},
		});

		return {
			bucket: results.name,
			instanceType,
			sourceKey,
			amiId: ami.id,
			dailySchedule: "cron(10 23 * * ? *) UTC (TEMP smoke-test; was 06:00)",
		};
	},
});
