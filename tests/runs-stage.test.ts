import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Instance, Tag } from "@aws-sdk/client-ec2";

import {
	GITHUB_OIDC_AUDIENCE,
	GITHUB_OIDC_URL,
	type PolicyDocument,
	readPolicy,
	trustPolicy,
} from "../infra/runs/github-role";
import { boxTags, launch } from "../infra/runs/launch-box";
import { chooseInstanceType, clientToken, LATEST_START_MS, lateness, SCHEDULED_EVENT } from "../infra/runs/launch-event";
import { PLACEMENT, PLACEMENTS } from "../infra/runs/placement";
import { MAX_AGE_MS, staleBoxes } from "../infra/runs/reap-boxes";
import { BOX_MARKER, buildUserData, USER_DATA_LIMIT_BYTES } from "../infra/runs/user-data";

const BOX_SH = readFileSync(join(import.meta.dir, "..", "runner", "box.sh"), "utf8");
const STACK = readFileSync(join(import.meta.dir, "..", "infra", "runs", "stack.ts"), "utf8");
const COMMIT = "537d4f1bd2fa883c897456d16a9b7c9a49548b05";
const VARIABLES = {
	bucket: "ledgermath-smr-runs-runsbucketbucket-abcdefgh",
	stage: "smr-runs",
	sourceKey: `source/${COMMIT}.tar.gz`,
	sourceCommit: COMMIT,
	region: "us-east-2",
};

describe("the user-data", () => {
	const userData = buildUserData(BOX_SH, VARIABLES);

	test("is the variables, the marker, then runner/box.sh without its first line", () => {
		const [header, body] = userData.split(`${BOX_MARKER}\n`);
		expect(header).toBe(
			[
				"#!/usr/bin/env bash",
				`export LEDGERMATH_BUCKET=${VARIABLES.bucket}`,
				"export LEDGERMATH_STAGE=smr-runs",
				`export LEDGERMATH_SOURCE_KEY=source/${COMMIT}.tar.gz`,
				`export LEDGERMATH_SOURCE_COMMIT=${COMMIT}`,
				"export AWS_DEFAULT_REGION=us-east-2",
				"",
			].join("\n"),
		);
		expect(body).toBe(BOX_SH.slice(BOX_SH.indexOf("\n") + 1));
	});

	test("uses the marker runner/box.sh looks for", () => {
		expect(BOX_SH).toContain(`MARKER="${BOX_MARKER}"`);
	});

	test("fits EC2's user-data limit with room to spare", () => {
		expect(Buffer.byteLength(userData)).toBeLessThan(USER_DATA_LIMIT_BYTES * 0.75);
	});

	test("refuses values a shell would read as more than a word", () => {
		expect(() => buildUserData(BOX_SH, { ...VARIABLES, bucket: "a b" })).toThrow();
		expect(() => buildUserData(BOX_SH, { ...VARIABLES, stage: "$(reboot)" })).toThrow();
		expect(() => buildUserData(BOX_SH, { ...VARIABLES, sourceCommit: "537d4f1" })).toThrow();
	});
});

describe("the launch", () => {
	test("uses the configured instance type unless the payload names one", () => {
		expect(chooseInstanceType(undefined, "c6i.8xlarge")).toBe("c6i.8xlarge");
		expect(chooseInstanceType({}, "c6i.8xlarge")).toBe("c6i.8xlarge");
		expect(chooseInstanceType({ instanceType: "c6i.large" }, "c6i.8xlarge")).toBe("c6i.large");
		expect(chooseInstanceType({ instanceType: "u-6tb1.metal" }, "c6i.8xlarge")).toBe("u-6tb1.metal");
	});

	test("refuses an instance type that is not one", () => {
		expect(() => chooseInstanceType({ instanceType: 5 }, "c6i.8xlarge")).toThrow();
		expect(() => chooseInstanceType({ instanceType: "c6i.large --dry-run" }, "c6i.8xlarge")).toThrow();
	});
});

/** The schedule's payload as EventBridge Scheduler delivers it at `time`. */
const delivered = (time: string): unknown =>
	JSON.parse(JSON.stringify(SCHEDULED_EVENT).replace("<aws.scheduler.scheduled-time>", time));

describe("a late scheduled launch", () => {
	const slot = delivered("2026-11-12T22:10:00Z");
	const at = (time: string): Date => new Date(time);

	test("is started up to ten minutes after its scheduled time", () => {
		expect(LATEST_START_MS).toBe(10 * 60 * 1000);
		expect(lateness(slot, at("2026-11-12T22:10:00Z"))).toBeUndefined();
		expect(lateness(slot, at("2026-11-12T22:20:00Z"))).toBeUndefined();
		expect(lateness(slot, at("2026-11-12T22:09:00Z"))).toBeUndefined(); // a clock a little behind
	});

	test("is refused after that, saying why", () => {
		expect(lateness(slot, at("2026-11-12T22:20:01Z"))).toContain("601 s late");
		expect(lateness(slot, at("2026-11-12T23:00:00Z"))).toContain("2026-11-12T22:10:00Z");
	});

	test("never applies to a launch by hand", () => {
		expect(lateness({}, at("2030-01-01T00:00:00Z"))).toBeUndefined();
		expect(lateness({ instanceType: "c6i.large" }, at("2030-01-01T00:00:00Z"))).toBeUndefined();
	});

	test("is refused by the handler without launching, and without throwing", async () => {
		// Nothing of the launch's configuration is set here, and no AWS call can
		// succeed: the refusal has to come before either is needed.
		const outcome = await launch(slot, at("2026-11-12T23:00:00Z"));
		expect(outcome.launched).toBe(false);
		expect(outcome.launched === false && outcome.reason).toContain("3000 s late");
	});
});

describe("the launch's client token", () => {
	test("is the same for every invocation of one scheduled slot, so EC2 starts one box", () => {
		const first = clientToken("smr-runs", delivered("2026-11-12T22:10:00Z"));
		const again = clientToken("smr-runs", delivered("2026-11-12T22:10:00Z"));
		expect(first).toBeDefined();
		expect(again).toBe(first);
		expect(first?.length).toBeLessThanOrEqual(64); // EC2's limit
	});

	test("differs from day to day and from stage to stage", () => {
		const tokens = new Set([
			clientToken("smr-runs", delivered("2026-11-12T22:10:00Z")),
			clientToken("smr-runs", delivered("2026-11-13T22:10:00Z")),
			clientToken("dev-runs", delivered("2026-11-12T22:10:00Z")),
		]);
		expect(tokens.size).toBe(3);
	});

	test("is left to the SDK, fresh each time, for a launch by hand", () => {
		expect(clientToken("smr-runs", {})).toBeUndefined();
		expect(clientToken("smr-runs", { instanceType: "c6i.large" })).toBeUndefined();
		expect(clientToken("smr-runs", undefined)).toBeUndefined();
	});

	test("refuses a payload whose placeholder was not replaced, rather than reuse one token every day", () => {
		expect(() => clientToken("smr-runs", SCHEDULED_EVENT)).toThrow();
		expect(() => clientToken("smr-runs", { scheduledTime: "yesterday" })).toThrow();
	});
});

describe("the reaper", () => {
	const now = Date.parse("2026-11-12T23:00:00Z");
	const instance = (id: string, tags: Tag[], minutesOld: number): Instance => ({
		InstanceId: id,
		Tags: tags,
		LaunchTime: new Date(now - minutesOld * 60 * 1000),
	});
	const julysTags: Tag[] = [
		{ Key: "ledgermath-runner", Value: "true" },
		{ Key: "ledgermath-stage", Value: "smr" },
	];

	test("terminates this stage's boxes that outlived their own timer, and nothing else", () => {
		const instances = [
			instance("i-stuck", boxTags("smr-runs", COMMIT), 51),
			instance("i-running", boxTags("smr-runs", COMMIT), 30),
			instance("i-other-stage", boxTags("dev-runs", COMMIT), 300),
			instance("i-july", julysTags, 300),
			instance("i-untagged", [], 300),
		];
		expect(staleBoxes(instances, "smr-runs", now)).toEqual(["i-stuck"]);
	});

	test("waits past the box's own 45-minute timer", () => {
		expect(MAX_AGE_MS).toBeGreaterThan(45 * 60 * 1000);
	});

	test("a box never carries the tag July's reaper selects on", () => {
		expect(boxTags("smr-runs", COMMIT).map((tag) => tag.Key)).not.toContain("ledgermath-runner");
	});
});

describe("where the stage launches", () => {
	test("is one shared placement, which the stack takes its instance type and zone from", () => {
		expect(PLACEMENT).toEqual({ instanceType: "c6i.8xlarge", zone: "us-east-2c" });
		expect(PLACEMENTS).toEqual([PLACEMENT]);
		expect(STACK).toContain('import { PLACEMENT } from "./placement";');
		expect(STACK).toContain("const ZONE = PLACEMENT.zone;");
		expect(STACK).toContain("const INSTANCE_TYPE = PLACEMENT.instanceType;");
		// No second copy of either in the stack.
		expect(STACK).not.toMatch(/"c6i\.|"us-east-2[a-z]"/);
	});
});

/**
 * Whether a policy allows an action on a resource, by IAM's rules for what
 * these documents use: Allow statements, exact actions, and resources where *
 * matches anything. Conditions are left out; trust policies are checked apart.
 */
function allows(policy: PolicyDocument, action: string, resource: string): boolean {
	const matches = (pattern: string, value: string): boolean =>
		new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);
	return policy.Statement.some(
		(statement) =>
			statement.Effect === "Allow" &&
			statement.Action.some((allowed) => matches(allowed, action)) &&
			(statement.Resource ?? []).some((allowed) => matches(allowed, resource)),
	);
}

describe("the role the runs workflow assumes", () => {
	const providerArn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com";
	const bucketArn = "arn:aws:s3:::ledgermath-smr-runs-runsbucketbucket-abcdefgh";

	test("trusts GitHub's OIDC provider, for this repository's workflows on main alone", () => {
		const policy = trustPolicy(providerArn);
		expect(policy.Statement).toEqual([
			{
				Effect: "Allow",
				Principal: { Federated: providerArn },
				Action: ["sts:AssumeRoleWithWebIdentity"],
				Condition: {
					StringEquals: {
						"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
						"token.actions.githubusercontent.com:sub": "repo:smrdotgg/ledgermath:ref:refs/heads/main",
					},
				},
			},
		]);
		// An exact match: no StringLike, no wildcard that a branch, a tag, a pull
		// request or another repository could satisfy.
		expect(JSON.stringify(policy)).not.toContain("*");
		expect(JSON.stringify(policy)).not.toContain("StringLike");
	});

	test("may list the bucket and read Runs, boot summaries and blobs, and nothing else", () => {
		const policy = readPolicy(bucketArn);
		expect(allows(policy, "s3:ListBucket", bucketArn)).toBe(true);
		for (const key of ["runs/2026/11/10/a.json", "boots/2026/11/10/b.json", "blobs/sha256/0123"]) {
			expect(allows(policy, "s3:GetObject", `${bucketArn}/${key}`)).toBe(true);
		}
		for (const key of ["logs/2026/11/10/b.log", "source/abc.tar.gz", "runsx/a", "other"]) {
			expect(allows(policy, "s3:GetObject", `${bucketArn}/${key}`)).toBe(false);
		}
		for (const action of ["s3:PutObject", "s3:DeleteObject", "s3:GetObjectVersion", "s3:ListBucketVersions", "s3:PutBucketPolicy", "iam:PassRole"]) {
			expect(allows(policy, action, bucketArn)).toBe(false);
			expect(allows(policy, action, `${bucketArn}/runs/a.json`)).toBe(false);
		}
		expect(allows(policy, "s3:ListBucket", "arn:aws:s3:::another-bucket")).toBe(false);
		expect(policy.Statement.flatMap((statement) => statement.Action).sort()).toEqual(["s3:GetObject", "s3:ListBucket"]);
	});

	test("is made by the stack: GitHub's provider, the role from these documents, and its ARN as an output", () => {
		expect(GITHUB_OIDC_URL).toBe("https://token.actions.githubusercontent.com");
		expect(GITHUB_OIDC_AUDIENCE).toBe("sts.amazonaws.com");
		expect(STACK).toContain('new aws.iam.OpenIdConnectProvider("GitHubOidc"');
		expect(STACK).toContain("clientIdLists: [GITHUB_OIDC_AUDIENCE]");
		expect(STACK).toContain("JSON.stringify(trustPolicy(arn))");
		expect(STACK).toContain("JSON.stringify(readPolicy(arn))");
		expect(STACK).toContain("runsReaderRole: readerRole.arn");
	});
});
