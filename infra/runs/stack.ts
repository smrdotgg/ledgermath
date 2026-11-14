/// <reference path="../../.sst/platform/config.d.ts" />

/**
 * The stack of a -runs stage. sst.config.ts sends every stage whose name ends
 * in -runs here; every other stage gets July's stack, unchanged.
 *
 * schedule.json names the targets: instance types, their zone, and the times
 * of day each boots (infra/runs/placement.ts). In the one scheduled stage
 * (infra/runs/stages.ts) each target gets an EventBridge schedule, and every
 * schedule invokes the one launch Lambda, which launches
 * one box of that type. The box boots the pinned image with runner/box.sh as
 * its user-data, fetches the source archive of the deployed commit, runs the
 * schedule's entries for its type, uploads to this stage's bucket and
 * terminates:
 *
 *     runs/<yyyy>/<mm>/<dd>/<id>.json      one Run
 *     blobs/sha256/<hex>                   every blob a Run cites
 *     boots/<yyyy>/<mm>/<dd>/<boot>.json   what one boot did
 *     logs/<yyyy>/<mm>/<dd>/<boot>.log     the box's log
 *     source/<commit>.tar.gz               git archive of the deployed commit
 *
 * The deploy also puts blobs there itself: AWS-LC's source archive, which the
 * box fetches to build http_get (infra/runs/tls-archive.ts), and the bytes of
 * each Fixture of the s3_fixtures Service, which S3 copies into a private
 * fixtures bucket of its own (infra/runs/fixtures.ts). A box may assume a
 * role that reads those objects and nothing else; runner/run.py does, once
 * per boot, and gives the keys to http_get alone.
 *
 * A second Lambda terminates any box of this stage that outlives its own
 * 45-minute timer.
 *
 * GitHub's OIDC provider and a role that only this repository's workflows on
 * main can assume let .github/workflows/runs.yml read Runs, boot summaries
 * and blobs from the bucket (infra/runs/github-role.ts).
 *
 * On the one stage PUBLIC_BLOBS names, and only when it says so, a CloudFront
 * distribution on the Free flat-rate plan lets anyone read blobs/sha256/<hex>,
 * and nothing else of the bucket, which stays private
 * (infra/runs/public-blobs.ts). It is off by default, and on every other
 * stage nothing of it exists: then the bucket's arguments, and everything
 * else here, are as they were without it.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { boxPolicy } from "./box-role";
import { confirmDeployAccount } from "./deploy-account";
import { fixturesReaderPolicy, fixturesReaderTrustPolicy, writeFixtureFiles } from "./fixtures";
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_URL, readPolicy, trustPolicy } from "./github-role";
import { scheduledTargetTypes, stageLaunchSchedules, TARGETS, ZONE } from "./placement";
import { PUBLIC_BLOBS, runsBucketArgs } from "./public-blobs";
import { preparePublicBlobs } from "./public-blobs-stack";
import { tlsArchive } from "./tls-archive";

/**
 * Amazon Linux 2023 2023.12.20260710.0, kernel 6.1: the image July's pipeline
 * booted from 2026-07-18 until it was retired. The image, and with it the
 * kernel and the compiler, changes only when this line does.
 */
const IMAGE_ID = "ami-03499a87bbb39a09a";
const REAP_SCHEDULE = "rate(5 minutes)";

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

export async function runsStack() {
	// Before anything is declared: the provider must act in the account the
	// stage's profile reaches (infra/runs/deploy-account.ts).
	confirmDeployAccount($app.stage, (await aws.getCallerIdentity({})).accountId);
	const archive = sourceArchive();
	// Checked before anything is made: a missing or wrong copy stops the deploy
	// here, saying how to fetch it.
	const tls = tlsArchive($cli.paths.root);
	// null on every stage but PUBLIC_BLOBS.stage, and there while "off". On
	// that stage it first reads what is deployed and stops a deploy the
	// transition rules refuse (infra/runs/public-blobs-guard.ts).
	const publicBlobs = preparePublicBlobs(PUBLIC_BLOBS, $cli.command);

	// Runs are added and never edited: versioning keeps every earlier object
	// even if a key is written twice. With public blobs "on", the bucket policy
	// also lets the distribution read blobs/sha256/*; otherwise the arguments
	// are { versioning: true }, as they always were.
	const bucket = new sst.aws.Bucket("RunsBucket", runsBucketArgs(publicBlobs?.bucketPolicy ?? null));
	const source = new aws.s3.BucketObjectv2("Source", {
		bucket: bucket.name,
		key: archive.key,
		source: $asset(archive.path),
		contentType: "application/gzip",
	});
	// AWS-LC's source archive, a blob like any other, named by its hash. Blobs
	// are kept for ever: a new pin gives a new key, so the resource is replaced,
	// and without retainOnDelete the provider would delete every version of the
	// old archive, which a reader needs to rebuild an older binary. With it, a
	// replacement, a resource taken out of this file, and `sst remove` all
	// leave the object in the bucket and only drop it from the stage's state.
	// (The stage's removal "retain" covers the bucket itself, not its objects.)
	new aws.s3.BucketObjectv2(
		"TlsArchive",
		{
			bucket: bucket.name,
			key: tls.key,
			source: $asset(tls.path),
			contentType: "application/gzip",
		},
		{ retainOnDelete: true },
	);

	// The s3_fixtures Service (infra/runs/fixtures.ts). Its bucket holds the
	// Fixtures and nothing else: never versioned, private, SSE-S3 by default,
	// no CORS, no lifecycle, no logging. Each Fixture's bytes are a blob in the
	// Runs bucket; S3 copies the blob into the fixtures bucket with a SHA-256
	// checksum over the whole object, as one part.
	const fixturesBucket = new sst.aws.Bucket("FixturesBucket", { cors: false });
	const fixtureFiles = writeFixtureFiles(join($cli.paths.root, ".sst", "ledgermath-fixtures"));
	for (const fixture of fixtureFiles) {
		// A blob too, kept for ever: see TlsArchive.
		const blob = new aws.s3.BucketObjectv2(
			`FixtureBlob${fixture.bytes}`,
			{
				bucket: bucket.name,
				key: fixture.blobKey,
				source: $asset(fixture.path),
				contentType: "application/octet-stream",
			},
			{ retainOnDelete: true },
		);
		new aws.s3.ObjectCopy(`Fixture${fixture.bytes}`, {
			bucket: fixturesBucket.name,
			key: fixture.key,
			source: $interpolate`${bucket.name}/${blob.key}`,
			checksumAlgorithm: "SHA256",
			storageClass: "STANDARD",
			serverSideEncryption: "AES256",
			metadataDirective: "COPY",
		});
	}

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

	// The box reads its source and AWS-LC's archive, lists blobs/ (so it
	// uploads only the blobs the bucket does not hold yet), writes its
	// prefixes, reads what EC2 says about its instance type, volumes, instance
	// and path to S3, and assumes the fixtures reader role; nothing else
	// (infra/runs/box-role.ts).
	const boxRole = new aws.iam.Role("BoxRole", {
		assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
	});
	// Only the box's role may assume it, and it may only read the Fixtures. A
	// session from a role a box already holds is role chaining, so it lasts at
	// most an hour.
	const fixturesRole = new aws.iam.Role("FixturesReaderRole", {
		description: "Assumed by the LedgerMath box's role for http_get: s3:GetObject on the Fixture objects, nothing else",
		assumeRolePolicy: boxRole.arn.apply((arn) => JSON.stringify(fixturesReaderTrustPolicy(arn))),
		maxSessionDuration: 3600,
	});
	new aws.iam.RolePolicy("FixturesReaderPolicy", {
		role: fixturesRole.id,
		policy: fixturesBucket.arn.apply((arn) => JSON.stringify(fixturesReaderPolicy(arn))),
	});
	new aws.iam.RolePolicy("BoxPolicy", {
		role: boxRole.id,
		policy: $resolve({ arn: bucket.arn, fixturesRoleArn: fixturesRole.arn }).apply(({ arn, fixturesRoleArn }) =>
			JSON.stringify(boxPolicy(arn, archive.key, { tlsArchiveKey: tls.key, fixturesRoleArn })),
		),
	});
	const boxProfile = new aws.iam.InstanceProfile("BoxProfile", { role: boxRole.name });

	// A retried launch could start a second box, or a late one that overlaps
	// the boots the schedule keeps apart. `retries: 0` makes the Lambda
	// event-invoke config that stops Lambda retrying an asynchronous
	// invocation, twice by default, and its transform sets the oldest event
	// Lambda will still run to a minute, the least it allows (six hours by
	// default). The handler refuses a scheduled launch more than ten minutes
	// after its time, or of a type that is not a target.
	//
	// Until step 4 this function was the child of a CronV2 named BoxLaunch.
	// The alias says it is the same function, so a deploy updates it in place,
	// keeping its name and its log group (where #38's dated checks read the
	// launches), instead of deleting it and making a new one. Once every
	// -runs stage has been deployed with it, the alias does nothing.
	const launchAliases = [{ parent: `urn:pulumi:${$app.stage}::${$app.name}::sst:aws:CronV2::BoxLaunch` }];
	const launch = new sst.aws.Function("BoxLaunchHandler", {
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
			LEDGERMATH_TARGET_INSTANCE_TYPES: scheduledTargetTypes($app.stage),
			LEDGERMATH_SUBNET_ID: subnet.id,
			LEDGERMATH_SECURITY_GROUP_ID: securityGroup.id,
			LEDGERMATH_INSTANCE_PROFILE: boxProfile.name,
			LEDGERMATH_FIXTURES_BUCKET: fixturesBucket.name,
			LEDGERMATH_FIXTURES_ROLE: fixturesRole.arn,
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
	}, { aliases: launchAliases });

	// One schedule per target (per minute past the hour its boots fall at; one
	// per target today), each with its own role allowed to invoke the launch
	// Lambda. Scheduler's own delivery retries are 0. The payload carries the
	// scheduled time and the instance type: the launch's client token comes
	// from both, so one slot of one target can only ever start one box. Only
	// the scheduled stage has them (infra/runs/stages.ts); in any other, boxes
	// start by hand, and the launch refuses a scheduled payload.
	const launchSchedules = stageLaunchSchedules($app.stage);
	for (const schedule of launchSchedules) {
		new sst.aws.CronV2(schedule.name, {
			schedule: schedule.expression,
			timezone: "UTC",
			retries: 0,
			event: schedule.event,
			function: launch,
		});
	}

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

	// The workflow's way in: GitHub's OIDC provider (one per account; AWS checks
	// GitHub's certificate against its own trusted CAs, so no thumbprint) and a
	// role that only workflows of this repository on main can assume, which
	// may list the bucket and read runs/, boots/ and blobs/.
	const githubOidc = new aws.iam.OpenIdConnectProvider("GitHubOidc", {
		url: GITHUB_OIDC_URL,
		clientIdLists: [GITHUB_OIDC_AUDIENCE],
	});
	const readerRole = new aws.iam.Role("RunsReaderRole", {
		description: "Assumed by .github/workflows/runs.yml on main: lists the bucket, reads runs/, boots/, blobs/",
		assumeRolePolicy: githubOidc.arn.apply((arn) => JSON.stringify(trustPolicy(arn))),
		maxSessionDuration: 3600,
	});
	new aws.iam.RolePolicy("RunsReaderPolicy", {
		role: readerRole.id,
		policy: bucket.arn.apply((arn) => JSON.stringify(readPolicy(arn))),
	});

	const publicBlobsOutputs = publicBlobs === null ? null : publicBlobs.create(bucket);

	return {
		bucket: bucket.name,
		runsReaderRole: readerRole.arn,
		launchFunction: launch.name,
		reaperFunction: reaper.nodes.function.name,
		/** Every target, with its boot times and the schedules that launch it. */
		targets: TARGETS.map((target) => ({
			instanceType: target.instance_type,
			zone: target.zone,
			bootsUtc: target.boots_utc,
			schedules: launchSchedules.filter((schedule) => schedule.instanceType === target.instance_type).map((schedule) => ({
				name: schedule.name,
				expression: `${schedule.expression} UTC`,
				payload: schedule.event,
			})),
		})),
		imageId: IMAGE_ID,
		zone: ZONE,
		subnet: subnet.id,
		sourceCommit: archive.commit,
		sourceKey: source.key,
		tlsArchiveKey: tls.key,
		fixturesBucket: fixturesBucket.name,
		fixturesRole: fixturesRole.arn,
		// Absent while off, so the outputs are as they were.
		...(publicBlobsOutputs === null ? {} : { publicBlobs: publicBlobsOutputs }),
	};
}
