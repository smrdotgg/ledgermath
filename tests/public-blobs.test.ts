import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BLOB_CACHE_CONTROL,
	BLOB_CONTENT_SECURITY_POLICY,
	BLOB_REQUEST_FUNCTION_CODE,
	BLOB_RESPONSE_FUNCTION_CODE,
	BLOB_GRANT_SID,
	BLOB_PATH_PATTERN,
	BLOB_PREFIX,
	BLOB_URI_PATTERN,
	blobGrant,
	consoleSteps,
	CUSTOM_DOMAIN_TLS_POLICY,
	distributionArgs,
	FREE_PLAN,
	FUNCTION_CODE_LIMIT_BYTES,
	judgePlan,
	MANAGED_CACHE_POLICY,
	MANAGED_RESPONSE_HEADERS_POLICY,
	MANAGED_RULE_GROUPS,
	NO_ROUTE_FUNCTION_CODE,
	ORIGIN_ID,
	PUBLIC_BLOBS,
	type PublicBlobsPlan,
	publicBlobsNames,
	publicBlobsPlan,
	RATE_LIMIT,
	type RateRule,
	reminder,
	runsBucketArgs,
	subscriptionState,
	subscriptionsFrom,
	webAclArnByName,
	webAclRules,
	withBlobGrant,
} from "../infra/runs/public-blobs";
import { blobsFromBucket, PUBLIC_REQUESTS_PER_SECOND, publicBlobStore } from "../scripts/lib/blobs";

const ROOT = join(import.meta.dir, "..");
const STACK = readFileSync(join(ROOT, "infra", "runs", "stack.ts"), "utf8");
const RESOURCES = readFileSync(join(ROOT, "infra", "runs", "public-blobs-stack.ts"), "utf8");

const BUCKET_ARN = "arn:aws:s3:::ledgermath-smr-runs-runsbucketbucket-abcdefgh";
const DISTRIBUTION_ARN = "arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE";
const WEB_ACL_ARN = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/ledgermath-smr-runs-public-blobs/a1b2c3d4-5678-90ab-cdef-EXAMPLE11111";
const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"; // sha256("test")
const NAMES = publicBlobsNames("ledgermath", "smr-runs");

/** The policy SST makes for the bucket: its HTTPS-only statement, as iam.getPolicyDocument renders it. */
const SST_POLICY = JSON.stringify({
	Version: "2012-10-17",
	Statement: [
		{
			Effect: "Deny",
			Action: "s3:*",
			Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
			Principal: "*",
			Condition: { Bool: { "aws:SecureTransport": "false" } },
		},
	],
});

/** Whether an IAM resource pattern (with * wildcards) covers an ARN. */
function covers(pattern: string, arn: string): boolean {
	const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
	return regex.test(arn);
}

function plan(state: "dark" | "on", extra: Partial<PublicBlobsPlan> = {}): PublicBlobsPlan {
	const made = publicBlobsPlan({ state, plan: "code", domain: null });
	if (made === null) throw new Error("no plan");
	return { ...made, ...extra };
}

const REFS = {
	bucketDomain: "ledgermath-smr-runs-runsbucketbucket-abcdefgh.s3.us-east-2.amazonaws.com",
	originAccessControlId: "E2QWRUHEXAMPLE",
	webAclArn: WEB_ACL_ARN,
	blobRequestFunctionArn: "arn:aws:cloudfront::123456789012:function/ledgermath-smr-runs-blob-request",
	blobResponseFunctionArn: "arn:aws:cloudfront::123456789012:function/ledgermath-smr-runs-blob-response",
	noRouteFunctionArn: "arn:aws:cloudfront::123456789012:function/ledgermath-smr-runs-no-route",
};

interface CfHeaders {
	[name: string]: { value: string };
}
interface CfResponse {
	statusCode: number;
	statusDescription?: string;
	headers: CfHeaders;
	body?: { encoding: string; data: string };
}
interface CfRequest {
	method: string;
	uri: string;
	headers: CfHeaders;
}
type Handler = (event: { context: { eventType: string }; request: CfRequest; response?: CfResponse }) => CfRequest | CfResponse;

/** Loads CloudFront Functions code as the runtime does: it defines `handler`. */
function load(code: string): Handler {
	return new Function(`${code}\nreturn handler;`)() as Handler;
}

function request(uri: string): CfRequest {
	return { method: "GET", uri, headers: { host: { value: "d111111abcdef8.cloudfront.net" } } };
}

describe("the switch", () => {
	test("is off as committed, so merging this deploys nothing", () => {
		expect(PUBLIC_BLOBS).toEqual({ state: "off", plan: "code", domain: null });
	});

	test("off makes no resources, and leaves the bucket's arguments exactly as they were", () => {
		expect(publicBlobsPlan({ state: "off", plan: "code", domain: null })).toBeNull();
		expect(publicBlobsPlan({ state: "off", plan: "console", domain: { name: "blobs.example.org", certificateArn: "arn" } })).toBeNull();
		expect(runsBucketArgs(null)).toStrictEqual({ versioning: true });
		const transform = (): undefined => undefined;
		expect(runsBucketArgs(transform)).toStrictEqual({ versioning: true, transform: { policy: transform } });
	});

	test("dark makes it disabled; on enables it, only once AWS says the plan is ACTIVE", () => {
		expect(plan("dark")).toEqual({ state: "dark", distributionEnabled: false, subscribeInCode: true, requireActivePlan: false, domain: null });
		expect(plan("on")).toEqual({ state: "on", distributionEnabled: true, subscribeInCode: true, requireActivePlan: true, domain: null });
		expect(publicBlobsPlan({ state: "dark", plan: "console", domain: null })?.subscribeInCode).toBe(false);
	});

	test("stack.ts makes nothing of it while off: same bucket arguments, no resource, no output", () => {
		expect(STACK).toContain("const publicBlobs = preparePublicBlobs(PUBLIC_BLOBS, !NON_DEPLOYING.has($cli.command));");
		expect(STACK).toContain('const bucket = new sst.aws.Bucket("RunsBucket", runsBucketArgs(publicBlobs?.bucketPolicy ?? null));');
		expect(STACK).toContain("const publicBlobsOutputs = publicBlobs === null ? null : publicBlobs.create(bucket);");
		expect(STACK).toContain("...(publicBlobsOutputs === null ? {} : { publicBlobs: publicBlobsOutputs }),");
		expect(STACK).not.toContain('new sst.aws.Bucket("RunsBucket", { versioning: true');
		// preparePublicBlobs returns before it asks AWS anything or makes anything.
		const prepare = RESOURCES.slice(RESOURCES.indexOf("export function preparePublicBlobs"));
		expect(prepare.indexOf("if (plan === null) return null;")).toBeGreaterThan(0);
		expect(prepare.indexOf("if (plan === null) return null;")).toBeLessThan(prepare.indexOf("checkPlan("));
		// Every resource is made in createResources, which only create() calls.
		const before = RESOURCES.slice(0, RESOURCES.indexOf("function createResources("));
		expect(before).not.toMatch(/new (aws|sst)\./);
		expect(RESOURCES.match(/new aws\.[a-z0-9]+\.[A-Za-z]+\(/g)).toEqual([
			"new aws.wafv2.WebAcl(",
			"new aws.cloudfront.OriginAccessControl(",
			"new aws.cloudfront.Function(",
			"new aws.cloudfront.Function(",
			"new aws.cloudfront.Function(",
			"new aws.cloudfront.Distribution(",
			"new aws.cloudcontrol.Resource(",
		]);
	});

	test("the web ACL and the plan subscription live in us-east-1, by the resources' region argument", () => {
		expect(RESOURCES).toMatch(/new aws\.wafv2\.WebAcl\("PublicBlobsWebAcl", \{\n\t\tregion: GLOBAL_REGION,/);
		expect(RESOURCES).toMatch(/new aws\.cloudcontrol\.Resource\("PublicBlobsFreePlan", \{\n\t\t\t\tregion: GLOBAL_REGION,/);
		expect(RESOURCES).toContain('scope: "CLOUDFRONT",');
	});
});

describe("the bucket grant", () => {
	test("lets this distribution, through the CloudFront service, GetObject under blobs/sha256/ and nothing more", () => {
		expect(blobGrant(BUCKET_ARN, DISTRIBUTION_ARN)).toEqual({
			Sid: BLOB_GRANT_SID,
			Effect: "Allow",
			Principal: { Service: "cloudfront.amazonaws.com" },
			Action: ["s3:GetObject"],
			Resource: [`${BUCKET_ARN}/blobs/sha256/*`],
			Condition: { StringEquals: { "AWS:SourceArn": DISTRIBUTION_ARN } },
		});
	});

	test("covers blob keys and no other key of the bucket, and never the bucket itself (no listing)", () => {
		const [resource] = blobGrant(BUCKET_ARN, DISTRIBUTION_ARN).Resource ?? [];
		if (resource === undefined) throw new Error("no resource");
		expect(covers(resource, `${BUCKET_ARN}/blobs/sha256/${HEX}`)).toBe(true);
		for (const key of [
			"runs/2026/11/14/x.json",
			"boots/2026/11/14/b.json",
			"logs/2026/11/14/b.log",
			"source/537d4f1bd2fa883c897456d16a9b7c9a49548b05.tar.gz",
			"blobs/other",
			"blobs/sha512/abc",
			"blob/sha256/abc",
			"x/blobs/sha256/abc",
		]) {
			expect(covers(resource, `${BUCKET_ARN}/${key}`)).toBe(false);
		}
		expect(covers(resource, BUCKET_ARN)).toBe(false);
	});

	test("is added to SST's policy, which keeps its own statement, once however often it is applied", () => {
		const once = withBlobGrant(SST_POLICY, BUCKET_ARN, DISTRIBUTION_ARN);
		const twice = withBlobGrant(once, BUCKET_ARN, DISTRIBUTION_ARN);
		expect(twice).toBe(once);
		const document = JSON.parse(once) as { Version: string; Statement: unknown[] };
		const original = JSON.parse(SST_POLICY) as { Statement: unknown[] };
		expect(document.Version).toBe("2012-10-17");
		expect(document.Statement).toEqual([original.Statement[0], blobGrant(BUCKET_ARN, DISTRIBUTION_ARN)]);
	});

	test("gives access to nobody else: its only Allow is the grant", () => {
		const document = JSON.parse(withBlobGrant(SST_POLICY, BUCKET_ARN, DISTRIBUTION_ARN)) as { Statement: Array<{ Effect: string }> };
		const allows = document.Statement.filter((statement) => statement.Effect === "Allow");
		expect(allows).toEqual([blobGrant(BUCKET_ARN, DISTRIBUTION_ARN)]);
		const text = JSON.stringify(allows);
		for (const action of ["s3:ListBucket", "s3:GetObjectVersion", "s3:*", "s3:PutObject"]) expect(text).not.toContain(action);
	});

	test("refuses anything that is not a policy document", () => {
		expect(() => withBlobGrant("{}", BUCKET_ARN, DISTRIBUTION_ARN)).toThrow("not a policy document");
		expect(() => withBlobGrant('{"Version":"2012-10-17","Statement":{}}', BUCKET_ARN, DISTRIBUTION_ARN)).toThrow("not a policy document");
	});
});

describe("the distribution", () => {
	const spec = distributionArgs(REFS, plan("on"), NAMES.comment);
	const behaviours = [spec.defaultCacheBehavior, ...spec.orderedCacheBehaviors];

	test("is enabled only in the on state", () => {
		expect(spec.enabled).toBe(true);
		expect(distributionArgs(REFS, plan("dark"), NAMES.comment).enabled).toBe(false);
	});

	test("has one origin, the bucket, read through Origin Access Control", () => {
		expect(spec.origins).toEqual([{ originId: ORIGIN_ID, domainName: REFS.bucketDomain, originAccessControlId: REFS.originAccessControlId }]);
		expect(behaviours.every((behaviour) => behaviour.targetOriginId === ORIGIN_ID)).toBe(true);
	});

	test("reaches the bucket from blobs/sha256/* alone; the default behaviour's function answers every request itself", () => {
		expect(spec.orderedCacheBehaviors.map((behaviour) => behaviour.pathPattern)).toEqual([BLOB_PATH_PATTERN]);
		expect(BLOB_PATH_PATTERN).toBe("blobs/sha256/*");
		expect(spec.defaultCacheBehavior.functionAssociations).toEqual([{ eventType: "viewer-request", functionArn: REFS.noRouteFunctionArn }]);
		expect(spec.orderedCacheBehaviors[0]?.functionAssociations).toEqual([
			{ eventType: "viewer-request", functionArn: REFS.blobRequestFunctionArn },
			{ eventType: "viewer-response", functionArn: REFS.blobResponseFunctionArn },
		]);
		expect(behaviours.length).toBeLessThanOrEqual(FREE_PLAN.cacheBehaviours);
	});

	test("allows GET and HEAD over HTTPS only, with AWS managed policies and the stored bytes uncompressed", () => {
		for (const behaviour of behaviours) {
			expect(behaviour.allowedMethods).toEqual(["GET", "HEAD"]);
			expect(behaviour.cachedMethods).toEqual(["GET", "HEAD"]);
			expect(behaviour.viewerProtocolPolicy).toBe("https-only");
			expect(behaviour.cachePolicyId).toBe(MANAGED_CACHE_POLICY.id);
			expect(behaviour.responseHeadersPolicyId).toBe(MANAGED_RESPONSE_HEADERS_POLICY.id);
			expect(behaviour.compress).toBe(false);
		}
		expect(MANAGED_CACHE_POLICY.id).toBe("b2884449-e4de-46a7-ac36-70bc7f1ddd6d");
		expect(MANAGED_RESPONSE_HEADERS_POLICY.id).toBe("e61eb60c-9c35-4d20-a928-2b84e02af89c");
	});

	test("speaks HTTP/2 and HTTP/3 and IPv6, from every edge location, behind the web ACL, under its *.cloudfront.net name", () => {
		expect(spec.httpVersion).toBe("http2and3");
		expect(spec.isIpv6Enabled).toBe(true);
		expect(spec.priceClass).toBe("PriceClass_All");
		expect(spec.webAclId).toBe(WEB_ACL_ARN);
		expect(spec.aliases).toEqual([]);
		expect(spec.viewerCertificate).toEqual({ cloudfrontDefaultCertificate: true });
		expect(spec.restrictions).toEqual({ geoRestriction: { restrictionType: "none" } });
	});

	test("takes a custom domain with a modern TLS policy from one setting", () => {
		const domain = { name: "blobs.example.org", certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/0000" };
		const withDomain = distributionArgs(REFS, plan("on", { domain }), NAMES.comment);
		expect(withDomain.aliases).toEqual(["blobs.example.org"]);
		expect(withDomain.viewerCertificate).toEqual({ acmCertificateArn: domain.certificateArn, sslSupportMethod: "sni-only", minimumProtocolVersion: CUSTOM_DOMAIN_TLS_POLICY });
		expect(CUSTOM_DOMAIN_TLS_POLICY).toBe("TLSv1.2_2025");
	});

	test("uses none of the features a flat-rate plan refuses, and no access logs (Free has none)", () => {
		const text = JSON.stringify(spec);
		for (const feature of [
			"forwardedValues",
			"originAccessIdentity",
			"s3OriginConfig",
			"realtimeLogConfigArn",
			"lambdaFunctionAssociations",
			"continuousDeploymentPolicyId",
			"staging",
			"fieldLevelEncryptionId",
			"anycastIpListId",
			"loggingConfig",
			"originRequestPolicyId",
			"trustedSigners",
			"trustedKeyGroups",
		]) {
			expect(text).not.toContain(feature);
		}
	});

	test("has names that fit AWS's limits", () => {
		expect(NAMES.blobRequestFunction).toMatch(/^[a-zA-Z0-9-_]{1,64}$/);
		expect(NAMES.blobResponseFunction).toMatch(/^[a-zA-Z0-9-_]{1,64}$/);
		expect(NAMES.noRouteFunction).toMatch(/^[a-zA-Z0-9-_]{1,64}$/);
		expect(NAMES.webAcl).toMatch(/^[\w-]{1,128}$/);
		expect(NAMES.originAccessControl.length).toBeLessThanOrEqual(64);
		expect(NAMES.comment.length).toBeLessThanOrEqual(128);
	});
});

describe("the functions", () => {
	const blobRequest = load(BLOB_REQUEST_FUNCTION_CODE);
	const blobResponse = load(BLOB_RESPONSE_FUNCTION_CODE);
	const noRoute = load(NO_ROUTE_FUNCTION_CODE);

	test("fit CloudFront Functions' size limit", () => {
		for (const code of [BLOB_REQUEST_FUNCTION_CODE, BLOB_RESPONSE_FUNCTION_CODE, NO_ROUTE_FUNCTION_CODE]) expect(Buffer.byteLength(code)).toBeLessThan(FUNCTION_CODE_LIMIT_BYTES);
	});

	test("let a blob's address through to the cache and the bucket, unchanged", () => {
		const viewerRequest = request(`/blobs/sha256/${HEX}`);
		expect(blobRequest({ context: { eventType: "viewer-request" }, request: viewerRequest })).toBe(viewerRequest);
	});

	test("answer 404 to anything else under blobs/sha256/, so it reaches neither cache nor bucket", () => {
		for (const uri of [
			"/blobs/sha256/",
			`/blobs/sha256/${HEX.toUpperCase()}`,
			`/blobs/sha256/${HEX.slice(1)}`,
			`/blobs/sha256/${HEX}0`,
			`/blobs/sha256/${HEX}/`,
			`/blobs/sha256/${HEX}/x`,
			`/blobs/sha256/../../runs/2026/11/14/x.json`,
			`/blobs/sha256/%2e%2e/runs`,
			`//blobs/sha256/${HEX}`,
		]) {
			const answer = blobRequest({ context: { eventType: "viewer-request" }, request: request(uri) }) as CfResponse;
			expect(answer.statusCode).toBe(404);
			expect(answer.headers["access-control-allow-origin"]?.value).toBe("*");
			expect(answer.headers["x-content-type-options"]?.value).toBe("nosniff");
			expect(answer.headers["content-type"]?.value).toBe("text/plain; charset=utf-8");
			expect(answer.body?.data).toContain("/blobs/sha256/<hex>");
		}
	});

	test("accept exactly the addresses under the blobs behaviour's path pattern that name a hash", () => {
		const pattern = new RegExp(BLOB_URI_PATTERN);
		expect(pattern.test(`/${BLOB_PREFIX}${HEX}`)).toBe(true);
		expect(`/${BLOB_PATH_PATTERN}`.replace("*", HEX)).toBe(`/blobs/sha256/${HEX}`);
	});

	test("give a blob the headers of bytes that never change, and keep the bucket's own", () => {
		for (const statusCode of [200, 206, 304]) {
			const response: CfResponse = { statusCode, headers: { "content-type": { value: "binary/octet-stream" }, etag: { value: '"abc"' } } };
			const answer = blobResponse({ context: { eventType: "viewer-response" }, request: request(`/blobs/sha256/${HEX}`), response }) as CfResponse;
			expect(answer.headers["cache-control"]?.value).toBe(BLOB_CACHE_CONTROL);
			expect(answer.headers["cache-control"]?.value).toBe("public, max-age=31536000, immutable");
			expect(answer.headers["access-control-allow-origin"]?.value).toBe("*");
			expect(answer.headers["x-content-type-options"]?.value).toBe("nosniff");
			expect(answer.headers["content-security-policy"]?.value).toBe(BLOB_CONTENT_SECURITY_POLICY);
			expect(answer.headers["content-type"]?.value).toBe("binary/octet-stream");
			expect(answer.headers.etag?.value).toBe('"abc"');
		}
	});

	test("never mark an error as immutable, should CloudFront ever run them for one", () => {
		const response: CfResponse = { statusCode: 403, headers: {} };
		const answer = blobResponse({ context: { eventType: "viewer-response" }, request: request(`/blobs/sha256/${HEX}`), response }) as CfResponse;
		expect(answer.headers["cache-control"]).toBeUndefined();
	});

	test("answer 404 to every address outside blobs/sha256/, the bucket's root included", () => {
		for (const uri of ["/", "/runs/2026/11/14/x.json", "/boots/", "/logs/2026/11/14/b.log", "/source/x.tar.gz", "/index.html", "/?list-type=2"]) {
			const answer = noRoute({ context: { eventType: "viewer-request" }, request: request(uri) }) as CfResponse;
			expect(answer.statusCode).toBe(404);
		}
	});
});

describe("the web ACL", () => {
	const rules = webAclRules(NAMES.webAcl);

	test("has a per-address rate limit and two AWS managed groups: 3 of the Free plan's 5 rules", () => {
		expect(rules.length).toBe(3);
		expect(rules.length).toBeLessThanOrEqual(FREE_PLAN.wafRules);
		expect(rules.map((rule) => rule.priority)).toEqual([0, 1, 2]);
		const rate = rules[0] as RateRule;
		expect(rate.action).toEqual({ block: {} });
		expect(rate.statement).toEqual({ rateBasedStatement: { limit: 1_500, aggregateKeyType: "IP", evaluationWindowSec: 300 } });
		expect(rules.slice(1).map((rule) => rule.statement)).toEqual(MANAGED_RULE_GROUPS.map((name) => ({ managedRuleGroupStatement: { vendorName: "AWS", name } })));
		expect(MANAGED_RULE_GROUPS).toEqual(["AWSManagedRulesAmazonIpReputationList", "AWSManagedRulesKnownBadInputsRuleSet"]);
		for (const rule of rules.slice(1)) expect(rule).toMatchObject({ overrideAction: { none: {} } });
	});

	test("has rule and metric names WAF accepts", () => {
		for (const rule of rules) {
			expect(rule.name).toMatch(/^[\w-]{1,128}$/);
			expect(rule.visibilityConfig.metricName).toMatch(/^[\w#:.\-/]{1,255}$/);
			expect(rule.visibilityConfig).toMatchObject({ cloudwatchMetricsEnabled: true, sampledRequestsEnabled: true });
		}
	});

	test("lets a polite mirror through and stops a runaway script", () => {
		const window = RATE_LIMIT.windowSeconds;
		// The pace the readers keep stays at least 20% under the limit.
		expect(PUBLIC_REQUESTS_PER_SECOND * window).toBe(1_200);
		expect(PUBLIC_REQUESTS_PER_SECOND * window).toBeLessThanOrEqual(0.8 * RATE_LIMIT.requests);
		// A day's new blobs, about 9,000, at that pace: under an hour.
		expect(9_000 / PUBLIC_REQUESTS_PER_SECOND / 60).toBe(37.5);
		// A loop at 50 a second passes the limit within a minute.
		expect(RATE_LIMIT.requests / 50).toBeLessThan(60);
		// The most one address held just under the limit makes in a day.
		expect(RATE_LIMIT.requests * ((24 * 3600) / window)).toBe(432_000);
		expect(RATE_LIMIT.requests).toBeGreaterThanOrEqual(10); // WAF's least
	});
});

describe("the Free plan", () => {
	test("is subscribed with the distribution and the web ACL", () => {
		expect(JSON.parse(subscriptionState(DISTRIBUTION_ARN, WEB_ACL_ARN))).toEqual({
			PlanFamily: "CloudFront",
			PlanTier: "FREE",
			UsageLevel: "DEFAULT",
			ResourceArns: [DISTRIBUTION_ARN, WEB_ACL_ARN],
		});
	});

	const acls = { WebACLs: [{ Name: "other", ARN: "arn:other" }, { Name: NAMES.webAcl, ARN: WEB_ACL_ARN }] };
	const summary = (status: string, planTier = "FREE", resourceArns = [DISTRIBUTION_ARN, WEB_ACL_ARN]) => ({
		arn: "arn:aws:pricingplanmanager::123456789012:subscription:sub_EXAMPLE",
		planFamily: "CloudFront",
		planTier,
		status,
		resourceArns,
		createdAt: "2026-11-14T10:00:00Z",
		eTag: "v1",
	});

	test("lets the distribution be enabled only when AWS lists an ACTIVE plan with the stage's web ACL", () => {
		const webAcl = webAclArnByName(acls, NAMES.webAcl);
		expect(webAcl).toEqual({ arn: WEB_ACL_ARN, complete: true });
		const active = judgePlan(webAcl, subscriptionsFrom({ subscriptionSummaries: [summary("ACTIVE")], nextToken: null }));
		expect(active).toMatchObject({ active: true, tier: "FREE" });
		expect(judgePlan(webAcl, subscriptionsFrom({ subscriptionSummaries: [summary("ACTIVE", "PRO")] }))).toMatchObject({ active: true, tier: "PRO" });
		for (const status of ["SYNC_IN_PROGRESS", "PENDING_APPROVAL", "FAILED"]) {
			const verdict = judgePlan(webAcl, subscriptionsFrom({ subscriptionSummaries: [summary(status)] }));
			expect(verdict.active).toBe(false);
			expect(verdict.reason).toContain(status);
		}
		const elsewhere = judgePlan(webAcl, subscriptionsFrom({ subscriptionSummaries: [summary("ACTIVE", "FREE", [DISTRIBUTION_ARN, "arn:other"])] }));
		expect(elsewhere).toMatchObject({ active: false, reason: "no plan subscription covers the stage's web ACL" });
		expect(judgePlan(webAcl, subscriptionsFrom({ subscriptionSummaries: [] }))).toMatchObject({ active: false });
	});

	test("says no when it cannot be sure", () => {
		expect(judgePlan(webAclArnByName({ WebACLs: [] }, NAMES.webAcl), { subscriptions: [], complete: true })).toMatchObject({
			active: false,
			reason: "the stage's web ACL does not exist yet",
		});
		expect(webAclArnByName({ WebACLs: [], NextMarker: "next" }, NAMES.webAcl)).toEqual({ arn: null, complete: false });
		const partial = subscriptionsFrom({ subscriptionSummaries: [], nextToken: "more" });
		expect(partial.complete).toBe(false);
		expect(judgePlan({ arn: WEB_ACL_ARN, complete: true }, partial).reason).toContain("first page");
		expect(() => subscriptionsFrom({})).toThrow("no subscriptionSummaries");
		expect(() => subscriptionsFrom({ subscriptionSummaries: [{ arn: "x" }] })).toThrow("lacks");
		expect(() => webAclArnByName({}, NAMES.webAcl)).toThrow("no WebACLs");
	});

	test("the deploy says what comes next", () => {
		const dark = reminder(plan("dark"), NAMES).join("\n");
		expect(dark).toContain("DISABLED");
		expect(dark).toContain("subscribes it to the Free plan");
		expect(dark).toContain('set PUBLIC_BLOBS.state to "on"');
		const byHand = reminder(plan("dark", { subscribeInCode: false }), NAMES).join("\n");
		expect(byHand).toContain(consoleSteps(NAMES).join("\n"));
		expect(byHand).toContain(NAMES.webAcl);
		expect(byHand).toContain("--plan-tier FREE");
		expect(reminder(plan("on"), NAMES).join("\n")).toContain("enabled");
	});
});

describe("reading blobs from a public address", () => {
	const BASE = "https://d111111abcdef8.cloudfront.net";
	const BYTES = new TextEncoder().encode("test");
	const HASH = `sha256:${HEX}`;
	const scratch = mkdtempSync(join(tmpdir(), "lm-public-blobs-"));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	function answering(status: number, body: string | Uint8Array, seen: string[] = []) {
		return async (url: string): Promise<Response> => {
			seen.push(url);
			return new Response(body, { status });
		};
	}

	test("returns a blob whose bytes hash to its name, and keeps it in the cache", async () => {
		expect(createHash("sha256").update(BYTES).digest("hex")).toBe(HEX);
		const seen: string[] = [];
		const cache = join(scratch, "cache");
		const fetchBlob = blobsFromBucket(publicBlobStore(`${BASE}/`, { fetch: answering(200, BYTES, seen), perSecond: Number.POSITIVE_INFINITY }), cache);
		expect(await fetchBlob(HASH)).toEqual(BYTES);
		expect(seen).toEqual([`${BASE}/blobs/sha256/${HEX}`]);
		expect(existsSync(join(cache, "sha256", HEX))).toBe(true);
		expect(await fetchBlob(HASH)).toEqual(BYTES);
		expect(seen.length).toBe(1);
	}, 5_000);

	test("refuses a body that does not hash to the name, and keeps nothing", async () => {
		const cache = join(scratch, "refused");
		const fetchBlob = blobsFromBucket(publicBlobStore(BASE, { fetch: answering(200, "not the blob"), perSecond: Number.POSITIVE_INFINITY }), cache);
		await expect(fetchBlob(HASH)).rejects.toThrow(`${BASE}/blobs/sha256/${HEX}: its bytes hash to sha256:`);
		expect(existsSync(join(cache, "sha256", HEX))).toBe(false);
	}, 5_000);

	test("takes 404, and S3's 403 AccessDenied, for a blob that is not there", async () => {
		const notFound = blobsFromBucket(publicBlobStore(BASE, { fetch: answering(404, "Not found."), perSecond: Number.POSITIVE_INFINITY }), null);
		expect(await notFound(HASH)).toBeNull();
		const s3 = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';
		const denied = blobsFromBucket(publicBlobStore(BASE, { fetch: answering(403, s3), perSecond: Number.POSITIVE_INFINITY }), null);
		expect(await denied(HASH)).toBeNull();
	}, 5_000);

	test("throws, rather than call a blob missing, when the distribution refuses or fails", async () => {
		const waf = "<HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY>Request blocked.</BODY></HTML>";
		const blocked = blobsFromBucket(publicBlobStore(BASE, { fetch: answering(403, waf), perSecond: Number.POSITIVE_INFINITY }), null);
		await expect(blocked(HASH)).rejects.toThrow("HTTP 403, refused by the distribution");
		const failing = blobsFromBucket(publicBlobStore(BASE, { fetch: answering(503, "Slow Down"), perSecond: Number.POSITIVE_INFINITY }), null);
		await expect(failing(HASH)).rejects.toThrow("HTTP 503");
	}, 5_000);

	test("takes only an https:// address, and asks it for blob keys only", async () => {
		expect(() => publicBlobStore("http://d111111abcdef8.cloudfront.net")).toThrow("starts with https://");
		expect(() => publicBlobStore("d111111abcdef8.cloudfront.net")).toThrow("starts with https://");
		const store = publicBlobStore(BASE, { fetch: answering(200, BYTES), perSecond: Number.POSITIVE_INFINITY });
		await expect(store.get("runs/2026/11/14/x.json")).rejects.toThrow("serves blobs/sha256/<hex> only");
		await expect(store.get(`blobs/sha256/${HEX}/../x`)).rejects.toThrow("serves blobs/sha256/<hex> only");
	}, 5_000);

	test("spaces its requests at the pace asked for, however many are in flight", async () => {
		const waits: number[] = [];
		const store = publicBlobStore(BASE, {
			fetch: answering(200, BYTES),
			perSecond: 4,
			now: () => 1_000,
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		const fetchBlob = blobsFromBucket(store, null);
		const results = await Promise.all([1, 2, 3, 4, 5].map(() => fetchBlob(HASH)));
		expect(results.every((bytes) => bytes !== null)).toBe(true);
		expect(waits).toEqual([250, 500, 750, 1_000]);
	}, 5_000);
});
