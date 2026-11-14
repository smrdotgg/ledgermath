/// <reference path="../../.sst/platform/config.d.ts" />

/**
 * Makes the public-blobs resources (infra/runs/public-blobs.ts) of a -runs
 * stage, and nothing at all while PUBLIC_BLOBS.state is "off".
 *
 * stack.ts calls preparePublicBlobs before it makes the Runs bucket, because
 * the bucket's one policy (which SST makes) must also hold the grant to the
 * distribution, and the distribution needs the bucket: the grant goes in
 * through the bucket's transform.policy, with the distribution's ARN as a
 * deferred output that create() resolves once the distribution exists. (Not
 * through the bucket's `policy` argument: SST holds back bucket.name and
 * bucket.nodes.bucket until that argument resolves, and the distribution
 * needs them, so that would wait for ever.)
 *
 * In us-east-1, by the `region` argument the provider's resources take since
 * @pulumi/aws 7 (no second provider): the web ACL, whose CLOUDFRONT scope
 * lives there, and the plan subscription, whose API is only there.
 */

import { execFileSync } from "node:child_process";

import {
	BLOB_PREFIX,
	BLOB_REQUEST_FUNCTION_CODE,
	BLOB_RESPONSE_FUNCTION_CODE,
	distributionArgs,
	GLOBAL_REGION,
	judgePlan,
	NO_ROUTE_FUNCTION_CODE,
	type PlanVerdict,
	type PublicBlobsNames,
	type PublicBlobsPlan,
	type PublicBlobsSetting,
	publicBlobsNames,
	publicBlobsPlan,
	reminder,
	SUBSCRIPTION_TYPE,
	subscriptionState,
	subscriptionsFrom,
	webAclArnByName,
	webAclRules,
	withBlobGrant,
} from "./public-blobs";

export interface PublicBlobsOutputs {
	state: "dark" | "on";
	enabled: boolean;
	distributionId: $util.Output<string>;
	distributionArn: $util.Output<string>;
	domainName: $util.Output<string>;
	/** A blob's public address, with <hex> for the hash's 64 hex digits. */
	blobAddress: $util.Output<string>;
	webAclArn: $util.Output<string>;
	/** The Free plan subscription's ARN, or what to do instead. */
	plan: $util.Output<string> | string;
}

export interface PublicBlobs {
	/** The Runs bucket's transform.policy: SST's policy, with the grant to the distribution added. */
	bucketPolicy: (args: aws.s3.BucketPolicyArgs) => undefined;
	/** Makes the resources, once the bucket exists. */
	create(bucket: sst.aws.Bucket): PublicBlobsOutputs;
}

/** One read-only AWS CLI call, in us-east-1, with the stage's profile. */
function awsJson(args: string[], profile: string | undefined): unknown {
	const command = [...args, "--region", GLOBAL_REGION, "--output", "json", ...(profile === undefined ? [] : ["--profile", profile])];
	return JSON.parse(execFileSync("aws", command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

/** Asks AWS whether the stage's web ACL is in an ACTIVE plan subscription. */
function checkPlan(webAclName: string, profile: string | undefined): PlanVerdict {
	try {
		const webAcl = webAclArnByName(awsJson(["wafv2", "list-web-acls", "--scope", "CLOUDFRONT", "--limit", "100"], profile), webAclName);
		return judgePlan(webAcl, subscriptionsFrom(awsJson(["pricing-plan-manager", "list-subscriptions"], profile)));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { active: false, reason: `AWS could not be asked (${message.split("\n").slice(0, 3).join(" ")})`, subscriptionArn: null, tier: null };
	}
}

/**
 * What stack.ts needs before and after it makes the bucket, or null for
 * "off". For "on", first asks AWS whether the Free plan is ACTIVE, and stops
 * a deploy that would enable the distribution without it (sst diff, remove
 * and refresh only warn).
 */
export function preparePublicBlobs(setting: PublicBlobsSetting, deploying: boolean): PublicBlobs | null {
	const plan = publicBlobsPlan(setting);
	if (plan === null) return null;
	const names = publicBlobsNames($app.name, $app.stage);
	if (plan.requireActivePlan) {
		const verdict = checkPlan(names.webAcl, new $util.Config("aws").get("profile"));
		if (verdict.active) {
			console.warn(`Public blobs: ${verdict.reason}.`);
		} else {
			const message = [
				`Public blobs: the distribution may not be enabled: ${verdict.reason}.`,
				'Enabling it now would serve blobs on pay-as-you-go pricing. Deploy with PUBLIC_BLOBS.state "dark" first',
				"(infra/runs/public-blobs.ts), check that its Free plan is ACTIVE, then deploy \"on\" again.",
			].join("\n");
			if (deploying) throw new Error(message);
			console.warn(`${message}\n(sst ${$cli.command} goes on; a deploy would stop here.)`);
		}
	}
	console.warn(reminder(plan, names).join("\n"));
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
	setDistributionArn: (arn: $util.Output<string>) => void,
): PublicBlobsOutputs {
	// The plan requires a web ACL; the plan pays for it and its rules.
	const webAcl = new aws.wafv2.WebAcl("PublicBlobsWebAcl", {
		region: GLOBAL_REGION,
		name: names.webAcl,
		description: "LedgerMath public blobs - per-address rate limit and AWS managed rules, required by the CloudFront Free plan",
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
		comment: "LedgerMath public blobs: 404 for every address outside blobs/sha256/",
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
			names.comment,
		),
	);
	setDistributionArn(distribution.arn);
	// Created after the distribution and the web ACL it names, and so deleted
	// before them: AWS refuses to delete a distribution that is on a plan.
	const subscription = plan.subscribeInCode
		? new aws.cloudcontrol.Resource("PublicBlobsFreePlan", {
				region: GLOBAL_REGION,
				typeName: SUBSCRIPTION_TYPE,
				desiredState: $resolve({ distributionArn: distribution.arn, webAclArn: webAcl.arn }).apply(({ distributionArn, webAclArn }) =>
					subscriptionState(distributionArn, webAclArn),
				),
			})
		: null;
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
	};
}
