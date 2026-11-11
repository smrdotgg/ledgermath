import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkDiskRuns, EBS_MODEL, INSTANCE_STORE_MODEL } from "../scripts/check-disk-runs";

// scripts/check-disk-runs.ts on hand-made Runs: two whose evidence adds up (an
// instance-store read and a root-volume write, with their dumps), then each
// broken one way, as the verifier broke them. Every number the checker
// compares must be present and finite, the event's change must be its after
// minus its before, file_device must be lsblk's number for the device, and the
// disk found must be the disk declared.

const scratch = mkdtempSync(join(tmpdir(), "check-disk-runs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Json = Record<string, unknown>;
const STORE_DIR = "/mnt/lm/instance-store";
const ROOT_DIR = "/var/tmp/ledgermath/disk";
const LSBLK = "$ lsblk -J -b -o NAME,TYPE,SIZE,MODEL,SERIAL,ROTA,FSTYPE,MOUNTPOINT,MAJ:MIN,PKNAME,LOG-SEC,PHY-SEC,MIN-IO,OPT-IO,DISC-GRAN,DISC-MAX,RA,RQ-SIZE,SCHED,MOUNTPOINTS";
const ran = (value: unknown) => ({ exit: 0, stdout: `${typeof value === "string" ? value : JSON.stringify(value)}\n`, stderr: "" });

/** 17 stat fields: reads, read sectors and writes set, in_flight 0. */
const stat = (reads: number, sectors: number, writes: number, writeSectors: number): number[] => [reads, 0, sectors, 5, writes, 0, writeSectors, 5, 0, 10, 10, 0, 0, 0, 0, 0, 0];
const statText = (fields: number[]): string => `${fields.map((n) => String(n).padStart(8)).join(" ")}\n`;
function change(before: number[], after: number[]): Json {
	const names = ["reads", "read_merges", "read_sectors", "read_ticks_ms", "writes", "write_merges", "write_sectors", "write_ticks_ms", "in_flight", "io_ticks_ms", "time_in_queue_ms", "discards", "discard_merges", "discard_sectors", "discard_ticks_ms", "flushes", "flush_ticks_ms"];
	return Object.fromEntries(names.map((name, i) => [name, (after[i] as number) - (before[i] as number)]).filter(([name]) => name !== "in_flight"));
}
const nvme = (reads: number, writes: number): Json => ({
	total_read_ops: reads,
	total_write_ops: writes,
	ebs_volume_performance_exceeded_iops: 0,
	ebs_volume_performance_exceeded_tp: 0,
	ec2_instance_ebs_performance_exceeded_iops: 0,
	ec2_instance_ebs_performance_exceeded_tp: 0,
	read_io_latency_histogram: { num_bins: 0, bins: [] },
});

interface World {
	store: { run: Json; observed: Json; counters: Json };
	root: { run: Json; observed: Json; counters: Json };
	sections: { before: Record<string, Json>; after: Record<string, Json> };
}

function world(): World {
	// The instance store: 3 reads of 8 KiB (one warmup, two counted).
	const storeBefore = stat(1000, 8000, 10, 80);
	const storeAfter = stat(1003, 8048, 10, 80);
	// The root volume: 3 durable writes of 8 KiB.
	const rootBefore = stat(500, 4000, 2000, 16000);
	const rootAfter = stat(500, 4000, 2003, 16048);
	const devices = (): Json => ({
		"/sys/class/nvme/nvme0/model": `${EBS_MODEL}              `,
		"/sys/class/nvme/nvme0/serial": "vol0aaaaaaaaaaaaaaaa",
		"/sys/class/nvme/nvme1/model": `${INSTANCE_STORE_MODEL}        `,
		"/sys/class/nvme/nvme1/serial": "AWS1111111111111111",
		[LSBLK]: ran({
			blockdevices: [
				{ name: "nvme0n1", "maj:min": "259:0", model: EBS_MODEL, serial: "vol0aaaaaaaaaaaaaaaa", mountpoint: null, mountpoints: [null],
					children: [{ name: "nvme0n1p1", "maj:min": "259:2", model: null, serial: null, mountpoint: "/", mountpoints: ["/"] }] },
				{ name: "nvme1n1", "maj:min": "259:1", model: INSTANCE_STORE_MODEL, serial: "AWS1111111111111111", mountpoint: STORE_DIR, mountpoints: [STORE_DIR] },
			],
		}),
		"$ findmnt -J": ran({ filesystems: [{ target: "/", source: "/dev/nvme0n1p1", fstype: "xfs", children: [{ target: STORE_DIR, source: "/run/ledgermath/instance-store-259-1", fstype: "xfs" }] }] }),
	});
	const provision = JSON.stringify({
		schema: "ledgermath.provision/2",
		decisions: [{ what: "instance_store", action: "prepare", disk: { name: "nvme1n1", serial: "AWS1111111111111111", dev: "259:1" } }],
		instance_store: { state: "ready", device: "259:1", serial: "AWS1111111111111111", mount_point: STORE_DIR, mounted_device: { stat: "259:1", mountinfo: "259:1" } },
		steps: [],
	});
	const once = {
		provision: { "/var/tmp/ledgermath/provision.json": provision },
		ec2_instance_type: { "$ aws ec2 describe-instance-types --instance-types i4i.2xlarge": ran({ InstanceTypes: [{ InstanceStorageInfo: { Disks: [{ Count: 1, SizeInGB: 1875, Type: "ssd" }] } }] }) },
		ec2_volumes: { "$ aws ec2 describe-volumes --filters x": ran({ Volumes: [{ VolumeId: "vol-0aaaaaaaaaaaaaaaa", VolumeType: "gp3", Size: 8, Iops: 3000, Throughput: 125 }] }) },
	};
	const before = {
		devices: devices(),
		block_stat: { "/sys/block/nvme0n1/stat": statText(rootBefore), "/sys/block/nvme1n1/stat": statText(storeBefore) },
		nvme_stats: { "$ nvme amzn stats /dev/nvme0n1 -o json": ran(nvme(500, 2000)), "$ nvme amzn stats /dev/nvme1n1 -o json": ran(nvme(1000, 10)) },
		...once,
	};
	const after = {
		devices: devices(),
		block_stat: { "/sys/block/nvme0n1/stat": statText(rootAfter), "/sys/block/nvme1n1/stat": statText(storeAfter) },
		nvme_stats: { "$ nvme amzn stats /dev/nvme0n1 -o json": ran(nvme(500, 2003)), "$ nvme amzn stats /dev/nvme1n1 -o json": ran(nvme(1003, 10)) },
		...once,
	};
	const make = (benchmark: string, params: Json, observed: Json, counters: Json): { run: Json; observed: Json; counters: Json } => {
		const events = [
			{ event: "started", t: 1, schema: "ledgermath.events/1", wall_utc: "2026-11-11T00:00:00.000000000Z", clock: "CLOCK_MONOTONIC_RAW", clock_read_ns: 20, quick: false },
			{ event: "observed", t: 2, values: observed },
			{ event: "sample_started", t: 10, sample: 0, warmup: true, repetitions: 1 },
			{ event: "sample_ended", t: 110, sample: 0 },
			{ event: "sample_started", t: 120, sample: 1, warmup: false, repetitions: 2 },
			{ event: "sample_ended", t: 320, sample: 1 },
			{ event: "verified", t: 330, checksum: "0x0000000000000001" },
			counters,
			{ event: "finished", t: 350 },
		];
		const run = { id: `01a1c900-0000-7000-8000-00000000000${benchmark === "disk_write" ? 2 : 1}`, started_at: "2026-11-11T00:00:00.000000000Z", benchmark, params, exit: { code: 0 }, events };
		return { run, observed, counters };
	};
	const store = make(
		"disk_read_random",
		{ disk: "instance_store", dir: STORE_DIR, request_bytes: 8192, span_bytes: 34359738368 },
		{ file_path: `${STORE_DIR}/ledgermath-fixture-v1`, file_device: "259:1", device_found: true, block_device: "nvme1n1", disk_device: "nvme1n1", disk_controller: "nvme1",
			disk_model: INSTANCE_STORE_MODEL, disk_serial: "AWS1111111111111111", fs_type: "xfs", mount_point: STORE_DIR, o_direct: true, request_bytes: 8192 },
		{ event: "device_counters", t: 340, interval: "lm_measure", device_found: true, disk_device: "nvme1n1", stat: "/sys/class/block/nvme1n1/stat",
			change: change(storeBefore, storeAfter), in_flight_before: 0, in_flight_after: 0, before: storeBefore, after: storeAfter, file_resident_pages: 0 },
	);
	const rootPartitionBefore = stat(400, 3000, 1900, 15000);
	const rootPartitionAfter = stat(400, 3000, 1903, 15048);
	const root = make(
		"disk_write",
		{ disk: "root_volume", dir: ROOT_DIR, request_bytes: 8192, sync: "fdatasync", file_bytes: 1073741824 },
		{ file_path: `${ROOT_DIR}/ledgermath-disk_write.scratch`, file_device: "259:2", device_found: true, block_device: "nvme0n1p1", disk_device: "nvme0n1", disk_controller: "nvme0",
			disk_model: EBS_MODEL, disk_serial: "vol0aaaaaaaaaaaaaaaa", fs_type: "xfs", mount_point: "/", o_direct: false, request_bytes: 8192 },
		{ event: "device_counters", t: 340, interval: "lm_measure", device_found: true, disk_device: "nvme0n1", stat: "/sys/class/block/nvme0n1/stat",
			change: change(rootBefore, rootAfter), in_flight_before: 0, in_flight_after: 0, before: rootBefore, after: rootAfter,
			partition: { block_device: "nvme0n1p1", change: change(rootPartitionBefore, rootPartitionAfter), in_flight_before: 0, in_flight_after: 0, before: rootPartitionBefore, after: rootPartitionAfter },
			file_resident_pages: 2 },
	);
	return { store, root, sections: { before, after } };
}

let buckets = 0;
/** Writes the world as a bucket directory and checks it. */
function check(w: World, options = {}) {
	const dir = join(scratch, `bucket-${buckets++}`);
	const put = (value: unknown): string => {
		const bytes = `${JSON.stringify(value)}\n`;
		const hash = createHash("sha256").update(bytes).digest("hex");
		mkdirSync(join(dir, "blobs", "sha256"), { recursive: true });
		writeFileSync(join(dir, "blobs", "sha256", hash), bytes);
		return `sha256:${hash}`;
	};
	const index = (sections: Record<string, Json>): string =>
		put({ schema: "ledgermath.dump/1", taken_at: "2026-11-11T00:00:00.000000000Z", sections: Object.fromEntries(Object.entries(sections).map(([name, section]) => [name, put(section)])) });
	const environment = { before: index(w.sections.before), after: index(w.sections.after) };
	mkdirSync(join(dir, "runs", "2026", "11", "11"), { recursive: true });
	for (const { run } of [w.store, w.root]) {
		writeFileSync(join(dir, "runs", "2026", "11", "11", `${run.id as string}.json`), JSON.stringify({ ...run, environment }));
	}
	return checkDiskRuns(dir, options);
}

function problemsAfter(change: (w: World) => void, options = {}): string[] {
	const w = world();
	change(w);
	return check(w, options).problems.map((problem) => problem.replace(/^.*?\(01a1c900-[^)]*\): /, ""));
}

describe("evidence that adds up", () => {
	test("passes: an instance-store read and a root-volume write, each tied to its dump", () => {
		const { lines, problems } = check(world());
		expect(problems).toEqual([]);
		expect(lines.length).toBe(2);
		expect(lines.find((line) => line.benchmark === "disk_read_random")?.summary).toContain("the provision record prepared this device number and mounted it here");
		expect(lines.find((line) => line.benchmark === "disk_write")?.summary).toContain("vol-0aaaaaaaaaaaaaaaa: gp3 8 GiB 3000 IOPS 125 MiB/s");
	});
});

describe("evidence that does not add up is a problem (the verifier's cases)", () => {
	test("a file_device that disagrees with lsblk", () => {
		expect(problemsAfter((w) => (w.store.observed.file_device = "259:7"))).toContain('observed file_device is "259:7", but the before-dump\'s lsblk gives nvme1n1 the number "259:1"');
	});

	test("a change.read_sectors that disagrees with the raw counters in the same event", () => {
		expect(problemsAfter((w) => ((w.store.counters.change as Json).read_sectors = 4800))).toContain("device_counters: change.read_sectors is 4800, but after minus before is 48");
	});

	test("empty counter arrays", () => {
		const problems = problemsAfter((w) => {
			w.store.counters.before = [];
			w.store.counters.after = [];
		});
		expect(problems).toContain("device_counters: before has 0 numbers and after 0; each must have the same number, 11 to 17");
	});

	test("NVMe JSON with no counter fields, where a comparison with NaN would pass", () => {
		const problems = problemsAfter((w) => {
			w.sections.after.nvme_stats = { ...w.sections.after.nvme_stats, "$ nvme amzn stats /dev/nvme1n1 -o json": ran({ read_io_latency_histogram: {} }) };
		});
		expect(problems).toContain("the after-dump's nvme amzn stats total_read_ops is undefined, not a finite number");
		expect(problems).toContain("the after-dump's nvme amzn stats total_write_ops is undefined, not a finite number");
		expect(problems.length).toBe(6);
	});
});

describe("every number compared must be present and finite", () => {
	test("a counter that is not a whole number", () => {
		expect(problemsAfter((w) => ((w.store.counters.after as unknown[])[2] = null))).toContain("device_counters: before and after must hold whole numbers, 0 or more");
	});

	test("a change field missing", () => {
		expect(problemsAfter((w) => delete (w.store.counters.change as Json).reads)).toContain("device_counters: change.reads is undefined, but after minus before is 3");
	});

	test("in_flight that is not the stat file's field 8", () => {
		expect(problemsAfter((w) => (w.store.counters.in_flight_after = 5))).toContain(
			"device_counters: in_flight_before and in_flight_after are 0 and 5, but the stat file's field 8 was 0 and 0",
		);
	});

	test("a partition's change that disagrees with its counters", () => {
		expect(problemsAfter((w) => (((w.root.counters.partition as Json).change as Json).writes = 99))).toContain(
			"device_counters.partition: change.writes is 99, but after minus before is 3",
		);
	});

	test("an NVMe counter given as a string", () => {
		const problems = problemsAfter((w) => {
			w.sections.before.nvme_stats = { ...w.sections.before.nvme_stats, "$ nvme amzn stats /dev/nvme0n1 -o json": ran({ ...nvme(500, 2000), total_write_ops: "2000" }) };
		});
		expect(problems).toEqual(['the before-dump\'s nvme amzn stats total_write_ops is "2000", not a finite number']);
	});

	test("no request_bytes in observed", () => {
		expect(problemsAfter((w) => delete w.store.observed.request_bytes)).toContain("observed request_bytes is undefined, not a finite number");
	});

	test("a dump's stat file that is not whole numbers", () => {
		const problems = problemsAfter((w) => {
			w.sections.after.block_stat = { ...w.sections.after.block_stat, "/sys/block/nvme1n1/stat": "1003 x 8048\n" };
		});
		expect(problems).toContain("the dumps hold no whole-number /sys/block/nvme1n1/stat before and after");
	});
});

describe("the disk found must be the disk declared", () => {
	test('"instance_store" that found the root volume\'s EBS device', () => {
		const problems = problemsAfter((w) => {
			(w.root.run.params as Json).disk = "instance_store";
		});
		expect(problems).toEqual([
			`it declares disk "instance_store", but found "${EBS_MODEL}" mounted at /; an instance-store set must find an "${INSTANCE_STORE_MODEL}" device mounted at its dir, ${ROOT_DIR}`,
		]);
	});

	test('"root_volume" that found the instance store', () => {
		const problems = problemsAfter((w) => {
			(w.store.run.params as Json).disk = "root_volume";
		});
		expect(problems).toEqual([
			`it declares disk "root_volume", but found "${INSTANCE_STORE_MODEL}" with the file's mount at ${STORE_DIR}, and lsblk does not list / as a mount point of nvme1n1; a root-volume set must find an "${EBS_MODEL}" device holding the root file system`,
		]);
	});

	test('"instance_store" on an instance-store device mounted somewhere other than its dir', () => {
		const problems = problemsAfter((w) => {
			(w.store.run.params as Json).dir = "/mnt/elsewhere";
			w.store.observed.file_path = "/mnt/elsewhere/ledgermath-fixture-v1";
		});
		expect(problems.some((problem) => problem.startsWith('it declares disk "instance_store", but found "Amazon EC2 NVMe Instance Storage" mounted at /mnt/lm/instance-store'))).toBe(true);
	});

	test('"root_volume" on an EBS device that does not hold the root file system', () => {
		const problems = problemsAfter((w) => {
			w.root.observed.mount_point = "/data";
		});
		expect(problems.some((problem) => problem.startsWith('it declares disk "root_volume", but found "Amazon Elastic Block Store" with the file\'s mount at /data'))).toBe(true);
	});

	test("a name that means nothing", () => {
		expect(problemsAfter((w) => ((w.root.run.params as Json).disk = "ebs"))).toContain('it declares disk "ebs", which is neither "instance_store" nor "root_volume"');
	});

	test("no block device at all is no disk: a problem, unless the caller accepts it (the container test's tmpfs)", () => {
		const tmpfs = (w: World): void => {
			Object.assign(w.root.observed, { device_found: false, fs_type: "tmpfs", mount_point: ROOT_DIR });
			for (const key of ["block_device", "disk_device", "disk_controller", "disk_model", "disk_serial"]) delete w.root.observed[key];
			w.root.counters = Object.assign(w.root.counters, { device_found: false });
			for (const key of ["disk_device", "stat", "change", "before", "after", "partition", "in_flight_before", "in_flight_after"]) delete w.root.counters[key];
			w.sections.before.devices = { ...w.sections.before.devices, "$ findmnt -J": ran({ filesystems: [{ target: "/", fstype: "xfs", children: [{ target: ROOT_DIR, fstype: "tmpfs" }] }] }) };
		};
		expect(problemsAfter(tmpfs)).toEqual([`it declares disk "root_volume", but found no block device behind ${ROOT_DIR}: it measured no disk`]);
		expect(problemsAfter(tmpfs, { acceptNoDevice: true })).toEqual([]);
	});
});

describe("an instance-store Run must be the device the provision record readied", () => {
	test("a record whose instance store is not ready", () => {
		const problems = problemsAfter((w) => {
			const text = JSON.parse(String(Object.values(w.sections.before.provision as Json)[0]));
			text.instance_store.state = "failed";
			w.sections.before.provision = { "/var/tmp/ledgermath/provision.json": JSON.stringify(text) };
		});
		expect(problems).toEqual(['the provision record\'s instance store is "failed", not ready']);
	});
});
