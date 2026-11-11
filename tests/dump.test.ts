import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The dump sections runner/run.py gained for the disk benchmarks, taken by
// tests/dump-sections.py with stand-ins for aws, nvme and IMDS.

type Section = Record<string, unknown>;
interface Results {
	ec2: { sections: Record<string, Section>; calls: string[] };
	ec2_refused: { sections: Record<string, Section>; calls: string[] };
	ec2_no_imds: { sections: Record<string, Section>; calls: string[] };
	boot: {
		once: Record<string, string>;
		indexes: Array<Record<string, string>>;
		provision: Section;
		missing: Section;
		without_record: string[];
		calls: string[];
	};
	nvme: { section: Section; calls: string[] };
	xfs: string[];
	dump: { names: string[]; devices: string[]; kernel_dirty: string[]; block_stat: string[] };
}

const scratch = mkdtempSync(join(tmpdir(), "dump-sections-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const done = spawnSync("python3", [join(import.meta.dir, "dump-sections.py"), scratch], { encoding: "utf8" });
if (done.status !== 0) throw new Error(`dump-sections.py failed:\n${done.stdout}${done.stderr}`);
const results = JSON.parse(done.stdout) as Results;

describe("what the EC2 API says, once per boot", () => {
	test("is three sections: the catalog record, the volumes and their status, and the instance's own record", () => {
		expect(Object.keys(results.ec2.sections).sort()).toEqual(["ec2_instance", "ec2_instance_type", "ec2_volumes"]);
		expect(results.ec2.calls).toEqual([
			"ec2 describe-instance-types --instance-types i4i.2xlarge --region us-east-2 --output json",
			"ec2 describe-volumes --filters Name=attachment.instance-id,Values=i-0123456789abcdef0 --region us-east-2 --output json",
			"ec2 describe-volume-status --volume-ids vol-0aaaaaaaaaaaaaaaa vol-0bbbbbbbbbbbbbbbb --region us-east-2 --output json",
			"ec2 describe-instances --instance-ids i-0123456789abcdef0 --region us-east-2 --output json",
		]);
		const volumes = results.ec2.sections.ec2_volumes as Record<string, { exit: number; stdout: string }>;
		expect(Object.keys(volumes).sort()).toEqual([
			"$ aws ec2 describe-volume-status --volume-ids vol-0aaaaaaaaaaaaaaaa vol-0bbbbbbbbbbbbbbbb --region us-east-2 --output json",
			"$ aws ec2 describe-volumes --filters Name=attachment.instance-id,Values=i-0123456789abcdef0 --region us-east-2 --output json",
		]);
		for (const result of Object.values(volumes)) expect(result.exit).toBe(0);
	});

	test("records a refused call with what it printed, and is never fatal", () => {
		const volumes = results.ec2_refused.sections.ec2_volumes as Record<string, Record<string, unknown>>;
		const listed = volumes["$ aws ec2 describe-volumes --filters Name=attachment.instance-id,Values=i-0123456789abcdef0 --region us-east-2 --output json"];
		expect(listed?.exit).toBe(254);
		expect(String(listed?.stderr)).toContain("UnauthorizedOperation");
		expect(volumes["$ aws ec2 describe-volume-status"]).toEqual({ "not taken": "describe-volumes gave no volume ids" });
		expect(results.ec2_refused.calls.length).toBe(3);
	});

	test("is not asked for when IMDS gives no instance, and says so", () => {
		expect(results.ec2_no_imds.calls).toEqual([]);
		for (const section of Object.values(results.ec2_no_imds.sections)) {
			expect(section).toEqual({ "not taken": "IMDS gave no instance id, instance type or region" });
		}
	});
});

describe("the sections taken once per boot", () => {
	test("are stored once and listed in every dump, the provision record among them, verbatim", () => {
		const { once, indexes } = results.boot;
		expect(Object.keys(once).sort()).toEqual(["ec2_instance", "ec2_instance_type", "ec2_volumes", "provision"]);
		for (const index of indexes) for (const [name, hash] of Object.entries(once)) expect(index[name]).toBe(hash);
		const [path, text] = Object.entries(results.boot.provision)[0] as [string, string];
		expect(path.endsWith("/provision.json")).toBe(true);
		expect(JSON.parse(text)).toEqual({ schema: "ledgermath.provision/1", steps: [] });
	});

	test("say so when the provision record is missing, and leave the section out when run.py is given none", () => {
		expect(Object.values(results.boot.missing)).toEqual([null]);
		expect(results.boot.without_record).toEqual(["ec2_instance", "ec2_instance_type", "ec2_volumes"]);
	});
});

describe("the dump taken around every Run", () => {
	test("holds nvme amzn stats of every Amazon NVMe namespace, and of no other disk", () => {
		expect(Object.keys(results.nvme.section)).toEqual(["$ nvme amzn stats /dev/nvme0n1 -o json", "$ nvme amzn stats /dev/nvme1n1 -o json"]);
		expect(results.nvme.calls).toEqual(["amzn stats /dev/nvme0n1 -o json", "amzn stats /dev/nvme1n1 -o json"]);
	});

	test("runs xfs_info once for each XFS file system, at its first mount point", () => {
		expect(results.xfs).toEqual(["/", "/mnt/lm/instance-store", "/mnt/with space"]);
	});

	test("keeps what changes on every read apart from devices, and devices gains lsblk's columns", () => {
		for (const name of ["block_stat", "nvme_stats", "devices", "kernel"]) expect(results.dump.names).toContain(name);
		expect(results.dump.devices).toContain(
			"$ lsblk -J -b -o NAME,TYPE,SIZE,MODEL,SERIAL,ROTA,FSTYPE,MOUNTPOINT,MAJ:MIN,PKNAME,LOG-SEC,PHY-SEC,MIN-IO,OPT-IO,DISC-GRAN,DISC-MAX,RA,RQ-SIZE,SCHED,MOUNTPOINTS",
		);
		expect(results.dump.kernel_dirty).toContain("/proc/sys/vm/dirty_background_ratio");
		expect(results.dump.kernel_dirty).toContain("/proc/sys/vm/dirty_expire_centisecs");
		for (const path of results.dump.block_stat) expect(path).toMatch(/^\/sys\/block\/[^/]+(\/[^/]+)?\/stat$/);
	});
});
