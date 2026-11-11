#!/usr/bin/env python3
"""Drives runner/provision.py's decisions through the cases they must get
right, with fake sysfs and /proc trees and a stand-in for every command it
would run. Used by tests/provision.test.ts.

    python3 tests/provision-cases.py OUT

For each case it builds the trees under OUT/<case>, runs provision.main() with
--sys, --proc, --node-dir, --instance-store-mount and --root-volume-dir all
under that directory, and records, without running any of them, the commands
provision.py asked for. What provision.py does itself (mkdir, rmdir, unlink) is
done for real there, so the case can say what exists afterwards. Prints one
JSON object: each case's exit status, decisions, commands (with OUT/<case>
written as $CASE), what exists afterwards, and the record's states.

A device node cannot be made without root, so make_node() makes a plain file
and node_number() answers from a table; read_start() and mounted_number()
answer as the case says. A case may also change the world after a named step
(`after`), as a device replaced between the check and the format would.
"""

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
EC2 = os.path.join(ROOT, "scripts", "box-in-container", "ec2")
EBS = "Amazon Elastic Block Store              "      # as sysfs pads it
STORE = "Amazon EC2 NVMe Instance Storage        "
MIB = 1 << 20


def load():
    spec = importlib.util.spec_from_file_location("provision", os.path.join(ROOT, "runner", "provision.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)


def link(path, target):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.lexists(path):
        os.remove(path)
    os.symlink(target, path)


def controller(sys_root, name, model, serial, namespaces):
    """namespaces: {name: {"dev": "259:1", "size": sectors, "partitions": [(name, dev)], "holders": [...]}},
    laid out as the kernel does: /sys/class/nvme/<controller>/<namespace>/,
    /sys/class/block/<namespace>/ with `device` linking to the controller, and
    /sys/dev/block/<major:minor> linking to /sys/class/block/<namespace>."""
    write(os.path.join(sys_root, "class", "nvme", name, "model"), model + "\n")
    write(os.path.join(sys_root, "class", "nvme", name, "serial"), serial + "\n")
    for ns, spec in namespaces.items():
        os.makedirs(os.path.join(sys_root, "class", "nvme", name, ns), exist_ok=True)
        block = os.path.join(sys_root, "class", "block", ns)
        write(os.path.join(block, "dev"), spec["dev"] + "\n")
        write(os.path.join(block, "size"), "%d\n" % spec.get("size", 3662109375))
        os.makedirs(os.path.join(block, "holders"), exist_ok=True)
        link(os.path.join(block, "device"), os.path.join("..", "..", "nvme", name))
        link(os.path.join(sys_root, "dev", "block", spec["dev"]), os.path.join("..", "..", "class", "block", ns))
        for holder in spec.get("holders", []):
            os.makedirs(os.path.join(block, "holders", holder), exist_ok=True)
        for part, dev in spec.get("partitions", []):
            write(os.path.join(block, part, "partition"), "1\n")
            write(os.path.join(block, part, "dev"), dev + "\n")


ROOT_DISK = {"nvme0n1": {"dev": "259:0", "size": 16777216,
                         "partitions": [("nvme0n1p1", "259:2"), ("nvme0n1p127", "259:3"), ("nvme0n1p128", "259:4")]}}
ROOT_MOUNTS = ("25 1 259:2 / / rw,noatime shared:1 - xfs /dev/nvme0n1p1 rw,attr2,inode64\n"
               "26 25 259:4 / /boot/efi rw,noatime shared:2 - vfat /dev/nvme0n1p128 rw\n")


def i4i(sys_root, store_number=1, **store):
    """An i4i.2xlarge: the EBS root volume and one instance-store disk, device 259:1."""
    ebs_number = 0 if store_number == 1 else 1
    ebs = {name.replace("nvme0", "nvme%d" % ebs_number): dict(spec, partitions=[(p.replace("nvme0", "nvme%d" % ebs_number), d) for p, d in spec["partitions"]])
           for name, spec in ROOT_DISK.items()}
    controller(sys_root, "nvme%d" % ebs_number, EBS, "vol0123456789abcdef0", ebs)
    controller(sys_root, "nvme%d" % store_number, STORE, "AWS0123456789ABCDEF0",
               {"nvme%dn1" % store_number: dict({"dev": "259:1"}, **store)})


def m5(sys_root):
    controller(sys_root, "nvme0", EBS, "vol0123456789abcdef0", ROOT_DISK)


# What a case can change after a step, as something replacing the device would.
def node_becomes(number):
    return lambda world: world["node_numbers"].update({path: number for path in world["node_numbers"]})


def number_now_names(namespace):
    return lambda world: link(os.path.join(world["sys"], "dev", "block", "259:1"), os.path.join("..", "..", "class", "block", namespace))


def gains_partition(world):
    write(os.path.join(world["sys"], "class", "block", "nvme1n1", "nvme1n1p1", "partition"), "1\n")


def gets_mounted(world):
    with open(os.path.join(world["proc"], "self", "mountinfo"), "a") as handle:
        handle.write("40 25 259:1 / /data rw - ext4 /dev/nvme1n1 rw\n")


LAST_BEFORE = "before nvme amzn stats"

CASES = {
    # name: (instance type, builder, options)
    "i4i": ("i4i.2xlarge", i4i, {}),
    "i4i-numbered-the-other-way": ("i4i.2xlarge", lambda s: i4i(s, store_number=0), {}),
    "m5-large": ("m5.large", m5, {}),
    "catalog-unreadable": ("i4i.2xlarge", i4i, {"catalog_fails": True}),
    "catalog-lists-none": ("m5.large", i4i, {}),
    "catalog-lists-one-none-found": ("i4i.2xlarge", m5, {}),
    "two-found": ("i4i.2xlarge", lambda s: (i4i(s), controller(s, "nvme2", STORE, "AWS2", {"nvme2n1": {"dev": "259:5"}})), {}),
    "model-differs": ("i4i.2xlarge", lambda s: (controller(s, "nvme0", EBS, "vol0", ROOT_DISK),
                                                controller(s, "nvme1", "Amazon EC2 NVMe Instance Storage v2", "AWS1", {"nvme1n1": {"dev": "259:1"}})), {}),
    "partitioned": ("i4i.2xlarge", lambda s: i4i(s, partitions=[("nvme1n1p1", "259:6")]), {}),
    "held": ("i4i.2xlarge", lambda s: i4i(s, holders=["dm-0"]), {}),
    "mounted": ("i4i.2xlarge", i4i, {"mounts": ROOT_MOUNTS + "40 25 259:1 / /data rw - ext4 /dev/nvme1n1 rw\n"}),
    "no-imds": ("", i4i, {}),
    "node-cannot-be-made": ("i4i.2xlarge", i4i, {"node_fails": True}),
    "node-is-another-device": ("i4i.2xlarge", i4i, {"node_number": "259:9"}),
    "signature": ("i4i.2xlarge", i4i, {"blkid": [(0, "/dev/x: UUID=\"1\" TYPE=\"ext4\"\n", "")]}),
    "blkid-fails": ("i4i.2xlarge", i4i, {"blkid": [(4, "", "")]}),
    "blkid-cannot-open": ("i4i.2xlarge", i4i, {"blkid": [(2, "", "error: /run/x: Permission denied\n")]}),
    "signature-at-recheck": ("i4i.2xlarge", i4i, {"blkid": [(2, "", ""), (0, "/dev/x: TYPE=\"xfs\"\n", "")]}),
    "unreadable": ("i4i.2xlarge", i4i, {"read_fails": True}),
    "node-changes-before-format": ("i4i.2xlarge", i4i, {"after": {LAST_BEFORE: node_becomes("259:7")}}),
    "number-names-another-disk": ("i4i.2xlarge", i4i, {"after": {LAST_BEFORE: number_now_names("nvme0n1")}}),
    "partitioned-before-format": ("i4i.2xlarge", i4i, {"after": {LAST_BEFORE: gains_partition}}),
    "mounted-before-format": ("i4i.2xlarge", i4i, {"after": {LAST_BEFORE: gets_mounted}}),
    "mkfs-fails": ("i4i.2xlarge", i4i, {"exits": {"mkfs.xfs": 1}}),
    "mount-fails": ("i4i.2xlarge", i4i, {"exits": {"mount": 32}}),
    "mounted-device-differs": ("i4i.2xlarge", i4i, {"mounted": {"stat": "259:2", "mountinfo": "259:2"}}),
    "mounted-device-differs-umount-fails": ("i4i.2xlarge", i4i, {"mounted": {"stat": "259:2", "mountinfo": "259:2"}, "exits": {"umount": 32}}),
    "mountinfo-differs": ("i4i.2xlarge", i4i, {"mounted": {"stat": "259:1", "mountinfo": "259:2"}}),
    "mount-point-left-at-boot": ("i4i.2xlarge", i4i, {"mount_point_before": "empty"}),
    "mount-point-left-at-boot-with-files": ("i4i.2xlarge", i4i, {"mount_point_before": "files"}),
    "instance-fixture-fails": ("i4i.2xlarge", i4i, {"fixture_fails": {"instance_store"}}),
    "root-fixture-fails": ("m5.large", m5, {"fixture_fails": {"root_volume"}}),
}


def run_case(provision, base, name):
    instance_type, build, options = CASES[name]
    case = os.path.join(base, name)
    world = {"sys": os.path.join(case, "sys"), "proc": os.path.join(case, "proc"), "node_numbers": {}}
    mount_point = os.path.join(case, "mnt", "lm", "instance-store")
    root_dir = os.path.join(case, "var", "tmp", "ledgermath", "disk")
    node_dir = os.path.join(case, "run", "ledgermath")
    build(world["sys"])
    write(os.path.join(world["proc"], "self", "mountinfo"), options.get("mounts", ROOT_MOUNTS))
    if options.get("mount_point_before"):
        os.makedirs(mount_point)
        if options["mount_point_before"] == "files":
            write(os.path.join(mount_point, "something"), "x")
    commands = []
    blkid = list(options.get("blkid", []))

    def run(self, step, arguments, timeout=120, environment=None, cleanup=False):
        self.check(cleanup)
        commands.append(" ".join(arguments))
        entry = {"step": step, "command": arguments, "state": "ended", "exit": 0, "stdout": "", "stderr": "", "seconds": 0.0}
        program = os.path.basename(arguments[0])
        if program == "aws":
            path = os.path.join(EC2, "describe-instance-types-%s.json" % arguments[arguments.index("--instance-types") + 1])
            if options.get("catalog_fails") or not os.path.exists(path):
                entry.update(exit=254, stderr="An error occurred (UnauthorizedOperation)")
            else:
                with open(path) as handle:
                    entry["stdout"] = handle.read()
        elif program == "blkid":
            code, out, err = blkid.pop(0) if blkid else (2, "", "")
            entry.update(exit=code, stdout=out, stderr=err)
        elif program == "fixture":
            disk = step.split(" ", 1)[1]
            if disk in options.get("fixture_fails", ()):
                write(arguments[1], "a partial Fixture")  # as a killed fixture tool would leave it
                entry.update(exit=1, stderr="fixture: error: pwrite: No space left on device")
            else:
                write(arguments[1], "a Fixture")
                entry["stdout"] = json.dumps({"bytes": int(arguments[2])})
        else:
            entry["exit"] = options.get("exits", {}).get(" ".join(arguments[:2]) if arguments[:2] == ["umount", "-l"] else program, 0)
        self.record["steps"].append(entry)
        hook = options.get("after", {}).get(step)
        if hook:
            hook(world)
        return entry

    def make_node(path, number):
        if options.get("node_fails"):
            raise PermissionError(1, "Operation not permitted", path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write(path, "")
        world["node_numbers"][path] = options.get("node_number", number)

    def mounted_number(path, proc_root):
        return options.get("mounted", {"stat": "259:1", "mountinfo": "259:1"})

    def read_start(path):
        if options.get("read_fails"):
            raise PermissionError(1, "Operation not permitted", path)
        return b"\0" * MIB

    provision.Recorder.run = run
    provision.make_node = make_node
    provision.node_number = lambda path: world["node_numbers"].get(path)
    provision.mounted_number = mounted_number
    provision.read_start = read_start
    record = os.path.join(case, "provision.json")
    status = provision.main(["--record", record, "--fixture-tool", "/opt/fixture", "--instance-type", instance_type,
                             "--region", "us-east-2" if instance_type else "", "--sys", world["sys"], "--proc", world["proc"],
                             "--node-dir", node_dir, "--instance-store-mount", mount_point, "--root-volume-dir", root_dir,
                             "--steps-dir", os.path.join(case, "steps")])
    with open(record) as handle:
        written = json.load(handle)
    show = lambda text: text.replace(case, "$CASE")
    return {
        "status": status,
        "decisions": [{"what": d["what"], "action": d["action"], "reason": show(d["reason"]), "disk": (d.get("disk") or {}).get("name")}
                      for d in written["decisions"]],
        "commands": [show(command) for command in commands],
        "actions": [show(" ".join(step["command"])) + (" FAILED" if step.get("exit") else "")
                    for step in written["steps"] if step.get("by") == "provision.py"],
        "moved_aside": sorted(name for name in os.listdir(os.path.dirname(mount_point)) if ".found-at-boot-" in name)
                       if os.path.isdir(os.path.dirname(mount_point)) else [],
        "exists": {"mount_point": os.path.isdir(mount_point), "root_volume_dir": os.path.isdir(root_dir),
                   "instance_store_fixture": os.path.exists(os.path.join(mount_point, "ledgermath-fixture-v1")),
                   "root_volume_fixture": os.path.exists(os.path.join(root_dir, "ledgermath-fixture-v1"))},
        "instance_store": written.get("instance_store"),
        "root_volume": written.get("root_volume"),
        "state": written["state"],
        "found": [disk["name"] for disk in written.get("instance_store_disks_found", [])],
        "catalog_instance_store_disks": written.get("catalog_instance_store_disks"),
        "schema": written["schema"],
    }


def main():
    base = os.path.abspath(sys.argv[1])
    os.makedirs(base, exist_ok=True)
    provision = load()
    provision.log = lambda message: None
    results = {}
    for name in CASES:
        module = load()  # fresh stubs for each case
        module.log = lambda message: None
        results[name] = run_case(module, base, name)
    print(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
