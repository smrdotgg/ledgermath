import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSchedule } from "../infra/runs/schedule";
import { type AwsFacts, compareWithAws } from "../scripts/check-targets";

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
