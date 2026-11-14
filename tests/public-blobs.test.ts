import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BLOB_CACHE_CONTROL,
	BLOB_CONTENT_SECURITY_POLICY,
	BLOB_GRANT_SID,
	BLOB_PATH_PATTERN,
	BLOB_PREFIX,
	BLOB_REQUEST_FUNCTION_CODE,
	BLOB_RESPONSE_FUNCTION_CODE,
	BLOB_URI_PATTERN,
	blobGrant,
	consoleSteps,
	CUSTOM_DOMAIN_TLS_POLICY,
	distributionArgs,
	distributionComment,
	FREE_PLAN,
	FUNCTION_CODE_LIMIT_BYTES,
	MANAGED_CACHE_POLICY,
	MANAGED_RESPONSE_HEADERS_POLICY,
	MANAGED_RULE_GROUPS,
	monthAtTotalLimit,
	NO_ROUTE_FUNCTION_CODE,
	ORIGIN_ID,
	PER_ADDRESS_RULE,
	PUBLIC_BLOBS,
	type PublicBlobsPlan,
	type PublicBlobsSetting,
	publicBlobsNames,
	publicBlobsPlan,
	RATE_LIMIT,
	type RateRule,
	reminder,
	runsBucketArgs,
	S3_GET_USD_PER_THOUSAND,
	subscriptionState,
	TOTAL_RATE_LIMIT,
	TOTAL_RULE,
	WEB_ACL_DESCRIPTION,
	WEB_ACL_DESCRIPTION_PATTERN,
	webAclRules,
	withBlobGrant,
} from "../infra/runs/public-blobs";
import { blobsFromBucket, PUBLIC_REQUESTS_PER_SECOND, publicBlobStore } from "../scripts/lib/blobs";

const ROOT = join(import.meta.dir, "..");
const STACK = readFileSync(join(ROOT, "infra", "runs", "stack.ts"), "utf8");
const RESOURCES = readFileSync(join(ROOT, "infra", "runs", "public-blobs-stack.ts"), "utf8");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

const STAGE = "production-runs";
const BUCKET_ARN = "arn:aws:s3:::ledgermath-production-runs-runsbucketbucket-abcdefgh";
const DISTRIBUTION_ARN = "arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE";
const WEB_ACL_ARN = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/ledgermath-production-runs-public-blobs/a1b2c3d4-5678-90ab-cdef-EXAMPLE11111";
const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"; // sha256("test")
const NAMES = publicBlobsNames("ledgermath", STAGE);

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

function setting(state: PublicBlobsSetting["state"], extra: Partial<PublicBlobsSetting> = {}): PublicBlobsSetting {
	return { stage: STAGE, state, plan: "code", domain: null, ...extra };
}

function plan(state: "dark" | "closed" | "on", extra: Partial<PublicBlobsSetting> = {}): PublicBlobsPlan {
	const made = publicBlobsPlan(setting(state, extra), STAGE);
	if (made === null) throw new Error("no plan");
	return made;
}

const REFS = {
	bucketDomain: "ledgermath-production-runs-runsbucketbucket-abcdefgh.s3.us-east-2.amazonaws.com",
	originAccessControlId: "E2QWRUHEXAMPLE",
	webAclArn: WEB_ACL_ARN,
	blobRequestFunctionArn: "arn:aws:cloudfront::123456789012:function/ledgermath-production-runs-blob-request",
	blobResponseFunctionArn: "arn:aws:cloudfront::123456789012:function/ledgermath-production-runs-blob-response",
	noRouteFunctionArn: "arn:aws:cloudfront::123456789012:function/ledgermath-production-runs-no-route",
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
	test("is off as committed, and names the one stage that may have a public distribution", () => {
		expect(PUBLIC_BLOBS).toEqual({ stage: "production-runs", state: "off", plan: "code", domain: null });
	});

	test("makes nothing on any other stage, whatever the state says", () => {
		for (const state of ["dark", "closed", "on"] as const) {
			for (const stage of ["smr-runs", "production", "production-runs2", "dev-runs"]) {
				expect(publicBlobsPlan(setting(state), stage)).toBeNull();
			}
		}
	});

	test("off makes no resources, and leaves the bucket's arguments exactly as they were", () => {
		expect(publicBlobsPlan(setting("off"), STAGE)).toBeNull();
		expect(publicBlobsPlan(setting("off", { plan: "console", domain: { name: "blobs.example.org", certificateArn: "arn" } }), STAGE)).toBeNull();
		expect(runsBucketArgs(null)).toStrictEqual({ versioning: true });
		const transform = (): undefined => undefined;
		expect(runsBucketArgs(transform)).toStrictEqual({ versioning: true, transform: { policy: transform } });
	});

	test("dark is disabled; closed is enabled but serves nothing; on serves blobs; enabled means protected", () => {
		const common = { stage: STAGE, plan: "code" as const, subscribeInCode: true, domain: null };
		expect(plan("dark")).toEqual({ ...common, state: "dark", distributionEnabled: false, serveBlobs: false, protect: false, comment: distributionComment(STAGE, "dark", "code") });
		expect(plan("closed")).toEqual({ ...common, state: "closed", distributionEnabled: true, serveBlobs: false, protect: true, comment: distributionComment(STAGE, "closed", "code") });
		expect(plan("on")).toEqual({ ...common, state: "on", distributionEnabled: true, serveBlobs: true, protect: true, comment: distributionComment(STAGE, "on", "code") });
		expect(plan("dark", { plan: "console" }).subscribeInCode).toBe(false);
	});

	test("stack.ts makes nothing of it while off: same bucket arguments, no resource, no output", () => {
		expect(STACK).toContain("const publicBlobs = preparePublicBlobs(PUBLIC_BLOBS, $cli.command);");
		expect(STACK).toContain('const bucket = new sst.aws.Bucket("RunsBucket", runsBucketArgs(publicBlobs?.bucketPolicy ?? null));');
		expect(STACK).toContain("const publicBlobsOutputs = publicBlobs === null ? null : publicBlobs.create(bucket);");
		expect(STACK).toContain("...(publicBlobsOutputs === null ? {} : { publicBlobs: publicBlobsOutputs }),");
		expect(STACK).not.toContain('new sst.aws.Bucket("RunsBucket", { versioning: true');
	});

	test("on another stage, preparePublicBlobs returns before it asks AWS anything; with off, after the check and before making anything", () => {
		const prepare = RESOURCES.slice(RESOURCES.indexOf("export function preparePublicBlobs"), RESOURCES.indexOf("function createResources("));
		const otherStage = prepare.indexOf("if ($app.stage !== setting.stage) return null;");
		expect(otherStage).toBeGreaterThan(0);
		expect(otherStage).toBeLessThan(prepare.indexOf("readDeployed("));
		expect(prepare.indexOf("readDeployed(")).toBeLessThan(prepare.indexOf("judgeTransition("));
		expect(prepare.indexOf("judgeTransition(")).toBeLessThan(prepare.indexOf("if (plan === null) return null;"));
		expect(prepare).not.toMatch(/new (aws|sst)\./);
		// A refused transition throws for every command but diff and refresh.
		expect(RESOURCES).toContain('const LOOKING_ONLY = new Set(["diff", "refresh"]);');
		expect(RESOURCES).toContain("if (!LOOKING_ONLY.has(command)) throw new Error(message);");
		expect(prepare).toContain("refuse(`Public blobs on ${setting.stage}: not allowed: ${judgement.reason}`, command);");
		// sst remove never runs the program, so nothing here judges a removal.
		expect(RESOURCES).not.toContain('"remove"');
	});

	test("refuses anything but off on a stage SST does not protect, or under sst dev, before it asks AWS anything", () => {
		const prepare = RESOURCES.slice(RESOURCES.indexOf("export function preparePublicBlobs"), RESOURCES.indexOf("function createResources("));
		const check = prepare.indexOf("const refusals = stageRefusals(setting.state, { protect: $app.protect === true, dev: $dev === true });");
		expect(check).toBeGreaterThan(prepare.indexOf("if ($app.stage !== setting.stage) return null;"));
		expect(prepare).toContain("if (refusals.length > 0) refuse(`Public blobs on ${setting.stage}: not allowed: ${refusals.join(\"; \")}.`, command);");
		for (const later of ["stageProfile()", "awsCli(", "readManaged(", "readDeployed("]) expect(check).toBeLessThan(prepare.indexOf(later));
	});

	test("makes the web ACL, the access control, three functions, the distribution, the subscription and the watch; nothing else", () => {
		const before = RESOURCES.slice(0, RESOURCES.indexOf("function createResources("));
		expect(before).not.toMatch(/new (aws|sst)\.[a-z]/);
		expect(RESOURCES.match(/new (aws|sst)\.[a-z0-9]+\.[A-Za-z0-9]+\(/g)).toEqual([
			"new aws.wafv2.WebAcl(",
			"new aws.cloudfront.OriginAccessControl(",
			"new aws.cloudfront.Function(",
			"new aws.cloudfront.Function(",
			"new aws.cloudfront.Function(",
			"new aws.cloudfront.Distribution(",
			"new aws.cloudcontrol.Resource(",
			"new sst.aws.CronV2(",
		]);
		// Pulumi refuses to delete or replace the distribution and the subscription while enabled.
		expect(RESOURCES.match(/\{ protect: plan\.protect \}/g)?.length).toBe(2);
	});

	test("the web ACL and the plan subscription live in us-east-1, by the resources' region argument", () => {
		expect(RESOURCES).toMatch(/new aws\.wafv2\.WebAcl\("PublicBlobsWebAcl", \{\n\t\tregion: GLOBAL_REGION,/);
		expect(RESOURCES).toMatch(/new aws\.cloudcontrol\.Resource\(\n\t\t\t\t"PublicBlobsFreePlan",\n\t\t\t\t\{\n\t\t\t\t\tregion: GLOBAL_REGION,/);
		expect(RESOURCES).toContain('scope: "CLOUDFRONT",');
	});

	test("nothing the deploy runs or prints assumes a profile: the stage's own is used", () => {
		for (const file of ["public-blobs.ts", "public-blobs-stack.ts", "public-blobs-guard.ts", "plan-watch.ts", "plan-watch-handler.ts"]) {
			const text = readFileSync(join(ROOT, "infra", "runs", file), "utf8");
			expect(text).not.toContain("tabot-dev");
			expect(text).not.toContain("tabot-production");
		}
		expect(RESOURCES).toContain('return new $util.Config("aws").get("profile") ?? process.env.AWS_PROFILE;');
		expect(consoleSteps(STAGE, "some-profile").join("\n")).toContain("--profile some-profile");
		expect(consoleSteps(STAGE, undefined).join("\n")).not.toContain("--profile");
		expect(reminder(plan("dark"), "some-profile").join("\n")).toContain("list-subscriptions --region us-east-1 --profile some-profile");
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

	test("is made only in on: dark and closed leave the bucket policy alone", () => {
		expect(plan("on").serveBlobs).toBe(true);
		expect(plan("dark").serveBlobs).toBe(false);
		expect(plan("closed").serveBlobs).toBe(false);
		const prepare = RESOURCES.slice(RESOURCES.indexOf("export function preparePublicBlobs"), RESOURCES.indexOf("function createResources("));
		expect(prepare).toContain("if (!plan.serveBlobs) return { bucketPolicy: null, create: (bucket) => createResources(plan, names, bucket, null) };");
		expect(prepare.indexOf("if (!plan.serveBlobs)")).toBeLessThan(prepare.indexOf("withBlobGrant("));
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
	const spec = distributionArgs(REFS, plan("on"));
	const behaviours = [spec.defaultCacheBehavior, ...spec.orderedCacheBehaviors];

	test("is enabled in closed and on, disabled in dark, and its comment records the state and plan", () => {
		expect(spec.enabled).toBe(true);
		expect(distributionArgs(REFS, plan("closed")).enabled).toBe(true);
		expect(distributionArgs(REFS, plan("dark")).enabled).toBe(false);
		expect(spec.comment).toBe("LedgerMath production-runs public blobs (blobs/sha256/* only): state=on plan=code");
		expect(distributionArgs(REFS, plan("closed", { plan: "console" })).comment).toBe("LedgerMath production-runs public blobs (blobs/sha256/* only): state=closed plan=console");
		for (const state of ["dark", "closed", "on"] as const) {
			for (const p of ["code", "console"] as const) expect(distributionComment("production-runs", state, p).length).toBeLessThanOrEqual(128);
		}
	});

	test("has one origin, the bucket, read through Origin Access Control", () => {
		expect(spec.origins).toEqual([{ originId: ORIGIN_ID, domainName: REFS.bucketDomain, originAccessControlId: REFS.originAccessControlId }]);
		expect(behaviours.every((behaviour) => behaviour.targetOriginId === ORIGIN_ID)).toBe(true);
	});

	test("in on, reaches the bucket from blobs/sha256/* alone; the default behaviour's function answers every request itself", () => {
		expect(spec.orderedCacheBehaviors.map((behaviour) => behaviour.pathPattern)).toEqual([BLOB_PATH_PATTERN]);
		expect(BLOB_PATH_PATTERN).toBe("blobs/sha256/*");
		expect(spec.defaultCacheBehavior.functionAssociations).toEqual([{ eventType: "viewer-request", functionArn: REFS.noRouteFunctionArn }]);
		expect(spec.orderedCacheBehaviors[0]?.functionAssociations).toEqual([
			{ eventType: "viewer-request", functionArn: REFS.blobRequestFunctionArn },
			{ eventType: "viewer-response", functionArn: REFS.blobResponseFunctionArn },
		]);
		expect(behaviours.length).toBeLessThanOrEqual(FREE_PLAN.cacheBehaviours);
	});

	test("in dark and closed, answers 404 to every address from both behaviours", () => {
		for (const state of ["dark", "closed"] as const) {
			const closed = distributionArgs(REFS, plan(state));
			const requestFunctions = [closed.defaultCacheBehavior, ...closed.orderedCacheBehaviors].map(
				(behaviour) => behaviour.functionAssociations.find((association) => association.eventType === "viewer-request")?.functionArn,
			);
			expect(requestFunctions).toEqual([REFS.noRouteFunctionArn, REFS.noRouteFunctionArn]);
			expect(JSON.stringify(closed)).not.toContain(REFS.blobRequestFunctionArn);
		}
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
		const withDomain = distributionArgs(REFS, plan("on", { domain }));
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

	test("every address the blob function lets through is one the total limit counts", () => {
		expect(`/${BLOB_PREFIX}${HEX}`.startsWith(TOTAL_RATE_LIMIT.pathPrefix)).toBe(true);
		expect(BLOB_URI_PATTERN.startsWith(`^${TOTAL_RATE_LIMIT.pathPrefix}`)).toBe(true);
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

	test("answer 404 to every address outside blobs/sha256/, the bucket's root included, and to a blob's in dark and closed", () => {
		for (const uri of ["/", "/runs/2026/11/14/x.json", "/boots/", "/logs/2026/11/14/b.log", "/source/x.tar.gz", "/index.html", "/?list-type=2", `/blobs/sha256/${HEX}`]) {
			const answer = noRoute({ context: { eventType: "viewer-request" }, request: request(uri) }) as CfResponse;
			expect(answer.statusCode).toBe(404);
		}
	});
});

describe("the web ACL", () => {
	const rules = webAclRules(NAMES.webAcl);
	const rate = (name: string): RateRule => {
		const rule = rules.find((r) => r.name === name);
		if (rule === undefined || !("action" in rule)) throw new Error(`no rate rule ${name}`);
		return rule;
	};

	test("has 4 of the Free plan's 5 rules: two AWS managed groups, the per-address limit, then the limit on the total", () => {
		expect(rules.length).toBe(4);
		expect(rules.length).toBeLessThanOrEqual(FREE_PLAN.wafRules);
		expect(rules.map((rule) => [rule.priority, rule.name])).toEqual([
			[0, "AWSManagedRulesAmazonIpReputationList"],
			[1, "AWSManagedRulesKnownBadInputsRuleSet"],
			[2, PER_ADDRESS_RULE],
			[3, TOTAL_RULE],
		]);
		expect(rules.slice(0, 2).map((rule) => rule.statement)).toEqual(MANAGED_RULE_GROUPS.map((name) => ({ managedRuleGroupStatement: { vendorName: "AWS", name } })));
		for (const rule of rules.slice(0, 2)) expect(rule).toMatchObject({ overrideAction: { none: {} } });
	});

	test("evaluates the limit on the total last, so what an earlier rule blocked is never counted against everyone", () => {
		const priorities = new Map(rules.map((rule) => [rule.name, rule.priority]));
		const total = priorities.get(TOTAL_RULE) as number;
		expect(Math.max(...rules.map((rule) => rule.priority))).toBe(total);
		expect(priorities.get(PER_ADDRESS_RULE) as number).toBeLessThan(total);
		for (const name of MANAGED_RULE_GROUPS) expect(priorities.get(name) as number).toBeLessThan(total);
		expect(new Set(rules.map((rule) => rule.priority)).size).toBe(rules.length);
	});

	test("limits each address to 1,500 requests in 5 minutes, and blocks it", () => {
		expect(rate(PER_ADDRESS_RULE)).toMatchObject({
			action: { block: {} },
			statement: { rateBasedStatement: { limit: 1_500, aggregateKeyType: "IP", evaluationWindowSec: 300 } },
		});
	});

	test("counts every request for a blob together, from any address, and blocks them all over 6,000 in 5 minutes", () => {
		expect(rate(TOTAL_RULE)).toEqual({
			name: TOTAL_RULE,
			priority: 3,
			action: { block: {} },
			statement: {
				rateBasedStatement: {
					limit: 6_000,
					aggregateKeyType: "CONSTANT",
					evaluationWindowSec: 300,
					scopeDownStatement: {
						byteMatchStatement: {
							fieldToMatch: { uriPath: {} },
							positionalConstraint: "STARTS_WITH",
							searchString: "/blobs/",
							textTransformations: [{ priority: 0, type: "NONE" }],
						},
					},
				},
			},
			visibilityConfig: { cloudwatchMetricsEnabled: true, metricName: `${NAMES.webAcl}-ceiling`, sampledRequestsEnabled: true },
		});
		expect(TOTAL_RATE_LIMIT).toEqual({ requests: 6_000, windowSeconds: 300, pathPrefix: "/blobs/" });
	});

	test("has a description WAF accepts, which the stack uses", () => {
		expect(WEB_ACL_DESCRIPTION).toMatch(WEB_ACL_DESCRIPTION_PATTERN);
		expect(WEB_ACL_DESCRIPTION.length).toBeLessThanOrEqual(256);
		expect(String(WEB_ACL_DESCRIPTION_PATTERN)).toBe(String(/^[\w+=:#@/\-,.][\w+=:#@/\-,.\s]+[\w+=:#@/\-,.]$/));
		for (const refused of ["a; b", "a (b)", "a <b>", " a", "a "]) expect(refused).not.toMatch(WEB_ACL_DESCRIPTION_PATTERN);
		expect(RESOURCES).toContain("description: WEB_ACL_DESCRIPTION,");
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
		expect(PUBLIC_REQUESTS_PER_SECOND * window).toBe(1_200);
		expect(PUBLIC_REQUESTS_PER_SECOND * window).toBeLessThanOrEqual(0.8 * RATE_LIMIT.requests);
		expect(9_000 / PUBLIC_REQUESTS_PER_SECOND / 60).toBe(37.5);
		expect(RATE_LIMIT.requests / 50).toBeLessThan(60);
		expect(RATE_LIMIT.requests).toBeGreaterThanOrEqual(10); // WAF's least
		// The total limit is above one address's, so one address alone never trips it,
		// and five polite mirrors at once use it all.
		expect(TOTAL_RATE_LIMIT.requests).toBeGreaterThan(RATE_LIMIT.requests);
		expect(TOTAL_RATE_LIMIT.requests / (PUBLIC_REQUESTS_PER_SECOND * window)).toBe(5);
	});

	test("a month at the total limit's steady rate: 6,000 × 288 × 31 requests, $21.43 of S3 GETs, an estimate and not a cap, as the README says", () => {
		expect((24 * 3600) / TOTAL_RATE_LIMIT.windowSeconds).toBe(288);
		const month = monthAtTotalLimit(31);
		expect(month.requests).toBe(6_000 * 288 * 31);
		expect(month.requests).toBe(53_568_000);
		expect(S3_GET_USD_PER_THOUSAND).toBe(0.0004);
		expect(month.usd).toBeCloseTo(21.4272, 6);
		expect(TOTAL_RATE_LIMIT.requests / TOTAL_RATE_LIMIT.windowSeconds).toBe(20);
		const prose = README.slice(README.indexOf("### Public blobs"), README.indexOf("## The Runs repository")).replace(/\s+/g, " ");
		for (const phrase of ["6,000 × 288 × 31", "53,568,000", "$21.43", "20 a second", "waf-rule-statement-type-rate-based-caveats.html", "There is no hard cap on S3 request charges"]) expect(prose).toContain(phrase);
		// Nothing calls the figure a ceiling or a maximum.
		for (const claim of ["the ceiling's $21.43", "at most 53,568,000", "a ceiling in practice", "up to the ceiling", "ceiling"]) expect(prose).not.toContain(claim);
	});
});

describe("the Free plan subscription", () => {
	test("is subscribed with the distribution and the web ACL", () => {
		expect(JSON.parse(subscriptionState(DISTRIBUTION_ARN, WEB_ACL_ARN))).toEqual({
			PlanFamily: "CloudFront",
			PlanTier: "FREE",
			UsageLevel: "DEFAULT",
			ResourceArns: [DISTRIBUTION_ARN, WEB_ACL_ARN],
		});
	});

	test("the deploy says what comes next, for each state, in the order dark, closed only if needed, on", () => {
		const dark = reminder(plan("dark"), "p").join("\n");
		expect(dark).toContain("production-runs (the only stage that has them): dark");
		expect(dark).toContain("DISABLED");
		expect(dark).toContain("subscribes it to the Free plan");
		expect(dark).toContain('set PUBLIC_BLOBS.state to "on"');
		expect(dark).toContain('Only if AWS refused to subscribe the disabled distribution: set "closed" instead');
		const byHand = reminder(plan("dark", { plan: "console" }), "p").join("\n");
		expect(byHand).toContain(consoleSteps(STAGE, "p").join("\n"));
		expect(byHand).toContain("--plan-tier FREE");
		const closed = reminder(plan("closed"), "p").join("\n");
		expect(closed).toContain("ENABLED but answers 404 to every address");
		expect(closed).toContain('set PUBLIC_BLOBS.state to "on"');
		const on = reminder(plan("on"), "p").join("\n");
		expect(on).toContain("The watch checks every 5 minutes");
		expect(on).toContain('Before changing or cancelling the plan, deploy "dark"');
	});
});

describe("reading blobs from a public address", () => {
	const BASE = "https://d111111abcdef8.cloudfront.net";
	const BYTES = new TextEncoder().encode("test");
	const HASH = `sha256:${HEX}`;
	const scratch = mkdtempSync(join(tmpdir(), "lm-public-blobs-"));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	function answering(status: number, body: string | Uint8Array | null, seen: string[] = [], headers: Record<string, string> = {}) {
		return async (url: string, init: RequestInit): Promise<Response> => {
			seen.push(`${url} redirect=${init.redirect}`);
			return new Response(body, { status, headers });
		};
	}

	test("returns a blob whose bytes hash to its name, and keeps it in the cache", async () => {
		expect(createHash("sha256").update(BYTES).digest("hex")).toBe(HEX);
		const seen: string[] = [];
		const cache = join(scratch, "cache");
		const fetchBlob = blobsFromBucket(publicBlobStore(`${BASE}/`, { fetch: answering(200, BYTES, seen), perSecond: Number.POSITIVE_INFINITY }), cache);
		expect(await fetchBlob(HASH)).toEqual(BYTES);
		expect(seen).toEqual([`${BASE}/blobs/sha256/${HEX} redirect=manual`]);
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

	test("never follows a redirect, and names both addresses", async () => {
		for (const status of [301, 302, 303, 307, 308]) {
			const seen: string[] = [];
			const store = publicBlobStore(BASE, { fetch: answering(status, null, seen, { location: "http://elsewhere.example/blobs/sha256/x" }), perSecond: Number.POSITIVE_INFINITY });
			await expect(blobsFromBucket(store, null)(HASH)).rejects.toThrow(
				`${BASE}/blobs/sha256/${HEX}: HTTP ${status} redirect to http://elsewhere.example/blobs/sha256/x; refused`,
			);
			expect(seen).toEqual([`${BASE}/blobs/sha256/${HEX} redirect=manual`]);
		}
		const followed = publicBlobStore(BASE, {
			fetch: async () => {
				const response = new Response(BYTES, { status: 200 });
				Object.defineProperty(response, "redirected", { value: true });
				return response;
			},
			perSecond: Number.POSITIVE_INFINITY,
		});
		await expect(blobsFromBucket(followed, null)(HASH)).rejects.toThrow("refused, a blob is read only from the address given");
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
