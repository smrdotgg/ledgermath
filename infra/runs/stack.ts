/// <reference path="../../.sst/platform/config.d.ts" />

/**
 * The stack of a -runs stage. sst.config.ts sends every stage whose name ends
 * in -runs here; every other stage gets July's stack, unchanged.
 *
 * Once a day a Lambda launches one box. The box boots the pinned image with
 * runner/box.sh as its user-data, fetches the source archive of the deployed
 * commit, runs the schedule, uploads to this stage's bucket and terminates:
 *
 *     runs/<yyyy>/<mm>/<dd>/<id>.json      one Run
 *     blobs/sha256/<hex>                   every blob a Run cites
 *     boots/<yyyy>/<mm>/<dd>/<boot>.json   what one boot did
 *     logs/<yyyy>/<mm>/<dd>/<boot>.log     the box's log
 *     source/<commit>.tar.gz               git archive of the deployed commit
 *
 * A second Lambda terminates any box of this stage that outlives its own
 * 45-minute timer.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { SCHEDULED_EVENT } from "./launch-event";

/**
 * Amazon Linux 2023 2023.12.20260710.0, kernel 6.1: the image July's pipeline
 * has booted since 2026-07-18. The image, and with it the kernel and the
 * compiler, changes only when this line does.
 */
const IMAGE_ID = "ami-03499a87bbb39a09a";
const ZONE = "us-east-2c";
const INSTANCE_TYPE = "c6i.8xlarge";
/**
 * An hour before July's 23:10. Two 32-vCPU runners and the dev machine's 4
 * vCPUs exceed the account's 64-vCPU quota, so the two must never overlap.
 */
const LAUNCH_SCHEDULE = "cron(10 22 * * ? *)";
const REAP_SCHEDULE = "rate(5 minutes)";
/** What a box may write. scripts/box-in-container/aws allows the same. */
const BOX_WRITES = ["runs/", "blobs/", "boots/", "logs/"];

/** SST commands that change nothing in AWS, which may run from a tree that differs from HEAD. */
const NON_DEPLOYING = new Set(["diff", "remove", "refresh"]);

interface SourceArchive {
	commit: string;
	path: string;
	key: string;
}

/**
 * A git archive of HEAD. A box runs exactly this, and its Runs record this
 * commit, so a deploy from a tree that differs from HEAD stops here: the
 * box's user-data (runner/box.sh, copied from the working tree) or anything
 * else deployed might then not be what the commit holds. sst-env.d.ts is
 * exempt; SST rewrites it on every deploy, and no box reads it.
 */
function sourceArchive(): SourceArchive {
	const root = $cli.paths.root;
	const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	const changes = git("status", "--porcelain", "--untracked-files=all")
		.split("\n")
		.filter((line) => line !== "" && !line.endsWith("sst-env.d.ts"));
	if (changes.length > 0) {
		const message = [
			"The working tree differs from HEAD, so a box would not run the commit its Runs record:",
			...changes.map((line) => `  ${line}`),
			"Commit or remove these changes, then deploy again.",
		].join("\n");
		if (!NON_DEPLOYING.has($cli.command)) throw new Error(message);
		console.warn(`${message}\n(sst ${$cli.command} goes on; a deploy would stop here.)`);
	}
	const commit = git("rev-parse", "HEAD").trim();
	const directory = join(root, ".sst", "ledgermath-source");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${commit}.tar.gz`);
	git("archive", "--format=tar.gz", "-o", path, commit);
	return { commit, path, key: `source/${commit}.tar.gz` };
}

export function runsStack() {
	const archive = sourceArchive();

	// Runs are added and never edited: versioning keeps every earlier object
	// even if a key is written twice.
	const bucket = new sst.aws.Bucket("RunsBucket", { versioning: true });
	const source = new aws.s3.BucketObjectv2("Source", {
		bucket: bucket.name,
		key: archive.key,
		source: $asset(archive.path),
		contentType: "application/gzip",
	});

	const vpc = aws.ec2.getVpcOutput({ default: true });
	const subnet = aws.ec2.getSubnetOutput({
		filters: [
			{ name: "vpc-id", values: [vpc.id] },
			{ name: "availability-zone", values: [ZONE] },
			{ name: "default-for-az", values: ["true"] },
		],
	});
	const securityGroup = new aws.ec2.SecurityGroup("BoxSg", {
		vpcId: vpc.id,
		description: "LedgerMath box - egress only",
		egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"], ipv6CidrBlocks: ["::/0"] }],
		ingress: [],
	});

	// The box reads its source, lists blobs/ (so it uploads only the blobs the
	// bucket does not hold yet), and writes its prefixes, nothing else.
	const boxRole = new aws.iam.Role("BoxRole", {
		assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
	});
	new aws.iam.RolePolicy("BoxPolicy", {
		role: boxRole.id,
		policy: $jsonStringify({
			Version: "2012-10-17",
			Statement: [
				{ Effect: "Allow", Action: ["s3:GetObject"], Resource: [$interpolate`${bucket.arn}/${archive.key}`] },
				{
					Effect: "Allow",
					Action: ["s3:ListBucket"],
					Resource: [bucket.arn],
					Condition: { StringLike: { "s3:prefix": ["blobs/", "blobs/*"] } },
				},
				{
					Effect: "Allow",
					Action: ["s3:PutObject"],
					Resource: BOX_WRITES.map((prefix) => $interpolate`${bucket.arn}/${prefix}*`),
				},
			],
		}),
	});
	const boxProfile = new aws.iam.InstanceProfile("BoxProfile", { role: boxRole.name });

	// A retried launch could start a second box, or a late one that overlaps
	// July's 23:10 launch. Scheduler's own delivery retries are SST's default
	// of 0; `function.retries: 0` makes the Lambda event-invoke config that
	// stops Lambda retrying an asynchronous invocation, twice by default, and
	// its transform sets the oldest event Lambda will still run to a minute,
	// the least it allows (six hours by default). The payload carries the
	// scheduled time: the launch's client token comes from it, so one slot can
	// only ever start one box, and the handler refuses a launch more than ten
	// minutes after it.
	const launch = new sst.aws.CronV2("BoxLaunch", {
		schedule: LAUNCH_SCHEDULE,
		timezone: "UTC",
		retries: 0,
		event: SCHEDULED_EVENT,
		function: {
			handler: "infra/runs/launch-box.handler",
			timeout: "60 seconds",
			retries: 0,
			transform: { eventInvokeConfig: { maximumEventAgeInSeconds: 60 } },
			copyFiles: [{ from: "runner/box.sh", to: "box.sh" }],
			environment: {
				LEDGERMATH_STAGE: $app.stage,
				LEDGERMATH_BUCKET: bucket.name,
				LEDGERMATH_SOURCE_KEY: source.key,
				LEDGERMATH_SOURCE_COMMIT: archive.commit,
				LEDGERMATH_IMAGE_ID: IMAGE_ID,
				LEDGERMATH_INSTANCE_TYPE: INSTANCE_TYPE,
				LEDGERMATH_SUBNET_ID: subnet.id,
				LEDGERMATH_SECURITY_GROUP_ID: securityGroup.id,
				LEDGERMATH_INSTANCE_PROFILE: boxProfile.name,
			},
			permissions: [
				{ actions: ["ec2:RunInstances"], resources: ["*"] },
				{
					actions: ["ec2:CreateTags"],
					resources: ["*"],
					conditions: [{ test: "StringEquals", variable: "ec2:CreateAction", values: ["RunInstances"] }],
				},
				{ actions: ["iam:PassRole"], resources: [boxRole.arn] },
			],
			nodejs: { install: ["@aws-sdk/client-ec2"] },
		},
	});

	const reaper = new sst.aws.CronV2("BoxReaper", {
		schedule: REAP_SCHEDULE,
		timezone: "UTC",
		function: {
			handler: "infra/runs/reap-boxes.handler",
			timeout: "60 seconds",
			environment: { LEDGERMATH_STAGE: $app.stage },
			permissions: [
				{ actions: ["ec2:DescribeInstances"], resources: ["*"] },
				{
					actions: ["ec2:TerminateInstances"],
					resources: ["*"],
					conditions: [
						{ test: "StringEquals", variable: "aws:ResourceTag/ledgermath-box", values: ["true"] },
						{ test: "StringEquals", variable: "aws:ResourceTag/ledgermath-stage", values: [$app.stage] },
					],
				},
			],
			nodejs: { install: ["@aws-sdk/client-ec2"] },
		},
	});

	return {
		bucket: bucket.name,
		launchFunction: launch.nodes.function.name,
		reaperFunction: reaper.nodes.function.name,
		launchSchedule: `${LAUNCH_SCHEDULE} UTC`,
		instanceType: INSTANCE_TYPE,
		imageId: IMAGE_ID,
		zone: ZONE,
		subnet: subnet.id,
		sourceCommit: archive.commit,
		sourceKey: source.key,
	};
}
