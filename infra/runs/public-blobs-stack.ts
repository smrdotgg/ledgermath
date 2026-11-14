/// <reference path="../../.sst/platform/config.d.ts" />

/**
 * Makes the public-blobs resources (infra/runs/public-blobs.ts) of the one
 * stage PUBLIC_BLOBS.stage names. On any other stage it returns at once:
 * nothing is made, and AWS is not asked anything.
 *
 * On that stage, before anything else, it reads what is deployed, read-only,
 * with the AWS CLI and the stage's own profile (`aws cloudfront
 * list-distributions`, and `aws pricing-plan-manager list-subscriptions` when
 * a distribution exists), and judges the transition (public-blobs-guard.ts).
 * A deploy, `sst dev` or `sst remove` that is not allowed stops there, before
 * any resource is touched; `sst diff` and `sst refresh` only warn. When AWS
 * cannot be asked, that is not allowed either. Pulumi's `protect` on the
 * distribution and the subscription, while the distribution is enabled, is a
 * second lock: Pulumi refuses to delete either until a "dark" deploy has
 * lifted it.
 *
 * stack.ts calls preparePublicBlobs before it makes the Runs bucket, because
 * in "on" the bucket's one policy (which SST makes) must also hold the grant
 * to the distribution, and the distribution needs the bucket: the grant goes
 * in through the bucket's transform.policy, with the distribution's ARN as a
 * deferred output that create() resolves once the distribution exists. (Not
 * through the bucket's `policy` argument: SST holds back bucket.name and
 * bucket.nodes.bucket until that argument resolves, and the distribution
 * needs them, so that would wait for ever.)
 *
 * In us-east-1, by the `region` argument the provider's resources take since
 * @pulumi/aws 7 (no second provider): the web ACL, whose CLOUDFRONT scope
 * lives there, and the plan subscription, whose API is only there. The watch
 * runs in the stage's own Region and calls both APIs in us-east-1.
 */

import { execFileSync } from "node:child_process";

import { watchPermissions } from "./plan-watch";
import {
	BLOB_PREFIX,
	BLOB_REQUEST_FUNCTION_CODE,
	BLOB_RESPONSE_FUNCTION_CODE,
	type DeployedState,
	distributionArgs,
	GLOBAL_REGION,
	NO_ROUTE_FUNCTION_CODE,
	type PublicBlobsNames,
	type PublicBlobsPlan,
	type PublicBlobsSetting,
	publicBlobsNames,
	publicBlobsPlan,
	reminder,
	SUBSCRIPTION_TYPE,
	subscriptionState,
	WATCH_SCHEDULE,
	WEB_ACL_DESCRIPTION,
	webAclRules,
	withBlobGrant,
} from "./public-blobs";
import { type AwsCli, coverage, judgeTransition, type PlanVerdict, readDeployed, readSubscriptions, type Target } from "./public-blobs-guard";

export interface PublicBlobsOutputs {
	state: DeployedState;
	enabled: boolean;
	distributionId: $util.Output<string>;
	distributionArn: $util.Output<string>;
	domainName: $util.Output<string>;
	/** A blob's public address, with <hex> for the hash's 64 hex digits. */
	blobAddress: $util.Output<string>;
	webAclArn: $util.Output<string>;
	/** The Free plan subscription's ARN, or what to do instead. */
	plan: $util.Output<string> | string;
	watchFunction: $util.Output<string>;
}

export interface PublicBlobs {
	/** In "on" only: the Runs bucket's transform.policy, SST's policy with the grant to the distribution added. */
	bucketPolicy: ((args: aws.s3.BucketPolicyArgs) => undefined) | null;
	/** Makes the resources, once the bucket exists. */
	create(bucket: sst.aws.Bucket): PublicBlobsOutputs;
}

/** SST commands that change nothing in AWS: a refused transition only warns. */
const LOOKING_ONLY = new Set(["diff", "refresh"]);

/** The profile the stage's AWS provider uses: sst.config.ts's, or AWS_PROFILE's. */
function stageProfile(): string | undefined {
	return new $util.Config("aws").get("profile") ?? process.env.AWS_PROFILE;
}

/** The AWS CLI, read-only, with the stage's profile. */
function awsCli(profile: string | undefined): AwsCli {
	return (args) => {
		const command = [...args, "--region", GLOBAL_REGION, "--output", "json", ...(profile === undefined ? [] : ["--profile", profile])];
		return JSON.parse(execFileSync("aws", command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
	};
}

/**
 * What stack.ts needs before and after it makes the bucket, or null when
 * nothing is to be made (another stage, or "off" with nothing deployed).
 * Throws when the transition from what is deployed is not allowed.
 */
export function preparePublicBlobs(setting: PublicBlobsSetting, command: string): PublicBlobs | null {
	if ($app.stage !== setting.stage) return null;
	const profile = stageProfile();
	const cli = awsCli(profile);
	const target: Target = command === "remove" ? { kind: "remove" } : { kind: "deploy", state: setting.state, plan: setting.plan };

	const deployed = readDeployed(cli, setting.stage);
	let verdict: PlanVerdict | null = null;
	if (deployed.kind === "present") {
		try {
			verdict = coverage(deployed.arn, readSubscriptions(cli));
		} catch (error) {
			console.warn(`Public blobs: the plan subscriptions could not be listed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
		}
	}
	const judgement = judgeTransition(deployed, target, verdict);
	for (const warning of judgement.warnings) console.warn(`Public blobs: WARNING: ${warning}.`);
	if (!judgement.allowed) {
		const message = `Public blobs on ${setting.stage}: not allowed: ${judgement.reason}`;
		if (!LOOKING_ONLY.has(command)) throw new Error(message);
		console.warn(`${message}\n(sst ${command} goes on; a deploy would stop here.)`);
	} else {
		console.warn(`Public blobs on ${setting.stage}: ${judgement.reason}.`);
	}

	const plan = publicBlobsPlan(setting, $app.stage);
	if (plan === null) return null;
	console.warn(reminder(plan, profile).join("\n"));
	const names = publicBlobsNames($app.name, $app.stage);
	if (!plan.serveBlobs) return { bucketPolicy: null, create: (bucket) => createResources(plan, names, bucket, null) };
	const [distributionArn, setDistributionArn] = $util.deferredOutput<string>();
	return {
		bucketPolicy: (args: aws.s3.BucketPolicyArgs): undefined => {
			args.policy = $resolve({ policy: $output(args.policy), bucketName: $output(args.bucket), arn: distributionArn }).apply(({ policy, bucketName, arn }) => {
				if (typeof policy !== "string") throw new Error("Public blobs: the bucket policy SST made is not a JSON document");
				return withBlobGrant(policy, `arn:aws:s3:::${bucketName}`, arn);
			});
			return undefined;
		},
		create: (bucket) => createResources(plan, names, bucket, setDistributionArn),
	};
}

function createResources(
	plan: PublicBlobsPlan,
	names: PublicBlobsNames,
	bucket: sst.aws.Bucket,
	setDistributionArn: ((arn: $util.Output<string>) => void) | null,
): PublicBlobsOutputs {
	// The plan requires a web ACL; the plan pays for it and its rules.
	const webAcl = new aws.wafv2.WebAcl("PublicBlobsWebAcl", {
		region: GLOBAL_REGION,
		name: names.webAcl,
		description: WEB_ACL_DESCRIPTION,
		scope: "CLOUDFRONT",
		defaultAction: { allow: {} },
		rules: webAclRules(names.webAcl),
		visibilityConfig: { cloudwatchMetricsEnabled: true, metricName: names.webAcl, sampledRequestsEnabled: true },
	});
	const oac = new aws.cloudfront.OriginAccessControl("PublicBlobsOac", {
		name: names.originAccessControl,
		description: "LedgerMath public blobs: CloudFront signs its requests to the private Runs bucket",
		originAccessControlOriginType: "s3",
		signingBehavior: "always",
		signingProtocol: "sigv4",
	});
	const blobRequestFunction = new aws.cloudfront.Function("PublicBlobsBlobRequestFunction", {
		name: names.blobRequestFunction,
		runtime: "cloudfront-js-2.0",
		comment: "LedgerMath public blobs: 404 unless the address is /blobs/sha256/<hex>",
		code: BLOB_REQUEST_FUNCTION_CODE,
		publish: true,
	});
	const blobResponseFunction = new aws.cloudfront.Function("PublicBlobsBlobResponseFunction", {
		name: names.blobResponseFunction,
		runtime: "cloudfront-js-2.0",
		comment: "LedgerMath public blobs: the headers of bytes that never change",
		code: BLOB_RESPONSE_FUNCTION_CODE,
		publish: true,
	});
	const noRouteFunction = new aws.cloudfront.Function("PublicBlobsNoRouteFunction", {
		name: names.noRouteFunction,
		runtime: "cloudfront-js-2.0",
		comment: "LedgerMath public blobs: 404 for every address",
		code: NO_ROUTE_FUNCTION_CODE,
		publish: true,
	});
	const distribution = new aws.cloudfront.Distribution(
		"PublicBlobsDistribution",
		distributionArgs<$util.Input<string>>(
			{
				bucketDomain: bucket.nodes.bucket.bucketRegionalDomainName,
				originAccessControlId: oac.id,
				webAclArn: webAcl.arn,
				blobRequestFunctionArn: blobRequestFunction.arn,
				blobResponseFunctionArn: blobResponseFunction.arn,
				noRouteFunctionArn: noRouteFunction.arn,
			},
			plan,
		),
		{ protect: plan.protect },
	);
	if (setDistributionArn !== null) setDistributionArn(distribution.arn);
	// Created after the distribution and the web ACL it names, and so deleted
	// before them: AWS refuses to delete a distribution that is on a plan.
	const subscription = plan.subscribeInCode
		? new aws.cloudcontrol.Resource(
				"PublicBlobsFreePlan",
				{
					region: GLOBAL_REGION,
					typeName: SUBSCRIPTION_TYPE,
					desiredState: $resolve({ distributionArn: distribution.arn, webAclArn: webAcl.arn }).apply(({ distributionArn, webAclArn }) =>
						subscriptionState(distributionArn, webAclArn),
					),
				},
				{ protect: plan.protect },
			)
		: null;
	// Disables the distribution when no ACTIVE plan covers it, deploy or not.
	const watch = new sst.aws.CronV2("PublicBlobsWatch", {
		schedule: WATCH_SCHEDULE,
		timezone: "UTC",
		function: {
			handler: "infra/runs/plan-watch-handler.handler",
			timeout: "60 seconds",
			environment: {
				LEDGERMATH_STAGE: plan.stage,
				LEDGERMATH_DISTRIBUTION_ID: distribution.id,
				LEDGERMATH_DISTRIBUTION_ARN: distribution.arn,
			},
			permissions: distribution.arn.apply((arn) => watchPermissions(arn)),
			nodejs: { install: ["@aws-sdk/client-cloudfront", "@aws-sdk/client-pricing-plan-manager"] },
		},
	});
	const host = plan.domain === null ? distribution.domainName : $output(plan.domain.name);
	return {
		state: plan.state,
		enabled: plan.distributionEnabled,
		distributionId: distribution.id,
		distributionArn: distribution.arn,
		domainName: distribution.domainName,
		blobAddress: $interpolate`https://${host}/${BLOB_PREFIX}<hex>`,
		webAclArn: webAcl.arn,
		plan: subscription === null ? 'none made: PUBLIC_BLOBS.plan is "console"; subscribe in the console' : subscription.id,
		watchFunction: watch.nodes.function.name,
	};
}
