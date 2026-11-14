/**
 * Public blobs: an Amazon CloudFront distribution on the Free flat-rate
 * pricing plan in front of the stage's bucket, so that anyone can read
 * blobs/sha256/<hex> and nothing else of it. The bucket stays private, with
 * its public access block on: CloudFront reads it through Origin Access
 * Control, and the bucket policy lets this one distribution read objects
 * under blobs/sha256/ and nothing more.
 *
 * Nothing exists until PUBLIC_BLOBS.state says so (below). The states, in the
 * order a stage goes through them:
 *
 *   off   nothing: the bucket and everything else are exactly as without
 *         this file. The default, so merging this deploys nothing.
 *   dark  everything is made, but the distribution is disabled, so it serves
 *         nothing to anyone, and with PUBLIC_BLOBS.plan "code" the deploy
 *         also subscribes it to the Free plan (AWS::PricingPlanManager::
 *         Subscription, through Cloud Control). A disabled distribution is
 *         never on pay-as-you-go traffic, because it has none.
 *   on    the distribution is enabled. The deploy refuses to go on unless
 *         AWS says, at that moment, that the web ACL is in an ACTIVE Free
 *         plan subscription (judgePlan): so there is no moment when the
 *         distribution serves anyone on pay-as-you-go pricing.
 *
 * Going back: from on to dark disables it; from dark or on to off deletes
 * everything, the plan subscription first (a Free plan is cancelled at once).
 *
 * The plan allows, and so this uses, only what the Free plan supports:
 * managed cache and response-headers policies (custom ones are a Business
 * feature), CloudFront Functions (included), no access logs (Pro), at most 5
 * cache behaviours (2 used) and 5 WAF rules (3 used), Origin Access Control
 * (Origin Access Identity is refused), and no legacy ForwardedValues.
 *
 * Plain data: no SST global is used, so tests can import it.
 * infra/runs/public-blobs-stack.ts makes the resources from it, and
 * tests/public-blobs.test.ts checks it.
 */

import type { PolicyStatement } from "./github-role";

export type PublicBlobsState = "off" | "dark" | "on";

/**
 * How the distribution gets its Free plan. "code": the deploy creates the
 * subscription (AWS::PricingPlanManager::Subscription through Cloud Control,
 * which the installed Pulumi AWS provider, 7.20.0, reaches through
 * aws.cloudcontrol.Resource; it has no resource of its own for it).
 * "console": the deploy makes no subscription and prints the console steps;
 * for when Cloud Control cannot create one.
 */
export type PlanAttachment = "code" | "console";

export interface CustomDomain {
	/** The name readers use, such as blobs.example.org: one alias, under the plan's one apex domain. */
	name: string;
	/** An ACM certificate in us-east-1 that covers the name. */
	certificateArn: string;
}

export interface PublicBlobsSetting {
	state: PublicBlobsState;
	plan: PlanAttachment;
	/** null: the default *.cloudfront.net name. */
	domain: CustomDomain | null;
}

/**
 * The switch. Committed, not an environment variable: a deploy must come
 * from a clean tree at HEAD (stack.ts, sourceArchive), so the state is in
 * git, and a routine deploy that forgot a variable cannot delete the
 * distribution or disable it.
 *
 * A custom domain is one line, e.g.
 *   domain: { name: "blobs.example.org", certificateArn: "arn:aws:acm:us-east-1:<account>:certificate/<id>" },
 * and then a DNS record (CNAME, or a Route 53 alias) from that name to the
 * distribution's domain name.
 */
export const PUBLIC_BLOBS: PublicBlobsSetting = {
	state: "off",
	plan: "code",
	domain: null,
};

/** Where CLOUDFRONT-scope web ACLs live, and the Pricing Plan Manager API's only Region. */
export const GLOBAL_REGION = "us-east-1";

/** The only keys anyone can read. */
export const BLOB_PREFIX = "blobs/sha256/";
/** The cache behaviour that reaches the bucket: CloudFront path patterns have no leading slash. */
export const BLOB_PATH_PATTERN = `${BLOB_PREFIX}*`;
/** A blob's address under the distribution: the hash's 64 lowercase hex digits and nothing else. */
export const BLOB_URI_PATTERN = "^/blobs/sha256/[0-9a-f]{64}$";
/** A blob's key is the hash of its bytes, so it never changes. */
export const BLOB_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** For the 404s the functions answer: an address that is no blob's now is no blob's later either, but a later page may live at "/". */
export const NOT_FOUND_CACHE_CONTROL = "public, max-age=300";
/** Defence in depth: should a blob ever be rendered as a document, it runs nothing and loads nothing. */
export const BLOB_CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";

/**
 * AWS managed policies, the only kind the Free plan allows
 * (docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html,
 * using-managed-response-headers-policies.html).
 *
 * CachingOptimizedForUncompressedObjects: TTLs of 1 second minimum, 24 hours
 * default, 365 days maximum; no query string, header or cookie in the cache
 * key, and none forwarded to the bucket (so ?versionId= never reaches S3); no
 * compression, so the bytes served are the bytes stored, whose hash is the
 * address. A blob carries no Cache-Control of its own (the box uploads none),
 * so CloudFront keeps it for the default 24 hours; an error from the bucket,
 * such as the 403 for a blob that is not there yet, for CloudFront's default
 * error caching time of 10 seconds.
 *
 * CORS-and-SecurityHeadersPolicy: Access-Control-Allow-Origin: * and
 * X-Content-Type-Options: nosniff (plus Referrer-Policy, Strict-Transport-
 * Security, X-Frame-Options: SAMEORIGIN, X-XSS-Protection) on every response,
 * errors included, which the viewer-response function does not see.
 */
export const MANAGED_CACHE_POLICY = { name: "CachingOptimizedForUncompressedObjects", id: "b2884449-e4de-46a7-ac36-70bc7f1ddd6d" } as const;
export const MANAGED_RESPONSE_HEADERS_POLICY = { name: "CORS-and-SecurityHeadersPolicy", id: "e61eb60c-9c35-4d20-a928-2b84e02af89c" } as const;

/** What the Free plan allows (flat-rate-pricing-plan.html, "Features by pricing plan tier"). */
export const FREE_PLAN = {
	requestsPerMonth: 1_000_000,
	gigabytesPerMonth: 100,
	cacheBehaviours: 5,
	wafRules: 5,
	plansPerAccount: 3,
} as const;

/**
 * The per-address rate limit: 1,500 requests in any 5 minutes, about 5 a
 * second. The data grow by about 9,000 blobs a day. A mirror that fetches a
 * day's new blobs at 4 a second (1,200 per 5 minutes, the pace
 * scripts/lib/blobs.ts keeps) takes 37.5 minutes and stays 20% under the
 * limit, which leaves room for WAF's estimate being near, not exact. A
 * runaway loop does tens to hundreds of requests a second and passes 1,500
 * within a minute; WAF then blocks that address (usually within 30 seconds of
 * it going over, AWS says) until its count over the last 5 minutes falls
 * below the limit, and blocked requests do not count against the plan's
 * allowance. What the limit does not do is keep the month inside the
 * allowance: one address held just under it makes 432,000 requests a day.
 */
export const RATE_LIMIT = { requests: 1_500, windowSeconds: 300 } as const;

/** The resources' names: unique in the account, and per stage. */
export interface PublicBlobsNames {
	webAcl: string;
	originAccessControl: string;
	blobRequestFunction: string;
	blobResponseFunction: string;
	noRouteFunction: string;
	comment: string;
}

export function publicBlobsNames(app: string, stage: string): PublicBlobsNames {
	const prefix = `${app}-${stage}`;
	return {
		webAcl: `${prefix}-public-blobs`,
		originAccessControl: `${prefix}-public-blobs`,
		blobRequestFunction: `${prefix}-blob-request`,
		blobResponseFunction: `${prefix}-blob-response`,
		noRouteFunction: `${prefix}-no-route`,
		comment: `LedgerMath ${stage}: public blobs (blobs/sha256/* only)`,
	};
}

export interface PublicBlobsPlan {
	state: "dark" | "on";
	distributionEnabled: boolean;
	/** The deploy creates the Free plan subscription. */
	subscribeInCode: boolean;
	/** The deploy stops unless AWS says the Free plan is ACTIVE. */
	requireActivePlan: boolean;
	domain: CustomDomain | null;
}

/** What a deploy makes for a setting: nothing at all for "off". */
export function publicBlobsPlan(setting: PublicBlobsSetting): PublicBlobsPlan | null {
	if (setting.state === "off") return null;
	return {
		state: setting.state,
		distributionEnabled: setting.state === "on",
		subscribeInCode: setting.plan === "code",
		requireActivePlan: setting.state === "on",
		domain: setting.domain,
	};
}

/**
 * The Runs bucket's arguments. With no transform they are, byte for byte,
 * what stack.ts passed before this file existed, so "off" changes nothing.
 */
export function runsBucketArgs<T>(policyTransform: T | null): { versioning: true; transform?: { policy: T } } {
	return policyTransform === null ? { versioning: true } : { versioning: true, transform: { policy: policyTransform } };
}

export const BLOB_GRANT_SID = "PublicBlobsThroughCloudFront";

/**
 * What the bucket policy adds: the CloudFront service may GetObject under
 * blobs/sha256/, only on behalf of this distribution. Not ListBucket, so the
 * distribution can never list the bucket, and a blob that is not there gets
 * 403 from S3, not 404. Not GetObjectVersion, so no older version of any key.
 */
export function blobGrant(bucketArn: string, distributionArn: string): PolicyStatement {
	return {
		Sid: BLOB_GRANT_SID,
		Effect: "Allow",
		Principal: { Service: "cloudfront.amazonaws.com" },
		Action: ["s3:GetObject"],
		Resource: [`${bucketArn}/${BLOB_PREFIX}*`],
		Condition: { StringEquals: { "AWS:SourceArn": distributionArn } },
	};
}

/**
 * The bucket policy SST makes (its HTTPS-only statement), with the grant
 * added. SST makes the bucket's one policy, so the grant goes into that
 * document rather than into a second policy, which would replace it.
 */
export function withBlobGrant(policyJson: string, bucketArn: string, distributionArn: string): string {
	const document = JSON.parse(policyJson) as { Version?: unknown; Statement?: unknown };
	if (typeof document.Version !== "string" || !Array.isArray(document.Statement)) {
		throw new Error(`the bucket policy is not a policy document: ${policyJson.slice(0, 200)}`);
	}
	const others = (document.Statement as Array<{ Sid?: unknown }>).filter((statement) => statement.Sid !== BLOB_GRANT_SID);
	const result: { Version: string; Statement: unknown[] } = {
		Version: document.Version,
		Statement: [...others, blobGrant(bucketArn, distributionArn)],
	};
	return JSON.stringify(result);
}

/** The id of the distribution's one origin, the stage's bucket. */
export const ORIGIN_ID = "runs-bucket";

const GET_HEAD = ["GET", "HEAD"];

export interface FunctionAssociation<T> {
	eventType: "viewer-request" | "viewer-response";
	functionArn: T;
}

export interface CacheBehaviour<T> {
	targetOriginId: string;
	viewerProtocolPolicy: "https-only";
	allowedMethods: string[];
	cachedMethods: string[];
	cachePolicyId: string;
	responseHeadersPolicyId: string;
	compress: false;
	functionAssociations: Array<FunctionAssociation<T>>;
}

export interface DistributionSpec<T> {
	enabled: boolean;
	comment: string;
	isIpv6Enabled: true;
	httpVersion: "http2and3";
	priceClass: "PriceClass_All";
	webAclId: T;
	aliases: string[];
	origins: Array<{ originId: string; domainName: T; originAccessControlId: T }>;
	defaultCacheBehavior: CacheBehaviour<T>;
	orderedCacheBehaviors: Array<CacheBehaviour<T> & { pathPattern: string }>;
	restrictions: { geoRestriction: { restrictionType: "none" } };
	viewerCertificate:
		| { cloudfrontDefaultCertificate: true }
		| { acmCertificateArn: string; sslSupportMethod: "sni-only"; minimumProtocolVersion: string };
}

export interface DistributionRefs<T> {
	/** The bucket's regional domain name (<bucket>.s3.us-east-2.amazonaws.com). */
	bucketDomain: T;
	originAccessControlId: T;
	webAclArn: T;
	blobRequestFunctionArn: T;
	blobResponseFunctionArn: T;
	noRouteFunctionArn: T;
}

/**
 * With a custom domain, the newest policy that still speaks TLS 1.2 (to
 * clients without 1.3). With the default *.cloudfront.net certificate
 * CloudFront sets the policy itself, to TLSv1, whatever is asked
 * (DownloadDistValuesGeneral.html, "Security policy").
 */
export const CUSTOM_DOMAIN_TLS_POLICY = "TLSv1.2_2025";

/**
 * The distribution: two cache behaviours. blobs/sha256/* reaches the bucket,
 * and its viewer-request function refuses (404) any address that is not
 * exactly /blobs/sha256/<64 lowercase hex>, before the cache or the bucket
 * sees it. The default behaviour reaches nothing: its function answers 404
 * to every request. GET and HEAD only, HTTPS only (plain HTTP gets 403),
 * HTTP/2 and HTTP/3, IPv6, every edge location.
 */
export function distributionArgs<T>(refs: DistributionRefs<T>, plan: PublicBlobsPlan, comment: string): DistributionSpec<T> {
	const behaviour = (associations: Array<FunctionAssociation<T>>): CacheBehaviour<T> => ({
		targetOriginId: ORIGIN_ID,
		viewerProtocolPolicy: "https-only",
		allowedMethods: [...GET_HEAD],
		cachedMethods: [...GET_HEAD],
		cachePolicyId: MANAGED_CACHE_POLICY.id,
		responseHeadersPolicyId: MANAGED_RESPONSE_HEADERS_POLICY.id,
		compress: false,
		functionAssociations: associations,
	});
	return {
		enabled: plan.distributionEnabled,
		comment,
		isIpv6Enabled: true,
		httpVersion: "http2and3",
		priceClass: "PriceClass_All",
		webAclId: refs.webAclArn,
		aliases: plan.domain === null ? [] : [plan.domain.name],
		origins: [{ originId: ORIGIN_ID, domainName: refs.bucketDomain, originAccessControlId: refs.originAccessControlId }],
		defaultCacheBehavior: behaviour([{ eventType: "viewer-request", functionArn: refs.noRouteFunctionArn }]),
		orderedCacheBehaviors: [
			{
				pathPattern: BLOB_PATH_PATTERN,
				...behaviour([
					{ eventType: "viewer-request", functionArn: refs.blobRequestFunctionArn },
					{ eventType: "viewer-response", functionArn: refs.blobResponseFunctionArn },
				]),
			},
		],
		restrictions: { geoRestriction: { restrictionType: "none" } },
		viewerCertificate:
			plan.domain === null
				? { cloudfrontDefaultCertificate: true }
				: { acmCertificateArn: plan.domain.certificateArn, sslSupportMethod: "sni-only", minimumProtocolVersion: CUSTOM_DOMAIN_TLS_POLICY },
	};
}

const NOT_FOUND_TEXT = "Not found. This address serves /blobs/sha256/<hex> and nothing else: <hex> is the 64 lowercase hex digits of the SHA-256 of the blob's bytes.\n";

/** The 404 the viewer-request functions answer with, in CloudFront Functions JavaScript (cloudfront-js-2.0). */
const NOT_FOUND_SOURCE = [
	"function notFound() {",
	"  return {",
	"    statusCode: 404,",
	"    statusDescription: 'Not Found',",
	"    headers: {",
	"      'content-type': { value: 'text/plain; charset=utf-8' },",
	`      'cache-control': { value: '${NOT_FOUND_CACHE_CONTROL}' },`,
	"      'access-control-allow-origin': { value: '*' },",
	"      'x-content-type-options': { value: 'nosniff' }",
	"    },",
	`    body: { encoding: 'text', data: ${JSON.stringify(NOT_FOUND_TEXT)} }`,
	"  };",
	"}",
].join("\n");

/**
 * The blobs behaviour's viewer-request function: a blob's address goes on to
 * the cache and the bucket, anything else gets 404 here.
 */
export const BLOB_REQUEST_FUNCTION_CODE = [
	`var BLOB = new RegExp(${JSON.stringify(BLOB_URI_PATTERN)});`,
	NOT_FOUND_SOURCE,
	"function handler(event) {",
	"  return BLOB.test(event.request.uri) ? event.request : notFound();",
	"}",
	"",
].join("\n");

/**
 * The blobs behaviour's viewer-response function: the headers of a blob that
 * never changes. CloudFront runs it only for status codes below 400
 * (edge-function-restrictions-all.html); it checks anyway.
 */
export const BLOB_RESPONSE_FUNCTION_CODE = [
	"function handler(event) {",
	"  var response = event.response;",
	"  if (response.statusCode < 400) {",
	`    response.headers['cache-control'] = { value: '${BLOB_CACHE_CONTROL}' };`,
	"    response.headers['access-control-allow-origin'] = { value: '*' };",
	"    response.headers['x-content-type-options'] = { value: 'nosniff' };",
	`    response.headers['content-security-policy'] = { value: ${JSON.stringify(BLOB_CONTENT_SECURITY_POLICY)} };`,
	"  }",
	"  return response;",
	"}",
	"",
].join("\n");

/** The default behaviour's function: every request that is not under blobs/sha256/ gets 404, and reaches neither cache nor bucket. */
export const NO_ROUTE_FUNCTION_CODE = [NOT_FOUND_SOURCE, "function handler(event) {", "  return notFound();", "}", ""].join("\n");

/** CloudFront Functions' limit on a function's code. */
export const FUNCTION_CODE_LIMIT_BYTES = 10_240;

export interface VisibilityConfig {
	cloudwatchMetricsEnabled: boolean;
	metricName: string;
	sampledRequestsEnabled: boolean;
}

export interface RateRule {
	name: string;
	priority: number;
	action: { block: Record<string, never> };
	statement: { rateBasedStatement: { limit: number; aggregateKeyType: "IP"; evaluationWindowSec: number } };
	visibilityConfig: VisibilityConfig;
}

export interface ManagedRule {
	name: string;
	priority: number;
	overrideAction: { none: Record<string, never> };
	statement: { managedRuleGroupStatement: { vendorName: "AWS"; name: string } };
	visibilityConfig: VisibilityConfig;
}

export type WebAclRule = RateRule | ManagedRule;

/**
 * AWS managed rule groups the web ACL uses: both are part of the protection
 * the CloudFront console applies by default to a distribution on a plan
 * (PricingPlanManager user guide, "Create the distribution and web ACL
 * before you subscribe"), both are free, and both block traffic, which then
 * does not count against the allowance. The third group of that default,
 * AWSManagedRulesCommonRuleSet, is left out: its rules guard applications
 * that parse what they are sent (bodies, query strings, cookies), while
 * behind this distribution are S3 GETs of hex names that the functions
 * already check, and it blocks requests without a User-Agent, which a plain
 * client mirroring blobs may send.
 */
export const MANAGED_RULE_GROUPS = ["AWSManagedRulesAmazonIpReputationList", "AWSManagedRulesKnownBadInputsRuleSet"] as const;

function visibility(metricName: string): VisibilityConfig {
	return { cloudwatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true };
}

/** The web ACL's rules: the per-address rate limit first, then the managed groups. 3 of the Free plan's 5. */
export function webAclRules(metricPrefix: string): WebAclRule[] {
	const rate: RateRule = {
		name: "per-address-rate-limit",
		priority: 0,
		action: { block: {} },
		statement: { rateBasedStatement: { limit: RATE_LIMIT.requests, aggregateKeyType: "IP", evaluationWindowSec: RATE_LIMIT.windowSeconds } },
		visibilityConfig: visibility(`${metricPrefix}-rate-limit`),
	};
	const managed = MANAGED_RULE_GROUPS.map(
		(name, index): ManagedRule => ({
			name,
			priority: index + 1,
			overrideAction: { none: {} },
			statement: { managedRuleGroupStatement: { vendorName: "AWS", name } },
			visibilityConfig: visibility(`${metricPrefix}-${name}`),
		}),
	);
	return [rate, ...managed];
}

/**
 * The Cloud Control desired state of the Free plan subscription
 * (AWS::PricingPlanManager::Subscription). A move to Pro is made in the
 * console or with the CLI, and this is left saying FREE: CloudFormation's
 * handler refuses to change a tier, and a deploy sends the subscription only
 * what changed in this document, so it never undoes the upgrade.
 */
export const SUBSCRIPTION_TYPE = "AWS::PricingPlanManager::Subscription";

export function subscriptionState(distributionArn: string, webAclArn: string): string {
	return JSON.stringify({ PlanFamily: "CloudFront", PlanTier: "FREE", UsageLevel: "DEFAULT", ResourceArns: [distributionArn, webAclArn] });
}

/** A subscription as `aws pricing-plan-manager list-subscriptions` lists it. */
export interface SubscriptionSummary {
	arn: string;
	planFamily: string;
	planTier: string;
	status: string;
	resourceArns: string[];
}

export interface PlanVerdict {
	active: boolean;
	/** Why, in words. */
	reason: string;
	subscriptionArn: string | null;
	tier: string | null;
}

/** A web ACL's ARN, by name, from `aws wafv2 list-web-acls --scope CLOUDFRONT` output; null when it is not there. */
export function webAclArnByName(output: unknown, name: string): { arn: string | null; complete: boolean } {
	const page = output as { WebACLs?: Array<{ Name?: unknown; ARN?: unknown }>; NextMarker?: unknown };
	if (!Array.isArray(page.WebACLs)) throw new Error("aws wafv2 list-web-acls: no WebACLs in its output");
	const found = page.WebACLs.find((acl) => acl.Name === name);
	return { arn: typeof found?.ARN === "string" ? found.ARN : null, complete: typeof page.NextMarker !== "string" || page.NextMarker === "" };
}

/** The subscriptions in `aws pricing-plan-manager list-subscriptions` output, and whether that was all of them. */
export function subscriptionsFrom(output: unknown): { subscriptions: SubscriptionSummary[]; complete: boolean } {
	const page = output as { subscriptionSummaries?: unknown[]; nextToken?: unknown };
	if (!Array.isArray(page.subscriptionSummaries)) throw new Error("aws pricing-plan-manager list-subscriptions: no subscriptionSummaries in its output");
	const subscriptions = page.subscriptionSummaries.map((entry, index) => {
		const s = entry as Partial<Record<keyof SubscriptionSummary, unknown>>;
		if (typeof s.arn !== "string" || typeof s.planFamily !== "string" || typeof s.planTier !== "string" || typeof s.status !== "string" || !Array.isArray(s.resourceArns)) {
			throw new Error(`aws pricing-plan-manager list-subscriptions: subscription ${index} lacks arn, planFamily, planTier, status or resourceArns`);
		}
		return { arn: s.arn, planFamily: s.planFamily, planTier: s.planTier, status: s.status, resourceArns: s.resourceArns.map(String) };
	});
	return { subscriptions, complete: page.nextToken === undefined || page.nextToken === null || page.nextToken === "" };
}

/**
 * Whether the distribution may be enabled: AWS lists an ACTIVE CloudFront
 * plan subscription whose resources include this stage's web ACL (a web ACL
 * in a plan serves that plan's distribution and no other). Any tier will do,
 * so moving to Pro changes nothing here. Anything else, including a list
 * that might go on past the page read, is no.
 */
export function judgePlan(webAcl: { arn: string | null; complete: boolean }, listed: { subscriptions: SubscriptionSummary[]; complete: boolean }): PlanVerdict {
	if (webAcl.arn === null) {
		return { active: false, reason: webAcl.complete ? "the stage's web ACL does not exist yet" : "the stage's web ACL is not on the first page of web ACLs", subscriptionArn: null, tier: null };
	}
	const covering = listed.subscriptions.filter((s) => s.planFamily === "CloudFront" && s.resourceArns.includes(webAcl.arn as string));
	const active = covering.find((s) => s.status === "ACTIVE");
	if (active !== undefined) {
		return { active: true, reason: `${active.planTier} plan ${active.arn} is ACTIVE`, subscriptionArn: active.arn, tier: active.planTier };
	}
	if (covering.length > 0) {
		const s = covering[0] as SubscriptionSummary;
		return { active: false, reason: `the plan subscription ${s.arn} is ${s.status}, not ACTIVE`, subscriptionArn: s.arn, tier: s.planTier };
	}
	return {
		active: false,
		reason: listed.complete ? "no plan subscription covers the stage's web ACL" : "no plan subscription on the first page covers the stage's web ACL",
		subscriptionArn: null,
		tier: null,
	};
}

/** The console steps that subscribe the distribution to the Free plan, for PUBLIC_BLOBS.plan "console". */
export function consoleSteps(names: PublicBlobsNames): string[] {
	return [
		"Subscribe the disabled distribution to the Free plan, in the CloudFront console (https://console.aws.amazon.com/cloudfront/v4/home):",
		`  1. Distributions: open the one whose description is "${names.comment}" (ID in the stage output publicBlobs.distributionId). Its status is Disabled.`,
		"  2. Choose its pricing plan (Manage plan), pick Free, and confirm. Its web ACL,",
		`     ${names.webAcl}, is already associated; nothing else needs to change.`,
		"  3. Wait until the plan shows as active (the API's status ACTIVE; AWS says 2 to 5 minutes).",
		"  Or, the same from the CLI (a Free plan activates at once; no approval):",
		`     aws pricing-plan-manager create-subscription --region ${GLOBAL_REGION} --plan-family CloudFront --plan-tier FREE \\`,
		"       --resource-arns <publicBlobs.distributionArn> <publicBlobs.webAclArn>",
	];
}

/** What the deploy prints, for a plan. */
export function reminder(plan: PublicBlobsPlan, names: PublicBlobsNames): string[] {
	const check = `aws pricing-plan-manager list-subscriptions --region ${GLOBAL_REGION}`;
	if (plan.state === "dark") {
		return [
			"Public blobs: dark. The distribution is DISABLED and serves nothing.",
			...(plan.subscribeInCode
				? ["This deploy subscribes it to the Free plan (AWS::PricingPlanManager::Subscription)."]
				: consoleSteps(names)),
			`Then check the plan is ACTIVE (${check}), set PUBLIC_BLOBS.state to "on" in infra/runs/public-blobs.ts, commit, and deploy.`,
			'The "on" deploy stops by itself unless AWS says the plan is ACTIVE.',
		];
	}
	return ["Public blobs: on. The distribution is enabled, and serves blobs/sha256/<hex> to anyone."];
}
