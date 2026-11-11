import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HTTP_GET_FIXTURES } from "../infra/runs/fixtures";
import { appliesTo, JULY_RULE, MIN_BOOT_GAP_MINUTES, parseSchedule, type Schedule, scheduleProblems } from "../infra/runs/schedule";

const ROOT = join(import.meta.dir, "..");
const FILE = JSON.parse(readFileSync(join(ROOT, "schedule.json"), "utf8")) as Schedule;

/** A small valid schedule: two targets, one entry for all and one for m5.large only. */
function valid(): Schedule {
	return {
		vcpu_quota: { limit: 64, reserved_outside_schedule: 4 },
		targets: [
			{ instance_type: "c6i.8xlarge", vcpus: 32, zone: "us-east-2c", boots_utc: ["04:10", "22:10"] },
			{ instance_type: "m5.large", vcpus: 2, zone: "us-east-2c", boots_utc: ["04:20"] },
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
			{ instance_type: "c6i.8xlarge", vcpus: 32, zone: "us-east-2c", boots_utc: ["04:10", "10:10", "16:10", "22:10"] },
			{ instance_type: "m5.large", vcpus: 2, zone: "us-east-2c", boots_utc: ["04:20", "10:20", "16:20", "22:20"] },
			{ instance_type: "c8i.2xlarge", vcpus: 8, zone: "us-east-2c", boots_utc: ["04:30", "10:30", "16:30", "22:30"] },
			{ instance_type: "c8a.2xlarge", vcpus: 8, zone: "us-east-2c", boots_utc: ["04:40", "10:40", "16:40", "22:40"] },
			{ instance_type: "i4i.2xlarge", vcpus: 8, zone: "us-east-2c", boots_utc: ["04:50", "10:50", "16:50", "22:50"] },
		]);
	});

	test("declares the account's 64-vCPU quota and the dev machine's 4, and its targets fit beside them: 58 + 4 = 62", () => {
		expect(FILE.vcpu_quota).toEqual({ limit: 64, reserved_outside_schedule: 4 });
		expect(FILE.targets.reduce((sum, target) => sum + target.vcpus, 0)).toBe(58);
	});

	test("names only benchmarks that have a directory with a Makefile", () => {
		for (const benchmark of FILE.benchmarks) expect(existsSync(join(ROOT, "benchmarks", benchmark.name, "Makefile"))).toBe(true);
	});

	test("gives http_get every parameter benchmarks/http_get/README.md lists, and no other", () => {
		const readme = readFileSync(join(ROOT, "benchmarks", "http_get", "README.md"), "utf8");
		const listed = [...readme.matchAll(/^\| `LM_PARAM_([A-Z_]+)` \|/gm)].map((match) => (match[1] as string).toLowerCase()).sort();
		expect(listed.length).toBeGreaterThan(0);
		for (const entry of FILE.benchmarks.filter((candidate) => candidate.name === "http_get")) {
			for (const params of entry.params) expect(Object.keys(params).sort()).toEqual(listed);
		}
	});

	test("runs http_get last, on every target, static only, against s3_fixtures: the study's five sets", () => {
		const entries = FILE.benchmarks.filter((entry) => entry.name === "http_get");
		expect(FILE.benchmarks.slice(-entries.length)).toEqual(entries);
		const common = {
			gap_mean_ms: 200,
			timeout_ms: 10000,
			ca_file: "/etc/pki/tls/certs/ca-bundle.crt",
			resolv_conf: "/etc/resolv.conf",
			auth: "sigv4",
		};
		const set = (size: number, connection: string, budget: number) => ({ object_bytes: size, key: `http_get/v1/${size}`, connection, budget_seconds: budget, ...common });
		expect(entries.map(({ samples, timeout_seconds, params }) => ({ samples, timeout_seconds, params }))).toEqual([
			{ samples: 200, timeout_seconds: 300, params: [set(4096, "new", 240), set(4096, "reused", 240), set(131072, "new", 240), set(131072, "reused", 240)] },
			{ samples: 40, timeout_seconds: 180, params: [set(16777216, "new", 120)] },
		]);
		for (const entry of entries) {
			expect(entry.builds).toEqual(["static"]);
			expect(entry.service).toBe("s3_fixtures");
			expect(entry.instance_types).toBeUndefined();
			// The runner's timeout is the backstop behind the binary's own budget: a minute more at least.
			for (const params of entry.params) expect(entry.timeout_seconds).toBeGreaterThanOrEqual(Number(params.budget_seconds) + 60);
		}
	});

	test("asks http_get only for the Fixtures the stage makes", () => {
		const keys = FILE.benchmarks.filter((entry) => entry.name === "http_get").flatMap((entry) => entry.params.map((params) => [params.key, params.object_bytes]));
		expect(keys).toEqual(
			[4096, 4096, 131072, 131072, 16777216].map((size) => {
				const fixture = HTTP_GET_FIXTURES.find((candidate) => candidate.bytes === size);
				return [fixture?.key, fixture?.bytes];
			}),
		);
	});
});

describe("the container test's instance-types schedule", () => {
	const file = JSON.parse(readFileSync(join(ROOT, "scripts", "box-in-container", "instance-types.json"), "utf8")) as Schedule;

	test("is valid, and on an m5.large leaves some entries out and runs others, one benchmark from two entries", () => {
		expect(scheduleProblems(file)).toEqual([]);
		const here = file.benchmarks.filter((entry) => appliesTo(entry, "m5.large"));
		expect(here.length).toBeGreaterThan(0);
		expect(here.length).toBeLessThan(file.benchmarks.length);
		expect(here.length).toBeGreaterThan(new Set(here.map((entry) => entry.name)).size);
		for (const benchmark of file.benchmarks) expect(existsSync(join(ROOT, "benchmarks", benchmark.name, "Makefile"))).toBe(true);
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
			"targets must be a non-empty list of { instance_type, vcpus, zone, boots_utc }",
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
			expect(problemsAfter((s) => (target(s, 1).boots_utc = ["00:00", "23:00"]))).toEqual([]);
		});

		test("lists each of its times once", () => {
			expect(problemsAfter((s) => (target(s, 1).boots_utc = ["04:20", "10:20", "04:20"]))).toEqual(["targets[1]: boots_utc lists 04:20 twice"]);
		});

		test("is the only target of its instance type", () => {
			expect(problemsAfter((s) => s.targets.push({ instance_type: "m5.large", vcpus: 2, zone: "us-east-2c", boots_utc: ["16:20"] }))).toEqual([
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

	describe("the vCPU quota", () => {
		test("is declared once, as a limit and what is reserved outside the schedule", () => {
			expect(problemsAfter((s) => delete (s as Partial<Schedule>).vcpu_quota)).toEqual([
				'vcpu_quota must be an object such as { "limit": 64, "reserved_outside_schedule": 4 }',
			]);
			expect(problemsAfter((s) => (s.vcpu_quota.limit = 0))).toEqual(["vcpu_quota: limit must be the account's vCPU quota, a whole number of at least 1, got 0"]);
			expect(problemsAfter((s) => (s.vcpu_quota.reserved_outside_schedule = -1))).toEqual([
				"vcpu_quota: reserved_outside_schedule must be a whole number of vCPUs, 0 or more, got -1",
			]);
			expect(problemsAfter((s) => (s.vcpu_quota.reserved_outside_schedule = 0))).toEqual([]);
			expect(problemsAfter((s) => ((s.vcpu_quota as unknown as Record<string, unknown>).dev_machine = 4))).toEqual(['vcpu_quota: unknown key "dev_machine"']);
		});

		test("needs every target's vcpus", () => {
			expect(problemsAfter((s) => delete (target(s, 1) as Partial<Schedule["targets"][number]>).vcpus)).toEqual([
				"targets[1]: vcpus must be the type's vCPUs as AWS counts them, a whole number of at least 1, got undefined",
			]);
			expect(problemsAfter((s) => (target(s, 1).vcpus = 1.5))[0]).toStartWith("targets[1]: vcpus must be");
		});

		test("rule A: refuses targets whose vCPUs together, beside what is reserved, exceed the quota", () => {
			// 58 + 4 = 62 of 64 fits; a sixth target of 4 vCPUs makes 66.
			const five = (s: Schedule) => {
				s.targets = FILE.targets.map((t) => ({ ...t, boots_utc: [...t.boots_utc] }));
			};
			expect(problemsAfter(five)).toEqual([]);
			expect(
				problemsAfter((s) => {
					five(s);
					s.targets.push({ instance_type: "c6i.xlarge", vcpus: 4, zone: "us-east-2c", boots_utc: ["05:00"] });
				}),
			).toEqual([
				"targets: their vCPUs together (62) and the 4 reserved outside the schedule make 66, over the quota of 64; with every target's box up at once, a launch would be refused",
			]);
			// Whatever the boot times: two 32-vCPU targets that never boot within hours of each other still cannot both be targets.
			expect(problemsAfter((s) => s.targets.push({ instance_type: "c7i.8xlarge", vcpus: 32, zone: "us-east-2c", boots_utc: ["12:00"] })).at(-1)).toStartWith(
				"targets: their vCPUs together (66)",
			);
			// Exactly the quota fits.
			expect(problemsAfter((s) => (s.vcpu_quota.limit = 38))).toEqual([]);
			expect(problemsAfter((s) => (s.vcpu_quota.limit = 37))[0]).toStartWith("targets: their vCPUs together (34) and the 4 reserved outside the schedule make 38, over the quota of 37");
		});

		test(`rule B: refuses two boots of one target less than ${MIN_BOOT_GAP_MINUTES} minutes apart`, () => {
			expect(MIN_BOOT_GAP_MINUTES).toBe(60);
			expect(problemsAfter((s) => (target(s, 0).boots_utc = ["04:10", "04:11"]))).toEqual([
				"targets: c6i.8xlarge boots at 04:10 and 04:11, 1 minute apart; a target's boots must be at least 60 minutes apart, across midnight too, so one box has ended before the next starts",
			]);
			expect(problemsAfter((s) => (target(s, 1).boots_utc = ["10:20", "04:20", "10:50"]))).toEqual([
				"targets: m5.large boots at 10:20 and 10:50, 30 minutes apart; a target's boots must be at least 60 minutes apart, across midnight too, so one box has ended before the next starts",
			]);
			expect(problemsAfter((s) => (target(s, 0).boots_utc = ["04:10", "05:10"]))).toEqual([]); // exactly 60
		});

		test("rule B: across midnight too", () => {
			expect(problemsAfter((s) => (target(s, 1).boots_utc = ["23:30", "00:10"]))).toEqual([
				"targets: m5.large boots at 23:30 and 00:10, 40 minutes apart; a target's boots must be at least 60 minutes apart, across midnight too, so one box has ended before the next starts",
			]);
			expect(problemsAfter((s) => (target(s, 1).boots_utc = ["23:30", "00:30"]))).toEqual([]);
		});
	});

	describe("while July's pipeline runs", () => {
		test("no c6i.8xlarge boots from 22:20 to 23:40 UTC, both included", () => {
			expect(JULY_RULE).toEqual({ instanceType: "c6i.8xlarge", from: "22:20", to: "23:40" });
			for (const time of ["22:20", "22:30", "23:10", "23:40"]) {
				const problems = problemsAfter((s) => (target(s, 0).boots_utc = ["10:10", time]));
				expect(problems.length).toBe(1);
				expect(problems[0]).toStartWith(`targets: c6i.8xlarge boots at ${time}, but no c6i.8xlarge may boot from 22:20 to 23:40 UTC`);
			}
			for (const time of ["22:19", "23:41", "00:00"]) expect(problemsAfter((s) => (target(s, 0).boots_utc = ["10:10", time]))).toEqual([]);
		});

		test("other types may boot then", () => {
			for (const time of ["22:20", "23:10", "23:40"]) expect(problemsAfter((s) => (target(s, 1).boots_utc = [time]))).toEqual([]);
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

		test("may name a Service its benchmark measures, one runner/run.py can give", () => {
			expect(problemsAfter((s) => (entry(s, 0).service = "s3_fixtures"))).toEqual([]);
			expect(problemsAfter((s) => (entry(s, 0).service = "s3" as never))).toEqual([
				'benchmarks[0]: service must be one of s3_fixtures, the Services runner/run.py can give, got "s3"',
			]);
			expect(problemsAfter((s) => (entry(s, 0).service = ["s3_fixtures"] as never))[0]).toStartWith("benchmarks[0]: service must be one of");
			expect(problemsAfter((s) => (entry(s, 0).services = "s3_fixtures"))).toEqual(['benchmarks[0]: unknown key "services"']);
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
