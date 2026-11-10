import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Instance, Tag } from "@aws-sdk/client-ec2";

import { boxTags } from "../infra/runs/launch-box";
import { chooseInstanceType, clientToken, SCHEDULED_EVENT } from "../infra/runs/launch-event";
import { MAX_AGE_MS, staleBoxes } from "../infra/runs/reap-boxes";
import { BOX_MARKER, buildUserData, USER_DATA_LIMIT_BYTES } from "../infra/runs/user-data";

const BOX_SH = readFileSync(join(import.meta.dir, "..", "runner", "box.sh"), "utf8");
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

describe("the launch's client token", () => {
	/** The schedule's payload as EventBridge Scheduler delivers it at `time`. */
	const delivered = (time: string): unknown =>
		JSON.parse(JSON.stringify(SCHEDULED_EVENT).replace("<aws.scheduler.scheduled-time>", time));

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
