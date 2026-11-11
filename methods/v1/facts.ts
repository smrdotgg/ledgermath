/**
 * Method version 1: which Runs make one Series, which recorded facts split a
 * Series into groups, and which Runs count.
 */

import { createHash } from "node:crypto";

import { canonicalJson, type ParamValue, type Run, type RunExit, schemaValidators } from "../run";
import { countedSamples, type SampleTime } from "./numbers";

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
 * Dump sections whose contents version 1 does not read. Both change on every
 * read (cpuinfo's "cpu MHz", meminfo, loadavg, uptime), so only their hashes
 * are compared; reading them would cost about 50 KB of fetches per Run.
 */
export const UNREAD_SECTIONS: ReadonlySet<string> = new Set(["cpuinfo", "memory"]);

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
 * boot, and it holds nothing that names the box itself.
 */
export const SPLIT_FACTS: readonly SplitFact[] = [
	{ fact: "binary", what: "binary.blob: the bytes that ran" },
	{ fact: "runner", what: "runner: the manifest of runner/ that launched the binary" },
	{ fact: "samples", what: "samples: LM_SAMPLES" },
	{ fact: "image", what: "provider.image_id" },
	{ fact: "cpuid", what: "dump section cpuid: the raw cpuid leaves of every CPU", section: "cpuid" },
	{ fact: "lscpu", what: "dump section lscpu", section: "lscpu" },
	{ fact: "sys_cpu", what: "dump section sys_cpu: topology, caches, vulnerabilities, microcode, cpufreq, cpuidle", section: "sys_cpu" },
	{
		fact: "kernel",
		what:
			`dump section kernel without its "${KERNEL_HOST_KEY}" entry, which holds the host name: ` +
			"canonical-json-sha256 is the sha256 of that object as JSON with keys sorted and no whitespace",
		section: "kernel",
	},
	{ fact: "process", what: "dump section process: limits, cgroup, allowed CPUs", section: "process" },
	{ fact: "packages", what: "dump section packages: every installed package and version", section: "packages" },
];

/** What version 1 does not split on, and why. Every dump section is in "what differed" all the same. */
export const NOT_SPLIT_ON: readonly SplitFact[] = [
	{ fact: "source_commit, source", what: "they change with every commit, whether or not the benchmark did" },
	{ fact: "cpuinfo", what: "changes on every read (each CPU's current MHz)" },
	{ fact: "memory", what: "changes on every read (meminfo, loadavg, uptime, pressure)" },
	{ fact: "devices", what: "holds the root volume's serial, which is new on every launch" },
	{
		fact: "provider",
		what:
			"holds the instance ID, private address and launch time, new on every launch; its instance type " +
			"and zone ID make the Series, and its image is split on",
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

/** The kernel section's fact: its contents without the host name, hashed. */
export function kernelFact(hash: string, blobs: BlobMap): string {
	const { [KERNEL_HOST_KEY]: _host, ...rest } = sectionJson(hash, blobs);
	return `canonical-json-sha256:${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
}

/** The split facts of one Run, given the sections of its before-dump. */
export function splitFacts(run: Run, before: Record<string, string>, blobs: BlobMap): Facts {
	const section = (name: string): string | null => before[name] ?? null;
	const kernel = section("kernel");
	return {
		binary: run.binary.blob,
		runner: run.runner,
		samples: run.samples,
		image: run.provider.image_id ?? null,
		cpuid: section("cpuid"),
		lscpu: section("lscpu"),
		sys_cpu: section("sys_cpu"),
		kernel: kernel === null ? null : kernelFact(kernel, blobs),
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

/**
 * Whether a Run counts. It counts when the binary exited 0 and its stream is
 * whole: every line an event that matches the events schema, `started` first
 * and not a --quick stream, `finished` last, and exactly `samples` counted
 * samples, each closed by its sample_ended.
 *
 * A stop signal the runner received (exit.runner_signal) does not by itself
 * keep a Run out: beside exit code 0 it means the binary had already finished.
 */
export function outcome(run: Run): Outcome {
	const failures: string[] = [];
	const exit = describeExit(run.exit);
	if (exit !== null) failures.push(exit);
	if (run.exit.runner_signal !== undefined && exit !== null) {
		failures.push(`the runner was told to stop by signal ${run.exit.runner_signal}`);
	}
	if (run.events_error !== undefined) {
		failures.push(`stdout line ${run.events_error.line} is not an event: ${run.events_error.message}`);
	}
	const validate = schemaValidators().event;
	const invalid = run.events.findIndex((event) => !validate(event));
	if (invalid >= 0) failures.push(`event ${invalid + 1} does not match schemas/events.schema.json`);

	const first = run.events[0];
	if (first?.event !== "started") failures.push("the stream does not open with started");
	else if (first.quick === true) failures.push("a --quick stream");
	if (run.events.at(-1)?.event !== "finished") failures.push("no finished event");

	const measured = invalid >= 0 ? { samples: [], problems: [] } : countedSamples(run.events);
	failures.push(...measured.problems);
	if (measured.samples.length !== run.samples) {
		failures.push(`${measured.samples.length} counted samples of the ${run.samples} asked for`);
	}
	return { failures, samples: failures.length === 0 ? measured.samples : [] };
}
