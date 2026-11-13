/**
 * The shape of schedule.json, and the one check of it. The stage reads the
 * targets from it at deploy (infra/runs/placement.ts), the alarm reads it to
 * know what it watches (scripts/alarm.ts), the tests check it
 * (tests/schedule.test.ts), and the box runs it (runner/run.py, which checks
 * only what it must to run safely and leaves the rest to this file).
 *
 *     {
 *       "vcpu_quota": { "limit": 64, "reserved_outside_schedule": 4 },
 *       "targets": [
 *         { "instance_type": "c6i.8xlarge", "vcpus": 32, "zone": "us-east-2c", "boots_utc": ["04:10", "22:10"] }
 *       ],
 *       "benchmarks": [
 *         { "name": "syscall", "builds": ["static"], "samples": 10, "timeout_seconds": 120,
 *           "params": [{ "call": "getpid" }], "instance_types": ["c6i.8xlarge"] }
 *       ]
 *     }
 *
 * A target is an instance type the stage launches, in a zone, at each of the
 * times of day in boots_utc; vcpus is how many vCPUs one box of it counts
 * against the account's quota (scripts/check-targets.ts compares it with
 * AWS). vcpu_quota is the account's quota of vCPUs for these instances, and
 * how many of them are held outside the schedule (the dev machine). The check
 * keeps every box the schedule launches inside the quota: all targets
 * together fit beside what is reserved, and a target's boots are far enough
 * apart that it never overlaps itself.
 *
 * A benchmark entry runs on every target unless it names instance_types, in
 * which case it runs only on those. Two entries may share a name, so one
 * benchmark can run different parameter sets on different types. An entry
 * may name a Service its benchmark measures, one of SERVICES; runner/run.py
 * then gives its executions that Service's inputs (LM_SERVICE_*).
 *
 * Plain data: no SST global and no file access, so the launch Lambda, tests
 * and scripts can import it.
 */

export type ParamValue = string | number | boolean;

export interface Target {
	/** An EC2 instance type, in AWS's words. */
	instance_type: string;
	/** The vCPUs one box of this type counts against the quota: AWS's DefaultVCpus for the type. */
	vcpus: number;
	/** The availability zone whose default subnet the box is launched in. */
	zone: string;
	/** The times of day, UTC, as HH:MM, at which the stage launches a box of this type. */
	boots_utc: string[];
}

export interface BenchmarkEntry {
	/** The directory under benchmarks/. */
	name: string;
	builds: string[];
	samples: number;
	timeout_seconds: number;
	/** Each one is delivered to the binary as LM_PARAM_<KEY>=<value>. */
	params: Array<Record<string, ParamValue>>;
	/** The instance types this entry runs on. Absent means every target. */
	instance_types?: string[];
	/** The Service the benchmark measures, whose inputs runner/run.py delivers. */
	service?: (typeof SERVICES)[number];
}

/**
 * The Services runner/run.py can give a benchmark's executions. s3_fixtures:
 * the stage's private bucket of Fixtures (infra/runs/fixtures.ts), as
 * LM_SERVICE_ENDPOINT, LM_SERVICE_REGION and three short-lived keys.
 */
export const SERVICES = ["s3_fixtures"] as const;

/** The account's quota of vCPUs for the instances the schedule launches. */
export interface VcpuQuota {
	/** The quota's value: Running On-Demand Standard instances, L-1216C47A, in the stage's region. */
	limit: number;
	/** vCPUs held outside the schedule, all the time: the dev machine. */
	reserved_outside_schedule: number;
}

export interface Schedule {
	vcpu_quota: VcpuQuota;
	targets: Target[];
	benchmarks: BenchmarkEntry[];
}

/** An EC2 instance type, such as c6i.8xlarge or u-6tb1.metal. */
export const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
const ZONE = /^[a-z]{2}-[a-z]+-[0-9][a-z]$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** A directory name, a build name, or a parameter's key (which becomes LM_PARAM_<KEY>). */
const WORD = /^[a-z][a-z0-9_]*$/;

const TARGET_KEYS = new Set(["instance_type", "vcpus", "zone", "boots_utc"]);
const ENTRY_KEYS = new Set(["name", "builds", "samples", "timeout_seconds", "params", "instance_types", "service"]);
const SCHEDULE_KEYS = new Set(["vcpu_quota", "targets", "benchmarks"]);
const QUOTA_KEYS = new Set(["limit", "reserved_outside_schedule"]);

/**
 * Two boots of one target are at least this far apart, across midnight too, so
 * a box has ended before the next of its type starts: a box lives at most 55
 * minutes (its own 45-minute timer as a rule; the reaper ends it after 50, and
 * runs every 5). With this, and every target's vCPUs together fitting the
 * quota beside what is reserved, no box the schedule launches can be refused
 * for the quota, whatever the times.
 */
export const MIN_BOOT_GAP_MINUTES = 60;
const MINUTES_PER_DAY = 24 * 60;

/** Minutes after midnight of an HH:MM time. */
export function minuteOfDay(time: string): number {
	return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

const isCount = (value: unknown, least: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= least;

/** Whether a schedule entry runs on a box of this instance type. An entry without instance_types runs on every type. */
export function appliesTo(entry: Pick<BenchmarkEntry, "instance_types">, instanceType: string | null | undefined): boolean {
	return entry.instance_types === undefined || (typeof instanceType === "string" && entry.instance_types.includes(instanceType));
}

/** JSON with object keys sorted, so two parameter sets that differ only in key order are the same. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const show = (value: unknown): string => JSON.stringify(value);

function unknownKeys(where: string, value: Record<string, unknown>, known: Set<string>, problems: string[]): void {
	for (const key of Object.keys(value)) if (!known.has(key)) problems.push(`${where}: unknown key ${show(key)}`);
}

function checkTarget(where: string, target: unknown, problems: string[]): target is Target {
	if (!isObject(target)) {
		problems.push(`${where}: must be an object`);
		return false;
	}
	unknownKeys(where, target, TARGET_KEYS, problems);
	const before = problems.length;
	if (typeof target.instance_type !== "string" || !INSTANCE_TYPE.test(target.instance_type)) {
		problems.push(`${where}: instance_type must be an EC2 instance type such as "c6i.8xlarge", got ${show(target.instance_type)}`);
	}
	if (!isCount(target.vcpus, 1)) {
		problems.push(`${where}: vcpus must be the type's vCPUs as AWS counts them, a whole number of at least 1, got ${show(target.vcpus)}`);
	}
	if (typeof target.zone !== "string" || !ZONE.test(target.zone)) {
		problems.push(`${where}: zone must be an availability zone such as "us-east-2c", got ${show(target.zone)}`);
	}
	const boots = target.boots_utc;
	if (!Array.isArray(boots) || boots.length === 0) {
		problems.push(`${where}: boots_utc must be a non-empty list of times such as "22:10"`);
		return false;
	}
	const seen = new Set<string>();
	for (const time of boots) {
		if (typeof time !== "string" || !TIME.test(time)) {
			problems.push(`${where}: boots_utc holds ${show(time)}, which is not a time of day as HH:MM, 00:00 to 23:59`);
		} else if (seen.has(time)) {
			problems.push(`${where}: boots_utc lists ${time} twice`);
		} else {
			seen.add(time);
		}
	}
	return problems.length === before;
}

/** targetTypes is null when the schedule has no list of targets to check instance_types against. */
function checkEntry(where: string, entry: unknown, targetTypes: Set<string> | null, problems: string[]): entry is BenchmarkEntry {
	if (!isObject(entry)) {
		problems.push(`${where}: must be an object`);
		return false;
	}
	unknownKeys(where, entry, ENTRY_KEYS, problems);
	const before = problems.length;
	if (typeof entry.name !== "string" || !WORD.test(entry.name)) {
		problems.push(`${where}: name must be a benchmark's directory under benchmarks/, got ${show(entry.name)}`);
	}
	const builds = entry.builds;
	if (!Array.isArray(builds) || builds.length === 0) {
		problems.push(`${where}: builds must be a non-empty list, such as ["static"]`);
	} else {
		for (const build of builds) if (typeof build !== "string" || !WORD.test(build)) problems.push(`${where}: builds holds ${show(build)}, which is not a build name`);
		if (new Set(builds).size !== builds.length) problems.push(`${where}: builds lists a build twice`);
	}
	for (const key of ["samples", "timeout_seconds"] as const) {
		const value = entry[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1) problems.push(`${where}: ${key} must be a whole number of at least 1, got ${show(value)}`);
	}
	const params = entry.params;
	if (!Array.isArray(params) || params.length === 0) {
		problems.push(`${where}: params must be a non-empty list of parameter sets`);
	} else {
		params.forEach((set: unknown, index) => {
			if (!isObject(set)) {
				problems.push(`${where}.params[${index}]: must be an object`);
				return;
			}
			for (const [key, value] of Object.entries(set)) {
				if (!WORD.test(key)) problems.push(`${where}.params[${index}]: key ${show(key)} cannot be an LM_PARAM_ variable; use lower case, digits and _`);
				const isValue = typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
				if (!isValue) problems.push(`${where}.params[${index}]: ${key} must be a string, a number or a boolean, got ${show(value)}`);
			}
		});
	}
	if (entry.instance_types !== undefined) {
		const types = entry.instance_types;
		if (!Array.isArray(types) || types.length === 0) {
			problems.push(`${where}: instance_types, when given, must be a non-empty list of target instance types; leave it out to run on every target`);
		} else {
			for (const type of types) {
				if (typeof type !== "string" || (targetTypes !== null && !targetTypes.has(type))) {
					problems.push(`${where}: instance_types names ${show(type)}, which is not the instance_type of any target`);
				}
			}
			if (new Set(types).size !== types.length) problems.push(`${where}: instance_types lists a type twice`);
		}
	}
	if (entry.service !== undefined && !(SERVICES as readonly unknown[]).includes(entry.service)) {
		problems.push(`${where}: service must be one of ${SERVICES.join(", ")}, the Services runner/run.py can give, got ${show(entry.service)}`);
	}
	return problems.length === before;
}

/** Every problem with a schedule, each saying where it is; empty when the schedule is valid. */
export function scheduleProblems(value: unknown): string[] {
	const problems: string[] = [];
	if (!isObject(value)) return ["the schedule must be a JSON object with targets and benchmarks"];
	unknownKeys("the schedule", value, SCHEDULE_KEYS, problems);

	const listed: unknown[] = Array.isArray(value.targets) ? value.targets : [];
	if (listed.length === 0) problems.push("targets must be a non-empty list of { instance_type, vcpus, zone, boots_utc }");
	const targets: Target[] = [];
	listed.forEach((target, index) => {
		if (checkTarget(`targets[${index}]`, target, problems)) targets.push(target);
	});

	// Every type a target names, even a target with another problem, so that
	// one bad boot time is not also reported for every entry naming its type.
	const types = new Set<string>();
	for (const target of listed) {
		const type = isObject(target) ? target.instance_type : undefined;
		if (typeof type !== "string" || !INSTANCE_TYPE.test(type)) continue;
		if (types.has(type)) problems.push(`targets: ${type} is listed twice; give one target all of its boot times`);
		types.add(type);
	}
	const zones = [...new Set(targets.map((target) => target.zone))];
	if (zones.length > 1) {
		problems.push(`targets: every target must be in one zone, because the stage launches into one subnet; found ${zones.join(", ")}`);
	}

	// Rule A: every target's box at once fits the quota beside what is reserved.
	const quota = value.vcpu_quota;
	let quotaValid = false;
	if (!isObject(quota)) {
		problems.push('vcpu_quota must be an object such as { "limit": 64, "reserved_outside_schedule": 4 }');
	} else {
		unknownKeys("vcpu_quota", quota, QUOTA_KEYS, problems);
		const before = problems.length;
		if (!isCount(quota.limit, 1)) problems.push(`vcpu_quota: limit must be the account's vCPU quota, a whole number of at least 1, got ${show(quota.limit)}`);
		if (!isCount(quota.reserved_outside_schedule, 0)) {
			problems.push(`vcpu_quota: reserved_outside_schedule must be a whole number of vCPUs, 0 or more, got ${show(quota.reserved_outside_schedule)}`);
		}
		quotaValid = problems.length === before;
	}
	const counts = listed.map((target) => (isObject(target) ? target.vcpus : undefined));
	if (quotaValid && listed.length > 0 && counts.every((count) => isCount(count, 1))) {
		const { limit, reserved_outside_schedule: reserved } = quota as unknown as VcpuQuota;
		const sum = (counts as number[]).reduce((total, count) => total + count, 0);
		if (sum + reserved > limit) {
			problems.push(
				`targets: their vCPUs together (${sum}) and the ${reserved} reserved outside the schedule make ${sum + reserved}, over the quota of ${limit}; with every target's box up at once, a launch would be refused`,
			);
		}
	}

	// Rule B: a target never overlaps itself.
	for (const target of targets) {
		const minutes = target.boots_utc.map(minuteOfDay).sort((a, b) => a - b);
		if (minutes.length < 2) continue;
		minutes.forEach((minute, index) => {
			const next = index + 1 < minutes.length ? (minutes[index + 1] as number) : (minutes[0] as number) + MINUTES_PER_DAY;
			if (next - minute >= MIN_BOOT_GAP_MINUTES) return;
			const time = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
			problems.push(
				`targets: ${target.instance_type} boots at ${time(minute)} and ${time(next)}, ${next - minute} minute${next - minute === 1 ? "" : "s"} apart; a target's boots must be at least ${MIN_BOOT_GAP_MINUTES} minutes apart, across midnight too, so one box has ended before the next starts`,
			);
		});
	}

	if (!Array.isArray(value.benchmarks)) {
		problems.push("benchmarks must be a list");
		return problems;
	}
	const entries: BenchmarkEntry[] = [];
	value.benchmarks.forEach((entry: unknown, index) => {
		if (checkEntry(`benchmarks[${index}]`, entry, listed.length > 0 ? types : null, problems)) entries.push(entry);
	});

	// A Series is one benchmark, parameter set and build on one instance type;
	// a boot that ran one twice would hold two Runs of it.
	const seen = new Map<string, number>();
	const duplicates = new Map<string, { message: string; types: string[] }>();
	for (const type of new Set(targets.map((target) => target.instance_type))) {
		value.benchmarks.forEach((entry: unknown, index) => {
			if (!entries.includes(entry as BenchmarkEntry)) return;
			const valid = entry as BenchmarkEntry;
			if (!appliesTo(valid, type)) return;
			for (const build of valid.builds) {
				for (const params of valid.params) {
					const key = canonical([valid.name, build, type, params]);
					const first = seen.get(key);
					if (first === undefined) {
						seen.set(key, index);
						continue;
					}
					// Said once for every type it happens on.
					const message = `benchmarks[${index}]: ${valid.name} ${build} ${canonical(params)} is already run by benchmarks[${first}]`;
					const duplicate = duplicates.get(message) ?? { message, types: [] };
					duplicate.types.push(type);
					duplicates.set(message, duplicate);
				}
			}
		});
	}
	for (const { message, types } of duplicates.values()) problems.push(`${message}, on ${types.join(", ")}`);
	return problems;
}

/** The schedule, checked; throws listing every problem when it is not valid. */
export function parseSchedule(value: unknown, where = "schedule.json"): Schedule {
	const problems = scheduleProblems(value);
	if (problems.length > 0) throw new Error(`${where} is not a valid schedule:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
	return value as Schedule;
}
