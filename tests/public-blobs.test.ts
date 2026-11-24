import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { apiBucketArgs, calendarDate, TREE_CACHE_CONTROL, TREE_CONTENT_TYPE, TREE_KINDS, treeObject } from "../infra/runs/api-bucket";
import { API_SCHEMAS as API_SCHEMAS_OF_BUILD } from "../scripts/lib/api";
import { API_SCHEMAS } from "../scripts/lib/api-schemas";
import {
	ALIAS_RECORD_TYPES,
	aliasRecordArgs,
	API_DOMAIN,
	BLOB_KEY,
	BOOT_KEY,
	bucketGrant,
	CACHING_OPTIMIZED,
	CACHING_UNCOMPRESSED,
	CERTIFICATE_ARGS,
	checkSetting,
	consoleSteps,
	declaredResources,
	type DistributionSpec,
	distributionArgs,
	distributionComment,
	EVIDENCE_CACHE_CONTROL,
	EVIDENCE_CONTENT_SECURITY_POLICY,
	EVIDENCE_RESPONSE_FUNCTION_CODE,
	FREE_PLAN,
	FUNCTION_CODE_LIMIT_BYTES,
	GLOBAL_REGION,
	GRANT_SID,
	isServedKey,
	MANAGED_RULE_GROUPS,
	monthAtTotalLimit,
	NO_ROUTE_FUNCTION_CODE,
	type Origin,
	ORIGIN_IDS,
	PER_ADDRESS_RULE,
	PLAN_ATTACHMENTS,
	PUBLIC_API,
	type PublicApiPlan,
	type PublicApiState,
	publicApiNames,
	publicApiPlan,
	RATE_LIMIT,
	type RateRule,
	reminder,
	REQUEST_FUNCTION_CODE,
	RESPONSE_HEADERS_POLICY,
	RUN_ID,
	RUN_KEY,
	runsBucketArgs,
	S3_GET_USD_PER_THOUSAND,
	SERVED,
	servedHeaders,
	servedPrefixes,
	STATES,
	subscriptionState,
	uriPattern,
	TLS_POLICY,
	TOTAL_RATE_LIMIT,
	TOTAL_RULE,
	WEB_ACL_DESCRIPTION,
	WEB_ACL_DESCRIPTION_PATTERN,
	webAclRules,
	withGrant,
} from "../infra/runs/public-blobs";
import { DISTRIBUTION_NAME } from "../infra/runs/public-blobs-guard";
import { PRODUCTION_STAGE, runsStageApp } from "../infra/runs/stages";
import { blobsFromBucket, PUBLIC_REQUESTS_PER_SECOND, publicBlobStore } from "../scripts/lib/blobs";
import { FREE_PLAN_MANAGED_GROUPS, FREE_PLAN_WAF_RULES, freePlanMessage, freePlanRefusals } from "./free-plan-waf";
import { failedTests, readJunit } from "./junit";
import { S3Standin } from "./s3-standin";

// The turn-on rehearsal runs the suite again in its own processes: seconds on a loaded machine.
setDefaultTimeout(120_000);

const ROOT = join(import.meta.dir, "..");
const STACK = readFileSync(join(ROOT, "infra", "runs", "stack.ts"), "utf8");
const RESOURCES = readFileSync(join(ROOT, "infra", "runs", "public-blobs-stack.ts"), "utf8");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const SECTION = README.slice(README.indexOf("### The public data API"), README.indexOf("## The Runs repository"));

const STAGE = "production-runs";
const RUNS_BUCKET_ARN = "arn:aws:s3:::ledgermath-production-runs-runsbucketbucket-abcdefgh";
const API_BUCKET_ARN = "arn:aws:s3:::ledgermath-production-runs-apibucketbucket-abcdefgh";
const DISTRIBUTION_ARN = "arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE";
const OTHER_DISTRIBUTION_ARN = "arn:aws:cloudfront::123456789012:distribution/E2OTHEREXAMPLE";
const WEB_ACL_ARN = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/ledgermath-production-runs-public-api/a1b2c3d4-5678-90ab-cdef-EXAMPLE11111";
const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"; // sha256("test")
const NAMES = publicApiNames("ledgermath", STAGE);

/** The policy SST makes for a bucket: its HTTPS-only statement, as iam.getPolicyDocument renders it. */
const sstPolicy = (bucketArn: string): string =>
	JSON.stringify({
		Version: "2012-10-17",
		Statement: [
			{
				Effect: "Deny",
				Action: "s3:*",
				Resource: [bucketArn, `${bucketArn}/*`],
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

function plan(state: "dark" | "closed" | "on", attachment: "code" | "console" = "code"): PublicApiPlan {
	const made = publicApiPlan({ stage: STAGE, state, plan: attachment }, STAGE);
	if (made === null) throw new Error("no plan");
	return made;
}

const REFS = {
	apiBucketDomain: "ledgermath-production-runs-apibucketbucket-abcdefgh.s3.us-east-2.amazonaws.com",
	runsBucketDomain: "ledgermath-production-runs-runsbucketbucket-abcdefgh.s3.us-east-2.amazonaws.com",
	originAccessControlId: "E2QWRUHEXAMPLE",
	webAclArn: WEB_ACL_ARN,
	requestFunctionArn: "arn:aws:cloudfront::123456789012:function/ledgermath-production-runs-request",
	evidenceResponseFunctionArn: "arn:aws:cloudfront::123456789012:function/ledgermath-production-runs-evidence-response",
	noRouteFunctionArn: "arn:aws:cloudfront::123456789012:function/ledgermath-production-runs-no-route",
	certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000",
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

function request(uri: string, host: string | null = API_DOMAIN.name): CfRequest {
	return { method: "GET", uri, headers: host === null ? {} : { host: { value: host } } };
}

const CREATE = RESOURCES.slice(RESOURCES.indexOf("function createResources("));
const PREPARE = RESOURCES.slice(RESOURCES.indexOf("export function preparePublicApi"), RESOURCES.indexOf("function createResources("));
/** Set in the turn-on rehearsal's own processes (below): the committed setting is then not the one in force. */
const REHEARSAL = process.env.LM_PUBLIC_API_STATE !== undefined;

/**
 * RELEASED_STATE: the state the public API is released in, which the
 * committed switch must hold. "on": the distribution serves the four served
 * prefixes at https://api.ledgermath.com, and both buckets' policies carry
 * their grant, in what is merged. Each commit that moves
 * the public API through its states (README, "The public data API", "Turning
 * it on") sets PUBLIC_API.state and this, together, on purpose, to the state
 * it deploys; the release gate below and the rehearsal both read it, and no
 * other test reads the committed switch.
 */
const RELEASED_STATE: PublicApiState = "on";
/** The release gate, as the JUnit report names it. */
const GATE = "tests/public-blobs.test.ts > the switch > RELEASE GATE: the committed switch is the released state, for production-runs";

describe("the switch", () => {
	// RELEASE GATE. The one test that reads the committed switch: it must be RELEASED_STATE.
	test("RELEASE GATE: the committed switch is the released state, for production-runs", () => {
		expect(PUBLIC_API.stage).toBe(PRODUCTION_STAGE);
		expect(PUBLIC_API.state).toBe(RELEASED_STATE);
	});

	test("is one typed setting, read once by the stack, and declared as the union of its states, so the type check sees every state", () => {
		// The setting's type allows production-runs alone.
		const typed: typeof PUBLIC_API.stage = "production-runs";
		expect(typed).toBe(PRODUCTION_STAGE);
		const source = readFileSync(join(ROOT, "infra", "runs", "public-blobs.ts"), "utf8");
		expect(source).toContain("export const PUBLIC_API: PublicApiSetting = {");
		expect(source).toMatch(/export interface PublicApiSetting \{[^}]*\n\tstate: PublicApiState;\n\tplan: PlanAttachment;\n\}/);
		// stack.ts's code (its comments aside) imports it and reads it once, and nothing else decides whether the API is served.
		const code = STACK.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
		expect(code.match(/PUBLIC_API\b/g)?.length).toBe(2);
		expect(code).toContain('import { PUBLIC_API, runsBucketArgs } from "./public-blobs";');
		expect(code).toContain("const publicApi = preparePublicApi(PUBLIC_API, $cli.command);");
	});

	test("rejects, at run time, a setting of no known state or plan attachment, or none at all", () => {
		const good = { stage: STAGE, state: "off", plan: "code" };
		expect(() => checkSetting(good)).not.toThrow();
		for (const state of STATES) for (const attachment of PLAN_ATTACHMENTS) expect(() => checkSetting({ stage: STAGE, state, plan: attachment })).not.toThrow();
		for (const [setting, message] of [
			[{ ...good, state: "On" }, 'state is "On", which is none of "off", "dark", "closed", "on"'],
			[{ ...good, state: "public" }, 'state is "public"'],
			[{ stage: STAGE, plan: "code" }, "state is undefined"],
			[{ ...good, state: null }, "state is null"],
			[{ ...good, plan: "Code" }, 'plan attachment is "Code", which is none of "code", "console"'],
			[{ stage: STAGE, state: "off" }, "plan attachment is undefined"],
			[{ state: "off", plan: "code" }, "names no stage"],
			[null, "is not an object"],
			["off", "is not an object"],
		] as const) {
			expect(() => checkSetting(setting)).toThrow(message);
			expect(() => publicApiPlan(setting, STAGE)).toThrow(message);
		}
	});

	test("rehearsed in child processes for every state and plan attachment, the switch fails the release gate exactly when it is not the released state, and nothing else", async () => {
		if (REHEARSAL) return;
		const files = ["tests/public-blobs.test.ts", "tests/public-blobs-guard.test.ts", "tests/plan-watch.test.ts", "tests/public-api-graph.test.ts"];
		const reports = mkdtempSync(join(tmpdir(), "rehearse-switch-"));
		for (const state of STATES) {
			for (const attachment of PLAN_ATTACHMENTS) {
				const report = join(reports, `${state}-${attachment}.xml`);
				const child = Bun.spawn(["bun", "test", "--preload", "./tests/rehearse-switch.ts", "--reporter=junit", `--reporter-outfile=${report}`, ...files], {
					cwd: ROOT,
					env: { ...process.env, LM_PUBLIC_API_STATE: state, LM_PUBLIC_API_PLAN: attachment },
					stdout: "pipe",
					stderr: "pipe",
				});
				const [, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
				const xml = readFileSync(report, "utf8");
				const expected = state === RELEASED_STATE ? [] : [GATE];
				expect({ state, attachment, failed: failedTests(xml) }).toEqual({ state, attachment, failed: expected });
				// Every file ran: its tests are in the report.
				for (const file of files) expect(readJunit(xml).some((entry) => entry.file === file)).toBe(true);
				expect({ state, attachment, exitCode }).toEqual({ state, attachment, exitCode: expected.length === 0 ? 0 : 1 });
			}
		}
	});

	test("refuses a setting naming any stage but production-runs, in every state, off included", () => {
		for (const stage of ["smr-runs", "production", "production-runs2", "dev-runs", "Production-runs", "", "production-run", " production-runs"]) {
			for (const state of STATES) {
				const setting = { stage, state, plan: "code" as const };
				expect(() => checkSetting(setting)).toThrow(`The public data API may be served from ${PRODUCTION_STAGE} alone`);
				for (const deployed of [stage, STAGE, "smr-runs"]) expect(() => publicApiPlan(setting, deployed)).toThrow("may be served from production-runs alone");
			}
		}
		// And every deploy checks it before anything else, on every stage.
		expect(PREPARE.indexOf("checkSetting(setting);")).toBeGreaterThan(0);
		expect(PREPARE.indexOf("checkSetting(setting);")).toBeLessThan(PREPARE.indexOf("if ($app.stage !== setting.stage) return null;"));
	});

	test("makes nothing on any other stage, whatever the state says", () => {
		for (const state of ["dark", "closed", "on"] as const) {
			for (const stage of ["smr-runs", "production", "production-runs2", "dev-runs"]) {
				expect(publicApiPlan({ stage: STAGE, state, plan: "code" }, stage)).toBeNull();
			}
		}
	});

	test("off: the stack declares no distribution, certificate, DNS record, web ACL or function, and no bucket grants anything to CloudFront", () => {
		for (const attachment of PLAN_ATTACHMENTS) {
			const off = publicApiPlan({ stage: STAGE, state: "off", plan: attachment }, STAGE);
			expect(off).toBeNull();
			expect(declaredResources(off)).toEqual([]);
		}
		// The buckets' arguments carry no transform of their policies: SST's own, HTTPS only, granting nothing.
		expect(runsBucketArgs(null)).toStrictEqual({ versioning: true });
		expect(apiBucketArgs(null)).toStrictEqual({ cors: false });
		// stack.ts passes the transforms only from a non-null preparePublicApi, makes the resources only then, and outputs nothing of them otherwise.
		expect(STACK).toContain('const bucket = new sst.aws.Bucket("RunsBucket", runsBucketArgs(publicApi?.runsBucketPolicy ?? null));');
		expect(STACK).toContain('const apiBucket = new sst.aws.Bucket("ApiBucket", apiBucketArgs(publicApi?.apiBucketPolicy ?? null));');
		expect(STACK).toContain("const publicApiOutputs = publicApi === null ? null : publicApi.create(bucket, apiBucket).outputs;");
		expect(STACK).toContain("...(publicApiOutputs === null ? {} : { publicApi: publicApiOutputs }),");
		// preparePublicApi returns null for off before it could make anything; it declares nothing itself.
		expect(PREPARE).toContain("const plan = publicApiPlan(setting, $app.stage);\n\tif (plan === null) return null;");
		expect(PREPARE).not.toMatch(/new (aws|sst)\./);
		// Nothing of it is declared anywhere else in the stack: stack.ts makes no CloudFront, ACM, Route 53 or WAF resource of its own.
		expect(STACK).not.toMatch(/new aws\.(cloudfront|acm|route53|wafv2)\./);
		expect(STACK).not.toContain("cloudfront.amazonaws.com");
	});

	test("dark is disabled; closed is enabled but serves nothing; on serves; enabled means protected", () => {
		const common = { stage: STAGE, plan: "code" as const, subscribeInCode: true };
		expect(plan("dark")).toEqual({ ...common, state: "dark", distributionEnabled: false, serve: false, protect: false, comment: distributionComment(STAGE, "dark", "code") });
		expect(plan("closed")).toEqual({ ...common, state: "closed", distributionEnabled: true, serve: false, protect: true, comment: distributionComment(STAGE, "closed", "code") });
		expect(plan("on")).toEqual({ ...common, state: "on", distributionEnabled: true, serve: true, protect: true, comment: distributionComment(STAGE, "on", "code") });
		expect(plan("dark", "console").subscribeInCode).toBe(false);
	});

	test("on: the stack declares exactly the distribution, its certificate and validation record, the api.ledgermath.com records, the web ACL, the access control, three functions, the plan and the watch (tests/public-api-graph.test.ts builds them)", () => {
		expect(declaredResources(plan("on"))).toEqual([
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
			"PublicApiFreePlan",
			"PublicApiWatch",
		]);
		expect(declaredResources(plan("dark"))).toEqual(declaredResources(plan("on")));
		expect(declaredResources(plan("on", "console"))).not.toContain("PublicApiFreePlan");
		expect(DISTRIBUTION_NAME).toBe("PublicApiDistribution");
		// Pulumi refuses to delete or replace the distribution and the subscription while enabled: a resource option, which the mocks do not see.
		expect(CREATE.match(/\{ protect: plan\.protect \}/g)?.length).toBe(2);
	});

	test("on another stage, preparePublicApi returns before it asks AWS anything; with off, after the check and before making anything", () => {
		const otherStage = PREPARE.indexOf("if ($app.stage !== setting.stage) return null;");
		expect(otherStage).toBeGreaterThan(0);
		expect(otherStage).toBeLessThan(PREPARE.indexOf("readDeployed("));
		expect(PREPARE.indexOf("readDeployed(")).toBeLessThan(PREPARE.indexOf("judgeTransition("));
		expect(PREPARE.indexOf("judgeTransition(")).toBeLessThan(PREPARE.indexOf("if (plan === null) return null;"));
		expect(RESOURCES).toContain('const LOOKING_ONLY = new Set(["diff", "refresh"]);');
		expect(RESOURCES).toContain("if (!LOOKING_ONLY.has(command)) throw new Error(message);");
		expect(PREPARE).toContain("refuse(`The public data API on ${setting.stage}: not allowed: ${judgement.reason}`, command);");
		expect(RESOURCES).not.toContain('"remove"');
	});

	test("refuses anything but off on a stage SST does not protect, or under sst dev, before it asks AWS anything", () => {
		const check = PREPARE.indexOf("const refusals = stageRefusals(setting.state, { protect: $app.protect === true, dev: $dev === true });");
		expect(check).toBeGreaterThan(PREPARE.indexOf("if ($app.stage !== setting.stage) return null;"));
		expect(PREPARE).toContain("if (refusals.length > 0) refuse(`The public data API on ${setting.stage}: not allowed: ${refusals.join(\"; \")}.`, command);");
		for (const later of ["stageProfile()", "awsCli(", "readManaged(", "readDeployed("]) expect(check).toBeLessThan(PREPARE.indexOf(later));
	});

	test("the stage it is for is the one stages.ts protects, and no other -runs stage is", () => {
		expect(runsStageApp(PUBLIC_API.stage).protect).toBe(true);
		expect(runsStageApp("smr-runs").protect).toBe(false);
	});

	test("the web ACL, the certificate, its validation and the plan subscription live in us-east-1, by the resources' region argument", () => {
		expect(GLOBAL_REGION).toBe("us-east-1");
		expect(CERTIFICATE_ARGS.region).toBe(GLOBAL_REGION);
		expect(CREATE).toMatch(/new aws\.wafv2\.WebAcl\("PublicApiWebAcl", \{\n\t\tregion: GLOBAL_REGION,/);
		expect(CREATE).toContain('new aws.acm.Certificate("PublicApiCertificate", { ...CERTIFICATE_ARGS });');
		expect(CREATE).toMatch(/new aws\.acm\.CertificateValidation\("PublicApiCertificateValidation", \{\n\t\tregion: GLOBAL_REGION,/);
		expect(CREATE).toMatch(/new aws\.cloudcontrol\.Resource\(\n\t\t\t\t"PublicApiFreePlan",\n\t\t\t\t\{\n\t\t\t\t\tregion: GLOBAL_REGION,/);
		expect(CREATE).toContain('scope: "CLOUDFRONT",');
	});

	test("nothing the deploy runs or prints assumes a profile: the stage's own is used", () => {
		for (const file of ["public-blobs.ts", "public-blobs-stack.ts", "public-blobs-guard.ts", "plan-watch.ts", "plan-watch-handler.ts", "api-bucket.ts"]) {
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

/** CloudFront's path patterns: * any run of characters (slashes included), ? one; case-sensitive; with or without the leading slash. */
function patternMatches(pattern: string, path: string): boolean {
	const regex = new RegExp(`^/?${pattern.replace(/^\//, "").split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("")}$`);
	return regex.test(path);
}

type Behaviour = DistributionSpec<string>["defaultCacheBehavior"];

/** The behaviour CloudFront picks for a path: the first ordered behaviour whose pattern matches, else the default. */
function behaviourFor(spec: DistributionSpec<string>, path: string): Behaviour {
	return spec.orderedCacheBehaviors.find((behaviour) => patternMatches(behaviour.pathPattern, path)) ?? spec.defaultCacheBehavior;
}

/** RFC 3986's removal of dot segments, as CloudFront may apply it before it picks a behaviour. */
function normalized(path: string): string {
	const out: string[] = [];
	for (const segment of path.split("/").slice(1)) {
		if (segment === "..") out.pop();
		else if (segment !== ".") out.push(segment);
	}
	return `/${out.join("/")}`;
}

const ORIGIN_OF_ID = Object.fromEntries(Object.entries(ORIGIN_IDS).map(([origin, id]) => [id, origin])) as Record<string, Origin>;
const BUCKET_ARNS: Record<Origin, string> = { api: API_BUCKET_ARN, runs: RUNS_BUCKET_ARN };

/** The two buckets' policies for a plan: SST's, with the grant in "on" only, as preparePublicApi's transforms make them. */
function policies(p: PublicApiPlan): Record<Origin, string> {
	const policy = (origin: Origin): string => (p.serve ? withGrant(sstPolicy(BUCKET_ARNS[origin]), BUCKET_ARNS[origin], DISTRIBUTION_ARN, origin) : sstPolicy(BUCKET_ARNS[origin]));
	return { api: policy("api"), runs: policy("runs") };
}

/** Whether a bucket policy lets the CloudFront service, for `distributionArn`, GetObject the object at `key`. */
function grants(policyJson: string, bucketArn: string, key: string, distributionArn: string): boolean {
	const document = JSON.parse(policyJson) as { Statement: Array<{ Effect: string; Principal?: unknown; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, string>> }> };
	return document.Statement.some((statement) => {
		if (statement.Effect !== "Allow") return false;
		if (JSON.stringify(statement.Principal) !== JSON.stringify({ Service: "cloudfront.amazonaws.com" })) return false;
		const actions = ([] as string[]).concat(statement.Action);
		if (!actions.some((action) => covers(action, "s3:GetObject"))) return false;
		if (statement.Condition?.StringEquals?.["AWS:SourceArn"] !== distributionArn) return false;
		return ([] as string[]).concat(statement.Resource).some((resource) => covers(resource, `${bucketArn}/${key}`));
	});
}

/** The functions by the ARN the distribution names them by, loaded as CloudFront Functions loads them. */
const FUNCTIONS: Record<string, Handler> = {
	[REFS.requestFunctionArn]: load(REQUEST_FUNCTION_CODE),
	[REFS.noRouteFunctionArn]: load(NO_ROUTE_FUNCTION_CODE),
	[REFS.evidenceResponseFunctionArn]: load(EVIDENCE_RESPONSE_FUNCTION_CODE),
};

/** The behaviour's viewer-request function run on the request: the request to go on with, or the response it answers. */
function viewerRequest(behaviour: Behaviour, path: string, host: string | null): CfRequest | CfResponse {
	const association = behaviour.functionAssociations.find((entry) => entry.eventType === "viewer-request");
	const sent = request(path, host);
	if (association === undefined) return sent;
	const handler = FUNCTIONS[association.functionArn];
	if (handler === undefined) throw new Error(`no function ${association.functionArn}`);
	return handler({ context: { eventType: "viewer-request" }, request: sent });
}

const isResponse = (value: CfRequest | CfResponse): value is CfResponse => "statusCode" in value;

/**
 * What a GET of `path` reads, by the distribution of a plan, or nothing: a
 * function answers it (its viewer-request function, run as CloudFront runs
 * it), or the bucket's policy refuses. The key is the path without its
 * leading slash, %-decoded as S3 decodes it; CloudFront picks the behaviour
 * from the path as sent, or, should it normalise dot segments first, from
 * that.
 */
function reads(p: PublicApiPlan, path: string, host: string | null = API_DOMAIN.name): Array<{ origin: Origin; key: string }> {
	const spec = distributionArgs(REFS, p);
	const bucketPolicies = policies(p);
	const found: Array<{ origin: Origin; key: string }> = [];
	for (const sent of new Set([path, normalized(path)])) {
		const behaviour = behaviourFor(spec, sent);
		if (isResponse(viewerRequest(behaviour, sent, host))) continue;
		const origin = ORIGIN_OF_ID[behaviour.targetOriginId] as Origin;
		let key: string;
		try {
			key = decodeURIComponent(sent.slice(1));
		} catch {
			continue;
		}
		if (grants(bucketPolicies[origin], BUCKET_ARNS[origin], key, DISTRIBUTION_ARN)) found.push({ origin, key });
	}
	return found;
}

/**
 * Every key each bucket holds or may hold: of every kind the stack, the boxes
 * and the workflow write, and, under the served prefixes too, keys of no
 * served shape that a person, a stray tool or a bug could leave there.
 */
const INVENTORY: Record<Origin, string[]> = {
	runs: [
		"runs/2026/11/19/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json",
		"boots/2026/11/19/0bd3dc59-287c-4e18-b5b3-7dd30d38d0b0.json",
		`blobs/sha256/${HEX}`,
		"logs/2026/11/19/0bd3dc59-287c-4e18-b5b3-7dd30d38d0b0.log",
		"source/537d4f1bd2fa883c897456d16a9b7c9a49548b05.tar.gz",
		"blobs/other",
		"blobs/sha512/abc",
		"results/c6i.8xlarge/2026-07-18T2310Z.json",
		"index.html",
		"v1/index.json",
		// Under served prefixes, of no served shape.
		"runs/2026/11/19/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json.bak",
		"runs/2026/11/19/01A1F200-3DD5-7AC0-8994-A5F0BA761290.json",
		"runs/2026/11/19/01a1f200-3dd5-4ac0-8994-a5f0ba761290.json",
		"runs/2026/11/19/notes.txt",
		"runs/2026/11/19/x.json",
		"runs/x.json",
		"runs/2026/11/19/sub/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json",
		"boots/2026/11/19/unknown.json",
		"boots/2026/11/19/0bd3dc59-287c-4e18-b5b3-7dd30d38d0b0.log",
		"boots/2026/11/19/0bd3dc59-287c-4e18-b5b3-7dd30d38d0b0.json.tmp",
		`blobs/sha256/${HEX}.tmp`,
		`blobs/sha256/${HEX.toUpperCase()}`,
		`blobs/sha256/${HEX.slice(1)}`,
		`blobs/sha256/${HEX}0`,
		`blobs/sha256/${HEX}/x`,
		// Dates that are no day of the calendar.
		"runs/2026/02/30/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json",
		"runs/2026/13/01/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json",
		"runs/2026/02/29/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json",
		"boots/2026/00/10/0bd3dc59-287c-4e18-b5b3-7dd30d38d0b0.json",
		"boots/2026/04/31/0bd3dc59-287c-4e18-b5b3-7dd30d38d0b0.json",
		// A leap year's 29th of February is a day.
		"runs/2024/02/29/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json",
	],
	api: [
		"v1/index.json",
		"v1/series.json",
		"v1/series/0cacb5fd6fae.json",
		"v1/series/0cacb5fd6fae/2026-11.json",
		"v1/prices/2026-11-19.json",
		"v1/schemas/index.schema.json",
		"v2/index.json",
		"index.html",
		"runs/2026/11/19/x.json",
		// Under v1/, of no served shape.
		"v1/index.json.bak",
		"v1/notes.md",
		"v1/series/0cacb5fd6fae.json~",
		"v1/series/0CACB5FD6FAE.json",
		"v1/series/0cacb5fd6fae/2026-11.json.orig",
		"v1/series/0cacb5fd6fae/extra/2026-11.json",
		"v1/prices/2026-11-19.json.tmp",
		"v1/schemas/index.schema.json.old",
		"v1/series/",
		// Names the build cannot write: a schema it does not publish, a month or day that is not one.
		"v1/schemas/unpublished.schema.json",
		"v1/prices/2026-99-99.json",
		"v1/prices/2026-02-29.json",
		"v1/prices/2026-11-31.json",
		"v1/series/0cacb5fd6fae/2026-13.json",
		"v1/series/0cacb5fd6fae/2026-00.json",
		// A leap year's 29th of February is a day.
		"v1/prices/2028-02-29.json",
	],
};

/** Whether a key is of a served shape and in the bucket that serves it. */
const isServed = (origin: Origin, key: string): boolean => servedPrefixes(origin).some((prefix) => key.startsWith(prefix)) && isServedKey(key);

/** Ways to ask for a key: as it is, and as an attacker might spell it. */
function spellings(key: string): string[] {
	const [first = "", ...rest] = key.split("/");
	return [
		`/${key}`,
		`//${key}`,
		`/./${key}`,
		`/x/../${key}`,
		`/runs/../${key}`,
		`/v1/../${key}`,
		`/blobs/sha256/../../${key}`,
		`/runs/%2e%2e/${key}`,
		`/${encodeURIComponent(key)}`,
		`/${first.toUpperCase()}/${rest.join("/")}`,
		`/${key}?versionId=abc`,
	];
}

describe("what is served, and what is not", () => {
	test("the tree from the API bucket; Run files, boot summaries and blobs from the Runs bucket; nothing else", () => {
		expect(SERVED.map((served) => [served.prefix, served.origin])).toEqual([
			["v1/", "api"],
			["runs/", "runs"],
			["boots/", "runs"],
			["blobs/sha256/", "runs"],
		]);
		expect(servedPrefixes("api")).toEqual(["v1/"]);
		expect(servedPrefixes("runs")).toEqual(["runs/", "boots/", "blobs/sha256/"]);
	});

	test("the README's list of what is served is the same list", () => {
		const rows = SECTION.split("\n").filter((line) => /^\| `\/[^`]*…` \|/.test(line));
		const listed = rows.map((row) => /^\| `\/([^`]*)…` \| the (API|Runs) bucket /.exec(row)?.slice(1, 3));
		expect(listed).toEqual(SERVED.map((served) => [served.prefix, served.origin === "api" ? "API" : "Runs"]));
	});

	test("every key of a served shape is readable at its own address, in on", () => {
		let served = 0;
		for (const origin of ["api", "runs"] as const) {
			for (const key of INVENTORY[origin].filter((k) => isServed(origin, k))) {
				expect(reads(plan("on"), `/${key}`)).toEqual([{ origin, key }]);
				served++;
			}
		}
		expect(served).toBe(11);
	});

	test("no key of no served shape is ever read, however it is spelt, served prefix or not; every read is of a served shape, from the bucket that serves it", () => {
		for (const origin of ["api", "runs"] as const) {
			for (const key of INVENTORY[origin]) {
				for (const path of spellings(key)) {
					for (const state of ["dark", "closed", "on"] as const) {
						for (const read of reads(plan(state), path.split("?")[0] as string)) {
							expect(isServed(read.origin, read.key)).toBe(true);
							expect(read.key).toBe(key);
						}
					}
				}
			}
		}
		// In particular, nothing of the Runs bucket's source/ and logs/, nothing at the root, and nothing under a served prefix of no served shape.
		for (const path of ["/", "/source/x.tar.gz", "/logs/2026/11/19/b.log", "/index.html", "/results/x.json", "/v2/index.json", "/runs", "/blobs/other", "/runs/2026/11/19/notes.txt", "/v1/notes.md", "/boots/2026/11/19/unknown.json"]) {
			expect(reads(plan("on"), path)).toEqual([]);
		}
	});

	test("under any other host than api.ledgermath.com, the distribution's own *.cloudfront.net name included, nothing is read", () => {
		for (const host of ["d111111abcdef8.cloudfront.net", "API.LEDGERMATH.COM.", "ledgermath.com", "api.ledgermath.com.evil.example", "", null]) {
			for (const origin of ["api", "runs"] as const) for (const key of INVENTORY[origin]) expect(reads(plan("on"), `/${key}`, host)).toEqual([]);
		}
		// The name is matched without regard to case, as DNS names are.
		expect(reads(plan("on"), "/v1/index.json", "API.LedgerMath.com")).toEqual([{ origin: "api", key: "v1/index.json" }]);
	});

	test("in dark and closed, nothing is read at all", () => {
		for (const state of ["dark", "closed"] as const) {
			for (const origin of ["api", "runs"] as const) {
				for (const key of INVENTORY[origin]) for (const path of spellings(key)) expect(reads(plan(state), path.split("?")[0] as string)).toEqual([]);
			}
		}
	});

	test("query strings never reach a bucket: the managed cache policies forward none, so no older version can be asked for", () => {
		for (const behaviour of [distributionArgs(REFS, plan("on")).defaultCacheBehavior, ...distributionArgs(REFS, plan("on")).orderedCacheBehaviors]) {
			expect([CACHING_OPTIMIZED.id, CACHING_UNCOMPRESSED.id]).toContain(behaviour.cachePolicyId);
		}
		expect(JSON.stringify(distributionArgs(REFS, plan("on")))).not.toContain("originRequestPolicyId");
	});
});

describe("the edge in on, in front of a stand-in for S3 that holds every key of the inventory", () => {
	let standin: S3Standin;
	const READER = "CLOUDFRONTOAC";
	beforeEach(() => {
		standin = new S3Standin();
		standin.start();
		for (const origin of ["api", "runs"] as const) {
			standin.bucket(origin, { readers: [READER] });
			for (const key of INVENTORY[origin]) standin.put(origin, key, `the bytes of ${origin}:${key}`, "application/json");
		}
	});
	afterEach(() => standin.stop());

	/** A GET through the distribution, as the model above routes it: a function's answer, the policy's refusal, or the bucket's object. */
	async function edge(path: string, host: string | null = API_DOMAIN.name): Promise<{ status: number; body: string; from: "function" | "policy" | "bucket" }> {
		const p = plan("on");
		const behaviour = behaviourFor(distributionArgs(REFS, p), path);
		const answered = viewerRequest(behaviour, path, host);
		if (isResponse(answered)) return { status: answered.statusCode, body: answered.body?.data ?? "", from: "function" };
		const origin = ORIGIN_OF_ID[behaviour.targetOriginId] as Origin;
		const key = decodeURIComponent(path.slice(1));
		if (!grants(policies(p)[origin], BUCKET_ARNS[origin], key, DISTRIBUTION_ARN)) return { status: 403, body: "AccessDenied", from: "policy" };
		const response = await fetch(`${standin.url}/${origin}/${key.split("/").map(encodeURIComponent).join("/")}`, {
			headers: { authorization: `AWS4-HMAC-SHA256 Credential=${READER}/20261121/us-east-2/s3/aws4_request, SignedHeaders=host, Signature=${"0".repeat(64)}` },
		});
		return { status: response.status, body: await response.text(), from: "bucket" };
	}

	const asked = (origin: string, key: string): boolean => standin.requests.some((entry) => entry.method === "GET" && entry.bucket === origin && entry.key === key);

	test("serves each object of a served shape from its bucket, with its bytes", async () => {
		for (const origin of ["api", "runs"] as const) {
			for (const key of INVENTORY[origin].filter((k) => isServed(origin, k))) {
				expect(await edge(`/${key}`)).toEqual({ status: 200, body: `the bytes of ${origin}:${key}`, from: "bucket" });
			}
		}
	});

	test("answers 404 itself to every object under a served prefix that is of no served shape, though the bucket holds it, and never asks the bucket for it", async () => {
		let refused = 0;
		for (const origin of ["api", "runs"] as const) {
			for (const key of INVENTORY[origin].filter((k) => servedPrefixes(origin).some((prefix) => k.startsWith(prefix)) && !isServedKey(k))) {
				const got = await edge(`/${key}`);
				expect({ key, status: got.status, from: got.from }).toEqual({ key, status: 404, from: "function" });
				expect(got.body).toContain("Not found.");
				expect(asked(origin, key)).toBe(false);
				refused++;
			}
		}
		expect(refused).toBe(35);
	});

	test("refuses another host with the same 403 before the bucket is asked, whatever the address, from the served behaviours and the default alike", async () => {
		const answers = new Set<string>();
		for (const host of ["d111111abcdef8.cloudfront.net", "API.LEDGERMATH.COM.", null]) {
			for (const key of ["v1/index.json", "runs/2026/11/19/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json", `blobs/sha256/${HEX}`, "", "source/x.tar.gz", "v1/notes.md", "nothing/here"]) {
				const got = await edge(`/${key}`, host);
				expect({ key, status: got.status, from: got.from }).toEqual({ key, status: 403, from: "function" });
				answers.add(got.body);
			}
		}
		expect([...answers]).toEqual(["Forbidden. LedgerMath's data API is served at https://api.ledgermath.com/ and under no other name.\n"]);
		expect(standin.requests).toEqual([]);
	});
});

describe("a wrong host, in every state", () => {
	test("gets 403 from every behaviour's function in dark and closed too, and 404 only under api.ledgermath.com", () => {
		for (const state of ["dark", "closed", "on"] as const) {
			const spec = distributionArgs(REFS, plan(state));
			for (const path of ["/", "/v1/index.json", "/runs/2026/11/19/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json", "/source/x"]) {
				const wrong = viewerRequest(behaviourFor(spec, path), path, "d111111abcdef8.cloudfront.net");
				expect({ state, path, status: isResponse(wrong) ? wrong.statusCode : "forwarded" }).toEqual({ state, path, status: 403 });
			}
			const root = viewerRequest(behaviourFor(spec, "/"), "/", API_DOMAIN.name);
			expect(isResponse(root) ? root.statusCode : "forwarded").toBe(404);
		}
	});
});

describe("the bucket grants", () => {
	test("let this distribution, through the CloudFront service, GetObject under each bucket's served prefixes and nothing more", () => {
		expect(bucketGrant(RUNS_BUCKET_ARN, DISTRIBUTION_ARN, "runs")).toEqual({
			Sid: GRANT_SID,
			Effect: "Allow",
			Principal: { Service: "cloudfront.amazonaws.com" },
			Action: ["s3:GetObject"],
			Resource: [`${RUNS_BUCKET_ARN}/runs/*`, `${RUNS_BUCKET_ARN}/boots/*`, `${RUNS_BUCKET_ARN}/blobs/sha256/*`],
			Condition: { StringEquals: { "AWS:SourceArn": DISTRIBUTION_ARN } },
		});
		expect(bucketGrant(API_BUCKET_ARN, DISTRIBUTION_ARN, "api")).toEqual({
			Sid: GRANT_SID,
			Effect: "Allow",
			Principal: { Service: "cloudfront.amazonaws.com" },
			Action: ["s3:GetObject"],
			Resource: [`${API_BUCKET_ARN}/v1/*`],
			Condition: { StringEquals: { "AWS:SourceArn": DISTRIBUTION_ARN } },
		});
	});

	test("are made only in on: dark and closed leave both policies alone", () => {
		expect(plan("on").serve).toBe(true);
		expect(plan("dark").serve).toBe(false);
		expect(plan("closed").serve).toBe(false);
		expect(PREPARE).toContain("if (!plan.serve) return { runsBucketPolicy: null, apiBucketPolicy: null, create: (runsBucket, apiBucket) => createResources(plan, names, runsBucket, apiBucket, null) };");
		expect(PREPARE.indexOf("if (!plan.serve)")).toBeLessThan(PREPARE.indexOf("withGrant("));
		expect(PREPARE).toContain('runsBucketPolicy: grant("runs"),');
		expect(PREPARE).toContain('apiBucketPolicy: grant("api"),');
	});

	test("are for this distribution only, and never the bucket itself (no listing), nor an older version", () => {
		for (const origin of ["api", "runs"] as const) {
			const policy = withGrant(sstPolicy(BUCKET_ARNS[origin]), BUCKET_ARNS[origin], DISTRIBUTION_ARN, origin);
			// The grant stops at the prefix; the request function narrows it to the served shapes.
			for (const key of INVENTORY[origin]) expect(grants(policy, BUCKET_ARNS[origin], key, DISTRIBUTION_ARN)).toBe(servedPrefixes(origin).some((prefix) => key.startsWith(prefix)));
			for (const key of INVENTORY[origin]) expect(grants(policy, BUCKET_ARNS[origin], key, OTHER_DISTRIBUTION_ARN)).toBe(false);
			const text = JSON.stringify(bucketGrant(BUCKET_ARNS[origin], DISTRIBUTION_ARN, origin));
			for (const action of ["s3:ListBucket", "s3:GetObjectVersion", "s3:*", "s3:PutObject"]) expect(text).not.toContain(action);
			for (const resource of bucketGrant(BUCKET_ARNS[origin], DISTRIBUTION_ARN, origin).Resource ?? []) expect(covers(resource, BUCKET_ARNS[origin])).toBe(false);
		}
	});

	test("are added to SST's policy, which keeps its own statement, once however often applied, and are its only Allow", () => {
		for (const origin of ["api", "runs"] as const) {
			const arn = BUCKET_ARNS[origin];
			const once = withGrant(sstPolicy(arn), arn, DISTRIBUTION_ARN, origin);
			expect(withGrant(once, arn, DISTRIBUTION_ARN, origin)).toBe(once);
			const document = JSON.parse(once) as { Version: string; Statement: Array<{ Effect: string }> };
			expect(document.Version).toBe("2012-10-17");
			const sst = JSON.parse(sstPolicy(arn)) as { Statement: Array<{ Effect: string }> };
			expect(document.Statement).toEqual([sst.Statement[0] as { Effect: string }, bucketGrant(arn, DISTRIBUTION_ARN, origin)]);
			expect(document.Statement.filter((statement) => statement.Effect === "Allow")).toEqual([bucketGrant(arn, DISTRIBUTION_ARN, origin)]);
		}
	});

	test("refuse anything that is not a policy document", () => {
		expect(() => withGrant("{}", RUNS_BUCKET_ARN, DISTRIBUTION_ARN, "runs")).toThrow("not a policy document");
		expect(() => withGrant('{"Version":"2012-10-17","Statement":{}}', API_BUCKET_ARN, DISTRIBUTION_ARN, "api")).toThrow("not a policy document");
	});
});

describe("the distribution", () => {
	const spec = distributionArgs(REFS, plan("on"));
	const behaviours = [spec.defaultCacheBehavior, ...spec.orderedCacheBehaviors];
	const byPattern = (pattern: string) => spec.orderedCacheBehaviors.find((behaviour) => behaviour.pathPattern === pattern);

	test("is enabled in closed and on, disabled in dark, and its comment records the state and plan", () => {
		expect(spec.enabled).toBe(true);
		expect(distributionArgs(REFS, plan("closed")).enabled).toBe(true);
		expect(distributionArgs(REFS, plan("dark")).enabled).toBe(false);
		expect(spec.comment).toBe("LedgerMath production-runs public API (api.ledgermath.com): state=on plan=code");
		for (const state of ["dark", "closed", "on"] as const) {
			for (const p of ["code", "console"] as const) expect(distributionComment("production-runs", state, p).length).toBeLessThanOrEqual(128);
		}
	});

	test("has two origins, the API bucket and the Runs bucket, both read through the one Origin Access Control", () => {
		expect(spec.origins).toEqual([
			{ originId: "api-bucket", domainName: REFS.apiBucketDomain, originAccessControlId: REFS.originAccessControlId },
			{ originId: "runs-bucket", domainName: REFS.runsBucketDomain, originAccessControlId: REFS.originAccessControlId },
		]);
		expect(CREATE).toContain('originAccessControlOriginType: "s3",');
		expect(CREATE).toContain('signingBehavior: "always",');
		expect(CREATE).toContain('signingProtocol: "sigv4",');
	});

	test("in on: one behaviour per served prefix, to its bucket, behind the request function; the evidence also with the headers function; the default answers every request itself; the Free plan's five", () => {
		expect(spec.orderedCacheBehaviors.map((behaviour) => [behaviour.pathPattern, behaviour.targetOriginId])).toEqual([
			["v1/*", "api-bucket"],
			["runs/*", "runs-bucket"],
			["boots/*", "runs-bucket"],
			["blobs/sha256/*", "runs-bucket"],
		]);
		const requestFunction = { eventType: "viewer-request" as const, functionArn: REFS.requestFunctionArn };
		expect(byPattern("v1/*")?.functionAssociations).toEqual([requestFunction]);
		for (const pattern of ["runs/*", "boots/*", "blobs/sha256/*"]) {
			expect(byPattern(pattern)?.functionAssociations).toEqual([requestFunction, { eventType: "viewer-response" as const, functionArn: REFS.evidenceResponseFunctionArn }]);
		}
		expect(spec.defaultCacheBehavior.functionAssociations).toEqual([{ eventType: "viewer-request", functionArn: REFS.noRouteFunctionArn }]);
		expect(behaviours.length).toBe(FREE_PLAN.cacheBehaviours);
	});

	test("in dark and closed, answers 404 to every address from every behaviour", () => {
		for (const state of ["dark", "closed"] as const) {
			const closed = distributionArgs(REFS, plan(state));
			const requestFunctions = [closed.defaultCacheBehavior, ...closed.orderedCacheBehaviors].map(
				(behaviour) => behaviour.functionAssociations.find((association) => association.eventType === "viewer-request")?.functionArn,
			);
			expect(requestFunctions).toEqual(Array(5).fill(REFS.noRouteFunctionArn));
		}
	});

	test("allows GET and HEAD over HTTPS only, with AWS managed policies: JSON compressed for a reader that asks, blobs as stored", () => {
		for (const behaviour of behaviours) {
			expect(behaviour.allowedMethods).toEqual(["GET", "HEAD"]);
			expect(behaviour.cachedMethods).toEqual(["GET", "HEAD"]);
			expect(behaviour.viewerProtocolPolicy).toBe("https-only");
			expect(behaviour.responseHeadersPolicyId).toBe(RESPONSE_HEADERS_POLICY.id);
		}
		for (const pattern of ["v1/*", "runs/*", "boots/*"]) expect(byPattern(pattern)).toMatchObject({ cachePolicyId: CACHING_OPTIMIZED.id, compress: true });
		expect(byPattern("blobs/sha256/*")).toMatchObject({ cachePolicyId: CACHING_UNCOMPRESSED.id, compress: false });
		expect(spec.defaultCacheBehavior).toMatchObject({ cachePolicyId: CACHING_UNCOMPRESSED.id, compress: false });
		expect(CACHING_OPTIMIZED.id).toBe("658327ea-f89d-4fab-a63d-7e88639e58f6");
		expect(CACHING_UNCOMPRESSED.id).toBe("b2884449-e4de-46a7-ac36-70bc7f1ddd6d");
		expect(RESPONSE_HEADERS_POLICY).toEqual({ name: "CORS-and-SecurityHeadersPolicy", id: "e61eb60c-9c35-4d20-a928-2b84e02af89c" });
	});

	test("speaks HTTP/2 and HTTP/3 and IPv6, from every edge location, behind the web ACL, under api.ledgermath.com alone with its certificate", () => {
		expect(spec.httpVersion).toBe("http2and3");
		expect(spec.isIpv6Enabled).toBe(true);
		expect(spec.priceClass).toBe("PriceClass_All");
		expect(spec.webAclId).toBe(WEB_ACL_ARN);
		expect(spec.aliases).toEqual(["api.ledgermath.com"]);
		expect(spec.viewerCertificate).toEqual({ acmCertificateArn: REFS.certificateArn, sslSupportMethod: "sni-only", minimumProtocolVersion: TLS_POLICY });
		expect(TLS_POLICY).toBe("TLSv1.2_2025");
		expect(spec.restrictions).toEqual({ geoRestriction: { restrictionType: "none" } });
	});

	test("uses none of the features a flat-rate plan refuses, no custom policy, and no access logs (Free has none)", () => {
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
		expect(RESOURCES).not.toMatch(/new aws\.cloudfront\.(CachePolicy|ResponseHeadersPolicy|OriginRequestPolicy|KeyValueStore)\(/);
	});

	test("has names that fit AWS's limits", () => {
		expect(NAMES.evidenceResponseFunction).toMatch(/^[a-zA-Z0-9-_]{1,64}$/);
		expect(NAMES.noRouteFunction).toMatch(/^[a-zA-Z0-9-_]{1,64}$/);
		expect(NAMES.webAcl).toMatch(/^[\w-]{1,128}$/);
		expect(NAMES.originAccessControl.length).toBeLessThanOrEqual(64);
	});
});

describe("the domain", () => {
	test("is api.ledgermath.com, in the hosted zone it is delegated to", () => {
		expect(API_DOMAIN).toEqual({ name: "api.ledgermath.com", hostedZoneId: "Z03039811C7UWLHZE7CZQ" });
	});

	test("has a certificate for that name alone, validated by DNS, in us-east-1", () => {
		expect(CERTIFICATE_ARGS).toEqual({ region: "us-east-1", domainName: "api.ledgermath.com", validationMethod: "DNS", keyAlgorithm: "RSA_2048" });
		// The validation record is ACM's, in the zone; the validation waits for it; the distribution takes the validated certificate.
		expect(CREATE).toContain("const option = options.find((entry) => entry.domainName === API_DOMAIN.name);");
		expect(CREATE).toMatch(/new aws\.route53\.Record\("PublicApiCertificateRecord", \{\n\t\tzoneId: API_DOMAIN\.hostedZoneId,\n\t\tname: validation\.resourceRecordName,\n\t\ttype: validation\.resourceRecordType,\n\t\trecords: \[validation\.resourceRecordValue\],/);
		expect(CREATE).toContain("validationRecordFqdns: [certificateRecord.fqdn],");
		expect(CREATE).toContain("certificateArn: certificateValidation.certificateArn,");
		expect(CREATE).not.toContain("allowOverwrite");
	});

	test("points at the distribution over IPv4 and IPv6, by alias records in that zone", () => {
		expect(ALIAS_RECORD_TYPES).toEqual(["A", "AAAA"]);
		for (const type of ALIAS_RECORD_TYPES) {
			expect(aliasRecordArgs(type, "d111111abcdef8.cloudfront.net", "Z2FDTNDATAQYW2")).toEqual({
				zoneId: "Z03039811C7UWLHZE7CZQ",
				name: "api.ledgermath.com",
				type,
				aliases: [{ name: "d111111abcdef8.cloudfront.net", zoneId: "Z2FDTNDATAQYW2", evaluateTargetHealth: false }],
			});
			expect(CREATE).toContain(`new aws.route53.Record("PublicApiAlias${type}", aliasRecordArgs("${type}", distribution.domainName, distribution.hostedZoneId));`);
		}
	});
});

describe("the headers", () => {
	const evidenceResponse = load(EVIDENCE_RESPONSE_FUNCTION_CODE);
	const answer = (uri: string, statusCode: number, headers: CfHeaders): CfResponse =>
		evidenceResponse({ context: { eventType: "viewer-response" }, request: request(uri), response: { statusCode, headers: { ...headers } } }) as CfResponse;
	const SAMPLES: Record<string, string> = {
		"v1/": "/v1/series/0cacb5fd6fae/2026-11.json",
		"runs/": "/runs/2026/11/19/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json",
		"boots/": "/boots/2026/11/19/0bd3dc59-287c-4e18-b5b3-7dd30d38d0b0.json",
		"blobs/sha256/": `/blobs/sha256/${HEX}`,
	};

	test("the tree's come from its objects: application/json, kept five minutes by edges and readers, which the managed policy's TTLs allow", () => {
		for (const path of ["v1/index.json", "v1/series.json", "v1/series/0cacb5fd6fae.json", "v1/series/0cacb5fd6fae/2026-11.json", "v1/prices/2026-11-19.json", "v1/schemas/series.schema.json"]) {
			const headers = servedHeaders(`/${path}`);
			expect(headers).toMatchObject({ cacheControl: TREE_CACHE_CONTROL, cacheControlFrom: "the object", contentType: TREE_CONTENT_TYPE, contentTypeFrom: "the object", edgeSeconds: 300, compressed: true });
			expect(treeObject(path)).toMatchObject({ contentType: headers?.contentType, cacheControl: headers?.cacheControl });
		}
		expect(TREE_CACHE_CONTROL).toBe("public, max-age=300");
		// CachingOptimized keeps an object for its max-age when it lies between its minimum (1 s) and maximum (365 days).
		const maxAge = Number(/max-age=(\d+)/.exec(TREE_CACHE_CONTROL)?.[1]);
		expect(maxAge).toBeGreaterThan(1);
		expect(maxAge).toBeLessThan(31_536_000);
	});

	test("the evidence's come from the function: immutable, CORS, nosniff, the sandbox, and JSON's type, on success only, keeping the bucket's ETag", () => {
		for (const prefix of ["runs/", "boots/", "blobs/sha256/"]) {
			const uri = SAMPLES[prefix] as string;
			const expected = servedHeaders(uri);
			if (expected === null) throw new Error(`nothing served at ${uri}`);
			for (const statusCode of [200, 206, 304]) {
				const got = answer(uri, statusCode, { "content-type": { value: "binary/octet-stream" }, etag: { value: '"abc"' } });
				expect(got.headers["cache-control"]?.value).toBe(expected.cacheControl);
				expect(got.headers["access-control-allow-origin"]?.value).toBe(expected.accessControlAllowOrigin);
				expect(got.headers["x-content-type-options"]?.value).toBe("nosniff");
				expect(got.headers["content-security-policy"]?.value).toBe(expected.contentSecurityPolicy as string);
				expect(got.headers["content-type"]?.value).toBe(expected.contentType ?? "binary/octet-stream");
				expect(got.headers.etag?.value).toBe('"abc"');
			}
			expect(answer(uri, 403, {}).headers["cache-control"]).toBeUndefined();
			expect(answer(uri, 404, {}).headers["cache-control"]).toBeUndefined();
		}
		expect(EVIDENCE_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
		expect(EVIDENCE_CONTENT_SECURITY_POLICY).toBe("default-src 'none'; sandbox");
		expect(servedHeaders(SAMPLES["blobs/sha256/"] as string)).toMatchObject({ contentType: null, contentTypeFrom: "the bucket", compressed: false });
	});

	test("nothing is served outside the served shapes, under a served prefix or not", () => {
		for (const path of ["/", "/index.html", "/source/x.tar.gz", "/logs/x.log", "/v2/index.json", "/blobs/other", "/runs/2026/11/19/x.json", "/v1/notes.md", "/boots/2026/11/19/unknown.json"]) {
			expect(servedHeaders(path)).toBeNull();
		}
	});

	test("are, for each kind of path, what the README's table says", () => {
		const rows = SECTION.split("\n").filter((line) => /^\| `\/[^`]*…` \|/.test(line));
		expect(rows.length).toBe(SERVED.length);
		for (const served of SERVED) {
			const row = rows.find((line) => line.startsWith(`| \`/${served.prefix}…\` |`));
			if (row === undefined) throw new Error(`no row for ${served.prefix}`);
			const cells = row.split(" | ").map((cell) => cell.replace(/^\| |\s*\|$/g, "").trim());
			const headers = servedHeaders(SAMPLES[served.prefix] as string);
			if (headers === null) throw new Error("not served");
			// | Path | From | Cache-Control | Content-Type | Access-Control-Allow-Origin | Compressed |
			expect(cells[2]).toBe(`\`${headers.cacheControl}\`, ${headers.cacheControlFrom === "the object" ? "on the object" : "from the function"}`);
			expect(cells[3]).toBe(headers.contentType === null ? "as stored (`binary/octet-stream`)" : `\`${headers.contentType}\`, ${headers.contentTypeFrom === "the object" ? "on the object" : "from the function"}`);
			expect(cells[4]).toBe(`\`${headers.accessControlAllowOrigin}\``);
			expect(cells[5]).toBe(headers.compressed ? "yes, when asked" : "no");
		}
	});
});

/** Every file under a directory, by its path from it with forward slashes. */
function filesUnder(directory: string): string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

describe("the shapes of key served", () => {
	test("are, for v1/, the tree's kinds (TREE_KINDS); for the evidence, a Run file, a boot summary and a blob; each within its own prefix", () => {
		expect(SERVED.flatMap((served) => served.keys.map((shape) => [served.prefix, shape.kind]))).toEqual([
			...TREE_KINDS.map((kind) => ["v1/", kind.kind]),
			["runs/", "a Run file"],
			["boots/", "a boot summary"],
			["blobs/sha256/", "a blob"],
		]);
		for (const served of SERVED) {
			for (const shape of served.keys) {
				expect(shape.key.source.startsWith(`^${served.prefix.replace(/\//g, "\\/")}`)).toBe(true);
				expect(shape.key.source.endsWith("$")).toBe(true);
				expect(new RegExp(uriPattern(shape)).source).toBe(`^\\/${shape.key.source.slice(1)}`);
			}
		}
	});

	test("a Run file's id is the Run schema's version 7 UUID, after a day of the calendar", () => {
		const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "run.schema.json"), "utf8")) as { properties: { id: { pattern: string } } };
		const id = schema.properties.id.pattern.replace(/^\^|\$$/g, "");
		expect(RUN_ID).toBe(id);
		expect(RUN_KEY.source).toBe(new RegExp(`^runs\\/${calendarDate("\\/")}\\/${id}\\.json$`).source);
	});

	test("cover every Run file, boot summary and blob of the samples, and every link the built tree gives to evidence", () => {
		const samples = join(import.meta.dir, "samples");
		let runs = 0;
		let boots = 0;
		let blobs = 0;
		for (const sample of readdirSync(samples, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
			for (const path of filesUnder(join(samples, sample.name))) {
				if (path.startsWith("runs/")) {
					expect(RUN_KEY.test(path)).toBe(true);
					runs++;
				}
				if (path.startsWith("boots/")) {
					expect(BOOT_KEY.test(path)).toBe(true);
					boots++;
				}
				if (path.startsWith("blobs/")) {
					expect(BLOB_KEY.test(path)).toBe(true);
					blobs++;
				}
			}
		}
		expect(runs).toBeGreaterThan(10);
		expect(boots).toBeGreaterThan(3);
		expect(blobs).toBeGreaterThan(10);
		// Every address the golden tree links, its own files and the evidence, is of a served shape, but two the test
		// fixture makes up and no box writes: not-a-run.json, a file in runs/ whose name is no Run id, which the tree lists
		// as unreadable with its evidence link, and a boot summary named boot-2026-11-12, where a box names it by the
		// kernel's boot id, a UUID (as all 197 of the Runs repository's were on 2026-11-21). Neither is served: only what
		// the boxes write is.
		const golden = join(import.meta.dir, "api-golden");
		const unserved = new Set<string>();
		let links = 0;
		for (const path of filesUnder(golden)) {
			expect(isServedKey(path)).toBe(true);
			for (const match of readFileSync(join(golden, path), "utf8").matchAll(/"https:\/\/api\.ledgermath\.com\/([^"{]+)"/g)) {
				if (!isServedKey(match[1] as string)) unserved.add(match[1] as string);
				links++;
			}
		}
		expect([...unserved].sort()).toEqual(["boots/2026/11/12/boot-2026-11-12.json", "runs/2026/11/14/not-a-run.json"]);
		expect(readFileSync(join(golden, "v1", "series.json"), "utf8")).toContain('"evidence":"https://api.ledgermath.com/runs/2026/11/14/not-a-run.json"');
		expect(links).toBeGreaterThan(20);
	});

	test("are, shape for shape, the README's list of addresses", () => {
		const rows = SECTION.split("\n").filter((line) => /^- (a|an|the) [^:]+: `\^\\\//.test(line));
		const listed = rows.map((row) => /^- ([^:]+): `([^`]+)`$/.exec(row)?.slice(1, 3));
		expect(listed).toEqual(SERVED.flatMap((served) => served.keys.map((shape) => [shape.kind, uriPattern(shape)])));
	});

	test("serve exactly the schemas the build publishes, from the build's own list", () => {
		expect(API_SCHEMAS_OF_BUILD).toBe(API_SCHEMAS);
		const schema = TREE_KINDS.find((kind) => kind.kind === "a schema")?.path as RegExp;
		for (const { name } of API_SCHEMAS) expect(isServedKey(`v1/schemas/${name}.schema.json`)).toBe(true);
		for (const name of ["unpublished", "index2", "series-months", "Index", "run", ""]) expect(isServedKey(`v1/schemas/${name}.schema.json`)).toBe(false);
		expect(schema.source).toContain(`(?:${API_SCHEMAS.map((entry) => entry.name).join("|")})`);
	});

	test("take a date as a day of the calendar and a month as a month, the leap years' 29th of February included, and nothing else", () => {
		const real = (year: number, month: number, day: number): boolean => {
			const date = new Date(Date.UTC(year, month - 1, day));
			return month >= 1 && month <= 12 && day >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
		};
		const pad = (value: number, width: number): string => String(value).padStart(width, "0");
		let checked = 0;
		for (const year of [1900, 2000, 2023, 2024, 2026, 2028, 2100, 2400]) {
			for (let month = 0; month <= 13; month++) {
				expect(isServedKey(`v1/series/0cacb5fd6fae/${pad(year, 4)}-${pad(month, 2)}.json`)).toBe(month >= 1 && month <= 12);
				for (let day = 0; day <= 32; day++) {
					const [y, m, d] = [pad(year, 4), pad(month, 2), pad(day, 2)];
					const expected = real(year, month, day);
					expect({ date: `${y}-${m}-${d}`, served: isServedKey(`v1/prices/${y}-${m}-${d}.json`) }).toEqual({ date: `${y}-${m}-${d}`, served: expected });
					expect(isServedKey(`runs/${y}/${m}/${d}/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json`)).toBe(expected);
					expect(isServedKey(`boots/${y}/${m}/${d}/0bd3dc59-287c-4e18-b5b3-7dd30d38d0b0.json`)).toBe(expected);
					checked++;
				}
			}
		}
		expect(checked).toBe(8 * 14 * 33);
		expect(calendarDate("-")).not.toContain("|[0-9]{4}-02-29");
	});
});

describe("the functions", () => {
	const noRoute = load(NO_ROUTE_FUNCTION_CODE);
	const requestFunction = load(REQUEST_FUNCTION_CODE);

	test("fit CloudFront Functions' size limit, and there are three", () => {
		for (const code of [REQUEST_FUNCTION_CODE, EVIDENCE_RESPONSE_FUNCTION_CODE, NO_ROUTE_FUNCTION_CODE]) expect(Buffer.byteLength(code)).toBeLessThan(FUNCTION_CODE_LIMIT_BYTES);
		expect(CREATE.match(/new aws\.cloudfront\.Function\(/g)?.length).toBe(3);
	});

	test("the request function lets through, unchanged, a request for a key of a served shape under api.ledgermath.com", () => {
		for (const uri of ["/v1/index.json", "/v1/series/0cacb5fd6fae/2026-11.json", "/runs/2026/11/19/01a1f200-3dd5-7ac0-8994-a5f0ba761290.json", `/blobs/sha256/${HEX}`]) {
			const sent = request(uri);
			expect(requestFunction({ context: { eventType: "viewer-request" }, request: sent })).toBe(sent);
		}
	});

	test("the request function answers 404 to a key of no served shape, and 403 to another host, before cache or bucket", () => {
		for (const uri of ["/v1/notes.md", "/runs/2026/11/19/x.json", `/blobs/sha256/${HEX.toUpperCase()}`, "/v1/index.json/", "/v1/index.json%00", "/boots/2026/11/19/unknown.json"]) {
			const got = requestFunction({ context: { eventType: "viewer-request" }, request: request(uri) }) as CfResponse;
			expect(got.statusCode).toBe(404);
			expect(got.headers["access-control-allow-origin"]?.value).toBe("*");
		}
		for (const host of ["d111111abcdef8.cloudfront.net", "api.ledgermath.com.", null]) {
			const got = requestFunction({ context: { eventType: "viewer-request" }, request: request("/v1/index.json", host) }) as CfResponse;
			expect(got.statusCode).toBe(403);
			expect(got.headers["content-type"]?.value).toBe("text/plain; charset=utf-8");
			expect(got.body?.data).toContain("https://api.ledgermath.com/");
		}
	});

	test("the no-route function answers 404 to every address under api.ledgermath.com, served or not, and reaches neither cache nor bucket", () => {
		for (const uri of ["/", "/runs/2026/11/14/x.json", "/boots/", "/logs/2026/11/14/b.log", "/source/x.tar.gz", "/index.html", "/v1/index.json", `/blobs/sha256/${HEX}`]) {
			const got = noRoute({ context: { eventType: "viewer-request" }, request: request(uri) }) as CfResponse;
			expect(got.statusCode).toBe(404);
			expect(got.headers["access-control-allow-origin"]?.value).toBe("*");
			expect(got.headers["x-content-type-options"]?.value).toBe("nosniff");
			expect(got.headers["content-type"]?.value).toBe("text/plain; charset=utf-8");
			expect(got.body?.data).toContain("/v1/index.json");
		}
	});

	test("the no-route function answers another host with the request function's 403, word for word", () => {
		for (const host of ["d111111abcdef8.cloudfront.net", null]) {
			for (const uri of ["/", "/v1/index.json", "/anything"]) {
				const fromDefault = noRoute({ context: { eventType: "viewer-request" }, request: request(uri, host) }) as CfResponse;
				const fromServed = requestFunction({ context: { eventType: "viewer-request" }, request: request("/v1/index.json", host) }) as CfResponse;
				expect(fromDefault.statusCode).toBe(403);
				expect(fromDefault).toEqual(fromServed);
			}
		}
	});
});

describe("the JUnit report reader", () => {
	test("counts each failed test once, by its file, describe and name, decoding what the report escapes", () => {
		const xml = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<testsuites name="bun test" tests="3" failures="1">',
			'  <testsuite name="tests/a.test.ts" file="tests/a.test.ts">',
			'    <testsuite name="a group" file="tests/a.test.ts" line="3">',
			'      <testcase name="passes" classname="a group" file="tests/a.test.ts" line="4" assertions="1" />',
			'      <testcase name="fails, with &quot;quotes&quot; &amp; &lt;angles&gt;" classname="a group" file="tests/a.test.ts" line="7">',
			'        <failure type="AssertionError" message="no">AssertionError</failure>',
			"      </testcase>",
			'      <testcase name="fails, with &quot;quotes&quot; &amp; &lt;angles&gt;" classname="a group" file="tests/a.test.ts" line="7">',
			'        <failure type="AssertionError" message="no">AssertionError again</failure>',
			"      </testcase>",
			"    </testsuite>",
			"  </testsuite>",
			"</testsuites>",
		].join("\n");
		expect(readJunit(xml).length).toBe(3);
		expect(failedTests(xml)).toEqual(['tests/a.test.ts > a group > fails, with "quotes" & <angles>']);
		expect(() => readJunit("(fail) a group > fails")).toThrow("not a JUnit report");
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

	test("counts every request together, from any address, whatever its path, and blocks them all over 6,000 in 5 minutes", () => {
		// The scope-down matches every request: from Antarctica, or not from Antarctica (a request whose country WAF cannot tell
		// included). A CONSTANT rule must have one, and the Free plan allows no string, size or regex match to write it with.
		const fromAntarctica = { geoMatchStatement: { countryCodes: ["AQ"] } };
		expect(rate(TOTAL_RULE)).toEqual({
			name: TOTAL_RULE,
			priority: 3,
			action: { block: {} },
			statement: {
				rateBasedStatement: {
					limit: 6_000,
					aggregateKeyType: "CONSTANT",
					evaluationWindowSec: 300,
					scopeDownStatement: { orStatement: { statements: [fromAntarctica, { notStatement: { statements: [fromAntarctica] } }] } },
				},
			},
			visibilityConfig: { cloudwatchMetricsEnabled: true, metricName: `${NAMES.webAcl}-ceiling`, sampledRequestsEnabled: true },
		});
		expect(TOTAL_RATE_LIMIT).toEqual({ requests: 6_000, windowSeconds: 300 });
	});

	test("uses only what the CloudFront Free plan was seen to accept, at every depth, in at most its 5 rules", () => {
		const refusals = freePlanRefusals(rules);
		if (refusals.length > 0) throw new Error(freePlanMessage(refusals));
		expect(FREE_PLAN_WAF_RULES).toBe(FREE_PLAN.wafRules);
		// A managed group added to the list is not thereby accepted: the walk names the two that were seen.
		expect([...FREE_PLAN_MANAGED_GROUPS]).toEqual([...MANAGED_RULE_GROUPS]);
	});

	test("the Free plan's walk refuses what the plan refused, and anything not seen accepted, nested or not", () => {
		const total = rate(TOTAL_RULE);
		const totalWith = (scopeDownStatement: unknown) => ({
			...total,
			statement: { rateBasedStatement: { ...total.statement.rateBasedStatement, scopeDownStatement } },
		});
		const uriStartsWithSlash = {
			byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: "STARTS_WITH", searchString: "/", textTransformations: [{ priority: 0, type: "NONE" }] },
		};
		const others = rules.filter((rule) => rule.name !== TOTAL_RULE);
		const cases: Array<[string, unknown[], string]> = [
			// The rule as built before 2026-11-24, which the Free plan refused ("String match statement", PRO).
			["the byte match on the URI path", [...others, totalWith(uriStartsWithSlash)], "statement.rateBasedStatement.scopeDownStatement.byteMatchStatement is a statement of a type"],
			[
				"a size constraint (refused, PRO)",
				[...others, totalWith({ sizeConstraintStatement: { fieldToMatch: { uriPath: {} }, comparisonOperator: "GE", size: 0, textTransformations: [{ priority: 0, type: "NONE" }] } })],
				"sizeConstraintStatement is a statement of a type",
			],
			["a byte match inside the Or", [...others, totalWith({ orStatement: { statements: [{ geoMatchStatement: { countryCodes: ["AQ"] } }, uriStartsWithSlash] } })], "orStatement.statements[1].byteMatchStatement"],
			["an And", [...others, totalWith({ andStatement: { statements: [{ geoMatchStatement: { countryCodes: ["AQ"] } }] } })], "andStatement is a statement of a type"],
			[
				"a geographic match on a forwarded address (header-based)",
				[...others, totalWith({ geoMatchStatement: { countryCodes: ["AQ"], forwardedIpConfig: { headerName: "X-Forwarded-For", fallbackBehavior: "MATCH" } } })],
				"geoMatchStatement.forwardedIpConfig is a field",
			],
			[
				"a third managed group",
				[...rules, { name: "AWSManagedRulesCommonRuleSet", priority: 4, overrideAction: { none: {} }, statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" } }, visibilityConfig: total.visibilityConfig }],
				'names the group "AWSManagedRulesCommonRuleSet"',
			],
			[
				"a rate rule on a forwarded address",
				[...others, { ...total, statement: { rateBasedStatement: { limit: 6_000, aggregateKeyType: "FORWARDED_IP", evaluationWindowSec: 300 } } }],
				'aggregates by "FORWARDED_IP"',
			],
			["a custom response (Pro)", [...others, { ...total, action: { block: { customResponse: { responseCode: 429 } } } }], "its action is"],
			["a challenge (Business)", [...others, { ...total, action: { challenge: {} } }], "its action is"],
			["a rule's labels", [...others, { ...total, ruleLabels: [{ name: "x" }] }], "ruleLabels is a field"],
			["6 rules", [...rules, rate(PER_ADDRESS_RULE), rate(PER_ADDRESS_RULE)], "the web ACL has 6 rules, and the CloudFront Free plan allows 5"],
		];
		for (const [what, refused, says] of cases) {
			const refusals = freePlanRefusals(refused);
			if (!refusals.some((refusal) => refusal.includes(says))) throw new Error(`${what}: expected a refusal saying ${JSON.stringify(says)}, got ${JSON.stringify(refusals)}`);
			const message = freePlanMessage(refusals);
			expect(message).toContain("CloudFront Free plan");
			expect(message).toContain("must first be shown to be accepted");
		}
	});

	test("has a description WAF accepts, which the stack uses", () => {
		expect(WEB_ACL_DESCRIPTION).toMatch(WEB_ACL_DESCRIPTION_PATTERN);
		expect(WEB_ACL_DESCRIPTION.length).toBeLessThanOrEqual(256);
		expect(String(WEB_ACL_DESCRIPTION_PATTERN)).toBe(String(/^[\w+=:#@/\-,.][\w+=:#@/\-,.\s]+[\w+=:#@/\-,.]$/));
		for (const refused of ["a; b", "a (b)", "a <b>", " a", "a "]) expect(refused).not.toMatch(WEB_ACL_DESCRIPTION_PATTERN);
		expect(CREATE).toContain("description: WEB_ACL_DESCRIPTION,");
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
		const prose = SECTION.replace(/\s+/g, " ");
		for (const phrase of ["6,000 × 288 × 31", "53,568,000", "$21.43", "20 a second", "waf-rule-statement-type-rate-based-caveats.html", "There is no hard cap on S3 request charges"]) expect(prose).toContain(phrase);
		for (const claim of ["the ceiling's $21.43", "at most 53,568,000", "a ceiling in practice", "up to the ceiling"]) expect(prose).not.toContain(claim);
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
		expect(dark).toContain("production-runs (the only stage that may have it): dark");
		expect(dark).toContain("DISABLED");
		expect(dark).toContain("subscribes it to the Free plan");
		expect(dark).toContain('set PUBLIC_API.state to "on"');
		expect(dark).toContain('Only if AWS refused to subscribe the disabled distribution: set "closed" instead');
		const byHand = reminder(plan("dark", "console"), "p").join("\n");
		expect(byHand).toContain(consoleSteps(STAGE, "p").join("\n"));
		expect(byHand).toContain("--plan-tier FREE");
		const closed = reminder(plan("closed"), "p").join("\n");
		expect(closed).toContain("ENABLED but answers 404 to every address");
		expect(closed).toContain("Until the plan is attached, the requests that reach it are billed at pay-as-you-go rates");
		expect(closed).toContain('set PUBLIC_API.state to "on"');
		const on = reminder(plan("on"), "p").join("\n");
		expect(on).toContain("https://api.ledgermath.com/");
		expect(on).toContain("The watch checks every 5 minutes");
		expect(on).toContain('Before changing or cancelling the plan, deploy "dark"');
	});

	test("every state the switch can take is one the README's table of states lists", () => {
		const states: PublicApiState[] = ["off", "dark", "closed", "on"];
		for (const state of states) expect(SECTION).toContain(`| \`${state}\` |`);
	});
});

describe("reading blobs from a public address", () => {
	const BASE = "https://api.ledgermath.com";
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
		expect(() => publicBlobStore("http://api.ledgermath.com")).toThrow("starts with https://");
		expect(() => publicBlobStore("api.ledgermath.com")).toThrow("starts with https://");
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
