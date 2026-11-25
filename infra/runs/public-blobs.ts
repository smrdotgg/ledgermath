/**
 * The public data API (ADR-0031): an Amazon CloudFront distribution on the
 * Free flat-rate pricing plan, at https://api.ledgermath.com, in front of two
 * private buckets of production-runs. It serves, at the host's root,
 *
 *     /v1/…                 the data API's tree, as the build wrote it   from the API bucket (api-bucket.ts)
 *     /runs/…               Run files                                    from the Runs bucket
 *     /boots/…              boot summaries                               from the Runs bucket
 *     /blobs/sha256/<hex>   blobs                                        from the Runs bucket
 *
 * and nothing else (SERVED). Both buckets stay private, with their public
 * access blocks on: CloudFront reads them through Origin Access Control, and,
 * only while the state is "on", each bucket's policy lets this one
 * distribution GetObject under its served prefixes and nothing more.
 *
 * It began, in this file, as "public blobs" (blobs/sha256/ alone, at the
 * distribution's *.cloudfront.net name); the file keeps that name. What was
 * kept, changed and replaced is in ADR-0031 and the README ("The public data
 * API").
 *
 * PUBLIC_API is the switch. Only production-runs may ever have anything but
 * "off" (publicApiPlan refuses a setting naming another stage), and on every
 * other stage nothing of it is made and AWS is not asked anything. On
 * production-runs, the states, in the order it goes through them:
 *
 *   off     nothing: no distribution, no certificate, no DNS record, no web
 *           ACL, no grant in either bucket's policy. The default, so merging
 *           this deploys none of it.
 *   dark    everything but the grants is made, the distribution disabled, so
 *           it serves nothing to anyone: the web ACL, the access control, the
 *           functions, the certificate and its validation record, the
 *           distribution, the api.ledgermath.com alias records, and the
 *           watch; with PUBLIC_API.plan "code" the deploy also subscribes the
 *           distribution to the Free plan (AWS::PricingPlanManager::
 *           Subscription, through Cloud Control). A disabled distribution has
 *           no traffic, so nothing to bill.
 *   closed  only if AWS refuses to subscribe a disabled distribution: the
 *           distribution is enabled, so that the plan can be attached, but
 *           serves nothing: every address WAF lets through gets 404 from a
 *           viewer-request function, and neither bucket grants it anything.
 *           Enabled, it takes public traffic, billed at pay-as-you-go rates
 *           until the plan is attached.
 *   on      the distribution serves: the served behaviours reach their
 *           buckets behind the request function (one host, and only keys of
 *           a served shape: SERVED), and both buckets' policies carry the
 *           grant. The deploy goes on only if AWS says, at that moment, that
 *           an ACTIVE plan covers the distribution.
 *
 * What is deployed decides what a deploy may do (public-blobs-guard.ts): from
 * an enabled distribution the only way out is "dark". A watch in the stage
 * (plan-watch.ts) runs every 5 minutes, deploy or not, and disables an
 * enabled distribution that no ACTIVE plan covers.
 *
 * The plan allows, and so this uses, only what the Free plan supports: AWS
 * managed cache and response-headers policies (custom ones are a Business
 * feature), CloudFront Functions (included), no access logs (Pro), at most 5
 * cache behaviours (5 used) and 5 WAF rules (4 used, and none with a string,
 * size or regex match: everyRequest), Origin Access Control,
 * one distribution and one apex domain per plan, and no legacy
 * ForwardedValues. Because the policies are managed, each header a reader
 * gets comes from one of three places: the object itself (the tree's
 * Content-Type and Cache-Control, set by the upload: api-bucket.ts), the
 * managed response-headers policy (CORS), or the one viewer-response function
 * (the evidence's Cache-Control, which the boxes upload without; servedHeaders
 * says which, path by path). Three functions in all, each under CloudFront
 * Functions' 10 KB: the request function, the evidence's response function,
 * and the 404 of the default behaviour (and of every behaviour in "dark" and
 * "closed").
 *
 * Plain data: no SST global is used, so tests can import it.
 * infra/runs/public-blobs-stack.ts makes the resources from it, and
 * tests/public-blobs.test.ts checks it.
 */

import { calendarDate, SERVED_AHEAD, TREE_CACHE_CONTROL, TREE_CONTENT_TYPE, TREE_KINDS, TREE_PREFIX } from "./api-bucket";
import type { PolicyStatement } from "./github-role";
import { PRODUCTION_STAGE } from "./stages";

export type PublicApiState = "off" | "dark" | "closed" | "on";
export const STATES: readonly PublicApiState[] = ["off", "dark", "closed", "on"];
/** The states in which the distribution exists. */
export type DeployedState = Exclude<PublicApiState, "off">;
export const DEPLOYED_STATES: readonly DeployedState[] = ["dark", "closed", "on"];

/**
 * How the distribution gets its Free plan. "code": the deploy creates the
 * subscription (AWS::PricingPlanManager::Subscription through Cloud Control,
 * which the installed Pulumi AWS provider, 7.20.0, reaches through
 * aws.cloudcontrol.Resource; it has no resource of its own for it).
 * "console": the deploy makes no subscription and prints the console steps;
 * for when Cloud Control cannot create one.
 */
export type PlanAttachment = "code" | "console";
export const PLAN_ATTACHMENTS: readonly PlanAttachment[] = ["code", "console"];

export interface PublicApiSetting {
	/** The one stage that may ever serve the API publicly: production-runs, which holds the permanent data. */
	stage: typeof PRODUCTION_STAGE;
	state: PublicApiState;
	plan: PlanAttachment;
}

/**
 * The switch: whether production-runs serves the data API and its evidence
 * publicly at https://api.ledgermath.com, and how far. Committed, not an
 * environment variable: a deploy must come from a clean tree at HEAD
 * (stack.ts, sourceArchive), so the state is in git, and a routine deploy
 * that forgot a variable cannot delete the distribution or disable it.
 * Turning it on is a change of `state`, reviewed and merged, and deployed in
 * the order the README gives ("The public data API", "Turning it on"); each
 * commit that changes it also changes the one test that pins it, to the
 * state it sets (tests/public-blobs.test.ts, RELEASED_STATE, "RELEASE
 * GATE"). Its type is
 * PublicApiSetting, not the literal, so the type check sees every state's
 * branch whatever is committed.
 */
export const PUBLIC_API: PublicApiSetting = {
	stage: "production-runs",
	state: "on",
	plan: "code",
};

/** The one name the API is served under, and the Route 53 hosted zone the subdomain is delegated to, in the production account (#64, 2026-11-19). */
export const API_DOMAIN = {
	name: "api.ledgermath.com",
	hostedZoneId: "Z03039811C7UWLHZE7CZQ",
} as const;

/** Where CLOUDFRONT-scope web ACLs live, the Pricing Plan Manager API's only Region, and where CloudFront takes its certificates from. */
export const GLOBAL_REGION = "us-east-1";

/** Which bucket a served prefix is read from. */
export type Origin = "api" | "runs";

/** One shape of key the project writes, as a regular expression over the bucket's key (no leading slash). */
export interface KeyShape {
	kind: string;
	key: RegExp;
}

export interface Served {
	/** A key prefix of its bucket, which is also the path under the host's root. */
	prefix: string;
	origin: Origin;
	what: string;
	/** The only keys under the prefix that are served: the shapes the project writes there. Anything else gets 404 at the edge. */
	keys: readonly KeyShape[];
}

/** The id of a Run: a version 7 UUID, the Run schema's id pattern (schemas/run.schema.json), unanchored. */
export const RUN_ID = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/**
 * A Run file: runs/<yyyy>/<mm>/<dd>/<id>.json, the Run's start date (a day of
 * the calendar) and its id, as runner/run.py writes it. All 7,270 Run files
 * of the Runs repository had this shape on 2026-11-21.
 */
export const RUN_KEY = new RegExp(`^runs\\/${calendarDate("\\/")}\\/${RUN_ID}\\.json$`);
/**
 * A boot summary: boots/<yyyy>/<mm>/<dd>/<boot>.json, the boot's day (a day of
 * the calendar) and the kernel's boot id, a UUID in lowercase hex, as
 * runner/run.py writes it from /proc/sys/kernel/random/boot_id. A boot whose
 * id could not be read writes unknown.json, which two such boots of one day
 * would share, and which the tree never links (no Run's boot is "unknown"):
 * it is not served. All 197 boot summaries of the Runs repository had this
 * shape on 2026-11-21.
 */
export const BOOT_KEY = new RegExp(`^boots\\/${calendarDate("\\/")}\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json$`);
/** A blob: blobs/sha256/<hex>, the SHA-256 of its bytes in 64 lowercase hex digits (scripts/lib/blobs.ts reads no other). */
export const BLOB_KEY = /^blobs\/sha256\/[0-9a-f]{64}$/;

/**
 * Everything the distribution can reach, in the order its behaviours are
 * listed, with the shapes of key served under each (under v1/, the tree's
 * kinds and the shapes served ahead of the build): the one list the
 * request function, the grants, the tests and the README's table of
 * addresses are all made from or held to. Anything else of either bucket
 * (the Runs bucket's source/ and logs/, an object under a served prefix of
 * no served shape, and whatever is put there later) is reached by no
 * behaviour, or answered 404 by the request function before the bucket is
 * asked.
 */
export const SERVED: readonly Served[] = [
	{ prefix: TREE_PREFIX, origin: "api", what: "the data API's tree", keys: [...TREE_KINDS, ...SERVED_AHEAD].map((kind) => ({ kind: kind.kind, key: kind.path })) },
	{ prefix: "runs/", origin: "runs", what: "Run files", keys: [{ kind: "a Run file", key: RUN_KEY }] },
	{ prefix: "boots/", origin: "runs", what: "boot summaries", keys: [{ kind: "a boot summary", key: BOOT_KEY }] },
	{ prefix: "blobs/sha256/", origin: "runs", what: "blobs", keys: [{ kind: "a blob", key: BLOB_KEY }] },
];

/** The prefixes a bucket's grant covers. */
export function servedPrefixes(origin: Origin): string[] {
	return SERVED.filter((served) => served.origin === origin).map((served) => served.prefix);
}

/** Whether a key (no leading slash) is of a shape the distribution serves. */
export function isServedKey(key: string): boolean {
	return SERVED.some((served) => served.keys.some((shape) => shape.key.test(key)));
}

/** A key shape as the request function matches it: against the request's URI, which starts with a slash. */
export function uriPattern(shape: KeyShape): string {
	const source = shape.key.source;
	if (!source.startsWith("^")) throw new Error(`the key shape of ${shape.kind} is not anchored at its start: ${source}`);
	return `^\\/${source.slice(1)}`;
}

/** CloudFront path patterns have no leading slash; * matches any characters, slashes included. */
export function pathPattern(prefix: string): string {
	return `${prefix}*`;
}

/** The ids of the distribution's two origins. */
export const ORIGIN_IDS: Readonly<Record<Origin, string>> = { api: "api-bucket", runs: "runs-bucket" };

/** A Run file, a boot summary or a blob is never edited, and each is named by, or cited with, its hash. */
export const EVIDENCE_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** For the 404s the functions answer: an address that is not served now may be later (the distribution goes "on"). */
export const NOT_FOUND_CACHE_CONTROL = "public, max-age=300";
/** Defence in depth: should evidence ever be rendered as a document, it runs nothing and loads nothing. */
export const EVIDENCE_CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";

export interface ManagedPolicy {
	name: string;
	id: string;
}

/**
 * AWS managed policies, the only kind the Free plan allows
 * (docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html,
 * using-managed-response-headers-policies.html).
 *
 * CachingOptimized: TTLs of 1 second minimum, 24 hours default, 365 days
 * maximum, and an object's own Cache-Control max-age in between wins; no
 * query string, header or cookie in the cache key, and none forwarded to the
 * bucket (so ?versionId= never reaches S3), but the normalised
 * Accept-Encoding, so gzip and Brotli are cached apart. The tree's objects
 * carry max-age=300, so the edges keep them five minutes; the Runs bucket's
 * carry none, so the edges keep them the default 24 hours. When CloudFront
 * compresses a response it turns the bucket's strong ETag into a weak one
 * (ServingCompressedFiles.html).
 *
 * CachingOptimizedForUncompressedObjects: the same, without compression, for
 * blobs, so the bytes served are the bytes stored, whose hash is the address.
 *
 * CORS-and-SecurityHeadersPolicy: Access-Control-Allow-Origin: * and
 * X-Content-Type-Options: nosniff (plus Referrer-Policy, Strict-Transport-
 * Security, X-Frame-Options: SAMEORIGIN, X-XSS-Protection) on every response,
 * errors included, which the viewer-response function does not see.
 */
export const CACHING_OPTIMIZED: ManagedPolicy = { name: "CachingOptimized", id: "658327ea-f89d-4fab-a63d-7e88639e58f6" };
export const CACHING_UNCOMPRESSED: ManagedPolicy = { name: "CachingOptimizedForUncompressedObjects", id: "b2884449-e4de-46a7-ac36-70bc7f1ddd6d" };
export const RESPONSE_HEADERS_POLICY: ManagedPolicy = { name: "CORS-and-SecurityHeadersPolicy", id: "e61eb60c-9c35-4d20-a928-2b84e02af89c" };

/** What the Free plan allows (flat-rate-pricing-plan.html, "Features by pricing plan tier"). */
export const FREE_PLAN = {
	requestsPerMonth: 1_000_000,
	gigabytesPerMonth: 100,
	cacheBehaviours: 5,
	wafRules: 5,
	plansPerAccount: 3,
} as const;

/** How a served prefix is cached and what its responses carry. */
export interface ServedRule {
	served: Served;
	cachePolicy: ManagedPolicy;
	/** CloudFront compresses JSON for a reader that asks; never blobs, whose bytes are their address. */
	compress: boolean;
	/** The viewer-response function sets the evidence's headers. */
	evidenceHeaders: boolean;
}

export function servedRule(served: Served): ServedRule {
	const blobs = served.prefix === "blobs/sha256/";
	return {
		served,
		cachePolicy: blobs ? CACHING_UNCOMPRESSED : CACHING_OPTIMIZED,
		compress: !blobs,
		evidenceHeaders: served.origin === "runs",
	};
}

/** The headers a reader gets, beyond the bucket's own (ETag, Last-Modified, Content-Length), and where each comes from. */
export interface ServedHeaders {
	cacheControl: string;
	cacheControlFrom: "the object" | "the function";
	/** null: the object's own (the boxes upload blobs as binary/octet-stream). */
	contentType: string | null;
	contentTypeFrom: "the object" | "the function" | "the bucket";
	accessControlAllowOrigin: "*";
	/** CloudFront's own time at the edges: the object's max-age, or the managed policy's default. */
	edgeSeconds: number;
	compressed: boolean;
	contentSecurityPolicy: string | null;
}

/**
 * What a successful response for `path` (with its leading slash) carries, or
 * null when no behaviour serves it (the default behaviour answers 404). The
 * README's table of headers is this, and tests hold the function's code and
 * the objects' headers to it.
 */
export function servedHeaders(path: string): ServedHeaders | null {
	const served = SERVED.find((entry) => path.startsWith(`/${entry.prefix}`));
	if (served === undefined || !served.keys.some((shape) => shape.key.test(path.slice(1)))) return null;
	const rule = servedRule(served);
	if (served.origin === "api") {
		return {
			cacheControl: TREE_CACHE_CONTROL,
			cacheControlFrom: "the object",
			contentType: TREE_CONTENT_TYPE,
			contentTypeFrom: "the object",
			accessControlAllowOrigin: "*",
			edgeSeconds: 300,
			compressed: rule.compress,
			contentSecurityPolicy: null,
		};
	}
	const json = path.endsWith(".json");
	return {
		cacheControl: EVIDENCE_CACHE_CONTROL,
		cacheControlFrom: "the function",
		contentType: json ? "application/json" : null,
		contentTypeFrom: json ? "the function" : "the bucket",
		accessControlAllowOrigin: "*",
		edgeSeconds: 86_400,
		compressed: rule.compress,
		contentSecurityPolicy: EVIDENCE_CONTENT_SECURITY_POLICY,
	};
}

/**
 * The per-address rate limit: 1,500 requests in any 5 minutes, about 5 a
 * second. The data grow by about 9,000 blobs a day. A mirror that fetches a
 * day's new blobs at 4 a second (1,200 per 5 minutes, the pace
 * scripts/lib/blobs.ts keeps) takes 37.5 minutes and stays 20% under the
 * limit, which leaves room for WAF's estimate being near, not exact; an agent
 * walking the tree at that pace does too. A runaway loop does tens to
 * hundreds of requests a second and passes 1,500 within a minute; WAF then
 * blocks that address (usually within 30 seconds of it going over, possibly
 * several minutes, AWS says) until its estimate of the address's rate falls
 * below the limit, and blocked requests do not count against the plan's
 * allowance. It does not limit the total: TOTAL_RATE_LIMIT does, as
 * approximately.
 */
export const RATE_LIMIT = { requests: 1_500, windowSeconds: 300 } as const;

/**
 * The rate limit on all requests together, from every address: 6,000 in any
 * 5 minutes (20 a second), counted by one WAF rate-based rule whose
 * aggregation is CONSTANT ("count all"), scoped down to every request
 * (everyRequest): each request that can reach a bucket (the tree, Run files,
 * boot summaries, blobs) is counted, and so are those CloudFront answers from
 * its cache or a function answers. Over it, every request is refused, for
 * everyone, until the rate falls.
 *
 * AWS enforces it approximately, and says so
 * (docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-caveats.html):
 * WAF estimates the rate, weighting recent requests, and limits near the
 * limit, not exactly at it; a rate over the limit can pass for up to several
 * minutes before WAF acts (usually under 30 seconds); and changing any of the
 * rule's rate settings resets its counts, which can pause it for up to a
 * minute. So it is not a cap on what S3 can bill, and nothing here is: there
 * is no hard cap on S3 request charges. monthAtTotalLimit gives what a month
 * costs at exactly this rate throughout; bursts can exceed it.
 */
export const TOTAL_RATE_LIMIT = { requests: 6_000, windowSeconds: 300 } as const;

/** S3 Standard GET and HEAD requests in us-east-2, USD per 1,000 (AWS's Price List API, publication of 2026-11-19: $0.004 per 10,000). */
export const S3_GET_USD_PER_THOUSAND = 0.0004;

/**
 * The requests in a month of `days` days at exactly TOTAL_RATE_LIMIT's rate
 * throughout, and what S3 bills for them if every one misses CloudFront's
 * cache: what a month costs at the configured steady rate, an estimate and
 * not a maximum (bursts can exceed it; see TOTAL_RATE_LIMIT).
 */
export function monthAtTotalLimit(days: number): { requests: number; usd: number } {
	const windows = (days * 24 * 3600) / TOTAL_RATE_LIMIT.windowSeconds;
	const requests = TOTAL_RATE_LIMIT.requests * windows;
	return { requests, usd: (requests / 1000) * S3_GET_USD_PER_THOUSAND };
}

/** How often the watch runs, and how long it leaves a closed distribution that no plan covers. */
export const WATCH_SCHEDULE = "rate(5 minutes)";
export const WATCH_INTERVAL_MINUTES = 5;
export const CLOSED_GRACE_MINUTES = 60;

/** The resources' names in AWS: unique in the account, and per stage. */
export interface PublicApiNames {
	webAcl: string;
	originAccessControl: string;
	requestFunction: string;
	evidenceResponseFunction: string;
	noRouteFunction: string;
}

export function publicApiNames(app: string, stage: string): PublicApiNames {
	const prefix = `${app}-${stage}`;
	return {
		webAcl: `${prefix}-public-api`,
		originAccessControl: `${prefix}-public-api`,
		requestFunction: `${prefix}-request`,
		evidenceResponseFunction: `${prefix}-evidence-response`,
		noRouteFunction: `${prefix}-no-route`,
	};
}

/**
 * The distribution's comment, which is also the record of what the stage
 * last deployed: the deploy and the watch read it back from AWS
 * (public-blobs-guard.ts, parseComment), and the deploy requires it to be
 * the comment the stage's state last saw (findDeployed). At most 128
 * characters.
 */
export function distributionComment(stage: string, state: DeployedState, plan: PlanAttachment): string {
	return `LedgerMath ${stage} public API (${API_DOMAIN.name}): state=${state} plan=${plan}`;
}

export interface PublicApiPlan {
	stage: string;
	state: DeployedState;
	plan: PlanAttachment;
	/** closed and on: the distribution is enabled. */
	distributionEnabled: boolean;
	/** on only: the served behaviours reach their buckets, and both buckets grant the distribution their served prefixes. */
	serve: boolean;
	/** The deploy creates the Free plan subscription. */
	subscribeInCode: boolean;
	/** Pulumi refuses to delete or replace the distribution and the subscription while it is enabled. */
	protect: boolean;
	comment: string;
}

/**
 * Throws unless the setting is one the code knows: an object, its state one
 * of STATES and its plan attachment one of PLAN_ATTACHMENTS (a typo, a
 * missing field or a value from some other version would otherwise reach
 * the plan as something no branch expects), and unless it names
 * production-runs, in every state: no other stage may ever serve the API, and
 * a misspelt or empty stage, even while "off", would make the setting
 * silently apply to no stage the day it is turned on. PUBLIC_API's type
 * already says so; this says it to a setting built at run time, and to a
 * test.
 */
export function checkSetting(setting: unknown): asserts setting is { stage: string; state: PublicApiState; plan: PlanAttachment } {
	if (typeof setting !== "object" || setting === null) throw new Error(`The public data API's setting is not an object: ${JSON.stringify(setting)}`);
	const { stage, state, plan } = setting as Record<string, unknown>;
	if (typeof stage !== "string") throw new Error(`The public data API's setting names no stage: ${JSON.stringify(stage)}`);
	if (!STATES.some((known) => known === state)) {
		throw new Error(`The public data API's state is ${JSON.stringify(state)}, which is none of ${STATES.map((known) => `"${known}"`).join(", ")} (infra/runs/public-blobs.ts)`);
	}
	if (!PLAN_ATTACHMENTS.some((known) => known === plan)) {
		throw new Error(`The public data API's plan attachment is ${JSON.stringify(plan)}, which is none of ${PLAN_ATTACHMENTS.map((known) => `"${known}"`).join(", ")} (infra/runs/public-blobs.ts)`);
	}
	if (stage !== PRODUCTION_STAGE) {
		throw new Error(
			`The public data API may be served from ${PRODUCTION_STAGE} alone, and the setting names ${JSON.stringify(stage)} (with the state "${String(state)}"). ` +
				`Set PUBLIC_API.stage to "${PRODUCTION_STAGE}" (infra/runs/public-blobs.ts), in every state, "off" included.`,
		);
	}
}

/**
 * What a deploy of `stage` makes for a setting: nothing at all for "off", or
 * for any stage but setting.stage. Throws for a setting checkSetting refuses:
 * one naming another stage than production-runs, in any state.
 */
export function publicApiPlan(setting: unknown, stage: string): PublicApiPlan | null {
	checkSetting(setting);
	if (stage !== setting.stage || setting.state === "off") return null;
	const enabled = setting.state === "closed" || setting.state === "on";
	return {
		stage,
		state: setting.state,
		plan: setting.plan,
		distributionEnabled: enabled,
		serve: setting.state === "on",
		subscribeInCode: setting.plan === "code",
		protect: enabled,
		comment: distributionComment(stage, setting.state, setting.plan),
	};
}

/**
 * Every resource the stack declares for a plan, by its name in the stage
 * (public-blobs-stack.ts makes exactly these, and tests/public-api-graph.test.ts
 * builds the stack's resources for each state, without AWS, and holds the two
 * together). None for "off". The grants are not resources: in "on" they go
 * into the two bucket policies SST already makes (bucketGrant, withGrant).
 */
export function declaredResources(plan: PublicApiPlan | null): string[] {
	if (plan === null) return [];
	return [
		"PublicApiWebAcl",
		"PublicApiOac",
		"PublicApiRequestFunction",
		"PublicApiEvidenceResponseFunction",
		"PublicApiNoRouteFunction",
		"PublicApiCertificate",
		"PublicApiCertificateRecord",
		"PublicApiCertificateValidation",
		"PublicApiDistribution",
		"PublicApiAliasA",
		"PublicApiAliasAAAA",
		...(plan.subscribeInCode ? ["PublicApiFreePlan"] : []),
		"PublicApiWatch",
	];
}

/**
 * The Runs bucket's arguments. With no transform they are, byte for byte,
 * what stack.ts passed before this file existed, so "off", "dark" and
 * "closed" leave the bucket policy as it was.
 */
export function runsBucketArgs<T>(policyTransform: T | null): { versioning: true; transform?: { policy: T } } {
	return policyTransform === null ? { versioning: true } : { versioning: true, transform: { policy: policyTransform } };
}

export const GRANT_SID = "PublicApiThroughCloudFront";

/**
 * What a bucket policy adds, in "on" only: the CloudFront service may
 * GetObject under the bucket's served prefixes, only on behalf of this
 * distribution. Not ListBucket, so the distribution can never list a bucket,
 * and a key that is not there gets 403 from S3, not 404. Not
 * GetObjectVersion, so no older version of any key.
 */
export function bucketGrant(bucketArn: string, distributionArn: string, origin: Origin): PolicyStatement {
	return {
		Sid: GRANT_SID,
		Effect: "Allow",
		Principal: { Service: "cloudfront.amazonaws.com" },
		Action: ["s3:GetObject"],
		Resource: servedPrefixes(origin).map((prefix) => `${bucketArn}/${prefix}*`),
		Condition: { StringEquals: { "AWS:SourceArn": distributionArn } },
	};
}

/**
 * The bucket policy SST makes (its HTTPS-only statement), with the grant
 * added. SST makes a bucket's one policy, so the grant goes into that
 * document rather than into a second policy, which would replace it.
 */
export function withGrant(policyJson: string, bucketArn: string, distributionArn: string, origin: Origin): string {
	const document = JSON.parse(policyJson) as { Version?: unknown; Statement?: unknown };
	if (typeof document.Version !== "string" || !Array.isArray(document.Statement)) {
		throw new Error(`the bucket policy is not a policy document: ${policyJson.slice(0, 200)}`);
	}
	const others = (document.Statement as Array<{ Sid?: unknown }>).filter((statement) => statement.Sid !== GRANT_SID);
	const result: { Version: string; Statement: unknown[] } = {
		Version: document.Version,
		Statement: [...others, bucketGrant(bucketArn, distributionArn, origin)],
	};
	return JSON.stringify(result);
}

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
	compress: boolean;
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
	viewerCertificate: { acmCertificateArn: T; sslSupportMethod: "sni-only"; minimumProtocolVersion: string };
}

export interface DistributionRefs<T> {
	/** Each bucket's regional domain name (<bucket>.s3.us-east-2.amazonaws.com). */
	apiBucketDomain: T;
	runsBucketDomain: T;
	originAccessControlId: T;
	webAclArn: T;
	requestFunctionArn: T;
	evidenceResponseFunctionArn: T;
	noRouteFunctionArn: T;
	/** The validated certificate for API_DOMAIN.name, in us-east-1. */
	certificateArn: T;
}

/** The newest policy that still speaks TLS 1.2 (to clients without 1.3). */
export const TLS_POLICY = "TLSv1.2_2025";

/**
 * The distribution: five cache behaviours, the Free plan's most. One per
 * served prefix, each reaching its bucket in "on" behind the request
 * function, which refuses another host than api.ledgermath.com and answers
 * 404 to a key of no served shape (the evidence also has the viewer-response
 * function that sets its headers), and the default behaviour, which reaches
 * nothing: its function answers 404 to every request, before the cache or a
 * bucket sees it. In "dark" and "closed" every behaviour has that function,
 * so nothing reaches a bucket. GET and HEAD only, HTTPS only (plain HTTP gets
 * 403), HTTP/2 and HTTP/3, IPv6, every edge location, under
 * api.ledgermath.com alone.
 */
export function distributionArgs<T>(refs: DistributionRefs<T>, plan: PublicApiPlan): DistributionSpec<T> {
	const noRoute: FunctionAssociation<T> = { eventType: "viewer-request", functionArn: refs.noRouteFunctionArn };
	const request: FunctionAssociation<T> = { eventType: "viewer-request", functionArn: refs.requestFunctionArn };
	const behaviour = (origin: Origin, cachePolicy: ManagedPolicy, compress: boolean, associations: Array<FunctionAssociation<T>>): CacheBehaviour<T> => ({
		targetOriginId: ORIGIN_IDS[origin],
		viewerProtocolPolicy: "https-only",
		allowedMethods: [...GET_HEAD],
		cachedMethods: [...GET_HEAD],
		cachePolicyId: cachePolicy.id,
		responseHeadersPolicyId: RESPONSE_HEADERS_POLICY.id,
		compress,
		functionAssociations: associations,
	});
	return {
		enabled: plan.distributionEnabled,
		comment: plan.comment,
		isIpv6Enabled: true,
		httpVersion: "http2and3",
		priceClass: "PriceClass_All",
		webAclId: refs.webAclArn,
		aliases: [API_DOMAIN.name],
		origins: (["api", "runs"] as const).map((origin) => ({
			originId: ORIGIN_IDS[origin],
			domainName: origin === "api" ? refs.apiBucketDomain : refs.runsBucketDomain,
			originAccessControlId: refs.originAccessControlId,
		})),
		defaultCacheBehavior: behaviour("api", CACHING_UNCOMPRESSED, false, [noRoute]),
		orderedCacheBehaviors: SERVED.map((served) => {
			const rule = servedRule(served);
			const associations: Array<FunctionAssociation<T>> = [
				plan.serve ? request : noRoute,
				...(rule.evidenceHeaders ? [{ eventType: "viewer-response" as const, functionArn: refs.evidenceResponseFunctionArn }] : []),
			];
			return { pathPattern: pathPattern(served.prefix), ...behaviour(served.origin, rule.cachePolicy, rule.compress, associations) };
		}),
		restrictions: { geoRestriction: { restrictionType: "none" } },
		viewerCertificate: { acmCertificateArn: refs.certificateArn, sslSupportMethod: "sni-only", minimumProtocolVersion: TLS_POLICY },
	};
}

/** The certificate: API_DOMAIN.name alone, validated by a DNS record in its hosted zone, in us-east-1, where CloudFront takes certificates from. */
export const CERTIFICATE_ARGS = {
	region: GLOBAL_REGION,
	domainName: API_DOMAIN.name,
	validationMethod: "DNS",
	keyAlgorithm: "RSA_2048",
} as const;

/** The TTL of the certificate's validation record. */
export const VALIDATION_RECORD_TTL = 300;

/** The alias records: api.ledgermath.com to the distribution, over IPv4 and IPv6 (the distribution has IPv6 on). */
export const ALIAS_RECORD_TYPES = ["A", "AAAA"] as const;

export function aliasRecordArgs<T>(type: (typeof ALIAS_RECORD_TYPES)[number], distributionDomain: T, distributionZoneId: T) {
	return {
		zoneId: API_DOMAIN.hostedZoneId,
		name: API_DOMAIN.name,
		type,
		aliases: [{ name: distributionDomain, zoneId: distributionZoneId, evaluateTargetHealth: false }],
	};
}

const NOT_FOUND_TEXT =
	"Not found. LedgerMath's data API starts at /v1/index.json; its evidence is at /runs/..., /boots/... and /blobs/sha256/<hex>, as the files link it.\n";

/** The 404 the no-route function answers with, in CloudFront Functions JavaScript (cloudfront-js-2.0). */
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

const OTHER_HOST_TEXT = `Forbidden. LedgerMath's data API is served at https://${API_DOMAIN.name}/ and under no other name.\n`;

/**
 * The one host, and the 403 every function answers a request for any other
 * with, whatever its path: the API has one name, and every request to
 * another gets the same answer, from whichever behaviour it reaches.
 */
const HOST_SOURCE = [
	`var HOST = ${JSON.stringify(API_DOMAIN.name)};`,
	"function otherHost(request) {",
	"  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';",
	"  if (host === HOST) return null;",
	"  return {",
	"    statusCode: 403,",
	"    statusDescription: 'Forbidden',",
	"    headers: {",
	"      'content-type': { value: 'text/plain; charset=utf-8' },",
	`      'cache-control': { value: '${NOT_FOUND_CACHE_CONTROL}' },`,
	"      'x-content-type-options': { value: 'nosniff' }",
	"    },",
	`    body: { encoding: 'text', data: ${JSON.stringify(OTHER_HOST_TEXT)} }`,
	"  };",
	"}",
].join("\n");

/**
 * The default behaviour's function, and every behaviour's in "dark" and
 * "closed": 403 for another host, as the request function answers it, and
 * 404 for every request to api.ledgermath.com; neither reaches cache or
 * bucket. Needed because CloudFront has no behaviour that reaches no origin,
 * and the default behaviour must otherwise name one: without it, every
 * address of no served prefix would be a request to a bucket.
 */
export const NO_ROUTE_FUNCTION_CODE = [
	HOST_SOURCE,
	NOT_FOUND_SOURCE,
	"function handler(event) {",
	"  return otherHost(event.request) || notFound();",
	"}",
	"",
].join("\n");

/**
 * The served behaviours' viewer-request function, in "on". A request whose
 * Host is not api.ledgermath.com (the distribution's own *.cloudfront.net
 * name, say) gets 403: the API has one host. A request whose path is not
 * exactly a key of a served shape (SERVED's keys: the tree's kinds, a Run
 * file, a boot summary, a blob) gets 404, before the cache or a bucket sees
 * it, so an object under a served prefix that the project did not write in
 * one of those shapes is never served, whatever is put there. Anything else
 * goes on, unchanged.
 */
export const REQUEST_FUNCTION_CODE = [
	`var SHAPES = [${SERVED.flatMap((served) => served.keys)
		.map((shape) => `new RegExp(${JSON.stringify(uriPattern(shape))})`)
		.join(", ")}];`,
	HOST_SOURCE,
	NOT_FOUND_SOURCE,
	"function handler(event) {",
	"  var request = event.request;",
	"  var refused = otherHost(request);",
	"  if (refused) return refused;",
	"  for (var i = 0; i < SHAPES.length; i++) {",
	"    if (SHAPES[i].test(request.uri)) return request;",
	"  }",
	"  return notFound();",
	"}",
	"",
].join("\n");

/**
 * The evidence behaviours' viewer-response function: the headers of bytes
 * that never change. Needed because the boxes upload Run files, boot
 * summaries and blobs with no Cache-Control (and the box is not changed for
 * this), the workflow may not write to the Runs bucket, and the Free plan
 * allows no custom response-headers policy, which would otherwise add it.
 * A Run file or boot summary (.json) is also given Content-Type:
 * application/json, which the boxes' upload guesses from the name today,
 * so that it does not depend on that guess. CloudFront runs it only for
 * status codes below 400 (edge-function-restrictions-all.html); it checks
 * anyway.
 */
export const EVIDENCE_RESPONSE_FUNCTION_CODE = [
	"function handler(event) {",
	"  var response = event.response;",
	"  if (response.statusCode < 400) {",
	`    response.headers['cache-control'] = { value: '${EVIDENCE_CACHE_CONTROL}' };`,
	"    response.headers['access-control-allow-origin'] = { value: '*' };",
	"    response.headers['x-content-type-options'] = { value: 'nosniff' };",
	`    response.headers['content-security-policy'] = { value: ${JSON.stringify(EVIDENCE_CONTENT_SECURITY_POLICY)} };`,
	"    if (event.request.uri.slice(-5) === '.json') {",
	"      response.headers['content-type'] = { value: 'application/json' };",
	"    }",
	"  }",
	"  return response;",
	"}",
	"",
].join("\n");

/** CloudFront Functions' limit on a function's code. */
export const FUNCTION_CODE_LIMIT_BYTES = 10_240;

export interface VisibilityConfig {
	cloudwatchMetricsEnabled: boolean;
	metricName: string;
	sampledRequestsEnabled: boolean;
}

export interface GeoMatch {
	geoMatchStatement: { countryCodes: string[] };
}

/** A scope-down statement that matches every request (everyRequest): Or(from a country, Not(from it)). */
export interface EveryRequestMatch {
	orStatement: { statements: [GeoMatch, { notStatement: { statements: [GeoMatch] } }] };
}

export interface RateRule {
	name: string;
	priority: number;
	action: { block: Record<string, never> };
	statement: {
		rateBasedStatement:
			| { limit: number; aggregateKeyType: "IP"; evaluationWindowSec: number }
			| { limit: number; aggregateKeyType: "CONSTANT"; evaluationWindowSec: number; scopeDownStatement: EveryRequestMatch };
	};
	visibilityConfig: VisibilityConfig;
}

/**
 * The country of everyRequest's two geographic matches: Antarctica. Any
 * country would do, since the statement matches every request whichever it
 * names; this is the one the scope-down was seen accepted with.
 */
export const EVERY_REQUEST_COUNTRY = "AQ";

/**
 * The total rule's scope-down statement, which matches every request: from
 * Antarctica, or not from Antarctica. A request is from a country or it is
 * not, and one whose country WAF cannot tell is not from Antarctica, so it
 * matches too. The shape is odd on purpose. A rate-based rule that counts all
 * requests together (aggregation CONSTANT) must have a scope-down statement;
 * this one must match every request, so that no request reaches a bucket
 * uncounted; and the CloudFront Free plan allows no string match, size
 * constraint or regular expression to write "every path" with. The rule as
 * first built matched URI paths that start with "/" (a byte match), and on
 * 2026-11-24 the Free plan refused it: the production-runs web ACL was "not
 * eligible for this subscription tier", and WAF refused the same rule on a
 * subscribed web ACL in the development account
 * (WAFFeatureNotIncludedInPricingPlanException, "String match statement",
 * PRO; a size constraint likewise). It accepted this one, with the other
 * three rules, and the subscription stayed ACTIVE. tests/free-plan-waf.ts
 * holds every statement of every rule to what the plan was seen to accept.
 * It is as deep as the provider allows: the installed @pulumi/aws (7.20.0)
 * bridges a Terraform schema in which a scope-down's Or may hold a Not, and
 * the Not only a plain statement such as a geographic match, never another
 * Or, And or Not (Pulumi's mocks do not run the provider; `sst diff` does).
 */
export function everyRequest(): EveryRequestMatch {
	const fromCountry = (): GeoMatch => ({ geoMatchStatement: { countryCodes: [EVERY_REQUEST_COUNTRY] } });
	return { orStatement: { statements: [fromCountry(), { notStatement: { statements: [fromCountry()] } }] } };
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
 * behind this distribution are S3 GETs of static files, and it blocks
 * requests without a User-Agent, which a plain client or agent may send.
 */
export const MANAGED_RULE_GROUPS = ["AWSManagedRulesAmazonIpReputationList", "AWSManagedRulesKnownBadInputsRuleSet"] as const;

/**
 * The web ACL's description. WAF takes letters, digits, whitespace and
 * _+=:#@/-,. only (API_CreateWebACL.html, Description), so no semicolon.
 */
export const WEB_ACL_DESCRIPTION = "LedgerMath public API - per-address limit, limit on all requests together, AWS managed rules, required by the CloudFront Free plan";
/** That pattern, as AWS states it. */
export const WEB_ACL_DESCRIPTION_PATTERN = /^[\w+=:#@/\-,.][\w+=:#@/\-,.\s]+[\w+=:#@/\-,.]$/;

export const PER_ADDRESS_RULE = "per-address-rate-limit";
export const TOTAL_RULE = "all-requests-ceiling";

function visibility(metricName: string): VisibilityConfig {
	return { cloudwatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true };
}

/**
 * The web ACL's rules, 4 of the Free plan's 5, in the order WAF evaluates
 * them (lowest priority first, stopping at the first that blocks): the two
 * managed groups, then the per-address limit, then the limit on the total.
 * So a request a managed group or the per-address limit has already blocked
 * is never counted by the total's rule: a single runaway address is cut off
 * by its own rule, and does not use up everyone's allowance under the total.
 * Its name, TOTAL_RULE, says "ceiling"; it is a rate limit WAF enforces
 * approximately (TOTAL_RATE_LIMIT).
 */
export function webAclRules(metricPrefix: string): WebAclRule[] {
	const managed = MANAGED_RULE_GROUPS.map(
		(name, index): ManagedRule => ({
			name,
			priority: index,
			overrideAction: { none: {} },
			statement: { managedRuleGroupStatement: { vendorName: "AWS", name } },
			visibilityConfig: visibility(`${metricPrefix}-${name}`),
		}),
	);
	const perAddress: RateRule = {
		name: PER_ADDRESS_RULE,
		priority: managed.length,
		action: { block: {} },
		statement: { rateBasedStatement: { limit: RATE_LIMIT.requests, aggregateKeyType: "IP", evaluationWindowSec: RATE_LIMIT.windowSeconds } },
		visibilityConfig: visibility(`${metricPrefix}-rate-limit`),
	};
	const total: RateRule = {
		name: TOTAL_RULE,
		priority: managed.length + 1,
		action: { block: {} },
		statement: {
			rateBasedStatement: {
				limit: TOTAL_RATE_LIMIT.requests,
				aggregateKeyType: "CONSTANT",
				evaluationWindowSec: TOTAL_RATE_LIMIT.windowSeconds,
				// CONSTANT needs a scope-down; it must match every request, and the
				// Free plan allows no string, size or regex match: everyRequest.
				scopeDownStatement: everyRequest(),
			},
		},
		visibilityConfig: visibility(`${metricPrefix}-ceiling`),
	};
	return [...managed, perAddress, total];
}

/**
 * The Cloud Control type of the Free plan subscription, and its desired
 * state. A move to Pro is made in the console or with the CLI, and this is
 * left saying FREE: CloudFormation's handler refuses to change a tier, and a
 * deploy sends the subscription only what changed in this document, so it
 * never undoes the upgrade.
 */
export const SUBSCRIPTION_TYPE = "AWS::PricingPlanManager::Subscription";

export function subscriptionState(distributionArn: string, webAclArn: string): string {
	return JSON.stringify({ PlanFamily: "CloudFront", PlanTier: "FREE", UsageLevel: "DEFAULT", ResourceArns: [distributionArn, webAclArn] });
}

/** `--profile <name>`, or nothing when the stage names no profile (its credentials then come from the environment). */
export function profileFlag(profile: string | undefined): string {
	return profile === undefined ? "" : ` --profile ${profile}`;
}

/** The console steps that subscribe the distribution to the Free plan, for PUBLIC_API.plan "console". */
export function consoleSteps(stage: string, profile: string | undefined): string[] {
	return [
		"Subscribe the distribution to the Free plan, in the CloudFront console (https://console.aws.amazon.com/cloudfront/v4/home),",
		`signed in to the account of the stage ${stage}:`,
		`  1. Distributions: open the one whose description starts "LedgerMath ${stage} public API" (ID in the stage output publicApi.distributionId).`,
		"  2. Choose its pricing plan (Manage plan), pick Free, and confirm. Its web ACL is already associated; nothing else needs to change.",
		"  3. Wait until the plan shows as active (the API's status ACTIVE; AWS says 2 to 5 minutes).",
		"  Or, the same from the CLI (a Free plan activates at once; no approval):",
		`     aws pricing-plan-manager create-subscription --region ${GLOBAL_REGION}${profileFlag(profile)} --plan-family CloudFront --plan-tier FREE \\`,
		"       --resource-arns <publicApi.distributionArn> <publicApi.webAclArn>",
	];
}

/** What the deploy prints after it has judged the transition, for the state being deployed. */
export function reminder(plan: PublicApiPlan, profile: string | undefined): string[] {
	const check = `aws pricing-plan-manager list-subscriptions --region ${GLOBAL_REGION}${profileFlag(profile)}`;
	const lines = [`The public data API on ${plan.stage} (the only stage that may have it): ${plan.state}.`];
	if (plan.state === "dark") {
		lines.push(
			`The distribution is DISABLED and serves nothing; neither bucket grants it anything. ${API_DOMAIN.name} points at it.`,
			...(plan.subscribeInCode ? ["This deploy subscribes it to the Free plan (AWS::PricingPlanManager::Subscription)."] : consoleSteps(plan.stage, profile)),
			`Next: check that the plan is ACTIVE and covers the distribution (${check}),`,
			'then set PUBLIC_API.state to "on" in infra/runs/public-blobs.ts, commit, and deploy; that deploy stops unless the plan is ACTIVE.',
			'Only if AWS refused to subscribe the disabled distribution: set "closed" instead, deploy, attach the plan, check it, then "on".',
		);
	} else if (plan.state === "closed") {
		lines.push(
			"The distribution is ENABLED but answers 404 to every address; neither bucket grants it anything, so nothing can be read.",
			"Until the plan is attached, the requests that reach it are billed at pay-as-you-go rates (CloudFront, its function, WAF), though S3 is never reached.",
			...(plan.subscribeInCode ? ["This deploy subscribes it to the Free plan (AWS::PricingPlanManager::Subscription)."] : consoleSteps(plan.stage, profile)),
			`Next: check that the plan is ACTIVE and covers the distribution (${check}), set PUBLIC_API.state to "on", commit, and deploy.`,
			`The watch leaves a closed distribution that no ACTIVE plan covers alone for ${CLOSED_GRACE_MINUTES} minutes after its last change, then disables it on its next run.`,
		);
	} else {
		lines.push(
			`The distribution is enabled and serves the data API and its evidence to anyone at https://${API_DOMAIN.name}/ (stage output publicApi.address).`,
			`The watch checks every ${WATCH_INTERVAL_MINUTES} minutes that an ACTIVE plan covers it, and disables it if not.`,
			'Before changing or cancelling the plan, deploy "dark": the watch disables the distribution whenever the plan is not ACTIVE,',
			'a change being applied (SYNC_IN_PROGRESS) included, and after that only a "dark" deploy brings it back.',
		);
	}
	return lines;
}
