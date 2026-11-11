import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import {
	clientToken,
	LATEST_START_MS,
	lateness,
	requestedInstanceType,
	SCHEDULED_TIME_PLACEHOLDER,
	scheduledEvent,
	unscheduledType,
} from "../infra/runs/launch-event";
import { LAUNCH_SCHEDULES, launchSchedules, SCHEDULE, TARGETS, ZONE } from "../infra/runs/placement";
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
	test("launches the instance type the payload names, any type for a launch by hand", () => {
		expect(requestedInstanceType({ instanceType: "c6i.large" })).toBe("c6i.large");
		expect(requestedInstanceType({ instanceType: "u-6tb1.metal" })).toBe("u-6tb1.metal");
	});

	test("refuses a payload that names no instance type, so none is launched by omission", () => {
		expect(() => requestedInstanceType(undefined)).toThrow("the payload must name an EC2 instance type");
		expect(() => requestedInstanceType({})).toThrow("the payload must name an EC2 instance type");
		expect(() => requestedInstanceType({ scheduledTime: "2026-11-12T22:10:00Z" })).toThrow();
	});

	test("refuses an instance type that is not one", () => {
		expect(() => requestedInstanceType({ instanceType: 5 })).toThrow();
		expect(() => requestedInstanceType({ instanceType: "c6i.large --dry-run" })).toThrow();
	});
});

/** One target's payload as EventBridge Scheduler delivers it at `time`. */
const delivered = (time: string, instanceType = "c6i.8xlarge"): unknown =>
	JSON.parse(JSON.stringify(scheduledEvent(instanceType)).replace(SCHEDULED_TIME_PLACEHOLDER, time));

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

describe("a scheduled launch of a type that is not a target", () => {
	const targets = ["c6i.8xlarge", "m5.large"];

	test("is refused, saying why", () => {
		expect(unscheduledType(delivered("2026-11-12T22:10:00Z", "c6i.8xlarge"), targets)).toBeUndefined();
		expect(unscheduledType(delivered("2026-11-12T22:20:00Z", "m5.large"), targets)).toBeUndefined();
		const reason = unscheduledType(delivered("2026-11-12T22:10:00Z", "c6i.32xlarge"), targets);
		expect(reason).toContain("names c6i.32xlarge, which is not a target of the deployed schedule (c6i.8xlarge, m5.large)");
	});

	test("is any type at all when launched by hand, without a scheduled time", () => {
		expect(unscheduledType({ instanceType: "c6i.32xlarge" }, targets)).toBeUndefined();
		expect(unscheduledType({ instanceType: "c6i.large" }, [])).toBeUndefined();
	});

	test("is refused by the handler before any configuration or AWS call is needed", async () => {
		const before = process.env.LEDGERMATH_TARGET_INSTANCE_TYPES;
		process.env.LEDGERMATH_TARGET_INSTANCE_TYPES = targets.join(",");
		try {
			const outcome = await launch(delivered("2026-11-12T22:10:00Z", "c6i.32xlarge"), new Date("2026-11-12T22:10:01Z"));
			expect(outcome.launched).toBe(false);
			expect(outcome.launched === false && outcome.reason).toContain("c6i.32xlarge, which is not a target");
		} finally {
			if (before === undefined) delete process.env.LEDGERMATH_TARGET_INSTANCE_TYPES;
			else process.env.LEDGERMATH_TARGET_INSTANCE_TYPES = before;
		}
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

	test("differs from slot to slot, from stage to stage, and from type to type", () => {
		const tokens = new Set([
			clientToken("smr-runs", delivered("2026-11-12T22:10:00Z")),
			clientToken("smr-runs", delivered("2026-11-13T22:10:00Z")),
			clientToken("smr-runs", delivered("2026-11-13T04:10:00Z")),
			clientToken("dev-runs", delivered("2026-11-12T22:10:00Z")),
			clientToken("smr-runs", delivered("2026-11-12T22:10:00Z", "m5.large")),
		]);
		expect(tokens.size).toBe(5);
	});

	test("comes from the stage, the instance type and the scheduled time", () => {
		const expected = createHash("sha256").update("ledgermath-box smr-runs c8i.2xlarge 2026-11-12T04:30:00Z").digest("hex");
		expect(clientToken("smr-runs", delivered("2026-11-12T04:30:00Z", "c8i.2xlarge"))).toBe(expected);
	});

	test("is two tokens, so two boxes, for two targets that boot at the same minute", () => {
		const schedules = launchSchedules([
			{ instance_type: "c8i.2xlarge", vcpus: 8, zone: "us-east-2c", boots_utc: ["04:30"] },
			{ instance_type: "c8a.2xlarge", vcpus: 8, zone: "us-east-2c", boots_utc: ["04:30"] },
		]);
		expect(schedules.map((schedule) => [schedule.expression, schedule.event])).toEqual([
			["cron(30 4 * * ? *)", { scheduledTime: "<aws.scheduler.scheduled-time>", instanceType: "c8i.2xlarge" }],
			["cron(30 4 * * ? *)", { scheduledTime: "<aws.scheduler.scheduled-time>", instanceType: "c8a.2xlarge" }],
		]);
		// What each schedule delivers at 04:30, and the token each launch uses.
		const payloads = schedules.map((schedule) =>
			JSON.parse(JSON.stringify(schedule.event).replace(SCHEDULED_TIME_PLACEHOLDER, "2026-11-12T04:30:00Z")),
		);
		expect(payloads).toEqual([
			{ scheduledTime: "2026-11-12T04:30:00Z", instanceType: "c8i.2xlarge" },
			{ scheduledTime: "2026-11-12T04:30:00Z", instanceType: "c8a.2xlarge" },
		]);
		const [first, second] = payloads.map((payload) => clientToken("smr-runs", payload));
		expect(first).toHaveLength(64);
		expect(second).toHaveLength(64);
		expect(first).not.toBe(second);
		// And each is stable across repeated invocations of its slot.
		expect(clientToken("smr-runs", payloads[0])).toBe(first);
	});

	test("is left to the SDK, fresh each time, for a launch by hand", () => {
		expect(clientToken("smr-runs", {})).toBeUndefined();
		expect(clientToken("smr-runs", { instanceType: "c6i.large" })).toBeUndefined();
		expect(clientToken("smr-runs", undefined)).toBeUndefined();
	});

	test("refuses a payload whose placeholder was not replaced, rather than reuse one token every day", () => {
		expect(() => clientToken("smr-runs", scheduledEvent("c6i.8xlarge"))).toThrow();
		expect(() => clientToken("smr-runs", { scheduledTime: "yesterday", instanceType: "c6i.8xlarge" })).toThrow();
	});

	test("refuses a scheduled payload that names no instance type", () => {
		expect(() => clientToken("smr-runs", { scheduledTime: "2026-11-12T22:10:00Z" })).toThrow("the payload must name an EC2 instance type");
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

describe("where and when the stage launches", () => {
	test("is schedule.json's targets, checked, in one zone", () => {
		expect(TARGETS).toEqual(SCHEDULE.targets);
		expect(TARGETS.map((target) => target.instance_type)).toEqual(["c6i.8xlarge", "m5.large", "c8i.2xlarge", "c8a.2xlarge", "i4i.2xlarge"]);
		expect(ZONE).toBe("us-east-2c");
	});

	test("is one EventBridge schedule per target, a cron of its boot times, invoking the launch with the scheduled time and the type", () => {
		const payload = (instanceType: string) => ({ scheduledTime: "<aws.scheduler.scheduled-time>", instanceType });
		expect(LAUNCH_SCHEDULES).toEqual([
			{ name: "BoxLaunchC6i8xlargeAt10", instanceType: "c6i.8xlarge", zone: "us-east-2c", boots: ["04:10", "10:10", "16:10", "22:10"], expression: "cron(10 4,10,16,22 * * ? *)", event: payload("c6i.8xlarge") },
			{ name: "BoxLaunchM5LargeAt20", instanceType: "m5.large", zone: "us-east-2c", boots: ["04:20", "10:20", "16:20", "22:20"], expression: "cron(20 4,10,16,22 * * ? *)", event: payload("m5.large") },
			{ name: "BoxLaunchC8i2xlargeAt30", instanceType: "c8i.2xlarge", zone: "us-east-2c", boots: ["04:30", "10:30", "16:30", "22:30"], expression: "cron(30 4,10,16,22 * * ? *)", event: payload("c8i.2xlarge") },
			{ name: "BoxLaunchC8a2xlargeAt40", instanceType: "c8a.2xlarge", zone: "us-east-2c", boots: ["04:40", "10:40", "16:40", "22:40"], expression: "cron(40 4,10,16,22 * * ? *)", event: payload("c8a.2xlarge") },
			{ name: "BoxLaunchI4i2xlargeAt50", instanceType: "i4i.2xlarge", zone: "us-east-2c", boots: ["04:50", "10:50", "16:50", "22:50"], expression: "cron(50 4,10,16,22 * * ? *)", event: payload("i4i.2xlarge") },
		]);
		expect(new Set(LAUNCH_SCHEDULES.map((schedule) => schedule.name)).size).toBe(LAUNCH_SCHEDULES.length);
	});

	test("fires at exactly the boot times: a target whose boots fall at two minutes gets a schedule for each", () => {
		const schedules = launchSchedules([{ instance_type: "c6i.8xlarge", vcpus: 32, zone: "us-east-2c", boots_utc: ["22:10", "13:45", "04:10", "00:00"] }]);
		expect(schedules.map((schedule) => [schedule.name, schedule.expression, schedule.boots])).toEqual([
			["BoxLaunchC6i8xlargeAt00", "cron(0 0 * * ? *)", ["00:00"]],
			["BoxLaunchC6i8xlargeAt10", "cron(10 4,22 * * ? *)", ["04:10", "22:10"]],
			["BoxLaunchC6i8xlargeAt45", "cron(45 13 * * ? *)", ["13:45"]],
		]);
	});

	test("is made by the stack from placement.ts alone: one launch function, a CronV2 per schedule, nothing hard-coded", () => {
		expect(STACK).toContain('import { LAUNCH_SCHEDULES, TARGETS, ZONE } from "./placement";');
		expect(STACK).toContain('new sst.aws.Function("BoxLaunchHandler", {');
		// The function of step 2's CronV2 BoxLaunch, kept rather than replaced.
		expect(STACK).toContain("const launchAliases = [{ parent: `urn:pulumi:${$app.stage}::${$app.name}::sst:aws:CronV2::BoxLaunch` }];");
		expect(STACK).toContain("}, { aliases: launchAliases });");
		expect(STACK).toContain("for (const schedule of LAUNCH_SCHEDULES) {");
		expect(STACK).toContain("new sst.aws.CronV2(schedule.name, {");
		expect(STACK).toContain("schedule: schedule.expression,");
		expect(STACK).toContain("event: schedule.event,");
		expect(STACK).toContain("function: launch,");
		expect(STACK).toContain('LEDGERMATH_TARGET_INSTANCE_TYPES: TARGETS.map((target) => target.instance_type).join(","),');
		expect(STACK).toContain('{ name: "availability-zone", values: [ZONE] }');
		// Never retried; an event older than a minute is dropped.
		expect(STACK).toMatch(/new sst\.aws\.Function\("BoxLaunchHandler", \{[^]*?retries: 0,\n\t\ttransform: \{ eventInvokeConfig: \{ maximumEventAgeInSeconds: 60 \} \},/);
		expect(STACK).toContain('\t\t\ttimezone: "UTC",\n\t\t\tretries: 0,\n\t\t\tevent: schedule.event,');
		// No instance type, zone, launch time or launch cron of its own.
		expect(STACK).not.toMatch(/"[a-z][a-z0-9-]*\.[0-9]*(nano|micro|small|medium|large|xlarge|metal)"|"us-east-2[a-z]"|cron\(|LEDGERMATH_INSTANCE_TYPE:/);
	});

	test("lists every target and its schedules among the stack's outputs", () => {
		expect(STACK).toContain("targets: TARGETS.map((target) => ({");
		expect(STACK).toContain("expression: `${schedule.expression} UTC`,");
		expect(STACK).toContain("payload: schedule.event,");
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
