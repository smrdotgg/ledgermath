/**
 * Checks that every disk Run says which disk it measured, that its dump proves
 * it, and that the disk it found is the disk its parameters declare (the
 * step-4 brief, #42, section 2.2 of its study). Reads a directory laid out like
 * a -runs stage's bucket:
 *
 *     bun scripts/check-disk-runs.ts DIR          prints one line per disk Run, then any problem
 *
 * For every Run of a benchmark named disk_* that exited 0:
 *   - `observed` names the file it opened, under the parameter set's `dir`,
 *     says whether it found a block device, and whether the descriptor has
 *     O_DIRECT (the random and io_uring reads must, the others must not);
 *   - what was found is what the parameters declare. The binary never reads
 *     `disk`; this checker holds the knowledge of what each name means:
 *       `instance_store`: an "Amazon EC2 NVMe Instance Storage" device, mounted
 *         at exactly the declared `dir`;
 *       `root_volume`: an "Amazon Elastic Block Store" device holding the root
 *         file system (the file's mount is `/`, and lsblk lists `/` as a mount
 *         point of that device);
 *     a Run that found no block device at all measured no disk, which is a
 *     problem unless the caller accepts it (the container test, whose disk
 *     directory is a tmpfs: acceptNoDevice);
 *   - one `device_counters` event follows `verified`, agrees on the device,
 *     holds counters of the kernel's length, every one a whole number, and its
 *     `change` is exactly `after` minus `before` (its partition's too);
 *   - when a device was found:
 *       `file_device` is the device number lsblk gives the device the Run names
 *         (`block_device`), in the dumps before and after;
 *       the dump before and after holds that disk's controller with the same
 *         model and serial (/sys/class/nvme/<controller>/), and lsblk lists the
 *         disk with them;
 *       the counters the binary read lie between the dumps' /sys/block/<disk>/stat
 *         (before-dump <= its before <= its after <= after-dump, field by field);
 *       the device did the work: read bytes at least the repetitions times the
 *         request (reads), or a device write for every repetition (fdatasync);
 *       nvme amzn stats was taken of the disk before and after, with every
 *         counter this compares present and a number, and the device counts at
 *         least as many reads and writes over the Run as the block layer did
 *         over the measured interval;
 *       an EBS volume's serial vol<id> is a volume the EC2 API lists for the
 *         instance (vol-<id>); an instance-store disk is the one the provision
 *         record prepared, by device number and serial, and mounted where the
 *         Run found it, and the catalog lists instance storage;
 *   - when none was found: findmnt in the dump shows a file system of the
 *     type the Run found at its mount point.
 *   - what the binary observed of its own work is what was declared
 *     (request_bytes, queue_depth, access, span_bytes, bytes_per_sample, sync),
 *     and its `work` event agrees with the samples' repetitions and the request
 *     size;
 *   - the file's device is the disk the Run names, or one of its partitions;
 *   - a device whose model says it is an Amazon NVMe disk comes with its
 *     controller, which owns the disk, and its nvme amzn stats, whose counters
 *     never go down.
 * Every number compared must be present and a safe whole number (parsed
 * exactly: a counter too long to be one is refused, never turned into
 * Infinity); one that is not is a problem in itself, never a comparison that
 * passes.
 *
 * An EC2 API section whose call failed is reported, not judged. Exit status 0
 * when all holds, 1 when not, 2 on bad usage. Used by
 * scripts/box-in-container/expect.ts.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunEvent, RunRecord } from "./check-runs";

type Section = Record<string, unknown>;
interface Command {
	exit?: number;
	stdout?: string;
	stderr?: string;
	[key: string]: unknown;
}

/** /sys/block/<disk>/stat, in the order the kernel writes it (Documentation/block/stat.rst). */
export const STAT_NAMES = [
	"reads", "read_merges", "read_sectors", "read_ticks_ms",
	"writes", "write_merges", "write_sectors", "write_ticks_ms",
	"in_flight", "io_ticks_ms", "time_in_queue_ms",
	"discards", "discard_merges", "discard_sectors", "discard_ticks_ms",
	"flushes", "flush_ticks_ms",
] as const;
const IN_FLIGHT = 8;
/** The fields every kernel since 2.6 writes; later ones add discards (4.18) and flushes (5.5). */
const STAT_MINIMUM = 11;
export const EBS_MODEL = "Amazon Elastic Block Store";
export const INSTANCE_STORE_MODEL = "Amazon EC2 NVMe Instance Storage";
/** The counters of nvme amzn stats this checker compares or reports. */
export const NVME_COUNTERS = [
	"total_read_ops", "total_write_ops",
	"ebs_volume_performance_exceeded_iops", "ebs_volume_performance_exceeded_tp",
	"ec2_instance_ebs_performance_exceeded_iops", "ec2_instance_ebs_performance_exceeded_tp",
] as const;

export interface DiskRunLine {
	id: string;
	benchmark: string;
	params: Record<string, unknown>;
	summary: string;
}

export interface DiskCheck {
	lines: DiskRunLine[];
	problems: string[];
}

export interface DiskCheckOptions {
	/** Accept a Run that found no block device (the container test's tmpfs). */
	acceptNoDevice?: boolean;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function blobJson(dir: string, hash: string): unknown {
	const path = join(dir, "blobs", "sha256", hash.replace(/^sha256:/, ""));
	return JSON.parse(readFileSync(path, "utf8"));
}

function dumpSections(dir: string, indexHash: string): Record<string, Section> {
	const index = blobJson(dir, indexHash) as { sections: Record<string, string> };
	const sections: Record<string, Section> = {};
	for (const [name, hash] of Object.entries(index.sections)) sections[name] = blobJson(dir, hash) as Section;
	return sections;
}

function parseStdout(command: unknown): unknown {
	if (typeof command !== "object" || command === null || (command as Command).exit !== 0 || typeof (command as Command).stdout !== "string") return undefined;
	try {
		return JSON.parse((command as Command).stdout as string);
	} catch {
		return undefined;
	}
}

function commandStartingWith(section: Section | undefined, prefix: string): Command | undefined {
	if (!section) return undefined;
	const key = Object.keys(section).find((k) => k.startsWith(prefix));
	return key === undefined ? undefined : (section[key] as Command);
}

/** A /sys/block/<disk>/stat file's numbers, or undefined unless every one is a safe whole number. */
function statNumbers(text: unknown): number[] | undefined {
	if (typeof text !== "string" || text.trim() === "") return undefined;
	const words = text.trim().split(/\s+/);
	if (!words.every((word) => /^[0-9]+$/.test(word))) return undefined;
	const numbers = words.map(Number);
	return numbers.every((n) => Number.isSafeInteger(n)) ? numbers : undefined;
}

/** The lsblk row named `name`, and whether `child` is it or below it. */
function holds(row: LsblkRow | undefined, child: unknown): boolean {
	if (!row) return false;
	if (row.name === child) return true;
	return (row.children ?? []).some((below) => holds(below, child));
}

/** Declared parameters with an observed counterpart: [param, observed key]. */
const DECLARED_OBSERVED: ReadonlyArray<[string, string]> = [
	["request_bytes", "request_bytes"],
	["queue_depth", "queue_depth"],
	["access", "access"],
	["span_bytes", "span_bytes"],
	["bytes_per_sample", "bytes_per_sample"],
	["sync", "sync_call"],
];
const NVME_MODELS: ReadonlySet<string> = new Set([EBS_MODEL, INSTANCE_STORE_MODEL]);

interface LsblkRow {
	name: string;
	serial?: string | null;
	model?: string | null;
	"maj:min"?: string;
	mountpoint?: string | null;
	mountpoints?: Array<string | null>;
	children?: LsblkRow[];
}

function lsblkRows(devices: Section | undefined): LsblkRow[] {
	const parsed = parseStdout(commandStartingWith(devices, "$ lsblk")) as { blockdevices?: LsblkRow[] } | undefined;
	const rows: LsblkRow[] = [];
	const walk = (list: LsblkRow[] | undefined): void => {
		for (const row of list ?? []) {
			rows.push(row);
			walk(row.children);
		}
	};
	walk(parsed?.blockdevices);
	return rows;
}

function rowMountPoints(row: LsblkRow | undefined): string[] {
	if (!row) return [];
	return [...(row.mountpoints ?? []), row.mountpoint ?? null].filter((point): point is string => typeof point === "string");
}

interface FindmntRow {
	target: string;
	fstype: string;
	children?: FindmntRow[];
}

function findmntRows(devices: Section | undefined): FindmntRow[] {
	const parsed = parseStdout(commandStartingWith(devices, "$ findmnt")) as { filesystems?: FindmntRow[] } | undefined;
	const rows: FindmntRow[] = [];
	const walk = (list: FindmntRow[] | undefined): void => {
		for (const row of list ?? []) {
			rows.push(row);
			walk(row.children);
		}
	};
	walk(parsed?.filesystems);
	return rows;
}

function nvmeStats(sections: Record<string, Section>, disk: string): Record<string, unknown> | undefined {
	const parsed = parseStdout(sections.nvme_stats?.[`$ nvme amzn stats /dev/${disk} -o json`]);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

interface Counters {
	change?: unknown;
	before?: unknown;
	after?: unknown;
	in_flight_before?: unknown;
	in_flight_after?: unknown;
}

/** Problems with one set of counters (the disk's, or its partition's) in a device_counters event. */
function counterProblems(where: string, counters: Counters): string[] {
	const problems: string[] = [];
	const { before, after, change } = counters;
	if (!Array.isArray(before) || !Array.isArray(after)) return [`${where}: before and after must be arrays of the stat file's numbers`];
	if (before.length < STAT_MINIMUM || before.length > STAT_NAMES.length || before.length !== after.length) {
		return [`${where}: before has ${before.length} numbers and after ${after.length}; each must have the same number, ${STAT_MINIMUM} to ${STAT_NAMES.length}`];
	}
	if (!before.every(isCount) || !after.every(isCount)) return [`${where}: before and after must hold whole numbers, 0 or more`];
	if (typeof change !== "object" || change === null || Array.isArray(change)) return [`${where}: change must be an object`];
	const changes = change as Record<string, unknown>;
	const expected = STAT_NAMES.slice(0, before.length).filter((_, index) => index !== IN_FLIGHT);
	const extra = Object.keys(changes).filter((key) => !expected.includes(key as (typeof expected)[number]));
	if (extra.length) problems.push(`${where}: change has fields the stat file does not: ${extra.join(", ")}`);
	STAT_NAMES.slice(0, before.length).forEach((name, index) => {
		if (index === IN_FLIGHT) return;
		const difference = (after[index] as number) - (before[index] as number);
		if (changes[name] !== difference) problems.push(`${where}: change.${name} is ${JSON.stringify(changes[name])}, but after minus before is ${difference}`);
	});
	if (counters.in_flight_before !== before[IN_FLIGHT] || counters.in_flight_after !== after[IN_FLIGHT]) {
		problems.push(`${where}: in_flight_before and in_flight_after are ${JSON.stringify(counters.in_flight_before)} and ${JSON.stringify(counters.in_flight_after)}, but the stat file's field ${IN_FLIGHT} was ${before[IN_FLIGHT]} and ${after[IN_FLIGHT]}`);
	}
	return problems;
}

export function checkDiskRuns(dir: string, options: DiskCheckOptions = {}): DiskCheck {
	const lines: DiskRunLine[] = [];
	const problems: string[] = [];
	const runsDir = join(dir, "runs");
	const files = existsSync(runsDir)
		? readdirSync(runsDir, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => join(entry.parentPath, entry.name))
		: [];
	const runs = files
		.map((path) => JSON.parse(readFileSync(path, "utf8")) as RunRecord & { benchmark: string; params: Record<string, unknown> })
		.filter((run) => run.benchmark.startsWith("disk_"))
		.sort((a, b) => a.started_at.localeCompare(b.started_at));

	for (const run of runs) {
		const label = `${run.benchmark} ${JSON.stringify(run.params)} (${run.id})`;
		const bad = (message: string): void => {
			problems.push(`${label}: ${message}`);
		};
		/** The value if it is a safe whole number, 0 or more; otherwise a problem, and undefined. */
		const need = (value: unknown, what: string): number | undefined => {
			if (isCount(value)) return value;
			bad(`${what} is ${typeof value === "number" && !Number.isFinite(value) ? String(value) : JSON.stringify(value)}, not a safe whole number`);
			return undefined;
		};
		if (!("code" in run.exit) || run.exit.code !== 0) {
			lines.push({ id: run.id, benchmark: run.benchmark, params: run.params, summary: `exit ${JSON.stringify(run.exit)}: not checked` });
			continue;
		}
		const events = run.events as RunEvent[];
		const observed: Record<string, unknown> = Object.assign({}, ...events.filter((e) => e.event === "observed").map((e) => e.values as object));
		const counters = events.filter((e) => e.event === "device_counters");
		const verifiedAt = events.findIndex((e) => e.event === "verified");

		const samples: Array<{ repetitions: number; ns: number; warmup: boolean }> = [];
		for (let i = 0; i < events.length; i++) {
			const e = events[i] as RunEvent;
			const next = events[i + 1];
			if (e.event !== "sample_started") continue;
			if (next?.event !== "sample_ended" || !isCount(e.repetitions) || e.repetitions < 1 || !isCount(next.t - e.t)) {
				bad(`sample ${String(e.sample)} is not a sample_started with whole repetitions closed by its sample_ended`);
				continue;
			}
			samples.push({ repetitions: e.repetitions, ns: next.t - e.t, warmup: e.warmup === true });
		}
		const repetitions = samples.reduce((sum, s) => sum + s.repetitions, 0);
		const counted = samples.filter((s) => !s.warmup).map((s) => s.ns / s.repetitions);
		if (counted.length === 0) bad("no counted sample");
		const nsPerRep = counted.length ? median(counted) : Number.NaN;
		const request = need(observed.request_bytes, "observed request_bytes");
		if (request === 0) bad("observed request_bytes is 0");
		const paramDir = trimSlash(String(run.params.dir ?? ""));

		// What the binary observed of its own work must be what was declared.
		for (const [param, key] of DECLARED_OBSERVED) {
			if (run.params[param] === undefined) continue;
			if (observed[key] !== run.params[param]) {
				bad(`it declares ${param} ${JSON.stringify(run.params[param])}, but observed ${key} is ${JSON.stringify(observed[key])}`);
			}
		}
		if (request !== undefined && observed.bytes_per_repetition !== request) {
			bad(`observed bytes_per_repetition is ${JSON.stringify(observed.bytes_per_repetition)}, not its request_bytes ${request}`);
		}
		const work = events.find((e) => e.event === "work") as Record<string, unknown> | undefined;
		if (!work) {
			bad("no work event");
		} else if (request !== undefined) {
			const counted = (key: string): number | undefined => need(work[key], `work ${key}`);
			const agree = (key: string, value: number, why: string): void => {
				const got = counted(key);
				if (got !== undefined && got !== value) bad(`work ${key} is ${got}, but ${why} is ${value}`);
			};
			if (run.benchmark === "disk_read_random" || run.benchmark === "disk_read_sequential") {
				agree("reads", repetitions, "the samples' repetitions");
				agree("bytes_read", repetitions * request, "the repetitions times request_bytes");
			} else if (run.benchmark === "disk_read_io_uring") {
				agree("completed_during_measuring", repetitions, "the samples' repetitions");
				const completed = counted("completed");
				if (completed !== undefined) agree("bytes_read", completed * request, "its completed times request_bytes");
			} else if (run.benchmark === "disk_write") {
				const checked = counted("writes_checked_before_measuring");
				if (checked !== undefined) agree("writes", repetitions + checked, "the repetitions and the writes checked before measuring");
				const writes = counted("writes");
				if (writes !== undefined) {
					agree("bytes_written", writes * request, "its writes times request_bytes");
					agree("fdatasyncs", run.params.sync === "fdatasync" ? writes : 0, `what sync ${JSON.stringify(run.params.sync)} calls for`);
				}
			}
		}

		if (typeof observed.file_path !== "string" || !observed.file_path.startsWith(`${paramDir}/`)) {
			bad(`observed file_path ${JSON.stringify(observed.file_path)} is not under dir ${paramDir}`);
		}
		const wantDirect = run.benchmark === "disk_read_random" || run.benchmark === "disk_read_io_uring";
		if (observed.o_direct !== wantDirect) bad(`observed o_direct is ${String(observed.o_direct)}, expected ${wantDirect}`);
		if (typeof observed.device_found !== "boolean") bad("observed has no device_found");
		if (counters.length !== 1) bad(`${counters.length} device_counters events, expected 1`);
		const dc = counters[0] as (RunEvent & Counters & { partition?: Counters }) | undefined;
		if (dc && events.indexOf(dc) < verifiedAt) bad("device_counters comes before verified");

		const before = dumpSections(dir, run.environment.before);
		const after = dumpSections(dir, run.environment.after);
		let summary = `${Number.isNaN(nsPerRep) ? "?" : nsPerRep.toFixed(1)} ns/rep`;
		if (request !== undefined && request > 0 && !Number.isNaN(nsPerRep)) summary += `, ${((request / nsPerRep) * 1e9 / 2 ** 20).toFixed(1)} MiB/s`;

		// What was found against what the parameters declare.
		const declared = run.params.disk;
		const mountPoint = typeof observed.mount_point === "string" ? trimSlash(observed.mount_point) : undefined;
		if (observed.device_found !== true) {
			if (!options.acceptNoDevice) bad(`it declares disk ${JSON.stringify(declared)}, but found no block device behind ${paramDir}: it measured no disk`);
		} else if (declared === "instance_store") {
			if (observed.disk_model !== INSTANCE_STORE_MODEL || mountPoint !== paramDir) {
				bad(`it declares disk "instance_store", but found "${String(observed.disk_model)}" mounted at ${String(observed.mount_point)}; an instance-store set must find an "${INSTANCE_STORE_MODEL}" device mounted at its dir, ${paramDir}`);
			}
		} else if (declared === "root_volume") {
			const holdsRoot = rowMountPoints(lsblkRows(before.devices).find((row) => row.name === observed.block_device)).includes("/");
			if (observed.disk_model !== EBS_MODEL || mountPoint !== "/" || !holdsRoot) {
				bad(`it declares disk "root_volume", but found "${String(observed.disk_model)}" with the file's mount at ${String(observed.mount_point)}${holdsRoot ? "" : `, and lsblk does not list / as a mount point of ${String(observed.block_device)}`}; a root-volume set must find an "${EBS_MODEL}" device holding the root file system`);
			}
		} else {
			bad(`it declares disk ${JSON.stringify(declared)}, which is neither "instance_store" nor "root_volume"`);
		}

		if (dc) {
			if (dc.device_found !== (observed.device_found === true)) bad(`device_counters says device_found ${String(dc.device_found)}, observed ${String(observed.device_found)}`);
			if (dc.device_found === true) {
				for (const problem of counterProblems("device_counters", dc)) bad(problem);
				if (dc.partition !== undefined) for (const problem of counterProblems("device_counters.partition", dc.partition)) bad(problem);
			}
		}

		if (observed.device_found === true) {
			const disk = String(observed.disk_device);
			const controller = String(observed.disk_controller ?? "");
			const nvme = NVME_MODELS.has(String(observed.disk_model));
			// A device whose model says it is an Amazon NVMe disk must come with its
			// controller, which owns the disk, and its controller's statistics.
			if (nvme && (!/^nvme[0-9]+$/.test(controller) || !new RegExp(`^${controller}n[0-9]+$`).test(disk))) {
				bad(`the disk is "${String(observed.disk_model)}", an NVMe device, but observed disk_controller ${JSON.stringify(observed.disk_controller)} is not the controller of ${disk}`);
			}
			if (dc?.device_found !== true || dc.disk_device !== disk) bad(`device_counters names ${String(dc?.disk_device)}, observed ${disk}`);
			summary += `; ${disk} "${String(observed.disk_model)}" ${String(observed.disk_serial)} ${String(observed.fs_type)} at ${String(observed.mount_point)}`;
			for (const [which, sections] of [["before", before], ["after", after]] as const) {
				const devices = sections.devices;
				if (controller.startsWith("nvme")) {
					const model = String(devices?.[`/sys/class/nvme/${controller}/model`] ?? "").trim();
					const serial = String(devices?.[`/sys/class/nvme/${controller}/serial`] ?? "").trim();
					if (model !== observed.disk_model || serial !== observed.disk_serial) {
						bad(`the ${which}-dump's /sys/class/nvme/${controller} is "${model}" ${serial}, the Run's "${String(observed.disk_model)}" ${String(observed.disk_serial)}`);
					}
				}
				const rows = lsblkRows(devices);
				const diskRow = rows.find((r) => r.name === disk);
				if (!diskRow || (diskRow.serial ?? "") !== observed.disk_serial || (diskRow.model ?? "").trim() !== observed.disk_model) {
					bad(`the ${which}-dump's lsblk lists ${disk} as ${JSON.stringify(diskRow && { serial: diskRow.serial, model: diskRow.model })}`);
				}
				const fileRow = rows.find((r) => r.name === observed.block_device);
				if (!fileRow || fileRow["maj:min"] !== observed.file_device) {
					bad(`observed file_device is ${JSON.stringify(observed.file_device)}, but the ${which}-dump's lsblk gives ${String(observed.block_device)} the number ${JSON.stringify(fileRow?.["maj:min"])}`);
				}
				// The file's device must be the disk, or one of its partitions.
				if (!holds(diskRow, observed.block_device)) {
					bad(`observed block_device ${String(observed.block_device)} is neither ${disk} nor below it in the ${which}-dump's lsblk, so the disk's counters, model and serial are not the file's`);
				}
			}

			const dumpBefore = statNumbers(before.block_stat?.[`/sys/block/${disk}/stat`]);
			const dumpAfter = statNumbers(after.block_stat?.[`/sys/block/${disk}/stat`]);
			const runBefore = Array.isArray(dc?.before) && dc.before.every(isCount) ? (dc.before as number[]) : undefined;
			const runAfter = Array.isArray(dc?.after) && dc.after.every(isCount) ? (dc.after as number[]) : undefined;
			if (!dumpBefore || !dumpAfter) {
				bad(`the dumps hold no /sys/block/${disk}/stat of safe whole numbers before and after`);
			} else if (runBefore && runAfter && runBefore.length > 0) {
				if (dumpBefore.length !== runBefore.length || dumpAfter.length !== runAfter.length) {
					bad(`the dumps' /sys/block/${disk}/stat has ${dumpBefore.length} and ${dumpAfter.length} numbers, the Run's ${runBefore.length} and ${runAfter.length}`);
				} else {
					runBefore.forEach((_, i) => {
						if (i === IN_FLIGHT) return;
						const [a, b, c, d] = [dumpBefore[i] as number, runBefore[i] as number, runAfter[i] as number, dumpAfter[i] as number];
						if (!(a <= b && b <= c && c <= d)) bad(`stat field ${i} (${STAT_NAMES[i]}) does not lie between the dumps: ${a} <= ${b} <= ${c} <= ${d}`);
					});
				}
			}

			const change = (dc?.change ?? {}) as Record<string, unknown>;
			if (run.benchmark.startsWith("disk_read")) {
				const sectors = need(change.read_sectors, "device_counters change.read_sectors");
				const reads = need(change.reads, "device_counters change.reads");
				if (sectors !== undefined && request !== undefined) {
					const bytes = sectors * 512;
					const asked = repetitions * request;
					// io_uring's window is from a full queue to a full queue.
					let slack = 0;
					if (run.benchmark === "disk_read_io_uring") slack = (need(observed.queue_depth, "observed queue_depth") ?? 0) * request;
					if (bytes + slack < asked) bad(`the device read ${bytes} bytes over the measured interval, fewer than its ${repetitions} repetitions of ${request} bytes`);
					summary += `; device read ${(bytes / asked).toFixed(4)}x the bytes asked, ${reads ? (bytes / reads / 1024).toFixed(1) : "-"} KiB a request`;
				}
			} else {
				const writes = need(change.writes, "device_counters change.writes");
				const flushes = need(change.flushes ?? 0, "device_counters change.flushes");
				if (writes !== undefined) {
					if (run.params.sync === "fdatasync" && writes < repetitions) bad(`${writes} device writes for ${repetitions} fdatasync'd writes`);
					summary += `; ${(writes / repetitions).toFixed(4)} device writes and ${((flushes ?? 0) / repetitions).toFixed(4)} flushes a write`;
				}
			}

			const statsBefore = nvmeStats(before, disk);
			const statsAfter = nvmeStats(after, disk);
			if (!statsBefore || !statsAfter) {
				if (nvme || controller.startsWith("nvme")) bad(`no nvme amzn stats of /dev/${disk} in both dumps`);
			} else {
				const delta: Record<string, number | undefined> = {};
				for (const key of NVME_COUNTERS) {
					const a = need(statsBefore[key], `the before-dump's nvme amzn stats ${key}`);
					const b = need(statsAfter[key], `the after-dump's nvme amzn stats ${key}`);
					delta[key] = a !== undefined && b !== undefined ? b - a : undefined;
					if (a !== undefined && b !== undefined && b < a) bad(`nvme amzn stats ${key} fell from ${a} to ${b} over the Run; a counter never goes down`);
				}
				const nvmeReads = delta.total_read_ops;
				const nvmeWrites = delta.total_write_ops;
				const blockReads = isCount(change.reads) ? change.reads : undefined;
				const blockWrites = isCount(change.writes) ? change.writes : undefined;
				if (nvmeReads !== undefined && nvmeWrites !== undefined && blockReads !== undefined && blockWrites !== undefined) {
					if (nvmeReads < blockReads || nvmeWrites < blockWrites) {
						bad(`nvme amzn stats counts ${nvmeReads} reads and ${nvmeWrites} writes over the Run, fewer than the block layer's ${blockReads} and ${blockWrites}`);
					}
				}
				const exceeded = NVME_COUNTERS.slice(2)
					.filter((key) => (delta[key] ?? 0) > 0)
					.map((key) => `${key} +${((delta[key] as number) / 1e6).toFixed(2)} s`);
				summary += `; device: ${nvmeReads ?? "?"} reads, ${nvmeWrites ?? "?"} writes${exceeded.length ? `, ${exceeded.join(", ")}` : ""}`;
			}

			if (observed.disk_model === EBS_MODEL) {
				const volumeId = `vol-${String(observed.disk_serial).replace(/^vol/, "")}`;
				const listed = parseStdout(commandStartingWith(before.ec2_volumes, "$ aws ec2 describe-volumes")) as { Volumes?: Array<Record<string, unknown>> } | undefined;
				if (!listed) {
					summary += "; describe-volumes not in the dump or failed";
				} else {
					const volume = listed.Volumes?.find((v) => v.VolumeId === volumeId);
					if (!volume) bad(`serial ${String(observed.disk_serial)} is ${volumeId}, which describe-volumes does not list`);
					else summary += `; ${volumeId}: ${String(volume.VolumeType)} ${String(volume.Size)} GiB ${String(volume.Iops)} IOPS ${String(volume.Throughput)} MiB/s`;
				}
			} else if (observed.disk_model === INSTANCE_STORE_MODEL) {
				const problem = provisionProblem(before, observed);
				if (problem) bad(problem);
				else summary += "; the provision record prepared this device number and mounted it here";
				const catalog = parseStdout(commandStartingWith(before.ec2_instance_type, "$ aws ec2 describe-instance-types")) as
					| { InstanceTypes?: Array<{ InstanceStorageInfo?: { Disks?: Array<{ Count: number; SizeInGB: number; Type: string }> } }> }
					| undefined;
				const disks = catalog?.InstanceTypes?.[0]?.InstanceStorageInfo?.Disks;
				if (catalog && !disks?.length) bad("the catalog record lists no instance storage");
				if (disks) summary += `; catalog: ${disks.map((d) => `${d.Count} x ${d.SizeInGB} GB ${d.Type}`).join(", ")}`;
			}
		} else if (observed.device_found === false) {
			const mount = findmntRows(before.devices).find((row) => row.target === observed.mount_point);
			if (!mount || mount.fstype !== observed.fs_type) {
				bad(`no device was found, and findmnt shows ${JSON.stringify(mount)} at ${String(observed.mount_point)}, the Run ${String(observed.fs_type)}`);
			}
			summary += `; no block device: ${String(observed.fs_type)} at ${String(observed.mount_point)}, as findmnt says`;
		}
		lines.push({ id: run.id, benchmark: run.benchmark, params: run.params, summary });
	}
	return { lines, problems };
}

/**
 * Why the provision record in a dump does not show that it prepared the
 * instance-store device the Run found, by device number and serial, and
 * mounted it where the Run found it; null when it does. Reads both the
 * current record (ledgermath.provision/2: instance_store.state "ready", its
 * device, serial, mount point and the mounted device's number) and the first
 * one (ledgermath.provision/1: a prepare decision and successful mkfs.xfs and
 * mount steps naming /dev/<disk>).
 */
function provisionProblem(sections: Record<string, Section>, observed: Record<string, unknown>): string | null {
	const text = Object.values(sections.provision ?? {})[0];
	if (typeof text !== "string") return "the dump holds no provision record";
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return "the provision record is not JSON";
	}
	const decisions = (record.decisions ?? []) as Array<{ what?: string; action?: string; disk?: { name?: string; serial?: string; dev?: string } }>;
	const prepared = decisions.find((d) => d.what === "instance_store" && d.action === "prepare");
	if (!prepared || prepared.disk?.dev !== observed.file_device || prepared.disk?.serial !== observed.disk_serial) {
		return `the provision record did not prepare device ${String(observed.file_device)} (${String(observed.disk_serial)})`;
	}
	if (record.schema === "ledgermath.provision/1") {
		const steps = (record.steps ?? []) as Array<{ command?: unknown; exit?: unknown }>;
		const ran = (command: string): boolean => steps.some((step) => Array.isArray(step.command) && step.command.join(" ") === command && step.exit === 0);
		const name = String(prepared.disk?.name);
		if (!ran(`mkfs.xfs /dev/${name}`) || !ran(`mount /dev/${name} ${String(observed.mount_point)}`)) {
			return `the provision record has no successful mkfs.xfs and mount of /dev/${name} at ${String(observed.mount_point)}`;
		}
		return null;
	}
	const store = (record.instance_store ?? {}) as { state?: string; device?: string; serial?: string; mount_point?: string; mounted_device?: { stat?: string; mountinfo?: string } };
	if (store.state !== "ready") return `the provision record's instance store is ${JSON.stringify(store.state)}, not ready`;
	if (store.device !== observed.file_device || store.serial !== observed.disk_serial) {
		return `the provision record readied device ${String(store.device)} (${String(store.serial)}), not the Run's ${String(observed.file_device)} (${String(observed.disk_serial)})`;
	}
	if (trimSlash(String(store.mount_point)) !== trimSlash(String(observed.mount_point))) {
		return `the provision record mounted it at ${String(store.mount_point)}, but the Run found it at ${String(observed.mount_point)}`;
	}
	if (store.mounted_device?.stat !== observed.file_device || store.mounted_device?.mountinfo !== observed.file_device) {
		return `the provision record found ${JSON.stringify(store.mounted_device)} mounted there, not ${String(observed.file_device)}`;
	}
	return null;
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (!dir || process.argv.length !== 3) {
		console.error("usage: bun scripts/check-disk-runs.ts DIR");
		process.exit(2);
	}
	const { lines, problems } = checkDiskRuns(dir);
	for (const line of lines) console.log(`${line.benchmark} ${JSON.stringify(line.params)}\n    ${line.summary}`);
	for (const problem of problems) console.error(`FAIL ${problem}`);
	console.log(`${lines.length} disk Runs, ${problems.length} problems`);
	process.exit(problems.length ? 1 : 0);
}
