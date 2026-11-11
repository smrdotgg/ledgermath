#!/usr/bin/env python3
"""Prepares the disks the disk benchmarks read, at boot, before run.py.

    python3 provision.py --supervise-seconds 330 --session-file FILE --record FILE
                         --fixture-tool PATH [--instance-type T] [--region R]

runner/box.sh runs it once, after the packages are installed and before
run.py. It does two things and writes everything it ran, every exit code,
everything printed and every timing to one record, FILE, which run.py puts in
every dump as the section `provision`:

1. The instance's own NVMe disk, where the instance type has one. Each
   controller in /sys/class/nvme whose model is exactly "Amazon EC2 NVMe
   Instance Storage" is an instance-store disk; nothing is assumed of the
   numbering. The count found must equal the catalog's (EC2's
   describe-instance-types, InstanceStorageInfo.Disks[].Count), and exactly
   one disk is prepared, only when it is empty. Information that is missing,
   empty or unreadable (a model, a serial, a size, a holders directory, the
   mount table) is a refusal that says which, never a pass. From then on the
   disk is its device number, major:minor: provision.py makes a block device
   node of its own for that number (mknod, in /dev/ledgermath, a directory only
   root can write, after checking in mountinfo that its file system is not
   mounted nodev: /run is, on the image, and a node there cannot be opened), so
   the node can never come to mean another device, and every command runs on
   that node. The disk is recorded before it is touched (lsblk, blkid, nvme
   id-ctrl, nvme id-ns, nvme amzn stats). Then it is opened read-only, and that
   descriptor is held until the mounted file system is confirmed, so the kernel
   cannot release the number for another disk in between. With it held,
   everything is checked again, immediately before mkfs.xfs: through the
   descriptor, the device number, the size and the first MiB; by the number,
   the same disk in sysfs (name, model, serial, size), no partition, no holder
   and no mount; and `blkid -p` finds no signature (exit 2 and nothing printed:
   blkid also exits 2 when it cannot open the device). Then a default XFS file
   system (`mkfs.xfs`, never forced), the mount point made, `mount -t xfs`, and
   the mounted file system's device number, by stat and by
   /proc/self/mountinfo, must be the number that was checked, with its model and
   serial still the ones checked. If the mount fails or anything differs, the
   file system is unmounted and the mount point removed, so no instance-store
   set can run on anything else. A type with no instance store has no such
   step; anything else is refused and recorded, and its Runs fail truthfully.

2. The Fixtures, made by runner/fixture.c with O_DIRECT writes and
   fdatasync: 32 GiB on the instance store when it was prepared, and 1 GiB
   under /var/tmp/ledgermath/disk on the root volume on every type. A Fixture
   not made whole is removed, and the root volume's directory exists only when
   its Fixture was made.

The record is written beside FILE and renamed over it when provisioning
starts, when each step starts (so a step in progress is in it) and when each
step ends, so whatever happens it says truthfully what was done. Every command
runs in a process group of its own: a step that runs past its time, or is told
to stop, has its whole group sent TERM, then KILL after a short grace, and
anything a step leaves running after it exits is killed too and recorded.
Provisioning has a deadline of its own; on SIGTERM, SIGINT or SIGHUP, or at
that deadline, it stops the step in progress, records what stopped it with the
output captured so far, undoes what is half done (a partial Fixture, a mount
it could not verify), and exits.

With --supervise-seconds N it runs all of that as a child in a session of its
own and is its outer limit, and writes that session's id to --session-file at
once: at N seconds, or when it is told to stop, the child is sent TERM, and
KILL after --supervise-grace-seconds; then every process left in the session
is killed, any step the child had not recorded the end of is recorded from its
output files, and the record says how provisioning ended. If the supervisor
itself is stopped or killed, box.sh, past its own outer limit, ends that
session from the session file and removes what a half-done preparation left.
So nothing of provisioning is running when box.sh starts the schedule.

The limits: provisioning stops itself at 300 seconds, the supervisor at 330
(KILL 15 seconds after its TERM), box.sh at 360 (KILL 10 seconds after). On a
real i4i.2xlarge provisioning took 44 seconds.

Nothing here stops the boot: a failure is recorded, and the exit status is
not 0 (1 for a failure or a refusal, 124 when a deadline or the outer limit
ended it, 128 + the signal when it was told to stop); box.sh logs it and goes on
to run.py. Every other benchmark still runs, and a disk Run that cannot work
fails on its own.

Runs on the box's own Python (3.9 on Amazon Linux 2023) with no packages.
"""

import argparse
import datetime
import fcntl
import json
import os
import re
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time

RECORD_SCHEMA = "ledgermath.provision/2"
INSTANCE_STORE_MODEL = "Amazon EC2 NVMe Instance Storage"
INSTANCE_STORE_MOUNT = "/mnt/lm/instance-store"
ROOT_VOLUME_DIR = "/var/tmp/ledgermath/disk"
NODE_DIR = "/dev/ledgermath"    # /run is mounted nodev on the image: a node there cannot be opened
FIXTURE_NAME = "ledgermath-fixture-v1"
INSTANCE_STORE_FIXTURE_BYTES = 32 << 30
ROOT_VOLUME_FIXTURE_BYTES = 1 << 30
NAMESPACE = re.compile(r"^nvme[0-9]+n[0-9]+$")
NUMBER = re.compile(r"^[0-9]+:[0-9]+$")
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
PROBE_BYTES = 1 << 20

DEADLINE_SECONDS = 300          # its own deadline, when not given one
KILL_GRACE_SECONDS = 5          # from TERM to KILL, for a step's process group
CLEANUP_SECONDS = 10            # the most a step undoing something may take
SUPERVISE_GRACE_SECONDS = 15    # from TERM to KILL, for provisioning itself
BLKGETSIZE64 = 0x80081272       # _IOR(0x12, 114, size_t): a block device's size in bytes
POLL_SECONDS = 0.05


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


def read_bytes(path):
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", "replace")
    except OSError:
        return None


def signal_name(signum):
    try:
        return signal.Signals(signum).name
    except ValueError:
        return "signal %d" % signum


# ---- what is there: the sysfs tree, the mounts ----

def partitions_and_holders(block):
    """The partitions (children with a `partition` file) and holders of the
    disk whose sysfs directory is `block`, and what could not be read: a
    directory that cannot be listed is never taken to mean "none"."""
    unreadable = []
    name = os.path.basename(block)
    try:
        children = sorted(os.listdir(block))
    except OSError as error:
        children = []
        unreadable.append("the partitions of %s cannot be listed (%s)" % (name, error.strerror))
    partitions = [child for child in children if os.path.exists(os.path.join(block, child, "partition"))]
    try:
        holders = sorted(os.listdir(os.path.join(block, "holders")))
    except OSError as error:
        holders = []
        unreadable.append("the holders of %s cannot be listed (%s)" % (name, error.strerror))
    return partitions, holders, unreadable


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
            partitions, holders, unreadable = partitions_and_holders(block)
            found.append({
                "controller": controller,
                "model": model,
                "serial": serial,
                "name": name,
                "dev": read_text(os.path.join(block, "dev")),
                "size_bytes": int(size) * 512 if size and size.isdigit() else None,
                "partitions": partitions,
                "holders": holders,
                "unreadable": unreadable,
            })
    return found


def device_identity(sys_root, number):
    """What the kernel's device number `number` ("major:minor") names now, read
    afresh from /sys/dev/block/<number>: the same keys as instance_store_disks()
    gives, without the controller; None when it names no block device."""
    if not number or not NUMBER.match(number):
        return None
    real = os.path.realpath(os.path.join(sys_root, "dev", "block", number))
    if not os.path.isdir(real):
        return None
    size = read_text(os.path.join(real, "size"))
    partitions, holders, unreadable = partitions_and_holders(real)
    return {
        "name": os.path.basename(real),
        "model": read_text(os.path.join(real, "device", "model")),
        "serial": read_text(os.path.join(real, "device", "serial")),
        "dev": read_text(os.path.join(real, "dev")),
        "size_bytes": int(size) * 512 if size and size.isdigit() else None,
        "partitions": partitions,
        "holders": holders,
        "unreadable": unreadable,
    }


IDENTITY_KEYS = (("name", "name"), ("model", "model"), ("serial", "serial"), ("size_bytes", "size"), ("dev", "device number"))


def missing_identity(found):
    """What of a disk's identity sysfs did not give (empty counts as not given)."""
    return [label for key, label in IDENTITY_KEYS if not found.get(key)]


def identity_problem(disk, identity):
    """Why the device number of `disk` no longer names that same empty disk, or
    None. Missing or unreadable information is a reason, never a match: two
    empty serials are not the same serial."""
    if identity is None:
        return "device number %s names no block device now" % disk["dev"]
    missing = missing_identity(identity)
    if missing:
        return "sysfs now gives device number %s no %s" % (disk["dev"], ", ".join(missing))
    if identity.get("unreadable"):
        return "; ".join(identity["unreadable"])
    for key, label in IDENTITY_KEYS:
        if identity.get(key) != disk.get(key):
            return "device number %s now has %s %r, not %r" % (disk["dev"], label, identity.get(key), disk.get(key))
    if identity["partitions"]:
        return "%s now has partitions (%s)" % (disk["name"], ", ".join(identity["partitions"]))
    if identity["holders"]:
        return "%s is now held by %s" % (disk["name"], ", ".join(identity["holders"]))
    return None


def mounted_devices(mountinfo_text):
    """The major:minor of every mounted file system's device."""
    devices = set()
    for line in mountinfo_text.splitlines():
        fields = line.split()
        if len(fields) > 2:
            devices.add(fields[2])
    return devices


def mountinfo_device(mountinfo_text, mount_point):
    """The major:minor of what is mounted at mount_point (the last mount
    there, which is the one seen), or None."""
    found = None
    for line in mountinfo_text.splitlines():
        fields = line.split()
        if len(fields) > 4 and fields[4].replace("\\040", " ") == mount_point:
            found = fields[2]
    return found


def mount_holding(path, mountinfo_text):
    """(mount point, per-mount options, file system type) of the mount that
    holds `path` (or, if it does not exist yet, the place it would be made),
    by /proc/self/mountinfo; None when no mount does."""
    path = os.path.realpath(path)
    best = None
    for line in mountinfo_text.splitlines():
        fields = line.split()
        if len(fields) < 6 or " - " not in line:
            continue
        point = fields[4].replace("\\040", " ")
        inside = path == point or point == "/" or path.startswith(point.rstrip("/") + "/")
        # The longest mount point wins; at one point, the last mount is the one seen.
        if inside and (best is None or len(point) >= len(best[0])):
            best = (point, fields[5], line.split(" - ", 1)[1].split()[0])
    return best


def devices_problem(directory, mountinfo_text):
    """Why a device node made in `directory` could not be opened (its file
    system is mounted nodev, or no mount is known to hold it), or None."""
    holding = mount_holding(directory, mountinfo_text)
    if holding is None:
        return "no mount in /proc/self/mountinfo holds %s, so whether it allows device nodes cannot be told" % directory
    point, options, fstype = holding
    if "nodev" in options.split(","):
        return "%s is on %s (%s), mounted nodev (%s): a device node there cannot be opened" % (directory, point, fstype, options)
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


# ---- the device node, and the mounted file system: by number ----

def node_path(node_dir, number):
    """The device node provision.py makes for a device number."""
    return os.path.join(node_dir, "instance-store-%s" % number.replace(":", "-"))


def make_node(path, number):
    """A block device node for `number` at `path`, in a directory only root
    may write. An existing node is kept only if it is that very device."""
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    if os.path.lexists(path):
        if node_number(path) != number:
            raise OSError("%s exists and is not a block device node for %s" % (path, number))
        return
    major, minor = (int(part) for part in number.split(":"))
    os.mknod(path, stat.S_IFBLK | 0o600, os.makedev(major, minor))


def node_number(path):
    """The device number of the block device node at `path`, never following a
    symbolic link; None when it is not a block device node."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISBLK(st.st_mode):
        return None
    return "%d:%d" % (os.major(st.st_rdev), os.minor(st.st_rdev))


class HeldDevice:
    """A read-only descriptor of the device, held open from just before the
    last checks until the mounted file system is confirmed: while it is open
    the kernel cannot release the device number for another disk. The last
    checks are made through it. Never O_EXCL: mkfs.xfs and mount claim the
    device exclusively, and a plain open does not stand in their way."""

    def __init__(self, path):
        self.path = path
        self.fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)

    def number(self):
        st = os.fstat(self.fd)
        if not stat.S_ISBLK(st.st_mode):
            return None
        return "%d:%d" % (os.major(st.st_rdev), os.minor(st.st_rdev))

    def size(self):
        return struct.unpack("Q", fcntl.ioctl(self.fd, BLKGETSIZE64, b"\0" * 8))[0]

    def read_start(self):
        """The first MiB of the device."""
        data = b""
        while len(data) < PROBE_BYTES:
            chunk = os.pread(self.fd, PROBE_BYTES - len(data), len(data))
            if not chunk:
                break
            data += chunk
        return data

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def hold_device(path):
    """Opens the device node read-only and holds it: OSError when it cannot."""
    return HeldDevice(path)


def mounted_number(mount_point, proc_root):
    """The device number of what is mounted at mount_point, two ways: stat of
    the mount point, and its line in /proc/self/mountinfo."""
    try:
        st = os.stat(mount_point)
        by_stat = "%d:%d" % (os.major(st.st_dev), os.minor(st.st_dev))
    except OSError:
        by_stat = None
    by_mountinfo = mountinfo_device(read_text(os.path.join(proc_root, "self", "mountinfo")) or "", mount_point)
    return {"stat": by_stat, "mountinfo": by_mountinfo}


# ---- the decisions ----

def decide(disks, catalog_count, mounted):
    """Whether to prepare an instance-store disk, and which, before anything is
    run on it.

    disks          what instance_store_disks() found
    catalog_count  catalog_disk_count(), or None when the catalog could not be read
    mounted        mounted_devices()

    Returns {"action": "none" | "refuse" | "probe", "reason": ..., "disk": ...}.
    "probe" means: this one disk may be prepared if the checks on its device
    number that follow all pass.
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
    if disk.get("unreadable"):
        return {"action": "refuse", "reason": "%s: %s" % (disk["name"], "; ".join(disk["unreadable"])), "disk": disk}
    missing = missing_identity(disk)
    if missing:
        return {"action": "refuse", "reason": "sysfs gives %s no %s" % (disk["name"], ", ".join(missing)), "disk": disk}
    if disk["partitions"]:
        return {"action": "refuse", "reason": "%s has partitions (%s): it is not empty" % (disk["name"], ", ".join(disk["partitions"])), "disk": disk}
    if disk["holders"]:
        return {"action": "refuse", "reason": "%s is held by %s: it is in use" % (disk["name"], ", ".join(disk["holders"])), "disk": disk}
    if not NUMBER.match(disk["dev"]):
        return {"action": "refuse", "reason": "sysfs gives %s the device number %r, which is not major:minor" % (disk["name"], disk["dev"]), "disk": disk}
    if disk["dev"] in mounted:
        return {"action": "refuse", "reason": "%s (%s) is mounted already" % (disk["name"], disk["dev"]), "disk": disk}
    return {"action": "probe", "reason": "%s (%s) is the one instance-store disk the catalog lists, with no partition, holder or mount" % (disk["name"], disk["dev"]), "disk": disk}


def after_probe(entry):
    """None when `blkid -p` found no signature: exit 2 and nothing printed.
    blkid exits 2 also when it cannot open the device, printing why, so the
    exit status alone is not enough."""
    code = entry.get("exit")
    said = ((entry.get("stdout") or "") + (entry.get("stderr") or "")).strip()
    if code == 2 and not said:
        return None
    if code == 0:
        return "blkid -p found a signature on it: it is not empty"
    if code == 2:
        return "blkid -p exited 2 but said %r: it may not have read the device, so whether it is empty cannot be told" % said[:200]
    return "blkid -p exited %r: whether it is empty cannot be told" % (code,)


# ---- processes ----

def proc_stat(pid, proc_root="/proc"):
    """(state, ppid, pgrp, session, comm) of a process, or None."""
    text = read_bytes(os.path.join(proc_root, str(pid), "stat"))
    if not text or ")" not in text:
        return None
    comm = text[text.index("(") + 1:text.rindex(")")]
    fields = text[text.rindex(")") + 2:].split()
    try:
        return fields[0], int(fields[1]), int(fields[2]), int(fields[3]), comm
    except (IndexError, ValueError):
        return None


def processes(match, proc_root="/proc"):
    """[{pid, comm, state}] of every process whose (pgrp, session) match(...) accepts."""
    found = []
    try:
        names = os.listdir(proc_root)
    except OSError:
        return found
    for name in names:
        if not name.isdigit():
            continue
        info = proc_stat(int(name), proc_root)
        if info is not None and match(info[2], info[3]):
            found.append({"pid": int(name), "comm": info[4], "state": info[0]})
    return sorted(found, key=lambda process: process["pid"])


def group_members(pgid):
    return processes(lambda pgrp, session: pgrp == pgid)


def group_alive(pgid):
    """Whether any process of the group is left that is not a zombie."""
    return any(process["state"] != "Z" for process in group_members(pgid))


def kill_group(pgid, child, grace, log_signals=None):
    """Ends every process of the group: TERM, then KILL after `grace` seconds
    if any is left, then KILL again until none is (at most 10 seconds), reaping
    the step's own process. Returns what it sent and what was left."""
    sent = []

    def send(signum):
        try:
            os.killpg(pgid, signum)
            sent.append(signal_name(signum))
        except ProcessLookupError:
            pass

    send(signal.SIGTERM)
    end = time.monotonic() + grace
    while time.monotonic() < end:
        child.poll()
        if not group_alive(pgid):
            break
        time.sleep(POLL_SECONDS)
    if group_alive(pgid):
        send(signal.SIGKILL)
    child.wait()
    # Until every member is gone; a zombie is waited for, not signalled.
    end = time.monotonic() + 10
    while group_members(pgid) and time.monotonic() < end:
        if group_alive(pgid):
            send(signal.SIGKILL)
        time.sleep(POLL_SECONDS)
    survivors = [process for process in group_members(pgid) if process["state"] != "Z"]
    return {"signals": sent, "survivors": survivors}


def kill_session(sid, proc_root="/proc"):
    """Kills every process left in session `sid` and waits until none is (at
    most 10 seconds). Returns what was found and what was left."""
    found = [process for process in processes(lambda pgrp, session: session == sid, proc_root) if process["state"] != "Z"]
    end = time.monotonic() + 10
    while time.monotonic() < end:
        alive = [process for process in processes(lambda pgrp, session: session == sid, proc_root) if process["state"] != "Z"]
        if not alive:
            break
        for process in alive:
            try:
                os.kill(process["pid"], signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(POLL_SECONDS)
    left = [process for process in processes(lambda pgrp, session: session == sid, proc_root) if process["state"] != "Z"]
    return {"killed": found, "survivors": left}


# ---- doing it, and recording it ----

class Stopped(Exception):
    """Provisioning was told to stop, or reached its deadline."""

    def __init__(self, why, status):
        Exception.__init__(self, why)
        self.why = why
        self.status = status


def write_json_atomically(path, value):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=1, sort_keys=True, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class Recorder:
    """Runs commands and keeps all of each: arguments, times, exit, output, and
    how it ended. The record is rewritten as each step starts and as it ends."""

    def __init__(self, path, steps_dir, deadline_seconds, kill_grace):
        self.path = path
        self.steps_dir = steps_dir
        self.kill_grace = kill_grace
        self.started = time.time_ns()
        self.deadline = time.monotonic() + deadline_seconds
        self.stop_signal = None
        self.record = {"schema": RECORD_SCHEMA, "started_at": rfc3339(self.started), "state": "running",
                       "pid": os.getpid(), "session": os.getsid(0), "deadline_seconds": deadline_seconds,
                       "steps": [], "decisions": [], "fixtures": []}

    def on_stop(self, signum, _frame):
        if self.stop_signal is None:
            self.stop_signal = signum

    def install(self):
        for signum in STOP_SIGNALS:
            signal.signal(signum, self.on_stop)

    def check(self, cleanup=False):
        """Raises Stopped if provisioning must stop before starting a step."""
        if cleanup:
            return
        if self.stop_signal is not None:
            raise Stopped("told to stop by %s" % signal_name(self.stop_signal), 128 + self.stop_signal)
        if time.monotonic() >= self.deadline:
            raise Stopped("its own deadline of %s seconds" % self.record["deadline_seconds"], 124)

    def write(self):
        ended = time.time_ns()
        self.record["written_at"] = rfc3339(ended)
        self.record["seconds"] = round((ended - self.started) / 1e9, 3)
        blocked = signal.pthread_sigmask(signal.SIG_BLOCK, STOP_SIGNALS)
        try:
            write_json_atomically(self.path, self.record)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, blocked)

    def _begin(self, step, command, by=None):
        entry = {"step": step, "command": command, "started_at": rfc3339(time.time_ns()), "state": "running"}
        if by:
            entry["by"] = by
        self.record["steps"].append(entry)
        return entry

    def _end(self, entry, started_ns):
        ended = time.time_ns()
        entry["ended_at"] = rfc3339(ended)
        entry["seconds"] = round((ended - started_ns) / 1e9, 3)
        self.write()

    def run(self, step, arguments, timeout=120, environment=None, cleanup=False):
        """Runs a command in a process group of its own and records it. A
        cleanup step runs even when provisioning is stopping, for at most
        CLEANUP_SECONDS."""
        self.check(cleanup)
        started = time.time_ns()
        entry = self._begin(step, arguments)
        if cleanup:
            limit, by_deadline = min(timeout, CLEANUP_SECONDS), False
        else:
            remaining = max(0.0, self.deadline - time.monotonic())
            limit, by_deadline = min(timeout, remaining), remaining < timeout
        entry["limit_seconds"] = round(limit, 3)
        if by_deadline:
            entry["limited_by"] = "provisioning's deadline"
        os.makedirs(self.steps_dir, exist_ok=True)
        number = len(self.record["steps"])
        out_path = os.path.join(self.steps_dir, "%02d.stdout" % number)
        err_path = os.path.join(self.steps_dir, "%02d.stderr" % number)
        entry["stdout_file"], entry["stderr_file"] = out_path, err_path
        self.write()
        try:
            with open(out_path, "wb") as out, open(err_path, "wb") as err:
                child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env=environment,
                                         close_fds=True, preexec_fn=os.setpgrp)
        except OSError as error:
            entry.update(state="could not start", exit=None, error=str(error))
            self._end(entry, started)
            log("%s: %s could not start: %s" % (step, " ".join(arguments), error))
            return entry
        entry["pgid"] = child.pid
        self.write()

        end = time.monotonic() + limit
        how = None
        while how is None:
            if child.poll() is not None:
                how = "ended"
            elif self.stop_signal is not None and not cleanup:
                how = "stopped"
            elif time.monotonic() >= end:
                how = "timed out"
            else:
                time.sleep(POLL_SECONDS)
        if how == "ended":
            entry["state"] = "ended"
            if group_alive(child.pid):
                entry["leftovers"] = kill_group(child.pid, child, self.kill_grace)
        else:
            entry["state"] = how
            if how == "stopped":
                entry["stopped_by"] = signal_name(self.stop_signal)
            elif by_deadline:
                entry["timed_out_by"] = "provisioning's deadline"
            entry["killed"] = kill_group(child.pid, child, self.kill_grace)
        entry["exit"] = child.returncode if child.returncode >= 0 else None
        if child.returncode < 0:
            entry["signal"] = signal_name(-child.returncode)
        entry["stdout"] = read_bytes(out_path)
        entry["stderr"] = read_bytes(err_path)
        self._end(entry, started)
        log("%s: %s %s exit=%s %.1fs" % (step, " ".join(arguments), entry["state"], entry.get("exit"), entry["seconds"]))
        if how == "stopped":
            raise Stopped("told to stop by %s" % entry["stopped_by"], 128 + self.stop_signal)
        if how == "timed out" and by_deadline:
            raise Stopped("its own deadline of %s seconds" % self.record["deadline_seconds"], 124)
        return entry

    def action(self, step, command, function, cleanup=False):
        """Does something in this process (mkdir, rmdir, mknod, unlink, a read)
        and records it as a step. Returns (ok, value)."""
        self.check(cleanup)
        started = time.time_ns()
        entry = self._begin(step, command, by="provision.py")
        self.write()
        try:
            value = function()
            entry.update(state="ended", exit=0)
            ok = True
        except OSError as error:
            value = None
            entry.update(state="ended", exit=1, error=str(error))
            ok = False
        if isinstance(value, dict):
            entry["result"] = value
        self._end(entry, started)
        log("%s: %s %s" % (step, " ".join(command), "ok" if ok else "FAILED: " + entry["error"]))
        return ok, value

    def last_error(self):
        """The error of the last step recorded, if it had one."""
        steps = self.record["steps"]
        return steps[-1].get("error") if steps else None

    def decided(self, what, decision):
        self.record["decisions"].append(dict(decision, what=what))
        self.write()
        log("%s: %s (%s)" % (what, decision.get("action"), decision.get("reason")))


def make_fixture(rec, args, disk_name, directory, size):
    """Step 2 for one disk. A Fixture not made whole is removed."""
    path = os.path.join(directory, FIXTURE_NAME)
    existed = os.path.lexists(path)
    fixture = {"disk": disk_name, "path": path, "bytes": size, "made": False, "existed_before": existed}
    rec.record["fixtures"].append(fixture)
    try:
        entry = rec.run("fixture " + disk_name, [args.fixture_tool, path, str(size)], timeout=args.fixture_timeout_seconds)
        fixture["made"] = entry.get("exit") == 0
        if fixture["made"]:
            try:
                fixture["tool"] = json.loads(entry["stdout"])
            except (TypeError, ValueError):
                pass
        return fixture["made"]
    finally:
        if not fixture["made"] and not existed and os.path.lexists(path):
            rec.action("remove the partial Fixture " + disk_name, ["rm", path], lambda: os.unlink(path), cleanup=True)
        rec.write()


def prepare_instance_store(rec, args):
    """Step 1. Returns "ready", "none" (no instance store here), "refused" or
    "failed"; a stop is recorded as "stopped" and raised again."""
    try:
        return _prepare_instance_store(rec, args)
    except Stopped:
        rec.record["instance_store"]["state"] = "stopped"
        raise


def _prepare_instance_store(rec, args):
    mp = args.instance_store_mount
    state = {"state": "none", "mount_point": mp}
    rec.record["instance_store"] = state

    def finish(how, decision=None):
        state["state"] = how
        if decision is not None:
            rec.decided("instance_store", decision)
        rec.write()
        return how

    # A directory at the mount point that is not this boot's mount would let
    # the instance-store sets run on the root volume.
    if os.path.ismount(mp):
        return finish("refused", {"action": "refuse", "reason": "something is mounted at %s already; it is left as it is" % mp})
    if os.path.lexists(mp):
        ok, _ = rec.action("remove what is at the mount point", ["rmdir", mp], lambda: os.rmdir(mp))
        if not ok:
            # Not empty, or not a directory: moved aside, never deleted.
            aside = "%s.found-at-boot-%d" % (mp, time.time_ns())
            ok, _ = rec.action("move what is at the mount point aside", ["mv", mp, aside], lambda: os.rename(mp, aside))
            if not ok:
                return finish("refused", {"action": "refuse", "reason": "%s exists, is not a mount, and can be neither removed nor moved aside" % mp})

    catalog_count = None
    if args.instance_type and args.region:
        environment = dict(os.environ, AWS_PAGER="")
        entry = rec.run("catalog", ["aws", "ec2", "describe-instance-types", "--region", args.region,
                                    "--instance-types", args.instance_type, "--output", "json"],
                        timeout=60, environment=environment)
        if entry.get("exit") == 0:
            try:
                catalog_count = catalog_disk_count(entry["stdout"])
            except (ValueError, TypeError, AttributeError) as error:
                rec.decided("catalog", {"action": "unreadable", "reason": str(error)})
    else:
        rec.decided("catalog", {"action": "not asked", "reason": "no instance type or region was given (IMDS did not answer)"})
    rec.record["catalog_instance_store_disks"] = catalog_count

    disks = instance_store_disks(args.sys)
    rec.record["instance_store_disks_found"] = disks
    mountinfo = read_text(os.path.join(args.proc, "self", "mountinfo"))
    if mountinfo is None:
        return finish("refused", {"action": "refuse", "reason": "/proc/self/mountinfo cannot be read, so what is mounted cannot be told"})
    decision = decide(disks, catalog_count, mounted_devices(mountinfo))
    if decision["action"] != "probe":
        return finish("none" if decision["action"] == "none" else "refused", decision)
    disk = decision["disk"]
    number = disk["dev"]
    state.update(disk=disk["name"], serial=disk["serial"], device=number)

    # From here on the disk is its device number.
    problem = identity_problem(disk, device_identity(args.sys, number))
    if problem:
        return finish("refused", {"action": "refuse", "reason": problem, "disk": disk})
    node = node_path(args.node_dir, number)
    state["node"] = node
    # The node's directory must be on a file system that allows device nodes:
    # on the image, /run is mounted nodev, and a node there cannot be opened.
    problem = devices_problem(os.path.dirname(node), mountinfo)
    if problem:
        return finish("refused", {"action": "refuse", "reason": problem, "disk": disk})
    major, minor = number.split(":")
    ok, _ = rec.action("make a device node for %s" % number, ["mknod", node, "b", major, minor], lambda: make_node(node, number))
    if not ok:
        return finish("refused", {"action": "refuse", "reason": "a device node for %s could not be made at %s (%s)" % (number, node, rec.last_error()), "disk": disk})
    if node_number(node) != number:
        return finish("refused", {"action": "refuse", "reason": "%s is device %s, not %s" % (node, node_number(node), number), "disk": disk})

    # Recorded before anything touches it.
    rec.run("before lsblk", ["lsblk", "-J", "-b", "-O", node])
    probe = rec.run("before blkid", ["blkid", "-p", node])
    rec.run("before nvme id-ctrl", ["nvme", "id-ctrl", node, "-o", "json"])
    rec.run("before nvme id-ns", ["nvme", "id-ns", node, "-H"])
    rec.run("before nvme amzn stats", ["nvme", "amzn", "stats", node, "-o", "json"])
    problem = after_probe(probe)
    if problem:
        return finish("refused", {"action": "refuse", "reason": "%s: %s" % (disk["name"], problem), "disk": disk})

    # The device is opened and held from here until its mounted file system is
    # confirmed, so its number cannot come to mean another disk in between.
    ok, held = rec.action("open the device and hold it open", ["open", node, "O_RDONLY"], lambda: hold_device(node))
    if not ok:
        return finish("refused", {"action": "refuse", "reason": "%s cannot be opened (%s)" % (node, rec.last_error()), "disk": disk})
    state["held_open"] = True
    try:
        return _format_and_mount(rec, args, state, finish, decision, disk, node, held)
    finally:
        held.close()
        state["held_open"] = False
        rec.write()


def _format_and_mount(rec, args, state, finish, decision, disk, node, held):
    number = disk["dev"]
    mp = args.instance_store_mount
    # Immediately before formatting: everything again, by number, with the device held.
    probe = rec.run("recheck blkid", ["blkid", "-p", node])
    problem = after_probe(probe)
    if problem is None:
        ok, data = rec.action("read the first MiB through the held descriptor", ["pread", node, str(PROBE_BYTES)],
                              lambda: {"bytes": len(held.read_start())})
        if not ok or data is None or data.get("bytes") != PROBE_BYTES:
            problem = "the first MiB of %s could not be read (%s)" % (node, rec.last_error() or "%s bytes" % (data or {}).get("bytes"))
    if problem is None:
        ok, seen = rec.action("ask the held descriptor what it is", ["fstat", "BLKGETSIZE64", node],
                              lambda: {"device": held.number(), "size_bytes": held.size()})
        if not ok or seen is None:
            problem = "the held descriptor of %s cannot say what it is (%s)" % (node, rec.last_error())
        elif seen["device"] != number:
            problem = "the held descriptor is device %s, not %s" % (seen["device"], number)
        elif seen["size_bytes"] != disk["size_bytes"]:
            problem = "the held device holds %s bytes, but sysfs gave %s" % (seen["size_bytes"], disk["size_bytes"])
    if problem is None:
        problem = identity_problem(disk, device_identity(args.sys, number))
    if problem is None and node_number(node) != number:
        problem = "%s is now device %s, not %s" % (node, node_number(node), number)
    if problem is None:
        mountinfo = read_text(os.path.join(args.proc, "self", "mountinfo"))
        if mountinfo is None:
            problem = "/proc/self/mountinfo cannot be read, so whether %s is mounted cannot be told" % disk["name"]
        elif number in mounted_devices(mountinfo):
            problem = "%s (%s) is now mounted" % (disk["name"], number)
    if problem:
        return finish("refused", {"action": "refuse", "reason": "just before formatting, %s" % problem, "disk": disk})
    rec.decided("instance_store", {"action": "prepare", "reason": decision["reason"] + "; checked again by its device number just before formatting, with the device held open and no signature", "disk": disk})

    # mkfs.xfs with its defaults, never -f: it refuses a device that holds a file system.
    if rec.run("mkfs.xfs", ["mkfs.xfs", node], timeout=900).get("exit") != 0:
        return finish("failed")
    ready = mounted = False
    try:
        state["made_mount_point"] = True  # recorded before, so whoever undoes a killed run knows
        rec.write()
        ok, _ = rec.action("make the mount point", ["mkdir", "-p", mp], lambda: os.makedirs(mp))
        if not ok:
            return finish("failed")
        if rec.run("mount", ["mount", "-t", "xfs", node, mp]).get("exit") != 0:
            return finish("failed")
        mounted = True
        seen = mounted_number(mp, args.proc)
        state["mounted_device"] = seen
        if seen["stat"] != number or seen["mountinfo"] != number:
            rec.decided("instance_store mount", {"action": "refuse", "reason": "%s is mounted from device %s by stat and %s by mountinfo, not the checked %s"
                                                 % (mp, seen["stat"], seen["mountinfo"], number), "disk": disk})
            return finish("failed")
        identity = device_identity(args.sys, number) or {}
        state["mounted_identity"] = {"model": identity.get("model"), "serial": identity.get("serial")}
        if not identity.get("model") or not identity.get("serial") or identity.get("model") != disk["model"] or identity.get("serial") != disk["serial"]:
            rec.decided("instance_store mount", {"action": "refuse", "reason": "device %s, mounted, has model %r and serial %r, not the checked %r and %r"
                                                 % (number, identity.get("model"), identity.get("serial"), disk["model"], disk["serial"]), "disk": disk})
            return finish("failed")
        rec.run("after xfs_info", ["xfs_info", mp])
        rec.run("after findmnt", ["findmnt", "-J", mp])
        rec.run("after lsblk", ["lsblk", "-J", "-b", "-O", node])
        ready = True
        return finish("ready")
    finally:
        if not ready:
            state["state"] = "stopped" if sys.exc_info()[0] is Stopped else "failed"
            if mounted or os.path.ismount(mp):
                if rec.run("umount", ["umount", mp], cleanup=True).get("exit") != 0:
                    rec.run("umount lazily", ["umount", "-l", mp], cleanup=True)
            if os.path.lexists(mp):
                rec.action("remove the mount point", ["rmdir", mp], lambda: os.rmdir(mp), cleanup=True)
            state["made_mount_point"] = os.path.lexists(mp)
            rec.write()


def prepare_root_volume(rec, args):
    """The root volume's directory and Fixture; the directory exists only when the Fixture was made."""
    directory = args.root_volume_dir
    state = {"state": "failed", "directory": directory}
    rec.record["root_volume"] = state
    ready = False
    try:
        if not os.path.isdir(directory):
            state["made_directory"] = True
            rec.write()
            ok, _ = rec.action("make the root volume's directory", ["mkdir", "-p", directory], lambda: os.makedirs(directory))
            if not ok:
                return False
        if not make_fixture(rec, args, "root_volume", directory, ROOT_VOLUME_FIXTURE_BYTES):
            return False
        rec.run("after findmnt root_volume", ["findmnt", "-J", "-T", directory])
        ready = True
        state["state"] = "ready"
        return True
    finally:
        if not ready:
            if sys.exc_info()[0] is Stopped:
                state["state"] = "stopped"
            if os.path.isdir(directory):
                rec.action("remove the root volume's directory", ["rmdir", directory], lambda: os.rmdir(directory), cleanup=True)
        rec.write()


def provision(args):
    rec = Recorder(args.record, args.steps_dir or os.path.join(os.path.dirname(os.path.abspath(args.record)), "provision-steps"),
                   args.deadline_seconds, args.kill_grace_seconds)
    rec.install()
    rec.record["instance_type"] = args.instance_type or None
    rec.write()
    status = 0
    try:
        store = prepare_instance_store(rec, args)
        if store == "ready":
            if not make_fixture(rec, args, "instance_store", args.instance_store_mount, INSTANCE_STORE_FIXTURE_BYTES):
                status = 1
        elif store in ("refused", "failed"):
            status = 1
        if not prepare_root_volume(rec, args):
            status = 1
        mounts = [path for path in (args.instance_store_mount,) if os.path.ismount(path)]
        rec.run("free space", ["df", "-B1", "--output=source,fstype,size,used,avail,target", "/", args.root_volume_dir, *mounts]
                if os.path.isdir(args.root_volume_dir) else ["df", "-B1", "--output=source,fstype,size,used,avail,target", "/", *mounts])
        rec.record["state"] = "done" if status == 0 else "failed"
    except Stopped as stop:
        rec.record.update(state="stopped", stopped_by=stop.why)
        log("STOPPED: %s" % stop.why)
        status = stop.status
    except Exception as error:  # recorded, never fatal to the boot
        rec.record.update(state="failed", error=repr(error))
        log("FAILED: %r" % error)
        status = 1
    finally:
        rec.record["exit"] = status
        rec.write()
    return status


# ---- the outer limit ----

def load_record(path):
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def finalize(path, report):
    """Completes the record after provisioning ended, however it ended: a step
    still marked running gets the output its files hold, and the record says
    how provisioning ended and what was left of it."""
    record = load_record(path)
    if record is None:
        record = {"schema": RECORD_SCHEMA, "state": "no record",
                  "steps": [], "decisions": [], "fixtures": [],
                  "note": "provision.py wrote no readable record before it ended"}
    for entry in record.get("steps", []):
        if entry.get("state") == "running":
            entry["state"] = "unfinished"
            entry["note"] = "provision.py ended before recording the end of this step; its output is what its files held"
            for key in ("stdout", "stderr"):
                name = entry.get(key + "_file")
                if name:
                    entry[key] = read_bytes(name)
    if record.get("state") == "running":
        record["state"] = "ended without recording its end"
    record["supervisor"] = report
    write_json_atomically(path, record)
    return record


def run_quietly(arguments, timeout):
    """A command the supervisor runs to undo something: its own process group,
    killed with the group after `timeout`. Returns what happened."""
    started = time.time_ns()
    timed_out = False
    # Into a file, not a pipe, so what it printed is kept however it ends.
    with tempfile.TemporaryFile() as output:
        try:
            child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                     close_fds=True, preexec_fn=os.setpgrp)
        except OSError as error:
            return {"command": arguments, "exit": None, "error": str(error)}
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_group(child.pid, child, 1)
        output.seek(0)
        text = output.read().decode("utf-8", "replace")
    result = {"command": arguments, "exit": child.returncode, "output": text, "seconds": round((time.time_ns() - started) / 1e9, 3)}
    if timed_out:
        result["timed_out_after_seconds"] = timeout
    return result


def undo(args, record):
    """What a provisioning that was killed outright left half done, undone as
    it would have undone it itself: a mount point it made whose mount it did
    not verify is unmounted and removed; a Fixture it did not make whole is
    removed (never one that was there before it); the root volume's directory,
    when not ready, is removed. Returns what was done."""
    done = []

    def attempt(what, command, function):
        try:
            function()
            done.append({"what": what, "command": command, "exit": 0})
        except OSError as error:
            done.append({"what": what, "command": command, "exit": 1, "error": str(error)})

    store = record.get("instance_store") or {}
    mp = args.instance_store_mount
    if store.get("state") != "ready" and store.get("made_mount_point"):
        if os.path.ismount(mp):
            result = run_quietly(["umount", mp], CLEANUP_SECONDS)
            done.append(dict(result, what="unmount the unverified instance store"))
            if result.get("exit") != 0:
                done.append(dict(run_quietly(["umount", "-l", mp], CLEANUP_SECONDS), what="unmount it lazily"))
        if os.path.lexists(mp):
            attempt("remove the mount point", ["rmdir", mp], lambda: os.rmdir(mp))
    for fixture in record.get("fixtures", []):
        path = fixture.get("path")
        if path and not fixture.get("made") and not fixture.get("existed_before", True) and os.path.lexists(path):
            attempt("remove the partial Fixture %s" % fixture.get("disk"), ["rm", path], lambda path=path: os.unlink(path))
    root = record.get("root_volume") or {}
    directory = args.root_volume_dir
    if root and root.get("state") != "ready" and os.path.isdir(directory):
        attempt("remove the root volume's directory", ["rmdir", directory], lambda: os.rmdir(directory))
    return done


def child_arguments(args):
    arguments = ["--record", args.record, "--fixture-tool", args.fixture_tool,
                 "--instance-type", args.instance_type, "--region", args.region,
                 "--sys", args.sys, "--proc", args.proc, "--node-dir", args.node_dir,
                 "--instance-store-mount", args.instance_store_mount, "--root-volume-dir", args.root_volume_dir,
                 "--kill-grace-seconds", str(args.kill_grace_seconds),
                 "--fixture-timeout-seconds", str(args.fixture_timeout_seconds)]
    if args.steps_dir:
        arguments += ["--steps-dir", args.steps_dir]
    # 300 seconds of a 330-second limit, so it stops itself before it is stopped.
    deadline = args.deadline_given if args.deadline_given is not None else max(1.0, args.supervise_seconds - min(30.0, args.supervise_seconds / 10))
    return arguments + ["--deadline-seconds", str(deadline)]


def supervise(args):
    stop = []
    for signum in STOP_SIGNALS:
        signal.signal(signum, lambda signum, _frame: stop.append(signum))
    started = time.time_ns()
    child = subprocess.Popen([sys.executable, os.path.abspath(__file__)] + child_arguments(args),
                             stdin=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    sid = child.pid
    # At once, so that if this supervisor is itself stopped or killed, box.sh
    # can still end everything in the worker's session (runner/box.sh).
    session_file = args.session_file or os.path.join(os.path.dirname(args.record), "provision.session")
    with open(session_file + ".tmp", "w") as handle:
        handle.write("%d\n" % sid)
    os.replace(session_file + ".tmp", session_file)
    end = time.monotonic() + args.supervise_seconds
    outer = None
    term_at = None
    while child.poll() is None:
        now = time.monotonic()
        if term_at is None and (stop or now >= end):
            outer = ("told to stop by %s" % signal_name(stop[0])) if stop else ("the outer limit of %s seconds" % args.supervise_seconds)
            log("%s: sending TERM to provisioning" % outer)
            child.send_signal(signal.SIGTERM)
            term_at = now
        # Told to stop by a signal (box.sh's own limit, a shutdown), it must be
        # done before whoever sent it gives up: box.sh's KILL comes 10 seconds
        # after its TERM. So 5 seconds of grace then, the full grace otherwise.
        elif term_at is not None and now - term_at >= (min(args.supervise_grace_seconds, 5) if stop else args.supervise_grace_seconds):
            log("provisioning did not stop within the grace after TERM: KILL")
            child.kill()
            term_at = float("inf")
        time.sleep(POLL_SECONDS)
    code = child.returncode
    status = code if code >= 0 else 128 - code
    session = kill_session(sid)
    if session["killed"]:
        log("killed %d processes left in provisioning's session: %s" % (len(session["killed"]), ", ".join(
            "%d %s" % (process["pid"], process["comm"]) for process in session["killed"])))
    undone = undo(args, load_record(args.record) or {})
    for action in undone:
        log("undone after provisioning ended: %s, exit %s" % (action["what"], action.get("exit")))
    ended = time.time_ns()
    report = {"limit_seconds": args.supervise_seconds, "grace_seconds": args.supervise_grace_seconds,
              "started_at": rfc3339(started), "ended_at": rfc3339(ended), "session": sid,
              "child_exit": code if code >= 0 else None, "child_signal": signal_name(-code) if code < 0 else None,
              "stopped_by": outer, "session_left": session["killed"], "session_survivors": session["survivors"],
              "undone": undone}
    finalize(args.record, report)
    if outer is not None:
        return 124 if not stop else 128 + stop[0]
    return status


def main(argv=None):
    parser = argparse.ArgumentParser(description="Prepare the disks the disk benchmarks read, and record it.")
    parser.add_argument("--record", required=True, help="where the record is written (run.py's --provision-record)")
    parser.add_argument("--fixture-tool", required=True, help="the built runner/fixture.c")
    parser.add_argument("--instance-type", default="", help="this box's instance type, from IMDS")
    parser.add_argument("--region", default="", help="this box's region, from IMDS")
    parser.add_argument("--supervise-seconds", type=float, help="run as a child in a session of its own, for at most this long")
    parser.add_argument("--supervise-grace-seconds", type=float, default=SUPERVISE_GRACE_SECONDS, help=argparse.SUPPRESS)
    parser.add_argument("--session-file", help="where the supervisor writes the worker's session id (default: provision.session beside the record)")
    parser.add_argument("--deadline-seconds", type=float, dest="deadline_given", help=argparse.SUPPRESS)
    parser.add_argument("--kill-grace-seconds", type=float, default=KILL_GRACE_SECONDS, help=argparse.SUPPRESS)
    parser.add_argument("--fixture-timeout-seconds", type=float, default=1200, help=argparse.SUPPRESS)
    parser.add_argument("--sys", default="/sys", help=argparse.SUPPRESS)
    parser.add_argument("--proc", default="/proc", help=argparse.SUPPRESS)
    parser.add_argument("--node-dir", default=NODE_DIR, help=argparse.SUPPRESS)
    parser.add_argument("--instance-store-mount", default=INSTANCE_STORE_MOUNT, help=argparse.SUPPRESS)
    parser.add_argument("--root-volume-dir", default=ROOT_VOLUME_DIR, help=argparse.SUPPRESS)
    parser.add_argument("--steps-dir", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    args.record = os.path.abspath(args.record)
    if args.supervise_seconds is not None:
        return supervise(args)
    args.deadline_seconds = args.deadline_given if args.deadline_given is not None else DEADLINE_SECONDS
    return provision(args)


if __name__ == "__main__":
    sys.exit(main())
