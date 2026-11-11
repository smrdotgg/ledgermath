import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appliesTo, JULY_RULE, parseSchedule, type Schedule, scheduleProblems } from "../infra/runs/schedule";

const ROOT = join(import.meta.dir, "..");
const FILE = JSON.parse(readFileSync(join(ROOT, "schedule.json"), "utf8")) as Schedule;

/** A small valid schedule: two targets, one entry for all and one for m5.large only. */
function valid(): Schedule {
	return {
		targets: [
			{ instance_type: "c6i.8xlarge", zone: "us-east-2c", boots_utc: ["04:10", "22:10"] },
			{ instance_type: "m5.large", zone: "us-east-2c", boots_utc: ["04:20"] },
		],
		benchmarks: [
			{ name: "syscall", builds: ["static"], samples: 10, timeout_seconds: 120, params: [{ call: "getpid" }] },
			{
				name: "syscall",
				builds: ["static"],
				samples: 10,
				timeout_seconds: 120,
				params: [{ call: "stat", path: "/tmp" }],
				instance_types: ["m5.large"],
			},
		],
	};
}

/** The problems with valid() after `change`. */
function problemsAfter(change: (schedule: Schedule & Record<string, unknown>) => void): string[] {
	const schedule = valid() as Schedule & Record<string, unknown>;
	change(schedule);
	return scheduleProblems(JSON.parse(JSON.stringify(schedule)));
}

const target = (schedule: Schedule, index: number) => schedule.targets[index] as Schedule["targets"][number] & Record<string, unknown>;
const entry = (schedule: Schedule, index: number) => schedule.benchmarks[index] as Schedule["benchmarks"][number] & Record<string, unknown>;

describe("schedule.json", () => {
	test("is valid", () => {
		expect(scheduleProblems(FILE)).toEqual([]);
	});

	test("launches the five types of step 4, in us-east-2c, four times a day each, keeping today's 22:10 c6i.8xlarge boot", () => {
		expect(FILE.targets).toEqual([
			{ instance_type: "c6i.8xlarge", zone: "us-east-2c", boots_utc: ["04:10", "10:10", "16:10", "22:10"] },
			{ instance_type: "m5.large", zone: "us-east-2c", boots_utc: ["04:20", "10:20", "16:20", "22:20"] },
			{ instance_type: "c8i.2xlarge", zone: "us-east-2c", boots_utc: ["04:30", "10:30", "16:30", "22:30"] },
			{ instance_type: "c8a.2xlarge", zone: "us-east-2c", boots_utc: ["04:40", "10:40", "16:40", "22:40"] },
			{ instance_type: "i4i.2xlarge", zone: "us-east-2c", boots_utc: ["04:50", "10:50", "16:50", "22:50"] },
		]);
	});

	test("names only benchmarks that have a directory with a Makefile", () => {
		for (const benchmark of FILE.benchmarks) expect(existsSync(join(ROOT, "benchmarks", benchmark.name, "Makefile"))).toBe(true);
	});
});

describe("the schedule's check", () => {
	test("passes a valid schedule, and parseSchedule returns it", () => {
		expect(scheduleProblems(valid())).toEqual([]);
		expect(parseSchedule(valid())).toEqual(valid());
	});

	test("parseSchedule throws, listing every problem", () => {
		const bad = { ...valid(), targets: [] };
		expect(() => parseSchedule(bad, "the test's schedule")).toThrow(
			"the test's schedule is not a valid schedule:\n  - targets must be a non-empty list",
		);
	});

	test("refuses a schedule without targets, or that is not an object", () => {
		expect(scheduleProblems([])).toEqual(["the schedule must be a JSON object with targets and benchmarks"]);
		expect(problemsAfter((s) => delete (s as Partial<Schedule>).targets)).toEqual([
			"targets must be a non-empty list of { instance_type, zone, boots_utc }",
		]);
	});

	test("refuses a key it does not know, so a misspelt instance_types does not silently mean every type", () => {
		expect(problemsAfter((s) => (entry(s, 1).instance_type = ["m5.large"]))).toContain('benchmarks[1]: unknown key "instance_type"');
		expect(problemsAfter((s) => (target(s, 0).boots = ["05:00"]))).toEqual(['targets[0]: unknown key "boots"']);
		expect(problemsAfter((s) => (s.notes = "hi"))).toEqual(['the schedule: unknown key "notes"']);
	});

	describe("a target", () => {
		test("names an instance type and a zone", () => {
			expect(problemsAfter((s) => (target(s, 0).instance_type = "c6i 8xlarge"))[0]).toStartWith("targets[0]: instance_type must be an EC2 instance type");
			expect(problemsAfter((s) => (target(s, 0).zone = "us-east-2"))).toEqual([
				'targets[0]: zone must be an availability zone such as "us-east-2c", got "us-east-2"',
			]);
		});

		test("boots at least once a day, at valid times of day", () => {
			expect(problemsAfter((s) => (target(s, 1).boots_utc = []))).toEqual([
				'targets[1]: boots_utc must be a non-empty list of times such as "22:10"',
			]);
			for (const time of ["24:00", "4:20", "04:60", "04:20Z", 420]) {
				expect(problemsAfter((s) => (target(s, 1).boots_utc = [time as string]))).toEqual([
					`targets[1]: boots_utc holds ${JSON.stringify(time)}, which is not a time of day as HH:MM, 00:00 to 23:59`,
				]);
			}
			expect(problemsAfter((s) => (target(s, 1).boots_utc = ["00:00", "23:59"]))).toEqual([]);
		});

		test("lists each of its times once", () => {
			expect(problemsAfter((s) => (target(s, 1).boots_utc = ["04:20", "10:20", "04:20"]))).toEqual(["targets[1]: boots_utc lists 04:20 twice"]);
		});

		test("is the only target of its instance type", () => {
			expect(problemsAfter((s) => s.targets.push({ instance_type: "m5.large", zone: "us-east-2c", boots_utc: ["16:20"] }))).toEqual([
				"targets: m5.large is listed twice; give one target all of its boot times",
			]);
		});

		test("is in the same zone as every other, since the stage launches into one subnet", () => {
			expect(problemsAfter((s) => (target(s, 1).zone = "us-east-2a"))).toEqual([
				"targets: every target must be in one zone, because the stage launches into one subnet; found us-east-2c, us-east-2a",
			]);
		});

		test("may boot at the same minute as another target", () => {
			expect(problemsAfter((s) => (target(s, 1).boots_utc = ["04:10"]))).toEqual([]);
		});
	});

	describe("while July's pipeline runs", () => {
		test("no c6i.8xlarge boots from 22:20 to 23:40 UTC, both included", () => {
			expect(JULY_RULE).toEqual({ instanceType: "c6i.8xlarge", from: "22:20", to: "23:40" });
			for (const time of ["22:20", "22:30", "23:10", "23:40"]) {
				const problems = problemsAfter((s) => target(s, 0).boots_utc.push(time));
				expect(problems.length).toBe(1);
				expect(problems[0]).toStartWith(`targets: c6i.8xlarge boots at ${time}, but no c6i.8xlarge may boot from 22:20 to 23:40 UTC`);
			}
			for (const time of ["22:19", "23:41", "00:00"]) expect(problemsAfter((s) => target(s, 0).boots_utc.push(time))).toEqual([]);
		});

		test("other types may boot then", () => {
			expect(problemsAfter((s) => (target(s, 1).boots_utc = ["22:20", "23:10", "23:40"]))).toEqual([]);
		});
	});

	describe("a benchmark entry", () => {
		test("has a name, builds, samples, a timeout and parameter sets", () => {
			expect(problemsAfter((s) => (entry(s, 0).name = "../syscall"))[0]).toStartWith("benchmarks[0]: name must be a benchmark's directory");
			expect(problemsAfter((s) => (entry(s, 0).builds = []))).toEqual(['benchmarks[0]: builds must be a non-empty list, such as ["static"]']);
			expect(problemsAfter((s) => (entry(s, 0).builds = ["static", "static"]))).toEqual(["benchmarks[0]: builds lists a build twice"]);
			expect(problemsAfter((s) => (entry(s, 0).samples = 0))).toEqual(["benchmarks[0]: samples must be a whole number of at least 1, got 0"]);
			expect(problemsAfter((s) => (entry(s, 0).timeout_seconds = 1.5))).toEqual([
				"benchmarks[0]: timeout_seconds must be a whole number of at least 1, got 1.5",
			]);
			expect(problemsAfter((s) => (entry(s, 0).params = []))).toEqual(["benchmarks[0]: params must be a non-empty list of parameter sets"]);
		});

		test("gives each parameter as an LM_PARAM_ variable can carry it", () => {
			expect(problemsAfter((s) => (entry(s, 0).params = [{ "Call-Kind": "getpid" }]))[0]).toStartWith(
				'benchmarks[0].params[0]: key "Call-Kind" cannot be an LM_PARAM_ variable',
			);
			expect(problemsAfter((s) => (entry(s, 0).params = [{ call: ["getpid"] } as never]))).toEqual([
				'benchmarks[0].params[0]: call must be a string, a number or a boolean, got ["getpid"]',
			]);
		});

		test("names only target instance types in instance_types, each once, and at least one", () => {
			expect(problemsAfter((s) => (entry(s, 1).instance_types = ["c8i.2xlarge"]))).toEqual([
				'benchmarks[1]: instance_types names "c8i.2xlarge", which is not the instance_type of any target',
			]);
			expect(problemsAfter((s) => (entry(s, 1).instance_types = ["m5.large", "m5.large"]))).toEqual(["benchmarks[1]: instance_types lists a type twice"]);
			expect(problemsAfter((s) => (entry(s, 1).instance_types = []))[0]).toStartWith("benchmarks[1]: instance_types, when given, must be a non-empty list");
			expect(problemsAfter((s) => (entry(s, 1).instance_types = "m5.large" as never))[0]).toStartWith("benchmarks[1]: instance_types, when given");
		});
	});

	describe("a parameter set", () => {
		test("may appear in two entries of one benchmark when they run on different types", () => {
			expect(
				problemsAfter((s) => {
					entry(s, 0).instance_types = ["c6i.8xlarge"];
					entry(s, 1).params = [{ call: "getpid" }];
				}),
			).toEqual([]);
		});

		test("is not run twice for the same benchmark, build and type, whatever the order of its keys", () => {
			expect(problemsAfter((s) => (entry(s, 1).params = [{ path: "/tmp", call: "stat" }, { call: "stat", path: "/tmp" }]))).toEqual([
				'benchmarks[1]: syscall static {"call":"stat","path":"/tmp"} is already run by benchmarks[1], on m5.large',
			]);
			// The entry for every type and the m5.large one both run getpid on m5.large.
			expect(problemsAfter((s) => (entry(s, 1).params = [{ call: "getpid" }]))).toEqual([
				'benchmarks[1]: syscall static {"call":"getpid"} is already run by benchmarks[0], on m5.large',
			]);
			expect(problemsAfter((s) => s.benchmarks.push({ ...entry(s, 0), samples: 5 }))).toEqual([
				'benchmarks[2]: syscall static {"call":"getpid"} is already run by benchmarks[0], on c6i.8xlarge, m5.large',
			]);
		});

		test("may repeat under another build, or in another benchmark", () => {
			expect(problemsAfter((s) => s.benchmarks.push({ ...entry(s, 0), builds: ["dynamic"] }))).toEqual([]);
			expect(problemsAfter((s) => s.benchmarks.push({ ...entry(s, 0), name: "hash" }))).toEqual([]);
		});
	});
});

describe("an entry's instance types", () => {
	test("absent, it runs on every type, and on a box whose type is unknown", () => {
		expect(appliesTo({}, "c6i.8xlarge")).toBe(true);
		expect(appliesTo({}, null)).toBe(true);
	});

	test("given, it runs only on those, never on a box whose type is unknown", () => {
		expect(appliesTo({ instance_types: ["m5.large"] }, "m5.large")).toBe(true);
		expect(appliesTo({ instance_types: ["m5.large"] }, "c6i.8xlarge")).toBe(false);
		expect(appliesTo({ instance_types: ["m5.large"] }, null)).toBe(false);
		expect(appliesTo({ instance_types: ["m5.large"] }, undefined)).toBe(false);
	});
});
