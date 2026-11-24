/**
 * Method version 1: which Runs make one Series, which recorded facts split a
 * Series into groups, and which Runs count.
 */

import { createHash } from "node:crypto";

import { canonicalJson, type ParamValue, type Run, type RunExit, type Stream, schemaValidators } from "../run";
import { countedSamples, observedBytesPerRepetition, type SampleTime } from "./numbers";
import { countProblem, streamCheck } from "./stream";

/** The Runs that share these make one Series. */
export interface SeriesKey {
	benchmark: string;
	params: Record<string, ParamValue>;
	build: string;
	instance_type: string | null;
	availability_zone_id: string | null;
}

export function seriesKey(run: Run): SeriesKey {
	return {
		benchmark: run.benchmark,
		params: run.params,
		build: run.binary.build,
		instance_type: run.provider.instance_type ?? null,
		availability_zone_id: run.provider.availability_zone_id ?? null,
	};
}

/** The same text for every Run of one Series, whatever order its params were written in. */
export function seriesKeyText(key: SeriesKey): string {
	return canonicalJson(key);
}

export function seriesId(key: SeriesKey): string {
	return createHash("sha256").update(seriesKeyText(key)).digest("hex").slice(0, 12);
}

/**
 * Dump sections whose contents version 1 does not read. Each changes on every
 * read (cpuinfo's "cpu MHz"; meminfo, loadavg, uptime; every block device's
 * I/O counters; every Amazon NVMe disk's counters and latency histograms; the
 * network card's and the kernel's traffic counters), so only their hashes are
 * compared, and "what differed" says they changed without naming keys;
 * reading cpuinfo and memory alone would cost about 50 KB of fetches per Run.
 */
export const UNREAD_SECTIONS: ReadonlySet<string> = new Set(["cpuinfo", "memory", "block_stat", "nvme_stats", "net_counters"]);

/** The key in the kernel section that holds the box's host name. */
export const KERNEL_HOST_KEY = "$ uname -a";

/** A recorded fact that splits a Series: what it is, and where it is read from. */
export interface SplitFact {
	fact: string;
	what: string;
	/** The before-dump section it is read from, if it is. */
	section?: string;
}

/**
 * The facts version 1 splits on, in this order. Each is read from the Run,
 * or from the dump the Run names as environment.before.
 *
 * Dump sections were chosen from the Runs: a section is split on when its
 * hash was the same before and after every Run, and across all Runs of a
 * boot, and it holds nothing that names the box itself. A section is compared
 * whole, apart from what LEFT_OUT lists.
 */
export const SPLIT_FACTS: readonly SplitFact[] = [
	{ fact: "binary", what: "binary.blob: the bytes that ran" },
	{ fact: "runner", what: "runner: the manifest of the runner that launched the binary, a blob listing each of its files with its hash" },
	{ fact: "samples", what: "samples: LM_SAMPLES" },
	{ fact: "image", what: "provider.image_id" },
	{ fact: "cpuid", what: "dump section cpuid: the raw cpuid leaves of every CPU, without what is left out", section: "cpuid" },
	{ fact: "lscpu", what: "dump section lscpu, without what is left out", section: "lscpu" },
	{ fact: "sys_cpu", what: "dump section sys_cpu: topology, caches, vulnerabilities, microcode, cpufreq, cpuidle", section: "sys_cpu" },
	{ fact: "kernel", what: "dump section kernel, without what is left out", section: "kernel" },
	{ fact: "process", what: "dump section process: limits, cgroup, allowed CPUs", section: "process" },
	{ fact: "packages", what: "dump section packages: every installed package and version", section: "packages" },
];

/** What version 1 does not split on, and why. Every dump section is in "what differed" all the same. */
export const NOT_SPLIT_ON: readonly SplitFact[] = [
	{ fact: "source_commit, source", what: "they change with every commit, whether or not the benchmark did" },
	{ fact: "cpuinfo", what: "changes on every read (each CPU's current MHz)" },
	{ fact: "memory", what: "changes on every read (meminfo, loadavg, uptime, pressure)" },
	{ fact: "block_stat", what: "changes on every read (each block device's I/O counters, /sys/block/*/stat)" },
	{ fact: "nvme_stats", what: "changes on every read (each Amazon NVMe disk's I/O counters and latency histograms, nvme amzn stats)" },
	{
		fact: "net_counters",
		what:
			"changes on every read (the default route's interface's own statistics, ethtool -S, with ENA's allowance-exceeded " +
			"counters; /proc/net/dev, /proc/net/snmp, /proc/net/netstat)",
	},
	{
		fact: "network",
		what:
			"the routes, MTUs, TCP and socket settings, resolver files and network driver; added for the Service benchmarks " +
			"after version 1's facts were chosen, and left to the Method that reads their requests",
	},
	{ fact: "devices", what: "holds the root volume's serial, which is new on every launch" },
	{
		fact: "provider",
		what:
			"holds the instance ID, private address and launch time, new on every launch; its instance type " +
			"and zone ID make the Series, and its image is split on",
	},
	{
		fact: "provision",
		what:
			"the box script's record of preparing the disks at boot: every command with its start and end times, new on " +
			"every boot, and what it printed, which names the disks by serial",
	},
	{
		fact: "ec2_instance_type",
		what:
			"the EC2 API's catalog record of the instance type, taken once per boot: the instance type already makes the " +
			"Series, AWS may revise the record without the machine changing, and a failed call records its error instead",
	},
	{ fact: "ec2_volumes", what: "names the instance's volumes and holds their creation times and status, new on every launch" },
	{ fact: "ec2_instance", what: "names the instance and holds its addresses and launch time, new on every launch" },
	{
		fact: "ec2_route_tables, ec2_vpc_endpoints",
		what:
			"the EC2 API's record of the path out of the box's subnet, taken once per boot: the route tables and the " +
			"VPC's endpoints, shared by every box of the stage; a failed call records its error instead",
	},
];

/** A value left out of a section before it is compared for the split. */
export interface LeftOut {
	section: string;
	what: string;
	why: string;
}

/**
 * Everything version 1 leaves out of a section before comparing it for the
 * split, and nothing else: each is a value measured or assigned anew at every
 * boot, so it would split every boot from every other. Any other difference,
 * anticipated or not, still splits. "What differed" still reports the raw
 * sections, and marks a difference that lies only in what is left out.
 */
export const LEFT_OUT: readonly LeftOut[] = [
	{
		section: "cpuid",
		what: "the lines of hypervisor leaf 0x40000010, one per CPU",
		why:
			"its eax is the TSC frequency in kHz as calibrated for the boot: 2,899,996 (0x002c401c) on the c6i.8xlarge " +
			"boot of 2026-11-10 23:36 UTC, 2,899,978 (0x002c400a) on the one of 2026-11-11 00:23 UTC; the other 2,208 " +
			"lines of the two dumps are identical",
	},
	{
		section: "lscpu",
		what: "the BogoMIPS field",
		why: "the kernel's delay-loop calibration at boot, from the same TSC frequency: 5799.99 and 5799.95 on those two boots",
	},
	{
		section: "kernel",
		what: `the "${KERNEL_HOST_KEY}" entry`,
		why: "it holds the host name, which comes from the private address and is new on every launch",
	},
];

export type Facts = Record<string, string | number | null>;

/** The bytes of the blobs this Method reads, by hash. */
export type BlobMap = ReadonlyMap<string, Uint8Array>;

function sectionJson(hash: string, blobs: BlobMap): Record<string, unknown> {
	const bytes = blobs.get(hash);
	if (bytes === undefined) throw new Error(`blob ${hash} was not fetched`);
	const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${hash} is not a dump section`);
	return value as Record<string, unknown>;
}

const CPUID_CALIBRATION_LINE = /^\s*0x40000010 0x[0-9a-f]+:/;
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** lscpu -J output without any entry whose field is "BogoMIPS:", at any depth. */
function withoutBogomips(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value
			.filter((item) => !(isObject(item) && typeof item.field === "string" && item.field.replace(/:$/, "").trim() === "BogoMIPS"))
			.map(withoutBogomips);
	}
	if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutBogomips(item)]));
	return value;
}

/** Applies f to the stdout of every command result in a section. */
function mapStdout(section: Record<string, unknown>, f: (stdout: string) => string): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(section).map(([key, value]) =>
			isObject(value) && typeof value.stdout === "string" ? [key, { ...value, stdout: f(value.stdout) }] : [key, value],
		),
	);
}

/** A section's contents without what LEFT_OUT lists for it. */
export function withoutLeftOut(name: string, section: Record<string, unknown>): Record<string, unknown> {
	if (name === "kernel") {
		const { [KERNEL_HOST_KEY]: _host, ...rest } = section;
		return rest;
	}
	if (name === "cpuid") {
		return mapStdout(section, (stdout) =>
			stdout
				.split("\n")
				.filter((line) => !CPUID_CALIBRATION_LINE.test(line))
				.join("\n"),
		);
	}
	if (name === "lscpu") {
		return mapStdout(section, (stdout) => {
			try {
				return canonicalJson(withoutBogomips(JSON.parse(stdout)));
			} catch {
				return stdout; // not JSON: compared whole
			}
		});
	}
	return section;
}

const LEFT_OUT_SECTIONS: ReadonlySet<string> = new Set(LEFT_OUT.map(({ section }) => section));

/**
 * A section's split fact: its hash, or for a section LEFT_OUT names,
 * canonical-json-sha256:<hex>, the sha256 of what remains as JSON with keys
 * sorted and no whitespace.
 */
export function sectionFact(name: string, hash: string, blobs: BlobMap): string {
	if (!LEFT_OUT_SECTIONS.has(name)) return hash;
	const remaining = withoutLeftOut(name, sectionJson(hash, blobs));
	return `canonical-json-sha256:${createHash("sha256").update(canonicalJson(remaining)).digest("hex")}`;
}

/** The split facts of one Run, given the sections of its before-dump. */
export function splitFacts(run: Run, before: Record<string, string>, blobs: BlobMap): Facts {
	const section = (name: string): string | null => {
		const hash = before[name];
		return hash === undefined ? null : sectionFact(name, hash, blobs);
	};
	return {
		binary: run.binary.blob,
		runner: run.runner,
		samples: run.samples,
		image: run.provider.image_id ?? null,
		cpuid: section("cpuid"),
		lscpu: section("lscpu"),
		sys_cpu: section("sys_cpu"),
		kernel: section("kernel"),
		process: section("process"),
		packages: section("packages"),
	};
}

/**
 * The top-level keys whose values differ between two versions of a dump
 * section, sorted; null when they are not read (UNREAD_SECTIONS) or one side
 * has no such section.
 */
export function changedKeys(name: string, from: string | undefined, to: string | undefined, blobs: BlobMap): string[] | null {
	if (UNREAD_SECTIONS.has(name) || from === undefined || to === undefined) return null;
	const a = sectionJson(from, blobs);
	const b = sectionJson(to, blobs);
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys]
		.filter((key) => !(key in a) || !(key in b) || canonicalJson(a[key]) !== canonicalJson(b[key]))
		.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

function describeExit(exit: RunExit): string | null {
	if ("code" in exit) return exit.code === 0 ? null : `exit code ${exit.code}`;
	const timeout = exit.timeout_seconds === undefined ? "" : ` (the runner's ${exit.timeout_seconds} s timeout)`;
	return `killed by signal ${exit.signal}${timeout}`;
}

export interface Outcome {
	/** Why the Run is kept out of every percentile; empty when it counts. */
	failures: string[];
	samples: SampleTime[];
}

/** How many of a failed Run's reasons its point shows, and how many characters of each. */
export const SHOWN_REASONS = 10;
export const REASON_CHARACTERS = 500;

/**
 * A failed Run's reasons as its point shows them, in both Methods: the first
 * SHOWN_REASONS, each cut to its first REASON_CHARACTERS characters (Unicode
 * code points), and how many more there are. A stream can have a problem on
 * every line, and a reason can quote what the stream holds, so one failed Run
 * would otherwise write as much into a month file and its Series file as its
 * stdout holds, past the files' ceilings, and stop every publish. At most
 * about 5 KB.
 */
export function failureText(reasons: readonly string[]): string {
	const shown = reasons.slice(0, SHOWN_REASONS).map(cutReason);
	const more = reasons.length - shown.length;
	if (more > 0) shown.push(`and ${more} more reason${more === 1 ? "" : "s"}, not shown`);
	return shown.join("; ");
}

/** A reason cut to its first REASON_CHARACTERS code points, never inside one, saying how long it was. */
function cutReason(reason: string): string {
	let characters = 0;
	let end = 0;
	for (const character of reason) {
		if (characters < REASON_CHARACTERS) end += character.length;
		characters++;
	}
	return characters <= REASON_CHARACTERS ? reason : `${reason.slice(0, end)}… (the first ${REASON_CHARACTERS} of its ${characters} characters)`;
}

/**
 * Whether a Run counts. It counts when the binary exited 0, every stdout line
 * parsed as an event, every event matches schemas/events.schema.json, and the
 * stream obeys every order rule of scripts/check-events.py (stream.ts) with
 * the Run's own `samples` as the number of counted samples to expect and no
 * --quick stream allowed. Any other Run is failed, with the reasons.
 *
 * A stop signal the runner received (exit.runner_signal) does not by itself
 * keep a Run out: beside exit code 0 it means the binary had already finished.
 *
 * The events are the Run's stdout, read by readStream (methods/run.ts) and
 * summarised once by summarizeStream, for every Run: a Run written before the
 * runner stopped copying them into the record counts as it did when they were
 * read from there.
 */
export function outcome(run: Run, stream: StreamSummary): Outcome {
	const failures: string[] = [];
	const exit = describeExit(run.exit);
	if (exit !== null) failures.push(exit);
	if (run.exit.runner_signal !== undefined && exit !== null) {
		failures.push(`the runner was told to stop by signal ${run.exit.runner_signal}`);
	}
	// One by one: a stream may have more problems than a call takes arguments.
	for (const problem of stream.problems) failures.push(problem);
	for (const problem of countProblem(stream.counted, run.samples)) failures.push(problem);
	if (failures.length > 0) return { failures, samples: [] };
	if (stream.samples instanceof Error) throw stream.samples;
	return { failures, samples: stream.samples };
}

/**
 * What version 1 needs of a Run's stream, and nothing proportional to the
 * stream's size: the problems the stream has of itself, in outcome()'s order
 * (where parsing stopped, each event that breaks the events schema, each
 * break of the order rules but the count, which needs the Run's `samples`),
 * the number of counted samples, those samples' times when the stream has no
 * problem of its own, and the bytes per repetition it observed. gather()
 * makes one per stdout blob as it reads it, and lets the blob go.
 */
export interface StreamSummary {
	problems: string[];
	/** Null when the stream had no event to count. */
	counted: number | null;
	/** The counted samples; the error countedSamples threw, if it did (a stream with problems is never asked). */
	samples: SampleTime[] | Error;
	bytesPerRepetition: number | null;
}

export function summarizeStream(stream: Stream): StreamSummary {
	const problems: string[] = [];
	if (stream.error !== null) {
		problems.push(`stdout line ${stream.error.line} is not an event: ${stream.error.message}`);
	}
	const validate = schemaValidators().event;
	stream.events.forEach((event, index) => {
		if (!validate(event)) problems.push(`event ${index + 1} does not match schemas/events.schema.json`);
	});
	const check = streamCheck(stream.events);
	for (const problem of check.problems) problems.push(problem);
	let samples: SampleTime[] | Error = [];
	if (problems.length === 0) {
		try {
			samples = countedSamples(stream.events);
		} catch (error) {
			samples = error as Error;
		}
	}
	return { problems, counted: check.counted, samples, bytesPerRepetition: observedBytesPerRepetition(stream.events) };
}
