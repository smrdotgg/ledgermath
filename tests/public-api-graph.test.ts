/**
 * The public data API's resources, built for each state of the switch by the
 * stack's own code (publicApiDeclarations in infra/runs/public-blobs-stack.ts)
 * under Pulumi's mocks: deterministic, and no request to AWS. What each state
 * declares, and with what arguments, is read from the resources Pulumi was
 * asked to make, not from the source text.
 *
 * Pulumi and its AWS provider are SST's, in .sst/platform (`bunx sst install`
 * writes them; it asks AWS nothing). Without them these tests are skipped,
 * unless LM_STACK_REQUIRED=1, as CI sets it, which makes their absence a
 * failure. SST's own CronV2 component is stood in for (it would bundle a
 * Lambda); everything else is the real provider's resource classes.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
	API_DOMAIN,
	declaredResources,
	EVIDENCE_RESPONSE_FUNCTION_CODE,
	GRANT_SID,
	NO_ROUTE_FUNCTION_CODE,
	type PlanAttachment,
	publicApiNames,
	publicApiPlan,
	REQUEST_FUNCTION_CODE,
	servedPrefixes,
} from "../infra/runs/public-blobs";
import { DISTRIBUTION_NAME } from "../infra/runs/public-blobs-guard";
import { watchPermissions } from "../infra/runs/plan-watch";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const PLATFORM = join(ROOT, ".sst", "platform", "node_modules");
const AVAILABLE = existsSync(join(PLATFORM, "@pulumi", "pulumi", "index.js")) && existsSync(join(PLATFORM, "@pulumi", "aws", "index.js"));
const REQUIRED = process.env.LM_STACK_REQUIRED === "1";
const STAGE = "production-runs";
const DISTRIBUTION_DOMAIN = "d111111abcdef8.cloudfront.net";
const CLOUDFRONT_ZONE = "Z2FDTNDATAQYW2";

if (!AVAILABLE && !REQUIRED) console.log("skipping the public API's resource graph: SST's platform is not installed (bunx sst install)");

test("SST's platform, with Pulumi and its AWS provider, is installed where CI requires it", () => {
	if (REQUIRED) expect(AVAILABLE).toBe(true);
});

interface Registered {
	type: string;
	name: string;
	inputs: Record<string, unknown>;
}

// biome-ignore lint: Pulumi's modules are loaded at run time, from SST's platform.
type Any = any;
let pulumi: Any;
let aws: Any;

/** What Pulumi's mocks give back for each kind of resource: its inputs, and the outputs the code reads. */
function outputsOf(type: string, name: string, inputs: Record<string, unknown>): Record<string, unknown> {
	const arn = `arn:mock:${type}:${name}`;
	switch (type) {
		case "aws:s3/bucket:Bucket":
			return { bucket: name, arn: `arn:aws:s3:::${name}`, bucketRegionalDomainName: `${name}.s3.us-east-2.amazonaws.com` };
		case "aws:cloudfront/distribution:Distribution":
			return { arn, domainName: DISTRIBUTION_DOMAIN, hostedZoneId: CLOUDFRONT_ZONE };
		case "aws:acm/certificate:Certificate":
			return {
				arn,
				domainValidationOptions: [
					{ domainName: inputs.domainName, resourceRecordName: "_x1.api.ledgermath.com.", resourceRecordType: "CNAME", resourceRecordValue: "_y2.acm-validations.aws." },
				],
			};
		case "aws:acm/certificateValidation:CertificateValidation":
			return { certificateArn: inputs.certificateArn };
		case "aws:route53/record:Record":
			return { fqdn: String(inputs.name).replace(/\.$/, "") };
		default:
			return { arn };
	}
}

interface Built {
	registered: Registered[];
	crons: Array<{ name: string; args: Any }>;
	byName(name: string): Registered;
	policy(bucket: "runs" | "api"): { Statement: Array<{ Sid?: string; Effect: string } & Record<string, unknown>> };
	resourceNames: string[];
}

/** Resolves an Output to its value. */
function valueOf<T>(output: Any): Promise<T> {
	return new Promise((resolve) => output.apply((value: T) => resolve(value)));
}

const SST_POLICY = (arn: string): string =>
	JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "s3:*", Resource: [arn, `${arn}/*`], Principal: "*", Condition: { Bool: { "aws:SecureTransport": "false" } } }] });

let builds = 0;

/** Builds the resources of one state and plan attachment, as stack.ts would: the two buckets (policies as SST makes them, with the transforms), then create(). */
async function build(state: "dark" | "closed" | "on", attachment: PlanAttachment): Promise<Built> {
	const registered: Registered[] = [];
	const crons: Array<{ name: string; args: Any }> = [];
	await pulumi.runtime.setMocks(
		{
			newResource: (args: { type: string; name: string; inputs: Record<string, unknown> }) => {
				registered.push({ type: args.type, name: args.name, inputs: args.inputs });
				return { id: `${args.name}-id`, state: { ...args.inputs, ...outputsOf(args.type, args.name, args.inputs) } };
			},
			call: () => ({}),
		},
		"ledgermath",
		`${STAGE}-${state}-${attachment}-${builds++}`,
		false,
	);
	class CronV2 extends pulumi.ComponentResource {
		nodes: { function: { name: Any } };
		constructor(name: string, args: Any) {
			super("sst:aws:CronV2", name, {}, {});
			crons.push({ name, args });
			this.nodes = { function: { name: pulumi.output(`${name}-function`) } };
			this.registerOutputs({});
		}
	}
	Object.assign(globalThis, { $util: pulumi, $resolve: pulumi.all, $output: pulumi.output, $interpolate: pulumi.interpolate, aws, sst: { aws: { CronV2 } } });
	// By a computed path, so that tsconfig.json's program does not take in the stack module and, through it, SST's
	// platform sources; scripts/check-stack-types.ts type-checks the module against them.
	const { publicApiDeclarations } = (await import(join(ROOT, "infra", "runs", "public-blobs-stack.ts"))) as Any;
	const plan = publicApiPlan({ stage: STAGE, state, plan: attachment }, STAGE);
	if (plan === null) throw new Error("no plan");
	const declared = publicApiDeclarations(plan, publicApiNames("ledgermath", STAGE));
	const bucket = (name: string, transform: ((args: Any) => undefined) | null) => {
		const made = new aws.s3.Bucket(`${name}Bucket`, {});
		const args = { bucket: made.bucket, policy: made.arn.apply((arn: string) => SST_POLICY(arn)) };
		if (transform !== null) transform(args);
		const policy = new aws.s3.BucketPolicy(`${name}Policy`, args);
		return { made, policy };
	};
	const runs = bucket("RunsBucket", declared.runsBucketPolicy);
	const api = bucket("ApiBucket", declared.apiBucketPolicy);
	const created = declared.create({ nodes: { bucket: runs.made } }, { nodes: { bucket: api.made } });
	for (const resource of [...Object.values(created.resources), runs.policy, api.policy]) await valueOf((resource as Any).urn);
	await valueOf(created.outputs.watchFunction);
	const byName = (name: string): Registered => {
		const found = registered.find((entry) => entry.name === name);
		if (found === undefined) throw new Error(`no resource ${name} was made`);
		return found;
	};
	return {
		registered,
		crons,
		byName,
		policy: (which) => JSON.parse(String(byName(which === "runs" ? "RunsBucketPolicy" : "ApiBucketPolicy").inputs.policy)),
		resourceNames: Object.keys(created.resources),
	};
}

const run = AVAILABLE ? describe : describe.skip;

run("the public API's resources, built for each state under Pulumi's mocks", () => {
	const built = new Map<string, Built>();
	beforeAll(async () => {
		pulumi = await import(join(PLATFORM, "@pulumi", "pulumi", "index.js"));
		aws = await import(join(PLATFORM, "@pulumi", "aws", "index.js"));
		for (const state of ["dark", "closed", "on"] as const) {
			for (const attachment of ["code", "console"] as const) built.set(`${state} ${attachment}`, await build(state, attachment));
		}
	});
	const get = (key: string): Built => built.get(key) as Built;
	const functionArn = (b: Built, name: string): string => `arn:mock:aws:cloudfront/function:Function:${name}`;
	const distribution = (b: Built) => b.byName(DISTRIBUTION_NAME).inputs as Any;

	test("each state makes exactly the resources declaredResources lists, and nothing else but the two buckets and their policies", () => {
		for (const [key, b] of built) {
			const [state, attachment] = key.split(" ") as ["dark" | "closed" | "on", PlanAttachment];
			const expected = declaredResources(publicApiPlan({ stage: STAGE, state, plan: attachment }, STAGE));
			// The mocks see the stood-in CronV2 too, as the component it is.
			const made = b.registered.map((entry) => entry.name);
			expect(b.registered.find((entry) => entry.name === "PublicApiWatch")?.type).toBe("sst:aws:CronV2");
			expect(made.filter((name) => !/^(Runs|Api)Bucket(Bucket|Policy)$/.test(name)).sort()).toEqual([...expected].sort());
			expect([...b.resourceNames].sort()).toEqual([...expected].sort());
		}
		expect(get("on console").resourceNames).not.toContain("PublicApiFreePlan");
		expect(get("on code").resourceNames).toContain("PublicApiFreePlan");
	});

	test("dark: the distribution is disabled, and every behaviour answers 404 from the no-route function", () => {
		const d = distribution(get("dark code"));
		expect(d.enabled).toBe(false);
		const behaviours = [d.defaultCacheBehavior, ...d.orderedCacheBehaviors];
		for (const behaviour of behaviours) {
			const request = behaviour.functionAssociations.filter((association: Any) => association.eventType === "viewer-request");
			expect(request).toEqual([{ eventType: "viewer-request", functionArn: functionArn(get("dark code"), "PublicApiNoRouteFunction") }]);
		}
	});

	test("closed: enabled, and still 404 from every behaviour", () => {
		const d = distribution(get("closed code"));
		expect(d.enabled).toBe(true);
		for (const behaviour of [d.defaultCacheBehavior, ...d.orderedCacheBehaviors]) {
			expect(behaviour.functionAssociations.find((association: Any) => association.eventType === "viewer-request")?.functionArn).toBe(
				functionArn(get("closed code"), "PublicApiNoRouteFunction"),
			);
		}
	});

	test("on: enabled; the served behaviours run the request function (and the evidence its response function); the default answers 404", () => {
		const b = get("on code");
		const d = distribution(b);
		expect(d.enabled).toBe(true);
		expect(d.defaultCacheBehavior.functionAssociations).toEqual([{ eventType: "viewer-request", functionArn: functionArn(b, "PublicApiNoRouteFunction") }]);
		for (const behaviour of d.orderedCacheBehaviors) {
			const expected = [{ eventType: "viewer-request", functionArn: functionArn(b, "PublicApiRequestFunction") }];
			if (behaviour.pathPattern !== "v1/*") expected.push({ eventType: "viewer-response", functionArn: functionArn(b, "PublicApiEvidenceResponseFunction") });
			expect(behaviour.functionAssociations).toEqual(expected);
		}
		expect(b.byName("PublicApiRequestFunction").inputs).toMatchObject({ code: REQUEST_FUNCTION_CODE, runtime: "cloudfront-js-2.0", publish: true, name: "ledgermath-production-runs-request" });
		expect(b.byName("PublicApiEvidenceResponseFunction").inputs).toMatchObject({ code: EVIDENCE_RESPONSE_FUNCTION_CODE });
		expect(b.byName("PublicApiNoRouteFunction").inputs).toMatchObject({ code: NO_ROUTE_FUNCTION_CODE });
	});

	test("in every state: two private origins through one access control, api.ledgermath.com with the validated certificate", () => {
		for (const b of built.values()) {
			const d = distribution(b);
			const oac = "PublicApiOac-id";
			expect(d.origins).toEqual([
				{ originId: "api-bucket", domainName: "ApiBucketBucket.s3.us-east-2.amazonaws.com", originAccessControlId: oac },
				{ originId: "runs-bucket", domainName: "RunsBucketBucket.s3.us-east-2.amazonaws.com", originAccessControlId: oac },
			]);
			expect(d.aliases).toEqual([API_DOMAIN.name]);
			expect(d.viewerCertificate).toEqual({ acmCertificateArn: "arn:mock:aws:acm/certificate:Certificate:PublicApiCertificate", sslSupportMethod: "sni-only", minimumProtocolVersion: "TLSv1.2_2025" });
			expect(d.webAclId).toBe("arn:mock:aws:wafv2/webAcl:WebAcl:PublicApiWebAcl");
		}
	});

	test("the certificate, its validation record and the alias records are in us-east-1 and the delegated zone, and point where they should", () => {
		const b = get("dark code");
		expect(b.byName("PublicApiCertificate").inputs).toMatchObject({ region: "us-east-1", domainName: API_DOMAIN.name, validationMethod: "DNS" });
		expect(b.byName("PublicApiCertificateRecord").inputs).toMatchObject({ zoneId: API_DOMAIN.hostedZoneId, name: "_x1.api.ledgermath.com.", type: "CNAME", records: ["_y2.acm-validations.aws."] });
		expect(b.byName("PublicApiCertificateValidation").inputs).toMatchObject({
			region: "us-east-1",
			certificateArn: "arn:mock:aws:acm/certificate:Certificate:PublicApiCertificate",
			validationRecordFqdns: ["_x1.api.ledgermath.com"],
		});
		for (const type of ["A", "AAAA"]) {
			expect(b.byName(`PublicApiAlias${type}`).inputs).toMatchObject({
				zoneId: API_DOMAIN.hostedZoneId,
				name: API_DOMAIN.name,
				type,
				aliases: [{ name: DISTRIBUTION_DOMAIN, zoneId: CLOUDFRONT_ZONE, evaluateTargetHealth: false }],
			});
		}
		expect(b.byName("PublicApiWebAcl").inputs).toMatchObject({ region: "us-east-1", scope: "CLOUDFRONT" });
	});

	test("the plan subscription names the distribution and the web ACL; the watch is given the distribution and only its permissions", () => {
		const b = get("dark code");
		const subscription = b.byName("PublicApiFreePlan").inputs as Any;
		expect(subscription.region).toBe("us-east-1");
		expect(JSON.parse(subscription.desiredState)).toEqual({
			PlanFamily: "CloudFront",
			PlanTier: "FREE",
			UsageLevel: "DEFAULT",
			ResourceArns: ["arn:mock:aws:cloudfront/distribution:Distribution:PublicApiDistribution", "arn:mock:aws:wafv2/webAcl:WebAcl:PublicApiWebAcl"],
		});
		const watch = b.crons.find((cron) => cron.name === "PublicApiWatch");
		expect(watch?.args.function.dev).toBe(false);
		expect(watch?.args.function.handler).toBe("infra/runs/plan-watch-handler.handler");
	});

	test("the watch's permissions are the distribution's own", async () => {
		const watch = get("on code").crons.find((cron) => cron.name === "PublicApiWatch");
		const arn = "arn:mock:aws:cloudfront/distribution:Distribution:PublicApiDistribution";
		expect(await valueOf<unknown>(watch?.args.function.permissions)).toEqual(watchPermissions(arn));
		expect(await valueOf<unknown>(watch?.args.function.environment.LEDGERMATH_DISTRIBUTION_ARN)).toBe(arn);
	});

	test("the buckets' policies grant CloudFront nothing in dark and closed, and in on exactly their served prefixes to this distribution", () => {
		for (const key of ["dark code", "closed code", "dark console", "closed console"]) {
			for (const which of ["runs", "api"] as const) {
				const statements = get(key).policy(which).Statement;
				expect(statements.filter((statement) => statement.Effect === "Allow")).toEqual([]);
			}
		}
		const on = get("on code");
		const arn = "arn:mock:aws:cloudfront/distribution:Distribution:PublicApiDistribution";
		for (const [which, bucket] of [
			["runs", "RunsBucketBucket"],
			["api", "ApiBucketBucket"],
		] as const) {
			const grants = on.policy(which).Statement.filter((statement) => statement.Sid === GRANT_SID);
			expect(grants).toEqual([
				{
					Sid: GRANT_SID,
					Effect: "Allow",
					Principal: { Service: "cloudfront.amazonaws.com" },
					Action: ["s3:GetObject"],
					Resource: servedPrefixes(which).map((prefix) => `arn:aws:s3:::${bucket}/${prefix}*`),
					Condition: { StringEquals: { "AWS:SourceArn": arn } },
				},
			]);
			expect(on.policy(which).Statement.filter((statement) => statement.Effect === "Allow")).toEqual(grants);
		}
	});
});
