import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSchedule } from "../infra/runs/schedule";
import { type AwsFacts, awsArguments, compareWithAws } from "../scripts/check-targets";

// scripts/check-targets.ts compares schedule.json with what AWS answers. AWS
// is not reached here (CI has no access): these are made-up answers.

const SCHEDULE = parseSchedule(JSON.parse(readFileSync(join(import.meta.dir, "..", "schedule.json"), "utf8")));
const TRUE: AwsFacts = {
	vcpus: { "c6i.8xlarge": 32, "m5.large": 2, "c8i.2xlarge": 8, "c8a.2xlarge": 8, "i4i.2xlarge": 8 },
	offered: ["c6i.8xlarge", "m5.large", "c8i.2xlarge", "c8a.2xlarge", "i4i.2xlarge"],
	quota: 64,
};

describe("comparing schedule.json with AWS", () => {
	test("finds nothing wrong when AWS agrees, and shows each comparison", () => {
		const { lines, problems } = compareWithAws(SCHEDULE, TRUE);
		expect(problems).toEqual([]);
		expect(lines[0]).toContain("c6i.8xlarge");
		expect(lines[0]).toContain("vcpus 32 = AWS 32");
		expect(lines.at(-1)).toBe("targets 58 + reserved 4 = 62 of 64");
	});

	test("reports a target whose vcpus differ from AWS's DefaultVCpus, or which AWS does not know", () => {
		const vcpus = { ...TRUE.vcpus, "m5.large": 4 } as Record<string, number>;
		delete vcpus["i4i.2xlarge"];
		expect(compareWithAws(SCHEDULE, { ...TRUE, vcpus }).problems).toEqual([
			"m5.large: schedule.json says vcpus 2; AWS's DefaultVCpus is 4",
			"i4i.2xlarge: schedule.json says vcpus 8; AWS's DefaultVCpus is not given",
		]);
	});

	test("reports a type not offered in its zone, and a quota that is not the declared limit", () => {
		expect(compareWithAws(SCHEDULE, { ...TRUE, offered: ["c6i.8xlarge", "m5.large", "c8i.2xlarge", "i4i.2xlarge"], quota: 32 }).problems).toEqual([
			"c8a.2xlarge: not offered in us-east-2c",
			"vcpu_quota.limit is 64; the applied quota L-1216C47A is 32",
		]);
	});

	test("counts what could not be read as a problem, so a partial check never passes", () => {
		expect(compareWithAws(SCHEDULE, { vcpus: undefined, offered: undefined, quota: undefined }).problems).toEqual([
			"could not read the instance types' vCPUs",
			"could not read the zone's offerings",
			"could not read the quota L-1216C47A",
		]);
	});
});

describe("which account it reads", () => {
	test("the account of the stage it is run for, by that account's profile", () => {
		expect(awsArguments("production-runs")).toEqual(["--profile", "tabot-production", "--output", "json"]);
		expect(awsArguments("smr-runs")).toEqual(["--profile", "tabot-dev", "--output", "json"]);
		expect(awsArguments("alice-runs")).toEqual(["--profile", "tabot-dev", "--output", "json"]);
		expect(() => awsArguments("production")).toThrow("is not a -runs stage");
	});

	test("every call names the stage's profile, whatever AWS_PROFILE says; no --stage is a usage error", () => {
		// A stand-in aws that records its arguments and answers as the production account would before its quota is raised.
		const directory = mkdtempSync(join(tmpdir(), "check-targets-"));
		try {
			const calls = join(directory, "calls");
			writeFileSync(
				join(directory, "aws"),
				[
					"#!/bin/sh",
					`echo "$*" >> '${calls}'`,
					'case "$*" in',
					'  *describe-instance-types*) echo \'[["c6i.8xlarge",32],["m5.large",2],["c8i.2xlarge",8],["c8a.2xlarge",8],["i4i.2xlarge",8]]\' ;;',
					'  *describe-instance-type-offerings*) echo \'["c6i.8xlarge","m5.large","c8i.2xlarge","c8a.2xlarge","i4i.2xlarge"]\' ;;',
					"  *get-service-quota*) echo 5.0 ;;",
					"esac",
					"",
				].join("\n"),
			);
			chmodSync(join(directory, "aws"), 0o755);
			const script = join(import.meta.dir, "..", "scripts", "check-targets.ts");
			const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, AWS_PROFILE: "tabot-dev" };
			const done = spawnSync("bun", [script, "--stage", "production-runs"], { encoding: "utf8", env, timeout: 30_000 });
			expect(done.status).toBe(1);
			expect(done.stdout).toContain("in the account of production-runs (profile tabot-production)");
			expect(done.stderr).toContain("MISMATCH: vcpu_quota.limit is 64; the applied quota L-1216C47A is 5");
			const lines = readFileSync(calls, "utf8").trim().split("\n");
			expect(lines.length).toBe(3);
			for (const line of lines) expect(line).toEndWith("--profile tabot-production --output json");

			const usage = spawnSync("bun", [script], { encoding: "utf8", env, timeout: 30_000 });
			expect(usage.status).toBe(2);
			expect(usage.stderr).toContain("--stage STAGE");
			expect(readFileSync(calls, "utf8").trim().split("\n").length).toBe(3);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);
});
