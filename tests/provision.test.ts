import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// runner/provision.py's decisions: which disk it prepares, what it refuses to
// format, that the device it checked is the device it formats and mounts, and
// that nothing is left at the mount point or the root volume's directory when
// their preparation did not succeed. tests/provision-cases.py builds fake
// sysfs and /proc trees for each case and records, without running them, the
// commands it asks for.

interface Case {
	status: number;
	decisions: Array<{ what: string; action: string; reason: string; disk: string | null }>;
	commands: string[];
	actions: string[];
	moved_aside: string[];
	exists: { mount_point: boolean; root_volume_dir: boolean; instance_store_fixture: boolean; root_volume_fixture: boolean };
	instance_store: { state: string; device?: string; node?: string; mounted_device?: unknown } | null;
	root_volume: { state: string } | null;
	state: string;
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
const instanceStore = (name: string) => get(name).decisions.filter((decision) => decision.what === "instance_store").at(-1);
const formats = (name: string): string[] => get(name).commands.filter((command) => command.startsWith("mkfs"));
const mounts = (name: string): string[] => get(name).commands.filter((command) => command.startsWith("mount "));
const fixtures = (name: string): string[] => get(name).commands.filter((command) => command.startsWith("/opt/fixture"));
const NODE = "$CASE/run/ledgermath/instance-store-259-1";
const MOUNT = "$CASE/mnt/lm/instance-store";
const ROOT_FIXTURE = "/opt/fixture $CASE/var/tmp/ledgermath/disk/ledgermath-fixture-v1 1073741824";
const STORE_FIXTURE = `/opt/fixture ${MOUNT}/ledgermath-fixture-v1 34359738368`;

describe("on an i4i.2xlarge", () => {
	test("finds the disk by its model, then works on a device node of its own for its number: records, checks again, formats, mounts, fills", () => {
		const c = get("i4i");
		expect(c.status).toBe(0);
		expect(c.schema).toBe("ledgermath.provision/2");
		expect(c.state).toBe("done");
		expect(c.found).toEqual(["nvme1n1"]);
		expect(c.catalog_instance_store_disks).toBe(1);
		expect(instanceStore("i4i")).toMatchObject({ action: "prepare", disk: "nvme1n1" });
		expect(c.instance_store).toMatchObject({ state: "ready", device: "259:1", disk: "nvme1n1", serial: "AWS0123456789ABCDEF0", mounted_device: { stat: "259:1", mountinfo: "259:1" } });
		expect(c.instance_store?.node?.endsWith("/run/ledgermath/instance-store-259-1")).toBe(true);
		expect(c.commands).toEqual([
			"aws ec2 describe-instance-types --region us-east-2 --instance-types i4i.2xlarge --output json",
			`lsblk -J -b -O ${NODE}`,
			`blkid -p ${NODE}`,
			`nvme id-ctrl ${NODE} -o json`,
			`nvme id-ns ${NODE} -H`,
			`nvme amzn stats ${NODE} -o json`,
			`blkid -p ${NODE}`,
			`mkfs.xfs ${NODE}`,
			`mount -t xfs ${NODE} ${MOUNT}`,
			`xfs_info ${MOUNT}`,
			`findmnt -J ${MOUNT}`,
			`lsblk -J -b -O ${NODE}`,
			STORE_FIXTURE,
			ROOT_FIXTURE,
			"findmnt -J -T $CASE/var/tmp/ledgermath/disk",
			"df -B1 --output=source,fstype,size,used,avail,target / $CASE/var/tmp/ledgermath/disk",
		]);
		expect(c.actions).toEqual([`mknod ${NODE} b 259 1`, `read ${NODE} 1048576`, `mkdir -p ${MOUNT}`, "mkdir -p $CASE/var/tmp/ledgermath/disk"]);
		// Nothing runs on a /dev name, so nothing can be redirected by renaming one.
		expect(c.commands.some((command) => command.includes("/dev/"))).toBe(false);
		expect(c.exists).toEqual({ mount_point: true, root_volume_dir: true, instance_store_fixture: true, root_volume_fixture: true });
	});

	test("never assumes the numbering: with the instance store as nvme0, it is that disk's number that is prepared", () => {
		expect(instanceStore("i4i-numbered-the-other-way")).toMatchObject({ action: "prepare", disk: "nvme0n1" });
		expect(formats("i4i-numbered-the-other-way")).toEqual([`mkfs.xfs ${NODE}`]);
	});

	test("never forces mkfs.xfs, and mounts as XFS explicitly", () => {
		for (const name of Object.keys(cases)) {
			for (const command of formats(name)) expect(command).toBe(`mkfs.xfs ${NODE}`);
			for (const command of mounts(name)) expect(command).toBe(`mount -t xfs ${NODE} ${MOUNT}`);
		}
	});
});

describe("a type with no instance store", () => {
	test("has no instance-store step, and still gets the root volume's Fixture", () => {
		const c = get("m5-large");
		expect(c.status).toBe(0);
		expect(c.found).toEqual([]);
		expect(c.catalog_instance_store_disks).toBe(0);
		expect(instanceStore("m5-large")?.action).toBe("none");
		expect(c.instance_store?.state).toBe("none");
		expect(formats("m5-large")).toEqual([]);
		expect(fixtures("m5-large")).toEqual([ROOT_FIXTURE]);
		expect(c.exists.mount_point).toBe(false);
	});
});

describe("refuses to format, records why, makes no mount point, and still makes the root volume's Fixture", () => {
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
		["node-cannot-be-made", /a device node for 259:1 could not be made/],
		["node-is-another-device", /instance-store-259-1 is device 259:9, not 259:1/],
		["signature", /blkid -p found a signature on it: it is not empty/],
		["blkid-fails", /blkid -p exited 4: whether it is empty cannot be told/],
		["blkid-cannot-open", /blkid -p exited 2 but said 'error: \/run\/x: Permission denied': it may not have read the device/],
		// Checked again, by the device number, just before formatting.
		["signature-at-recheck", /^just before formatting, blkid -p found a signature/],
		["unreadable", /^just before formatting, provision.py could not read the first MiB/],
		["node-changes-before-format", /^just before formatting, .*instance-store-259-1 is now device 259:7, not 259:1/],
		["number-names-another-disk", /^just before formatting, device number 259:1 now has name 'nvme0n1', not 'nvme1n1'/],
		["partitioned-before-format", /^just before formatting, nvme1n1 now has partitions \(nvme1n1p1\)/],
		["mounted-before-format", /^just before formatting, nvme1n1 \(259:1\) is now mounted/],
	];
	for (const [name, reason] of refusals) {
		test(name, () => {
			const c = get(name);
			const decision = instanceStore(name);
			expect(decision?.action).toBe("refuse");
			expect(decision?.reason).toMatch(reason);
			expect(c.instance_store?.state).toBe("refused");
			expect(formats(name)).toEqual([]);
			expect(mounts(name)).toEqual([]);
			expect(c.exists.mount_point).toBe(false);
			expect(fixtures(name)).toEqual([ROOT_FIXTURE]);
			expect(c.exists.root_volume_fixture).toBe(true);
			expect(c.status).toBe(1);
		});
	}

	test("a disk refused after it was found was recorded first, and only read", () => {
		expect(get("signature").commands.filter((command) => command.includes("instance-store-259-1"))).toEqual([
			`lsblk -J -b -O ${NODE}`,
			`blkid -p ${NODE}`,
			`nvme id-ctrl ${NODE} -o json`,
			`nvme id-ns ${NODE} -H`,
			`nvme amzn stats ${NODE} -o json`,
		]);
	});
});

describe("a format or mount that does not succeed leaves no mount point, so no instance-store set can run on the root volume", () => {
	test("mkfs.xfs fails: no mount point is made", () => {
		const c = get("mkfs-fails");
		expect(c.status).toBe(1);
		expect(c.instance_store?.state).toBe("failed");
		expect(mounts("mkfs-fails")).toEqual([]);
		expect(c.actions).not.toContain(`mkdir -p ${MOUNT}`);
		expect(c.exists.mount_point).toBe(false);
		expect(fixtures("mkfs-fails")).toEqual([ROOT_FIXTURE]);
	});

	test("mount fails: the mount point it made is removed, and no Fixture is written there", () => {
		const c = get("mount-fails");
		expect(c.status).toBe(1);
		expect(c.instance_store?.state).toBe("failed");
		expect(c.actions).toContain(`mkdir -p ${MOUNT}`);
		expect(c.actions).toContain(`rmdir ${MOUNT}`);
		expect(c.commands.some((command) => command.startsWith("umount"))).toBe(false);
		expect(c.exists.mount_point).toBe(false);
		expect(fixtures("mount-fails")).toEqual([ROOT_FIXTURE]);
	});

	for (const name of ["mounted-device-differs", "mountinfo-differs"]) {
		test(`${name}: the mounted file system is not the checked device: unmounted, the mount point removed, recorded`, () => {
			const c = get(name);
			expect(c.status).toBe(1);
			expect(c.instance_store?.state).toBe("failed");
			const refused = c.decisions.find((decision) => decision.what === "instance_store mount");
			expect(refused?.action).toBe("refuse");
			expect(refused?.reason).toMatch(/is mounted from device .* not the checked 259:1/);
			expect(c.commands).toContain(`umount ${MOUNT}`);
			expect(c.actions).toContain(`rmdir ${MOUNT}`);
			expect(c.exists.mount_point).toBe(false);
			expect(fixtures(name)).toEqual([ROOT_FIXTURE]);
			expect(c.commands.some((command) => command.startsWith("xfs_info"))).toBe(false);
		});
	}

	test("if umount fails, it unmounts lazily, and still removes the mount point", () => {
		const c = get("mounted-device-differs-umount-fails");
		expect(c.commands.filter((command) => command.startsWith("umount"))).toEqual([`umount ${MOUNT}`, `umount -l ${MOUNT}`]);
		expect(c.exists.mount_point).toBe(false);
	});

	test("an empty directory found at the mount point at boot is removed first", () => {
		const c = get("mount-point-left-at-boot");
		expect(c.actions[0]).toBe(`rmdir ${MOUNT}`);
		expect(c.instance_store?.state).toBe("ready");
	});

	test("one with files in it is moved aside, never deleted, before anything else", () => {
		const c = get("mount-point-left-at-boot-with-files");
		expect(c.actions.slice(0, 2)).toEqual([`rmdir ${MOUNT} FAILED`, expect.stringMatching(new RegExp(`^mv \\$CASE/mnt/lm/instance-store \\$CASE/mnt/lm/instance-store\\.found-at-boot-\\d+$`))]);
		expect(c.moved_aside.length).toBe(1);
		expect(c.instance_store?.state).toBe("ready");
	});
});

describe("a Fixture not made whole is removed", () => {
	test("on the instance store: the partial file goes, the verified mount stays", () => {
		const c = get("instance-fixture-fails");
		expect(c.status).toBe(1);
		expect(c.instance_store?.state).toBe("ready");
		expect(c.actions).toContain(`rm ${MOUNT}/ledgermath-fixture-v1`);
		expect(c.exists).toMatchObject({ mount_point: true, instance_store_fixture: false, root_volume_fixture: true });
	});

	test("on the root volume: the partial file and the directory go, so no root-volume set finds a directory", () => {
		const c = get("root-fixture-fails");
		expect(c.status).toBe(1);
		expect(c.root_volume?.state).toBe("failed");
		expect(c.actions).toEqual([
			"mkdir -p $CASE/var/tmp/ledgermath/disk",
			"rm $CASE/var/tmp/ledgermath/disk/ledgermath-fixture-v1",
			"rmdir $CASE/var/tmp/ledgermath/disk",
		]);
		expect(c.exists).toMatchObject({ root_volume_dir: false, root_volume_fixture: false });
	});
});
