/**
 * Checks that every disk Run says which disk it measured, and that its dump
 * proves it (the step-4 brief, #42, section 2.2 of its study). Reads a
 * directory laid out like a -runs stage's bucket:
 *
 *     bun scripts/check-disk-runs.ts DIR          prints one line per disk Run, then any problem
 *
 * For every Run of a benchmark named disk_* that exited 0:
 *   - `observed` names the file it opened, under the parameter set's `dir`,
 *     and says whether it found a block device, and whether the descriptor has
 *     O_DIRECT (the random and io_uring reads must, the others must not);
 *   - one `device_counters` event follows `verified`, and agrees on the device;
 *   - when a device was found:
 *       the dump before and after holds that disk's controller with the same
 *         model and serial (/sys/class/nvme/<controller>/), and lsblk lists the
 *         disk with them;
 *       the counters the binary read lie between the dumps' /sys/block/<disk>/stat
 *         (before-dump <= its before <= its after <= after-dump, field by field);
 *       the device did the work: read bytes at least the repetitions times the
 *         request (reads), or a device write for every repetition (fdatasync);
 *       nvme amzn stats was taken of the disk before and after, and the device
 *         counts at least as many reads and writes over the Run as the block
 *         layer did over the measured interval;
 *       an EBS volume's serial vol<id> is a volume the EC2 API lists for the
 *         instance (vol-<id>); an instance-store disk is the one the provision
 *         record prepared (mkfs.xfs and mount of that device, at the mount point
 *         the Run found), and the catalog lists instance storage;
 *   - when none was found (the container test's tmpfs): findmnt in the dump
 *     shows a file system of the type the Run found at its mount point.
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
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The stat fields that only grow; field 8 (in_flight) is a level. */
const MONOTONIC = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16];
const EBS_MODEL = "Amazon Elastic Block Store";
const INSTANCE_STORE_MODEL = "Amazon EC2 NVMe Instance Storage";

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
	if (!isObject(command) || command.exit !== 0 || typeof command.stdout !== "string") return undefined;
	try {
		return JSON.parse(command.stdout);
	} catch {
		return undefined;
	}
}

function commandStartingWith(section: Section | undefined, prefix: string): Command | undefined {
	if (!section) return undefined;
	const key = Object.keys(section).find((k) => k.startsWith(prefix));
	return key === undefined ? undefined : (section[key] as Command);
}

function statNumbers(text: unknown): number[] | undefined {
	if (typeof text !== "string") return undefined;
	return text.trim().split(/\s+/).map(Number);
}

interface LsblkRow {
	name: string;
	serial?: string | null;
	model?: string | null;
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

interface NvmeStats {
	total_read_ops: number;
	total_write_ops: number;
	[key: string]: unknown;
}

function nvmeStats(sections: Record<string, Section>, disk: string): NvmeStats | undefined {
	return parseStdout(sections.nvme_stats?.[`$ nvme amzn stats /dev/${disk} -o json`]) as NvmeStats | undefined;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function checkDiskRuns(dir: string): DiskCheck {
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
			if (e.event === "sample_started" && next?.event === "sample_ended") {
				samples.push({ repetitions: e.repetitions as number, ns: next.t - e.t, warmup: e.warmup as boolean });
			}
		}
		const repetitions = samples.reduce((sum, s) => sum + s.repetitions, 0);
		const counted = samples.filter((s) => !s.warmup).map((s) => s.ns / s.repetitions);
		const nsPerRep = counted.length ? median(counted) : NaN;
		const request = Number(observed.request_bytes);
		const paramDir = String(run.params.dir ?? "");

		if (typeof observed.file_path !== "string" || !observed.file_path.startsWith(`${paramDir.replace(/\/$/, "")}/`)) {
			bad(`observed file_path ${JSON.stringify(observed.file_path)} is not under dir ${paramDir}`);
		}
		const wantDirect = run.benchmark === "disk_read_random" || run.benchmark === "disk_read_io_uring";
		if (observed.o_direct !== wantDirect) bad(`observed o_direct is ${String(observed.o_direct)}, expected ${wantDirect}`);
		if (typeof observed.device_found !== "boolean") bad("observed has no device_found");
		if (counters.length !== 1) bad(`${counters.length} device_counters events, expected 1`);
		const dc = counters[0] as (RunEvent & { change?: Record<string, number>; before?: number[]; after?: number[] }) | undefined;
		if (dc && events.indexOf(dc) < verifiedAt) bad("device_counters comes before verified");

		const before = dumpSections(dir, run.environment.before);
		const after = dumpSections(dir, run.environment.after);
		let summary = `${Number.isNaN(nsPerRep) ? "?" : nsPerRep.toFixed(1)} ns/rep`;
		if (Number.isFinite(request) && request > 0 && !Number.isNaN(nsPerRep)) summary += `, ${((request / nsPerRep) * 1e9 / 2 ** 20).toFixed(1)} MiB/s`;

		if (observed.device_found === true) {
			const disk = String(observed.disk_device);
			const controller = String(observed.disk_controller ?? "");
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
				const row = lsblkRows(devices).find((r) => r.name === disk);
				if (!row || (row.serial ?? "") !== observed.disk_serial || (row.model ?? "").trim() !== observed.disk_model) {
					bad(`the ${which}-dump's lsblk lists ${disk} as ${JSON.stringify(row && { serial: row.serial, model: row.model })}`);
				}
			}
			const dumpBefore = statNumbers(before.block_stat?.[`/sys/block/${disk}/stat`]);
			const dumpAfter = statNumbers(after.block_stat?.[`/sys/block/${disk}/stat`]);
			if (!dumpBefore || !dumpAfter || !dc?.before || !dc.after) {
				bad(`no /sys/block/${disk}/stat in the dumps, or no counters in the Run`);
			} else {
				for (const i of MONOTONIC) {
					if (i >= dc.before.length) continue;
					const [a, b, c, d] = [dumpBefore[i] ?? Number.NaN, dc.before[i] ?? Number.NaN, dc.after[i] ?? Number.NaN, dumpAfter[i] ?? Number.NaN];
					if (!(a <= b && b <= c && c <= d)) bad(`stat field ${i} does not lie between the dumps: ${a} <= ${b} <= ${c} <= ${d}`);
				}
			}
			const change = dc?.change ?? {};
			const reads = run.benchmark.startsWith("disk_read");
			if (reads) {
				const bytes = (change.read_sectors ?? 0) * 512;
				const asked = repetitions * request;
				// io_uring's window is from a full queue to a full queue.
				const slack = run.benchmark === "disk_read_io_uring" ? Number(observed.queue_depth ?? 0) * request : 0;
				if (bytes + slack < asked) bad(`the device read ${bytes} bytes over the measured interval, fewer than its ${repetitions} repetitions of ${request} bytes`);
				summary += `; device read ${(bytes / asked).toFixed(4)}x the bytes asked, ${(change.reads ?? 0) ? ((change.read_sectors ?? 0) * 512 / (change.reads ?? 1) / 1024).toFixed(1) : "-"} KiB a request`;
			} else {
				const writes = change.writes ?? 0;
				if (run.params.sync === "fdatasync" && writes < repetitions) bad(`${writes} device writes for ${repetitions} fdatasync'd writes`);
				summary += `; ${(writes / repetitions).toFixed(4)} device writes and ${((change.flushes ?? 0) / repetitions).toFixed(4)} flushes a write`;
			}
			const statsBefore = nvmeStats(before, disk);
			const statsAfter = nvmeStats(after, disk);
			if (!statsBefore || !statsAfter) {
				if (controller.startsWith("nvme") && String(observed.disk_model).startsWith("Amazon")) bad(`no nvme amzn stats of /dev/${disk} in both dumps`);
			} else {
				const nvmeReads = statsAfter.total_read_ops - statsBefore.total_read_ops;
				const nvmeWrites = statsAfter.total_write_ops - statsBefore.total_write_ops;
				if (nvmeReads < (change.reads ?? 0) || nvmeWrites < (change.writes ?? 0)) {
					bad(`nvme amzn stats counts ${nvmeReads} reads and ${nvmeWrites} writes over the Run, fewer than the block layer's ${change.reads} and ${change.writes}`);
				}
				const exceeded = ["ebs_volume_performance_exceeded_iops", "ebs_volume_performance_exceeded_tp", "ec2_instance_ebs_performance_exceeded_iops", "ec2_instance_ebs_performance_exceeded_tp"]
					.map((key) => [key, Number(statsAfter[key]) - Number(statsBefore[key])] as const)
					.filter(([, delta]) => delta > 0)
					.map(([key, delta]) => `${key} +${(delta / 1e6).toFixed(2)} s`);
				summary += `; device: ${nvmeReads} reads, ${nvmeWrites} writes${exceeded.length ? `, ${exceeded.join(", ")}` : ""}`;
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
				const record = Object.values(before.provision ?? {})[0];
				const provision = typeof record === "string" ? (JSON.parse(record) as { decisions: Array<Record<string, unknown>>; steps: Array<Record<string, unknown>> }) : undefined;
				const prepared = provision?.decisions.find((d) => d.what === "instance_store" && d.action === "prepare");
				const preparedDisk = prepared?.disk as { name?: string; serial?: string } | undefined;
				const ran = (command: string): boolean =>
					(provision?.steps ?? []).some((step) => Array.isArray(step.command) && step.command.join(" ") === command && step.exit === 0);
				if (!prepared || preparedDisk?.name !== disk || preparedDisk.serial !== observed.disk_serial) {
					bad(`the provision record did not prepare ${disk} (${String(observed.disk_serial)})`);
				} else if (!ran(`mkfs.xfs /dev/${disk}`) || !ran(`mount /dev/${disk} ${String(observed.mount_point)}`)) {
					bad(`the provision record has no successful mkfs.xfs and mount of /dev/${disk} at ${String(observed.mount_point)}`);
				} else {
					summary += "; the provision record made and mounted it";
				}
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
