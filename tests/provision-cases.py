#!/usr/bin/env python3
"""Drives runner/provision.py through the cases its decisions must get right,
with fake sysfs, /dev and /proc trees and a stand-in for every command it would
run. Used by tests/provision.test.ts.

    python3 tests/provision-cases.py OUT

For each case it builds the trees under OUT/<case>, runs provision.main() with
--sys, --dev and --proc pointing at them, and records, without running any of
them, the commands provision.py asked for. Prints one JSON object: each case's
exit status, the decisions recorded, and the commands, in order.

The stand-in answers the catalog from scripts/box-in-container/ec2/ (or fails
it), and blkid, mkfs.xfs and the rest as the case says. A device node cannot be
made without root, so where a case needs one that is right, device_node() is
replaced by one that accepts it; the cases about the node itself use the real
one against the fake /dev.
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


def load():
    spec = importlib.util.spec_from_file_location("provision", os.path.join(ROOT, "runner", "provision.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)


def controller(sys_root, name, model, serial, namespaces):
    """namespaces: {name: {"dev": "259:1", "size": sectors, "partitions": [(name, dev)], "holders": [...]}}"""
    write(os.path.join(sys_root, "class", "nvme", name, "model"), model + "\n")
    write(os.path.join(sys_root, "class", "nvme", name, "serial"), serial + "\n")
    for ns, spec in namespaces.items():
        os.makedirs(os.path.join(sys_root, "class", "nvme", name, ns), exist_ok=True)
        block = os.path.join(sys_root, "class", "block", ns)
        write(os.path.join(block, "dev"), spec["dev"] + "\n")
        write(os.path.join(block, "size"), "%d\n" % spec.get("size", 3662109375))
        os.makedirs(os.path.join(block, "holders"), exist_ok=True)
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
    """An i4i.2xlarge: the EBS root volume and one instance-store disk."""
    ebs_number = 0 if store_number == 1 else 1
    ebs = {name.replace("nvme0", "nvme%d" % ebs_number): dict(spec, partitions=[(p.replace("nvme0", "nvme%d" % ebs_number), d) for p, d in spec["partitions"]])
           for name, spec in ROOT_DISK.items()}
    controller(sys_root, "nvme%d" % ebs_number, EBS, "vol0123456789abcdef0", ebs)
    controller(sys_root, "nvme%d" % store_number, STORE, "AWS0123456789ABCDEF0",
               {"nvme%dn1" % store_number: dict({"dev": "259:1"}, **store)})


CASES = {
    # name: (instance type, builder, overrides)
    "i4i": ("i4i.2xlarge", lambda s: i4i(s), {}),
    "i4i-numbered-the-other-way": ("i4i.2xlarge", lambda s: i4i(s, store_number=0), {}),
    "m5-large": ("m5.large", lambda s: controller(s, "nvme0", EBS, "vol0123456789abcdef0", ROOT_DISK), {}),
    "catalog-unreadable": ("i4i.2xlarge", lambda s: i4i(s), {"catalog_fails": True}),
    "catalog-lists-none": ("m5.large", lambda s: i4i(s), {}),
    "catalog-lists-one-none-found": ("i4i.2xlarge", lambda s: controller(s, "nvme0", EBS, "vol0123456789abcdef0", ROOT_DISK), {}),
    "two-found": ("i4i.2xlarge", lambda s: (i4i(s), controller(s, "nvme2", STORE, "AWS2", {"nvme2n1": {"dev": "259:5"}})), {}),
    "model-differs": ("i4i.2xlarge", lambda s: (controller(s, "nvme0", EBS, "vol0", ROOT_DISK),
                                                controller(s, "nvme1", "Amazon EC2 NVMe Instance Storage v2", "AWS1", {"nvme1n1": {"dev": "259:1"}})), {}),
    "partitioned": ("i4i.2xlarge", lambda s: i4i(s, partitions=[("nvme1n1p1", "259:6")]), {}),
    "held": ("i4i.2xlarge", lambda s: i4i(s, holders=["dm-0"]), {}),
    "mounted": ("i4i.2xlarge", lambda s: i4i(s), {"mounts": ROOT_MOUNTS + "40 25 259:1 / /data rw - ext4 /dev/nvme1n1 rw\n"}),
    "no-device-node": ("i4i.2xlarge", lambda s: i4i(s), {"real_node_check": True}),
    "node-not-a-block-device": ("i4i.2xlarge", lambda s: i4i(s), {"real_node_check": True, "regular_node": True}),
    "signature": ("i4i.2xlarge", lambda s: i4i(s), {"blkid": 0}),
    "blkid-fails": ("i4i.2xlarge", lambda s: i4i(s), {"blkid": 4}),
    "mkfs-fails": ("i4i.2xlarge", lambda s: i4i(s), {"mkfs": 1}),
    "no-imds": ("", lambda s: i4i(s), {}),
}


def run_case(provision, base, name):
    instance_type, build, options = CASES[name]
    sys_root, dev_root, proc_root = (os.path.join(base, name, part) for part in ("sys", "dev", "proc"))
    os.makedirs(dev_root)
    build(sys_root)
    write(os.path.join(proc_root, "self", "mountinfo"), options.get("mounts", ROOT_MOUNTS))
    if options.get("regular_node"):
        write(os.path.join(dev_root, "nvme1n1"), "")
    commands = []

    def run(self, step, arguments, timeout=120, environment=None):
        commands.append(" ".join(arguments))
        entry = {"step": step, "command": arguments, "exit": 0, "stdout": "", "stderr": "", "seconds": 0.0}
        program = os.path.basename(arguments[0])
        if program == "aws":
            path = os.path.join(EC2, "describe-instance-types-%s.json" % arguments[arguments.index("--instance-types") + 1])
            if options.get("catalog_fails") or not os.path.exists(path):
                entry.update(exit=254, stderr="An error occurred (UnauthorizedOperation)")
            else:
                with open(path) as handle:
                    entry["stdout"] = handle.read()
        elif program == "blkid":
            entry["exit"] = options.get("blkid", 2)
        elif program == "mkfs.xfs":
            entry["exit"] = options.get("mkfs", 0)
        elif program == "fixture":
            entry["stdout"] = json.dumps({"bytes": int(arguments[2])})
        self.record["steps"].append(entry)
        return entry

    provision.Recorder.run = run
    real_node = provision.device_node
    if not options.get("real_node_check"):
        provision.device_node = lambda dev, disk_name, expected: None
    record = os.path.join(base, name, "provision.json")
    try:
        status = provision.main(["--record", record, "--fixture-tool", "/opt/fixture", "--instance-type", instance_type,
                                 "--region", "us-east-2" if instance_type else "", "--sys", sys_root, "--dev", dev_root, "--proc", proc_root])
    finally:
        provision.device_node = real_node
    with open(record) as handle:
        written = json.load(handle)
    dev_prefix = dev_root + "/"
    return {
        "status": status,
        "decisions": [{"what": d["what"], "action": d["action"], "reason": d["reason"], "disk": (d.get("disk") or {}).get("name")}
                      for d in written["decisions"]],
        "commands": [command.replace(dev_prefix, "/dev/") for command in commands],
        "found": [disk["name"] for disk in written.get("instance_store_disks_found", [])],
        "catalog_instance_store_disks": written.get("catalog_instance_store_disks"),
        "schema": written["schema"],
    }


def main():
    base = os.path.abspath(sys.argv[1])
    provision = load()
    provision.log = lambda message: None
    results = {name: run_case(provision, base, name) for name in CASES}
    print(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
