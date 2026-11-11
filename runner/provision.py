#!/usr/bin/env python3
"""Prepares the disks the disk benchmarks read, at boot, before run.py.

    python3 provision.py --record FILE --fixture-tool PATH
                         [--instance-type T] [--region R]

runner/box.sh runs it once, after the packages are installed and before
run.py. It does two things and writes everything it ran, every exit code,
everything printed and every timing to one record, FILE, which run.py puts in
every dump as the section `provision`:

1. The instance's own NVMe disk, where the instance type has one. Each
   controller in /sys/class/nvme whose model is exactly "Amazon EC2 NVMe
   Instance Storage" is an instance-store disk; nothing is assumed of the
   numbering. The count found must equal the catalog's (EC2's
   describe-instance-types, InstanceStorageInfo.Disks[].Count). Exactly one
   disk is prepared, and only when it is empty: no partition, no holder, not
   mounted, a device node that is that device, and no signature that
   `blkid -p` can find. It is recorded before it is touched (lsblk, blkid,
   nvme id-ctrl, nvme id-ns, nvme amzn stats), then given a default XFS file
   system (`mkfs.xfs`, never forced), mounted at /mnt/lm/instance-store, and
   recorded again (xfs_info, findmnt). A type with no instance store has no
   such step. Anything else is refused and recorded, so its Runs fail
   truthfully for want of a Fixture.

2. The Fixtures, made by runner/fixture.c with O_DIRECT writes and
   fdatasync: 32 GiB on the instance store when it was prepared, and 1 GiB
   under /var/tmp/ledgermath/disk on the root volume on every type.

Nothing here stops the boot: a failure is recorded, the record is written,
and the exit status is 1; box.sh logs it and goes on to run.py. Every other
benchmark still runs, and a disk Run that cannot work fails on its own.

Runs on the box's own Python (3.9 on Amazon Linux 2023) with no packages.
"""

import argparse
import datetime
import json
import os
import re
import stat
import subprocess
import sys
import time

RECORD_SCHEMA = "ledgermath.provision/1"
INSTANCE_STORE_MODEL = "Amazon EC2 NVMe Instance Storage"
INSTANCE_STORE_MOUNT = "/mnt/lm/instance-store"
ROOT_VOLUME_DIR = "/var/tmp/ledgermath/disk"
FIXTURE_NAME = "ledgermath-fixture-v1"
INSTANCE_STORE_FIXTURE_BYTES = 32 << 30
ROOT_VOLUME_FIXTURE_BYTES = 1 << 30
NAMESPACE = re.compile(r"^nvme[0-9]+n[0-9]+$")


def log(message):
    print("ledgermath-provision: " + message, flush=True)


def rfc3339(ns):
    seconds, fraction = divmod(ns, 10 ** 9)
    moment = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S") + ".%09dZ" % fraction


def read_text(path):
    """A file's text, stripped, or None when it cannot be read."""
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", "replace").strip()
    except OSError:
        return None


# ---- what is there: the sysfs tree, the mounts, the device nodes ----

def instance_store_disks(sys_root="/sys"):
    """Every namespace of every NVMe controller whose model is the instance
    store's, as the sysfs tree under sys_root shows them, in sorted order of
    controller and namespace name. Each is a dict:

        controller, model, serial, name, dev ("major:minor"), size_bytes,
        partitions (names), holders (names)
    """
    found = []
    base = os.path.join(sys_root, "class", "nvme")
    try:
        controllers = sorted(os.listdir(base))
    except OSError:
        return found
    for controller in controllers:
        directory = os.path.join(base, controller)
        model = read_text(os.path.join(directory, "model"))
        if model != INSTANCE_STORE_MODEL:
            continue
        serial = read_text(os.path.join(directory, "serial"))
        try:
            entries = sorted(os.listdir(directory))
        except OSError:
            entries = []
        for name in entries:
            if not NAMESPACE.match(name):
                continue
            block = os.path.join(sys_root, "class", "block", name)
            size = read_text(os.path.join(block, "size"))
            try:
                children = sorted(os.listdir(block))
            except OSError:
                children = []
            partitions = [child for child in children
                          if os.path.exists(os.path.join(block, child, "partition"))]
            try:
                holders = sorted(os.listdir(os.path.join(block, "holders")))
            except OSError:
                holders = []
            found.append({
                "controller": controller,
                "model": model,
                "serial": serial,
                "name": name,
                "dev": read_text(os.path.join(block, "dev")),
                "size_bytes": int(size) * 512 if size and size.isdigit() else None,
                "partitions": partitions,
                "holders": holders,
            })
    return found


def mounted_devices(mountinfo_text):
    """The major:minor of every mounted file system's device."""
    devices = set()
    for line in mountinfo_text.splitlines():
        fields = line.split()
        if len(fields) > 2:
            devices.add(fields[2])
    return devices


def device_node(dev_root, name, expected_dev):
    """None when dev_root/name is a block device node with the number sysfs
    gives; otherwise why not."""
    path = os.path.join(dev_root, name)
    try:
        st = os.stat(path)
    except OSError as error:
        return "the device node %s cannot be used: %s" % (path, error.strerror)
    if not stat.S_ISBLK(st.st_mode):
        return "%s is not a block device node" % path
    number = "%d:%d" % (os.major(st.st_rdev), os.minor(st.st_rdev))
    if number != expected_dev:
        return "%s is device %s, but sysfs says %s is %s" % (path, number, name, expected_dev)
    return None


def catalog_disk_count(catalog_stdout):
    """The number of instance-store disks the catalog record gives: the sum of
    InstanceStorageInfo.Disks[].Count, 0 when the type has no
    InstanceStorageInfo. Raises ValueError when the record cannot be read."""
    record = json.loads(catalog_stdout)
    types = record.get("InstanceTypes")
    if not isinstance(types, list) or len(types) != 1:
        raise ValueError("expected one instance type in the catalog's answer, got %r" % (types,))
    info = types[0].get("InstanceStorageInfo")
    if info is None:
        return 0
    return sum(int(disk.get("Count", 0)) for disk in info.get("Disks", []))


# ---- the decision ----

def decide(disks, catalog_count, mounted, node_problem):
    """Whether to prepare an instance-store disk, and which, before any
    signature is probed.

    disks          what instance_store_disks() found
    catalog_count  catalog_disk_count(), or None when the catalog could not be read
    mounted        mounted_devices()
    node_problem   a function of a disk giving device_node()'s answer for it

    Returns {"action": "none" | "refuse" | "probe", "reason": ..., "disk": ...}.
    "probe" means: this one disk may be prepared if blkid -p finds nothing on it.
    """
    if not disks:
        if catalog_count is None:
            return {"action": "none", "reason": "no NVMe controller here has the model %r, and the catalog could not be read" % INSTANCE_STORE_MODEL}
        if catalog_count == 0:
            return {"action": "none", "reason": "this instance type has no instance store: the catalog lists none, and no NVMe controller has the model %r" % INSTANCE_STORE_MODEL}
        return {"action": "refuse", "reason": "the catalog lists %d instance-store disk%s, but no NVMe controller has the model %r"
                % (catalog_count, "" if catalog_count == 1 else "s", INSTANCE_STORE_MODEL)}
    names = ", ".join(disk["name"] for disk in disks)
    if catalog_count is None:
        return {"action": "refuse", "reason": "found %s, but the catalog could not be read, so the count of instance-store disks cannot be compared" % names}
    if catalog_count != len(disks):
        return {"action": "refuse", "reason": "found %d instance-store disk%s (%s), but the catalog lists %d"
                % (len(disks), "" if len(disks) == 1 else "s", names, catalog_count)}
    if len(disks) != 1:
        return {"action": "refuse", "reason": "found %d instance-store disks (%s); this script prepares one, and which to use for the Series is a decision not yet made" % (len(disks), names)}
    disk = disks[0]
    if disk["partitions"]:
        return {"action": "refuse", "reason": "%s has partitions (%s): it is not empty" % (disk["name"], ", ".join(disk["partitions"])), "disk": disk}
    if disk["holders"]:
        return {"action": "refuse", "reason": "%s is held by %s: it is in use" % (disk["name"], ", ".join(disk["holders"])), "disk": disk}
    if not disk["dev"]:
        return {"action": "refuse", "reason": "sysfs gives no device number for %s" % disk["name"], "disk": disk}
    if disk["dev"] in mounted:
        return {"action": "refuse", "reason": "%s (%s) is mounted already" % (disk["name"], disk["dev"]), "disk": disk}
    if not disk["size_bytes"]:
        return {"action": "refuse", "reason": "sysfs gives %s no size" % disk["name"], "disk": disk}
    problem = node_problem(disk)
    if problem is not None:
        return {"action": "refuse", "reason": problem, "disk": disk}
    return {"action": "probe", "reason": "%s is the one instance-store disk the catalog lists, with no partition, holder or mount" % disk["name"], "disk": disk}


def after_probe(blkid_exit):
    """blkid -p exits 2 when it finds no signature, 0 when it finds one."""
    if blkid_exit == 2:
        return None
    if blkid_exit == 0:
        return "blkid -p found a signature on it: it is not empty"
    return "blkid -p exited %r: whether it is empty cannot be told" % (blkid_exit,)


# ---- doing it, and recording it ----

class Recorder:
    """Runs commands and keeps all of each: arguments, times, exit, output."""

    def __init__(self):
        self.started = time.time_ns()
        self.record = {"schema": RECORD_SCHEMA, "started_at": rfc3339(self.started), "steps": [], "decisions": [], "fixtures": []}

    def run(self, step, arguments, timeout=120, environment=None):
        started = time.time_ns()
        entry = {"step": step, "command": arguments, "started_at": rfc3339(started)}
        try:
            done = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  timeout=timeout, env=environment)
            entry["exit"] = done.returncode
            entry["stdout"] = done.stdout.decode("utf-8", "replace")
            entry["stderr"] = done.stderr.decode("utf-8", "replace")
        except (OSError, subprocess.TimeoutExpired) as error:
            entry["exit"] = None
            entry["error"] = str(error)
        ended = time.time_ns()
        entry["ended_at"] = rfc3339(ended)
        entry["seconds"] = round((ended - started) / 1e9, 3)
        self.record["steps"].append(entry)
        log("%s: %s exit=%s %.1fs" % (step, " ".join(arguments), entry.get("exit"), entry["seconds"]))
        return entry

    def decided(self, what, decision):
        self.record["decisions"].append(dict(decision, what=what))
        log("%s: %s (%s)" % (what, decision.get("action"), decision.get("reason")))

    def write(self, path):
        ended = time.time_ns()
        self.record["ended_at"] = rfc3339(ended)
        self.record["seconds"] = round((ended - self.started) / 1e9, 3)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(self.record, handle, indent=1, sort_keys=True, ensure_ascii=False)
            handle.write("\n")
        os.replace(temporary, path)


def make_fixture(recorder, tool, disk_name, directory, size):
    path = os.path.join(directory, FIXTURE_NAME)
    entry = recorder.run("fixture " + disk_name, [tool, path, str(size)], timeout=1200)
    fixture = {"disk": disk_name, "path": path, "bytes": size, "made": entry.get("exit") == 0}
    if entry.get("exit") == 0:
        try:
            fixture["tool"] = json.loads(entry["stdout"])
        except ValueError:
            pass
    recorder.record["fixtures"].append(fixture)
    return fixture["made"]


def prepare_instance_store(recorder, args):
    """Step 1. Returns True when the instance store is mounted and ready for its Fixture."""
    catalog_count = None
    if args.instance_type and args.region:
        environment = dict(os.environ, AWS_PAGER="")
        entry = recorder.run("catalog", ["aws", "ec2", "describe-instance-types", "--region", args.region,
                                         "--instance-types", args.instance_type, "--output", "json"],
                             timeout=60, environment=environment)
        if entry.get("exit") == 0:
            try:
                catalog_count = catalog_disk_count(entry["stdout"])
            except (ValueError, TypeError, AttributeError) as error:
                recorder.decided("catalog", {"action": "unreadable", "reason": str(error)})
    else:
        recorder.decided("catalog", {"action": "not asked", "reason": "no instance type or region was given (IMDS did not answer)"})
    recorder.record["catalog_instance_store_disks"] = catalog_count

    disks = instance_store_disks(args.sys)
    recorder.record["instance_store_disks_found"] = disks
    mountinfo = read_text(os.path.join(args.proc, "self", "mountinfo")) or ""
    decision = decide(disks, catalog_count, mounted_devices(mountinfo),
                      lambda disk: device_node(args.dev, disk["name"], disk["dev"]))
    if decision["action"] != "probe":
        recorder.decided("instance_store", decision)
        return False

    disk = decision["disk"]
    device = os.path.join(args.dev, disk["name"])
    controller = os.path.join(args.dev, disk["controller"])
    # Recorded before anything touches it.
    recorder.run("before lsblk", ["lsblk", "-J", "-b", "-O", device])
    probe = recorder.run("before blkid", ["blkid", "-p", device])
    recorder.run("before nvme id-ctrl", ["nvme", "id-ctrl", controller, "-o", "json"])
    recorder.run("before nvme id-ns", ["nvme", "id-ns", device, "-H"])
    recorder.run("before nvme amzn stats", ["nvme", "amzn", "stats", device, "-o", "json"])
    problem = after_probe(probe.get("exit"))
    if problem is not None:
        recorder.decided("instance_store", {"action": "refuse", "reason": "%s: %s" % (disk["name"], problem), "disk": disk})
        return False
    recorder.decided("instance_store", {"action": "prepare", "reason": decision["reason"] + ", and no signature", "disk": disk})

    # mkfs.xfs with its defaults, never -f: it refuses a device that holds a file system.
    if recorder.run("mkfs.xfs", ["mkfs.xfs", device], timeout=900).get("exit") != 0:
        return False
    if recorder.run("mkdir", ["mkdir", "-p", INSTANCE_STORE_MOUNT]).get("exit") != 0:
        return False
    if recorder.run("mount", ["mount", device, INSTANCE_STORE_MOUNT]).get("exit") != 0:
        return False
    recorder.run("after xfs_info", ["xfs_info", INSTANCE_STORE_MOUNT])
    recorder.run("after findmnt", ["findmnt", "-J", INSTANCE_STORE_MOUNT])
    recorder.run("after lsblk", ["lsblk", "-J", "-b", "-O", device])
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description="Prepare the disks the disk benchmarks read, and record it.")
    parser.add_argument("--record", required=True, help="where the record is written (run.py's --provision-record)")
    parser.add_argument("--fixture-tool", required=True, help="the built runner/fixture.c")
    parser.add_argument("--instance-type", default="", help="this box's instance type, from IMDS")
    parser.add_argument("--region", default="", help="this box's region, from IMDS")
    parser.add_argument("--sys", default="/sys", help=argparse.SUPPRESS)
    parser.add_argument("--dev", default="/dev", help=argparse.SUPPRESS)
    parser.add_argument("--proc", default="/proc", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    recorder = Recorder()
    recorder.record["instance_type"] = args.instance_type or None
    status = 0
    try:
        if prepare_instance_store(recorder, args):
            if not make_fixture(recorder, args.fixture_tool, "instance_store", INSTANCE_STORE_MOUNT, INSTANCE_STORE_FIXTURE_BYTES):
                status = 1
        elif any(d.get("action") in ("refuse", "prepare") for d in recorder.record["decisions"] if d["what"] == "instance_store"):
            status = 1

        if recorder.run("mkdir", ["mkdir", "-p", ROOT_VOLUME_DIR]).get("exit") != 0:
            status = 1
        elif not make_fixture(recorder, args.fixture_tool, "root_volume", ROOT_VOLUME_DIR, ROOT_VOLUME_FIXTURE_BYTES):
            status = 1
        recorder.run("after findmnt root_volume", ["findmnt", "-J", "-T", ROOT_VOLUME_DIR])
        recorder.run("free space", ["df", "-B1", "--output=source,fstype,size,used,avail,target", "/", "/var/tmp",
                                    *([INSTANCE_STORE_MOUNT] if os.path.ismount(INSTANCE_STORE_MOUNT) else [])])
    except Exception as error:  # recorded, never fatal to the boot
        recorder.record["error"] = repr(error)
        log("FAILED: %r" % error)
        status = 1
    finally:
        recorder.write(args.record)
    return status


if __name__ == "__main__":
    sys.exit(main())
