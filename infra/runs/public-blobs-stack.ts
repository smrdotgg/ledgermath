/// <reference path="../../.sst/platform/config.d.ts" />

/**
 * Makes the public data API's resources (infra/runs/public-blobs.ts) on the
 * one stage PUBLIC_API.stage names. A setting that names another stage with
 * anything but "off" stops every deploy (checkSetting). On any other stage it
 * returns at once: nothing is made, and AWS is not asked anything.
 *
 * On that stage, before anything else, it reads what is deployed: which
 * distribution the stage's own state records (the copy SST pulled for this
 * run, so the one this deploy will update, by ID), then, read-only, with the
 * AWS CLI and the stage's own profile, `aws cloudfront list-distributions`,
 * which must agree with it, and `aws pricing-plan-manager list-subscriptions`
 * when a distribution exists; and it judges the transition
 * (public-blobs-guard.ts). A deploy that is not allowed stops there, before
 * any resource is touched; `sst diff` and `sst refresh` only warn. When the
 * stage's state cannot be read or the distributions cannot be listed, no
 * transition is allowed; when the subscriptions cannot be listed, "on" is not.
 *
 * Before that, and before AWS is asked anything, a state other than "off"
 * is refused in dev mode ($dev: `sst dev`, `sst deploy --dev`), and needs a
 * protected stage ($app.protect, sst.config.ts's app()): `sst remove`
 * never runs this program (SST 4.17 runs `pulumi destroy` without
 * --run-program), so nothing here can judge a removal, and only SST's stage
 * protection, which refuses `sst remove` outright, stops one. Pulumi's
 * `protect` on the distribution and the subscription, while the distribution
 * is enabled, is a narrower lock kept in the stage's saved state: Pulumi
 * refuses to delete or replace either until a "dark" deploy has lifted it.
 *
 * stack.ts calls preparePublicApi before it makes the two buckets, because
 * in "on" each bucket's one policy (which SST makes) must also hold the grant
 * to the distribution, and the distribution needs both buckets: each grant
 * goes in through its bucket's transform.policy, with the distribution's ARN
 * as a deferred output that create() resolves once the distribution exists.
 * (Not through a bucket's `policy` argument: SST holds back bucket.name and
 * bucket.nodes.bucket until that argument resolves, and the distribution
 * needs them, so that would wait for ever.)
 *
 * In us-east-1, by the `region` argument the provider's resources take since
 * @pulumi/aws 7 (no second provider): the web ACL, whose CLOUDFRONT scope
 * lives there, the certificate and its validation, which CloudFront takes
 * from there only, and the plan subscription, whose API is only there. Route
 * 53 is global. The watch runs in the stage's own Region and calls both
 * APIs in us-east-1.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { watchPermissions } from "./plan-watch";
import {
	aliasRecordArgs,
	API_DOMAIN,
	CERTIFICATE_ARGS,
	checkSetting,
	type DeployedState,
	distributionArgs,
	EVIDENCE_RESPONSE_FUNCTION_CODE,
	GLOBAL_REGION,
	NO_ROUTE_FUNCTION_CODE,
	type Origin,
	type PublicApiNames,
	type PublicApiPlan,
	type PublicApiSetting,
	publicApiNames,
	publicApiPlan,
	reminder,
	SUBSCRIPTION_TYPE,
	subscriptionState,
	VALIDATION_RECORD_TTL,
	WATCH_SCHEDULE,
	WEB_ACL_DESCRIPTION,
	webAclRules,
	withGrant,
} from "./public-blobs";
import {
	type AwsCli,
	coverage,
	DISTRIBUTION_NAME,
	judgeTransition,
	type PlanVerdict,
	readDeployed,
	readManaged,
	readSubscriptions,
	stageRefusals,
	type Target,
} from "./public-blobs-guard";

export interface PublicApiOutputs {
	state: DeployedState;
	enabled: boolean;
	distributionId: $util.Output<string>;
	distributionArn: $util.Output<string>;
	/** The distribution's own *.cloudfront.net name, which api.ledgermath.com is an alias of. */
	domainName: $util.Output<string>;
	/** The table of contents, where a reader starts. */
	address: string;
	webAclArn: $util.Output<string>;
	certificateArn: $util.Output<string>;
	/** The Free plan subscription's ARN, or what to do instead. */
	plan: $util.Output<string> | string;
	watchFunction: $util.Output<string>;
}

type PolicyTransform = (args: aws.s3.BucketPolicyArgs) => undefined;

export interface PublicApi {
	/** In "on" only: the Runs bucket's transform.policy, SST's policy with the grant of runs/, boots/ and blobs/sha256/ to the distribution added. */
	runsBucketPolicy: PolicyTransform | null;
	/** In "on" only: the API bucket's transform.policy, SST's policy with the grant of v1/ to the distribution added. */
	apiBucketPolicy: PolicyTransform | null;
	/** Makes the resources, once both buckets exist. */
	create(runsBucket: sst.aws.Bucket, apiBucket: sst.aws.Bucket): PublicApiOutputs;
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

/** Stops the command with `message`, or, for a command that changes nothing in AWS, warns and goes on. */
function refuse(message: string, command: string): void {
	if (!LOOKING_ONLY.has(command)) throw new Error(message);
	console.warn(`${message}\n(sst ${command} goes on; a deploy would stop here.)`);
}

/**
 * What stack.ts needs before and after it makes the buckets, or null when
 * nothing is to be made (another stage, or "off" with nothing deployed).
 * Throws when the setting names another stage than production-runs, when
 * the stage may not have the public API, or when the transition from what is
 * deployed is not allowed.
 */
export function preparePublicApi(setting: PublicApiSetting, command: string): PublicApi | null {
	checkSetting(setting);
	if ($app.stage !== setting.stage) return null;
	const refusals = stageRefusals(setting.state, { protect: $app.protect === true, dev: $dev === true });
	if (refusals.length > 0) refuse(`The public data API on ${setting.stage}: not allowed: ${refusals.join("; ")}.`, command);
	const profile = stageProfile();
	const cli = awsCli(profile);
	const target: Target = { state: setting.state, plan: setting.plan };

	// The distribution this deploy will update, by ID, from the copy of the
	// stage's state SST pulled for this run; then AWS's listing, which must agree.
	const managed = readManaged((path) => readFileSync(path, "utf8"), process.env.PULUMI_BACKEND_URL, $app.name, $app.stage);
	const deployed = readDeployed(cli, setting.stage, managed);
	let verdict: PlanVerdict | null = null;
	if (deployed.kind === "present") {
		try {
			verdict = coverage(deployed.arn, readSubscriptions(cli));
		} catch (error) {
			console.warn(`The public data API: the plan subscriptions could not be listed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
		}
	}
	const judgement = judgeTransition(deployed, target, verdict);
	for (const warning of judgement.warnings) console.warn(`The public data API: WARNING: ${warning}.`);
	if (!judgement.allowed) {
		refuse(`The public data API on ${setting.stage}: not allowed: ${judgement.reason}`, command);
	} else {
		console.warn(`The public data API on ${setting.stage}: ${judgement.reason}.`);
	}

	const plan = publicApiPlan(setting, $app.stage);
	if (plan === null) return null;
	console.warn(reminder(plan, profile).join("\n"));
	const names = publicApiNames($app.name, $app.stage);
	if (!plan.serve) return { runsBucketPolicy: null, apiBucketPolicy: null, create: (runsBucket, apiBucket) => createResources(plan, names, runsBucket, apiBucket, null) };
	const [distributionArn, setDistributionArn] = $util.deferredOutput<string>();
	const grant =
		(origin: Origin): PolicyTransform =>
		(args) => {
			args.policy = $resolve({ policy: $output(args.policy), bucketName: $output(args.bucket), arn: distributionArn }).apply(({ policy, bucketName, arn }) => {
				if (typeof policy !== "string") throw new Error("The public data API: the bucket policy SST made is not a JSON document");
				return withGrant(policy, `arn:aws:s3:::${bucketName}`, arn, origin);
			});
			return undefined;
		};
	return {
		runsBucketPolicy: grant("runs"),
		apiBucketPolicy: grant("api"),
		create: (runsBucket, apiBucket) => createResources(plan, names, runsBucket, apiBucket, setDistributionArn),
	};
}

function createResources(
	plan: PublicApiPlan,
	names: PublicApiNames,
	runsBucket: sst.aws.Bucket,
	apiBucket: sst.aws.Bucket,
	setDistributionArn: ((arn: $util.Output<string>) => void) | null,
): PublicApiOutputs {
	// The plan requires a web ACL; the plan pays for it and its rules.
	const webAcl = new aws.wafv2.WebAcl("PublicApiWebAcl", {
		region: GLOBAL_REGION,
		name: names.webAcl,
		description: WEB_ACL_DESCRIPTION,
		scope: "CLOUDFRONT",
		defaultAction: { allow: {} },
		rules: webAclRules(names.webAcl),
		visibilityConfig: { cloudwatchMetricsEnabled: true, metricName: names.webAcl, sampledRequestsEnabled: true },
	});
	// One access control for both origins: it says how CloudFront signs, not which bucket.
	const oac = new aws.cloudfront.OriginAccessControl("PublicApiOac", {
		name: names.originAccessControl,
		description: "LedgerMath public API: CloudFront signs its requests to the private API and Runs buckets",
		originAccessControlOriginType: "s3",
		signingBehavior: "always",
		signingProtocol: "sigv4",
	});
	const evidenceResponseFunction = new aws.cloudfront.Function("PublicApiEvidenceResponseFunction", {
		name: names.evidenceResponseFunction,
		runtime: "cloudfront-js-2.0",
		comment: "LedgerMath public API: the headers of Run files, boot summaries and blobs, which never change",
		code: EVIDENCE_RESPONSE_FUNCTION_CODE,
		publish: true,
	});
	const noRouteFunction = new aws.cloudfront.Function("PublicApiNoRouteFunction", {
		name: names.noRouteFunction,
		runtime: "cloudfront-js-2.0",
		comment: "LedgerMath public API: 404 for every address",
		code: NO_ROUTE_FUNCTION_CODE,
		publish: true,
	});
	// api.ledgermath.com's certificate, validated by a record in the zone the
	// subdomain is delegated to; the zone's CAA record lets Amazon issue it.
	const certificate = new aws.acm.Certificate("PublicApiCertificate", { ...CERTIFICATE_ARGS });
	const validation = certificate.domainValidationOptions.apply((options) => {
		const option = options.find((entry) => entry.domainName === API_DOMAIN.name);
		if (option === undefined) throw new Error(`The public data API: ACM gave no validation record for ${API_DOMAIN.name}`);
		return option;
	});
	const certificateRecord = new aws.route53.Record("PublicApiCertificateRecord", {
		zoneId: API_DOMAIN.hostedZoneId,
		name: validation.resourceRecordName,
		type: validation.resourceRecordType,
		records: [validation.resourceRecordValue],
		ttl: VALIDATION_RECORD_TTL,
	});
	const certificateValidation = new aws.acm.CertificateValidation("PublicApiCertificateValidation", {
		region: GLOBAL_REGION,
		certificateArn: certificate.arn,
		validationRecordFqdns: [certificateRecord.fqdn],
	});
	// Under DISTRIBUTION_NAME: the guard finds it in the stage's state by that name.
	const distribution = new aws.cloudfront.Distribution(
		DISTRIBUTION_NAME,
		distributionArgs<$util.Input<string>>(
			{
				apiBucketDomain: apiBucket.nodes.bucket.bucketRegionalDomainName,
				runsBucketDomain: runsBucket.nodes.bucket.bucketRegionalDomainName,
				originAccessControlId: oac.id,
				webAclArn: webAcl.arn,
				evidenceResponseFunctionArn: evidenceResponseFunction.arn,
				noRouteFunctionArn: noRouteFunction.arn,
				certificateArn: certificateValidation.certificateArn,
			},
			plan,
		),
		{ protect: plan.protect },
	);
	if (setDistributionArn !== null) setDistributionArn(distribution.arn);
	new aws.route53.Record("PublicApiAliasA", aliasRecordArgs("A", distribution.domainName, distribution.hostedZoneId));
	new aws.route53.Record("PublicApiAliasAAAA", aliasRecordArgs("AAAA", distribution.domainName, distribution.hostedZoneId));
	// Created after the distribution and the web ACL it names, and so deleted
	// before them: AWS refuses to delete a distribution that is on a plan.
	const subscription = plan.subscribeInCode
		? new aws.cloudcontrol.Resource(
				"PublicApiFreePlan",
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
	// dev: false, so that it is always the real function: in SST 4.17 a
	// function defaults to live development, and `sst dev` would deploy a stub
	// that works only while a local session runs.
	const watch = new sst.aws.CronV2("PublicApiWatch", {
		schedule: WATCH_SCHEDULE,
		timezone: "UTC",
		function: {
			handler: "infra/runs/plan-watch-handler.handler",
			dev: false,
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
	return {
		state: plan.state,
		enabled: plan.distributionEnabled,
		distributionId: distribution.id,
		distributionArn: distribution.arn,
		domainName: distribution.domainName,
		address: `https://${API_DOMAIN.name}/v1/index.json`,
		webAclArn: webAcl.arn,
		certificateArn: certificateValidation.certificateArn,
		plan: subscription === null ? 'none made: PUBLIC_API.plan is "console"; subscribe in the console' : subscription.id,
		watchFunction: watch.nodes.function.name,
	};
}
