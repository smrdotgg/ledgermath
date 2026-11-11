import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// runner/provision.py's decisions: which disk it prepares, and what it refuses
// to format. tests/provision-cases.py builds fake sysfs, /dev and /proc trees
// for each case and records, without running them, the commands it asks for.

interface Case {
	status: number;
	decisions: Array<{ what: string; action: string; reason: string; disk: string | null }>;
	commands: string[];
	found: string[];
	catalog_instance_store_disks: number | null;
	schema: string;
}

const scratch = mkdtempSync(join(tmpdir(), "provision-cases-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const done = spawnSync("python3", [join(import.meta.dir, "provision-cases.py"), join(scratch, "out")], { encoding: "utf8" });
if (done.status !== 0) throw new Error(`provision-cases.py failed:\n${done.stdout}${done.stderr}`);
const cases = JSON.parse(done.stdout) as Record<string, Case>;

const get = (name: string): Case => {
	const found = cases[name];
	if (!found) throw new Error(`no case ${name}`);
	return found;
};
const instanceStore = (name: string) => get(name).decisions.find((decision) => decision.what === "instance_store");
const formats = (name: string): string[] => get(name).commands.filter((command) => command.startsWith("mkfs"));
const fixtures = (name: string): string[] => get(name).commands.filter((command) => command.startsWith("/opt/fixture"));
const ROOT_FIXTURE = "/opt/fixture /var/tmp/ledgermath/disk/ledgermath-fixture-v1 1073741824";
const STORE_FIXTURE = "/opt/fixture /mnt/lm/instance-store/ledgermath-fixture-v1 34359738368";

describe("on an i4i.2xlarge", () => {
	test("finds the instance-store disk by its model, records it, then formats, mounts and fills it, and the root volume's Fixture too", () => {
		const c = get("i4i");
		expect(c.status).toBe(0);
		expect(c.schema).toBe("ledgermath.provision/1");
		expect(c.found).toEqual(["nvme1n1"]);
		expect(c.catalog_instance_store_disks).toBe(1);
		expect(instanceStore("i4i")).toMatchObject({ action: "prepare", disk: "nvme1n1" });
		expect(c.commands).toEqual([
			"aws ec2 describe-instance-types --region us-east-2 --instance-types i4i.2xlarge --output json",
			"lsblk -J -b -O /dev/nvme1n1",
			"blkid -p /dev/nvme1n1",
			"nvme id-ctrl /dev/nvme1 -o json",
			"nvme id-ns /dev/nvme1n1 -H",
			"nvme amzn stats /dev/nvme1n1 -o json",
			"mkfs.xfs /dev/nvme1n1",
			"mkdir -p /mnt/lm/instance-store",
			"mount /dev/nvme1n1 /mnt/lm/instance-store",
			"xfs_info /mnt/lm/instance-store",
			"findmnt -J /mnt/lm/instance-store",
			"lsblk -J -b -O /dev/nvme1n1",
			STORE_FIXTURE,
			"mkdir -p /var/tmp/ledgermath/disk",
			ROOT_FIXTURE,
			"findmnt -J -T /var/tmp/ledgermath/disk",
			"df -B1 --output=source,fstype,size,used,avail,target / /var/tmp",
		]);
		// Nothing of the root volume's disk is ever named.
		expect(c.commands.some((command) => command.includes("nvme0"))).toBe(false);
	});

	test("never assumes the numbering: with the instance store as nvme0, it is nvme0n1 that is prepared", () => {
		expect(instanceStore("i4i-numbered-the-other-way")).toMatchObject({ action: "prepare", disk: "nvme0n1" });
		expect(formats("i4i-numbered-the-other-way")).toEqual(["mkfs.xfs /dev/nvme0n1"]);
	});

	test("never forces mkfs.xfs, and stops when it fails: no mount, no Fixture there, and the boot is told", () => {
		for (const name of Object.keys(cases)) for (const command of formats(name)) expect(command).not.toContain("-f");
		const c = get("mkfs-fails");
		expect(c.status).toBe(1);
		expect(c.commands.some((command) => command.startsWith("mount"))).toBe(false);
		expect(fixtures("mkfs-fails")).toEqual([ROOT_FIXTURE]);
	});
});

describe("a type with no instance store", () => {
	test("has no instance-store step, and still gets the root volume's Fixture", () => {
		const c = get("m5-large");
		expect(c.status).toBe(0);
		expect(c.found).toEqual([]);
		expect(c.catalog_instance_store_disks).toBe(0);
		expect(instanceStore("m5-large")?.action).toBe("none");
		expect(formats("m5-large")).toEqual([]);
		expect(fixtures("m5-large")).toEqual([ROOT_FIXTURE]);
	});
});

describe("refuses to format, records why, and still makes the root volume's Fixture", () => {
	const refusals: Array<[string, RegExp]> = [
		["catalog-unreadable", /the catalog could not be read, so the count of instance-store disks cannot be compared/],
		["no-imds", /the catalog could not be read/],
		["catalog-lists-none", /found 1 instance-store disk \(nvme1n1\), but the catalog lists 0/],
		["catalog-lists-one-none-found", /the catalog lists 1 instance-store disk, but no NVMe controller has the model/],
		["two-found", /found 2 instance-store disks \(nvme1n1, nvme2n1\), but the catalog lists 1/],
		["model-differs", /no NVMe controller has the model 'Amazon EC2 NVMe Instance Storage'/],
		["partitioned", /nvme1n1 has partitions \(nvme1n1p1\): it is not empty/],
		["held", /nvme1n1 is held by dm-0: it is in use/],
		["mounted", /nvme1n1 \(259:1\) is mounted already/],
		["no-device-node", /the device node .*\/nvme1n1 cannot be used: No such file or directory/],
		["node-not-a-block-device", /nvme1n1 is not a block device node/],
		["signature", /blkid -p found a signature on it: it is not empty/],
		["blkid-fails", /blkid -p exited 4: whether it is empty cannot be told/],
	];
	for (const [name, reason] of refusals) {
		test(name, () => {
			const decision = instanceStore(name);
			expect(decision?.action).toBe("refuse");
			expect(decision?.reason).toMatch(reason);
			expect(formats(name)).toEqual([]);
			expect(get(name).commands.some((command) => command.startsWith("mount"))).toBe(false);
			expect(fixtures(name)).toEqual([ROOT_FIXTURE]);
			expect(get(name).status).toBe(1);
		});
	}

	test("a disk refused after it was found was recorded first, and blkid is the only thing that touched it", () => {
		const c = get("signature");
		expect(c.commands.filter((command) => command.includes("nvme1"))).toEqual([
			"lsblk -J -b -O /dev/nvme1n1",
			"blkid -p /dev/nvme1n1",
			"nvme id-ctrl /dev/nvme1 -o json",
			"nvme id-ns /dev/nvme1n1 -H",
			"nvme amzn stats /dev/nvme1n1 -o json",
		]);
	});
});
