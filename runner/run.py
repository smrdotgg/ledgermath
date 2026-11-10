#!/usr/bin/env python3
"""Runs the schedule on this box and writes one Run for every execution.

The schedule is schedule.json at the root of the source tree. It is not part of
the runner: a Run carries its own parameters, so editing the schedule changes
no recorded fact of any Run it does not touch.

For each benchmark in the schedule it builds every named build, then runs each
parameter set under each build. Around every execution it dumps the box's
environment, and it records what happened without judging it: a crash, a
timeout, and a clean exit all produce a Run.

Everything is written under --out, ready to be copied to the bucket as it is:

    runs/<yyyy>/<mm>/<dd>/<id>.json    one Run (schemas/run.schema.json)
    blobs/sha256/<hash>                every blob a Run cites, named by its hash
    boots/<yyyy>/<mm>/<dd>/<boot>.json what this boot did

Told to stop by SIGTERM, SIGINT or SIGHUP, it kills the binary it is running,
still writes that execution's Run (with `exit.runner_signal`), starts nothing
more, writes the boot summary listing what was not run, and exits non-zero. A
SIGKILL, or the box losing power, loses the execution in flight.

Runs on the box's own Python (3.9 on Amazon Linux 2023) with no packages.
"""

import argparse
import datetime
import glob
import hashlib
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

RUN_SCHEMA = "ledgermath.run/1"
DUMP_SCHEMA = "ledgermath.dump/1"
BOOT_SCHEMA = "ledgermath.boot/1"


def log(message):
    print("ledgermath-run: " + message, flush=True)


# ---- small pieces ----

def rfc3339(ns):
    """Wall-clock nanoseconds since the epoch as 2026-01-02T03:04:05.123456789Z."""
    seconds, fraction = divmod(ns, 10 ** 9)
    moment = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S") + ".%09dZ" % fraction


def uuid7(unix_ms):
    """A version 7 UUID: 48 bits of milliseconds, then random bits."""
    random_bits = secrets.randbits(74)
    value = (unix_ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= (random_bits >> 62) << 64
    value |= 0x2 << 62
    value |= random_bits & ((1 << 62) - 1)
    text = "%032x" % value
    return "-".join((text[0:8], text[8:12], text[12:16], text[16:20], text[20:32]))


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def write_atomically(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "wb") as handle:
        handle.write(data)
    os.replace(temporary, path)


def as_json(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


class Blobs:
    """Content-addressed files: a blob's name is the sha256 of its bytes."""

    def __init__(self, out):
        self.directory = os.path.join(out, "blobs", "sha256")

    def put(self, data):
        digest = sha256_hex(data)
        path = os.path.join(self.directory, digest)
        if not os.path.exists(path):
            write_atomically(path, data)
        return "sha256:" + digest

    def put_file(self, path):
        with open(path, "rb") as handle:
            return self.put(handle.read())


def read_text(path):
    """A file's text, or None when it cannot be read."""
    try:
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", "replace")
    except OSError:
        return None


def read_files(patterns):
    """Maps every file matching the glob patterns to its verbatim text."""
    found = {}
    for pattern in patterns:
        for path in glob.glob(pattern):
            if os.path.isfile(path):
                found[path] = read_text(path)
    return found


def run_command(arguments, timeout=60):
    """Runs a command for the dump and returns what it printed, verbatim."""
    try:
        done = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": str(error)}
    return {
        "exit": done.returncode,
        "stdout": done.stdout.decode("utf-8", "replace"),
        "stderr": done.stderr.decode("utf-8", "replace"),
    }


def command_key(arguments):
    return "$ " + " ".join(arguments)


# ---- the provider ----

class Imds:
    """The EC2 instance metadata service, version 2."""

    BASE = "http://169.254.169.254/latest/"
    PATHS = [
        "dynamic/instance-identity/document",
        "meta-data/instance-id",
        "meta-data/instance-type",
        "meta-data/ami-id",
        "meta-data/instance-life-cycle",
        "meta-data/placement/region",
        "meta-data/placement/availability-zone",
        "meta-data/placement/availability-zone-id",
    ]

    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.token = None

    def _request(self, path, method="GET", headers=None):
        request = urllib.request.Request(self.BASE + path, method=method, headers=headers or {})
        with self.opener.open(request, timeout=2) as response:
            return response.read().decode("utf-8", "replace")

    def get(self, path):
        try:
            if self.token is None:
                self.token = self._request("api/token", "PUT", {"X-aws-ec2-metadata-token-ttl-seconds": "21600"})
            return self._request(path, headers={"X-aws-ec2-metadata-token": self.token})
        except (OSError, ValueError):
            return None

    def section(self):
        return {self.BASE + path: self.get(path) for path in self.PATHS}


def provider_fields(imds):
    """The provider's own words for where this is running, verbatim."""
    instance_id = imds.get("meta-data/instance-id")
    if instance_id is None:
        return {"name": "unknown"}
    return {
        "name": "aws",
        "instance_type": imds.get("meta-data/instance-type"),
        "region": imds.get("meta-data/placement/region"),
        "availability_zone": imds.get("meta-data/placement/availability-zone"),
        "availability_zone_id": imds.get("meta-data/placement/availability-zone-id"),
        "image_id": imds.get("meta-data/ami-id"),
        "instance_id": instance_id,
    }


# ---- the environment dump ----

CPU = "/sys/devices/system/cpu"
NODE = "/sys/devices/system/node"


def dump_sections(cpuid_tool, imds):
    """Everything the box reports about itself, raw and unmasked.

    Each section maps a source, a path or a command line, to exactly what it
    returned. Sections are stored as separate blobs so the ones that do not
    change (the processor, the kernel's settings) are stored once.
    """
    sections = {}

    if cpuid_tool:
        sections["cpuid"] = {command_key([os.path.basename(cpuid_tool)]): run_command([cpuid_tool])}
    sections["cpuinfo"] = read_files(["/proc/cpuinfo"])
    sections["lscpu"] = {command_key(["lscpu", "-J"]): run_command(["lscpu", "-J"])}

    sections["sys_cpu"] = read_files([
        CPU + "/online", CPU + "/offline", CPU + "/possible", CPU + "/present", CPU + "/isolated",
        CPU + "/smt/*",
        CPU + "/vulnerabilities/*",
        CPU + "/cpufreq/boost",
        CPU + "/intel_pstate/*",
        CPU + "/cpuidle/*",
        CPU + "/cpu[0-9]*/online",
        CPU + "/cpu[0-9]*/topology/*",
        CPU + "/cpu[0-9]*/cache/index[0-9]*/level",
        CPU + "/cpu[0-9]*/cache/index[0-9]*/type",
        CPU + "/cpu[0-9]*/cache/index[0-9]*/size",
        CPU + "/cpu[0-9]*/cache/index[0-9]*/coherency_line_size",
        CPU + "/cpu[0-9]*/cache/index[0-9]*/number_of_sets",
        CPU + "/cpu[0-9]*/cache/index[0-9]*/ways_of_associativity",
        CPU + "/cpu[0-9]*/cache/index[0-9]*/physical_line_partition",
        CPU + "/cpu[0-9]*/cache/index[0-9]*/shared_cpu_list",
        CPU + "/cpu[0-9]*/cache/index[0-9]*/id",
        CPU + "/cpu[0-9]*/cpufreq/scaling_driver",
        CPU + "/cpu[0-9]*/cpufreq/scaling_governor",
        CPU + "/cpu[0-9]*/cpufreq/scaling_available_governors",
        CPU + "/cpu[0-9]*/cpufreq/scaling_min_freq",
        CPU + "/cpu[0-9]*/cpufreq/scaling_max_freq",
        CPU + "/cpu[0-9]*/cpufreq/cpuinfo_min_freq",
        CPU + "/cpu[0-9]*/cpufreq/cpuinfo_max_freq",
        CPU + "/cpu[0-9]*/cpufreq/energy_performance_preference",
        CPU + "/cpu[0-9]*/cpufreq/boost",
        CPU + "/cpu[0-9]*/cpuidle/state[0-9]*/name",
        CPU + "/cpu[0-9]*/cpuidle/state[0-9]*/desc",
        CPU + "/cpu[0-9]*/cpuidle/state[0-9]*/latency",
        CPU + "/cpu[0-9]*/cpuidle/state[0-9]*/residency",
        CPU + "/cpu[0-9]*/cpuidle/state[0-9]*/disable",
        CPU + "/cpu[0-9]*/cpuidle/state[0-9]*/default_status",
        CPU + "/cpu[0-9]*/microcode/version",
    ])

    kernel = read_files([
        "/proc/version", "/proc/cmdline", "/etc/os-release",
        "/proc/sys/kernel/osrelease",
        "/proc/sys/kernel/randomize_va_space",
        "/proc/sys/kernel/numa_balancing",
        "/proc/sys/kernel/perf_event_paranoid",
        "/proc/sys/kernel/nmi_watchdog",
        "/proc/sys/kernel/sched_autogroup_enabled",
        "/proc/sys/vm/swappiness",
        "/proc/sys/vm/overcommit_memory",
        "/proc/sys/vm/zone_reclaim_mode",
        "/proc/sys/vm/nr_hugepages",
        "/sys/kernel/mm/transparent_hugepage/enabled",
        "/sys/kernel/mm/transparent_hugepage/defrag",
        "/sys/kernel/mm/transparent_hugepage/shmem_enabled",
        "/sys/kernel/mm/transparent_hugepage/use_zero_page",
        "/sys/kernel/mm/transparent_hugepage/khugepaged/defrag",
        "/sys/kernel/mm/hugepages/hugepages-*/nr_hugepages",
        "/sys/devices/system/clocksource/clocksource0/current_clocksource",
        "/sys/devices/system/clocksource/clocksource0/available_clocksource",
        NODE + "/online", NODE + "/possible", NODE + "/has_cpu", NODE + "/has_memory",
        NODE + "/node[0-9]*/cpulist",
        NODE + "/node[0-9]*/distance",
        "/sys/module/nvme_core/parameters/*",
    ])
    kernel[command_key(["uname", "-a"])] = run_command(["uname", "-a"])
    sections["kernel"] = kernel

    sections["memory"] = read_files([
        "/proc/meminfo", "/proc/loadavg", "/proc/uptime", "/proc/swaps",
        "/proc/pressure/cpu", "/proc/pressure/memory", "/proc/pressure/io",
        NODE + "/node[0-9]*/meminfo",
    ])

    devices = read_files([
        "/sys/class/nvme/nvme[0-9]*/model",
        "/sys/class/nvme/nvme[0-9]*/serial",
        "/sys/class/nvme/nvme[0-9]*/firmware_rev",
        "/sys/block/*/size",
        "/sys/block/*/queue/scheduler",
        "/sys/block/*/queue/rotational",
        "/sys/block/*/queue/logical_block_size",
        "/sys/block/*/queue/physical_block_size",
        "/sys/block/*/queue/nr_requests",
        "/sys/block/*/queue/read_ahead_kb",
        "/sys/class/dmi/id/sys_vendor",
        "/sys/class/dmi/id/product_name",
        "/sys/class/dmi/id/product_version",
        "/sys/class/dmi/id/bios_vendor",
        "/sys/class/dmi/id/bios_version",
        "/sys/class/dmi/id/bios_date",
        "/sys/class/dmi/id/board_vendor",
        "/sys/class/dmi/id/board_name",
        "/sys/class/dmi/id/chassis_type",
    ])
    for arguments in (["lsblk", "-J", "-b", "-o", "NAME,TYPE,SIZE,MODEL,SERIAL,ROTA,FSTYPE,MOUNTPOINT"],
                      ["findmnt", "-J"]):
        devices[command_key(arguments)] = run_command(arguments)
    sections["devices"] = devices

    process = read_files(["/proc/self/limits", "/proc/self/cgroup"])
    process["allowed_cpus"] = sorted(os.sched_getaffinity(0))
    sections["process"] = process

    if os.path.exists("/usr/bin/rpm"):
        arguments = ["rpm", "-qa", "--qf", "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n"]
    else:
        arguments = ["dpkg-query", "-W", "-f", "${Package} ${Version} ${Architecture}\n"]
    packages = run_command(arguments)
    if "stdout" in packages:
        packages["stdout"] = "".join(sorted(packages["stdout"].splitlines(True)))
    sections["packages"] = {command_key(arguments[:2]) + " (sorted)": packages}

    sections["provider"] = imds.section()
    return sections


def take_dump(blobs, cpuid_tool, imds):
    """Dumps the environment and returns the hash of the dump's index."""
    taken_at = time.time_ns()
    index = {"schema": DUMP_SCHEMA, "taken_at": rfc3339(taken_at), "sections": {}}
    for name, section in dump_sections(cpuid_tool, imds).items():
        data = (json.dumps(section, sort_keys=True, indent=1, ensure_ascii=False) + "\n").encode("utf-8")
        index["sections"][name] = blobs.put(data)
    return blobs.put(as_json(index))


# ---- building ----

class BuildFailed(Exception):
    pass


def make(directory, *arguments):
    return subprocess.run(["make", "--no-print-directory", "-C", directory] + list(arguments),
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def build(root, name, build_name, blobs):
    """Builds one benchmark one way and describes the result."""
    directory = os.path.join(root, "benchmarks", name)
    done = make(directory, "-B", "BUILD=" + build_name)
    output = done.stdout.decode("utf-8", "replace")
    if done.returncode != 0:
        raise BuildFailed("make BUILD=%s in %s exited %d:\n%s" % (build_name, directory, done.returncode, output))
    path = os.path.join(directory, "build", build_name, name)
    if not os.path.isfile(path):
        raise BuildFailed("make BUILD=%s in %s did not produce %s" % (build_name, directory, path))

    compiler = make(directory, "-s", "compiler")
    resolved = make(directory, "-s", "resolved")
    if compiler.returncode != 0 or resolved.returncode != 0:
        raise BuildFailed("make compiler or make resolved failed in %s" % directory)
    return {
        "path": path,
        "record": {
            "blob": blobs.put_file(path),
            "build": build_name,
            "compiler": compiler.stdout.decode("utf-8", "replace").strip(),
            "command": output.strip(),
            "resolved_flags": blobs.put(resolved.stdout),
        },
    }


# ---- being told to stop ----

STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)


class Stop:
    """The first stop signal received, and the binary running at the time."""

    signal = None
    child = None
    logged = False


def still_running(child):
    """True until the child has ended. It never reaps the child, so while this
    is true the child's pid is still its own and safe to signal."""
    try:
        return os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None
    except ChildProcessError:  # already reaped
        return False


def on_stop(signum, _frame):
    # Nothing is printed here: writing to stdout while the main code is in the
    # middle of a write raises "reentrant call". stopping() logs it instead.
    if Stop.signal is None:
        Stop.signal = signum
    child = Stop.child
    if child is not None and still_running(child):
        os.kill(child.pid, signal.SIGKILL)


def stopping():
    """True once a stop signal has arrived; logs it the first time it is seen."""
    if Stop.signal is not None and not Stop.logged:
        Stop.logged = True
        log("told to stop by %s" % signal.Signals(Stop.signal).name)
    return Stop.signal is not None


# ---- one execution ----

def param_text(value):
    """A parameter as the binary receives it: plain, never quoted."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def execute(binary, arguments, environment, timeout_seconds):
    """Runs the binary and waits. Nothing of ours runs while it does.

    The child gets exactly `environment`, an empty working directory, and files
    for stdout and stderr. This process then blocks in waitpid; the timeout is a
    kernel alarm, not a polling loop. A stop signal kills the child too, and the
    exit record says which signal it was.
    """
    scratch = tempfile.mkdtemp(prefix="ledgermath-")
    workdir = os.path.join(scratch, "cwd")
    os.mkdir(workdir)
    stdout_path = os.path.join(scratch, "stdout")
    stderr_path = os.path.join(scratch, "stderr")
    timed_out = []

    with open(stdout_path, "wb") as out, open(stderr_path, "wb") as err:
        started = time.time_ns()
        child = subprocess.Popen([binary] + arguments, env=environment, cwd=workdir,
                                 stdin=subprocess.DEVNULL, stdout=out, stderr=err, close_fds=True)
        Stop.child = child
        if Stop.signal is not None and still_running(child):  # told to stop while it was being launched
            os.kill(child.pid, signal.SIGKILL)

        def on_alarm(_signal, _frame):
            # An alarm that comes after the binary ended by itself kills nothing
            # and records nothing.
            if still_running(child):
                timed_out.append(True)
                os.kill(child.pid, signal.SIGKILL)

        previous = signal.signal(signal.SIGALRM, on_alarm)
        signal.alarm(timeout_seconds)
        try:
            # Wait until the binary has ended, without reaping it.
            os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT)
            # Whether the runner had been told to stop is read at the moment
            # the binary is reaped, with the stop signals held (run.py has one
            # thread), so a signal that comes later stops the boot but is not
            # written into this execution's exit.
            signal.pthread_sigmask(signal.SIG_BLOCK, STOP_SIGNALS)
            try:
                stop_signal = Stop.signal
                status = child.wait()
                Stop.child = None
            finally:
                signal.pthread_sigmask(signal.SIG_UNBLOCK, STOP_SIGNALS)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
            Stop.child = None
        ended = time.time_ns()

    with open(stdout_path, "rb") as handle:
        stdout = handle.read()
    with open(stderr_path, "rb") as handle:
        stderr = handle.read()
    for path in (stdout_path, stderr_path):
        os.remove(path)
    for leftover in os.listdir(workdir):
        log("warning: the binary left %s in its working directory" % leftover)
    exit_record = {"code": status} if status >= 0 else {"signal": -status}
    # Only when the runner's own SIGKILL is how the binary ended: a binary that
    # ended by itself an instant before the kill keeps its own exit alone.
    if timed_out and status == -signal.SIGKILL:
        exit_record["timeout_seconds"] = timeout_seconds
    if stop_signal is not None:
        exit_record["runner_signal"] = stop_signal
    return started, ended, exit_record, stdout, stderr


def parse_events(stdout):
    """Every stdout line, parsed, in order; stops at the first line that is not a JSON object."""
    events = []
    text = stdout.decode("utf-8", "replace")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    for number, line in enumerate(lines, start=1):
        try:
            event = json.loads(line)
        except ValueError as error:
            return events, {"line": number, "message": "not JSON: %s" % error}
        if not isinstance(event, dict):
            return events, {"line": number, "message": "not a JSON object"}
        events.append(event)
    return events, None


def put_tree(blobs, directory, skip=("build", "__pycache__")):
    """One hash for a directory: the blob listing every file as `sha256  path`, sorted by path."""
    lines = []
    for parent, names, files in os.walk(directory):
        names[:] = sorted(name for name in names if name not in skip)
        for name in sorted(files):
            path = os.path.join(parent, name)
            with open(path, "rb") as handle:
                lines.append("%s  %s\n" % (sha256_hex(handle.read()), os.path.relpath(path, directory)))
    return blobs.put("".join(sorted(lines, key=lambda line: line.split("  ", 1)[1])).encode("utf-8"))


# ---- the schedule ----

def main():
    parser = argparse.ArgumentParser(description="Run the schedule on this box and write one Run per execution.")
    parser.add_argument("--root", required=True, help="the source tree (holds benchmarks/ and runner/)")
    parser.add_argument("--out", required=True, help="where runs/, blobs/ and boots/ are written")
    parser.add_argument("--schedule", help="defaults to schedule.json under --root")
    parser.add_argument("--source-commit", required=True, help="the git commit the source tree was archived from")
    parser.add_argument("--source-archive", required=True, help="the archive the source tree was unpacked from")
    parser.add_argument("--cpuid", help="the built runner/cpuid.c; without it the dump has no cpuid section")
    parser.add_argument("--quick", action="store_true", help="developer mode: pass --quick to every binary")
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    out = os.path.abspath(args.out)
    with open(args.schedule or os.path.join(root, "schedule.json"), encoding="utf-8") as handle:
        schedule = json.load(handle)

    for stop_signal in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(stop_signal, on_stop)

    blobs = Blobs(out)
    imds = Imds()
    provider = provider_fields(imds)
    boot = (read_text("/proc/sys/kernel/random/boot_id") or "").strip()
    source = blobs.put_file(args.source_archive)
    runner = put_tree(blobs, os.path.join(root, "runner"))
    cpuid_tool = os.path.abspath(args.cpuid) if args.cpuid else None
    log("boot=%s provider=%s source_commit=%s source=%s runner=%s"
        % (boot, json.dumps(provider), args.source_commit, source, runner))

    boot_started = time.time_ns()
    summary = {
        "schema": BOOT_SCHEMA,
        "boot": boot,
        "provider": provider,
        "source_commit": args.source_commit,
        "source": source,
        "runner": runner,
        "started_at": rfc3339(boot_started),
        "runs": [],
        "build_failures": [],
        "not_run": [],
    }
    day = datetime.datetime.fromtimestamp(boot_started // 10 ** 9, datetime.timezone.utc)

    def not_run(name, build_name, params):
        summary["not_run"].append({"benchmark": name, "build": build_name, "params": params})

    try:
        for benchmark in schedule["benchmarks"]:
            name = benchmark["name"]
            built = []
            unbuilt = []  # told to stop before these were built
            for build_name in benchmark["builds"]:
                if stopping():
                    unbuilt.append(build_name)
                    continue
                try:
                    built.append(build(root, name, build_name, blobs))
                    log("built %s %s %s" % (name, build_name, built[-1]["record"]["blob"]))
                except BuildFailed as error:
                    log("BUILD FAILED: %s" % error)
                    summary["build_failures"].append({"benchmark": name, "build": build_name, "message": str(error)})

            for index, params in enumerate(benchmark["params"]):
                for build_name in unbuilt:
                    not_run(name, build_name, params)
                # Builds take turns going first, by parameter set and by day, so
                # neither build always runs on the warmer or the cooler box.
                order = built if (index + day.toordinal()) % 2 == 0 else list(reversed(built))
                for one in order:
                    build_name = one["record"]["build"]
                    if stopping():
                        not_run(name, build_name, params)
                        continue
                    environment = {"LM_PARAM_" + key.upper(): param_text(value) for key, value in params.items()}
                    environment["LM_SAMPLES"] = str(benchmark["samples"])

                    before = take_dump(blobs, cpuid_tool, imds)
                    if stopping():
                        not_run(name, build_name, params)
                        continue
                    try:
                        started, ended, exit_record, stdout, stderr = execute(
                            one["path"], ["--quick"] if args.quick else [], environment, benchmark["timeout_seconds"])
                    except OSError as error:
                        log("COULD NOT START %s %s: %s" % (name, build_name, error))
                        summary["build_failures"].append(
                            {"benchmark": name, "build": build_name, "message": "could not start: %s" % error})
                        continue
                    after = take_dump(blobs, cpuid_tool, imds)

                    events, events_error = parse_events(stdout)
                    run = {
                        "schema": RUN_SCHEMA,
                        "id": uuid7(started // 10 ** 6),
                        "boot": boot,
                        "started_at": rfc3339(started),
                        "ended_at": rfc3339(ended),
                        "benchmark": name,
                        "params": params,
                        "samples": benchmark["samples"],
                        "source_commit": args.source_commit,
                        "source": source,
                        "binary": one["record"],
                        "provider": provider,
                        "environment": {"before": before, "after": after},
                        "runner": runner,
                        "exit": exit_record,
                        "events": events,
                        "stdout": blobs.put(stdout),
                        "stderr": blobs.put(stderr),
                    }
                    if events_error is not None:
                        run["events_error"] = events_error

                    moment = datetime.datetime.fromtimestamp(started // 10 ** 9, datetime.timezone.utc)
                    path = os.path.join(out, "runs", moment.strftime("%Y/%m/%d"), run["id"] + ".json")
                    write_atomically(path, as_json(run))
                    summary["runs"].append({
                        "id": run["id"],
                        "benchmark": name,
                        "build": build_name,
                        "params": params,
                        "exit": exit_record,
                    })
                    log("run %s %s %s %s exit=%s events=%d seconds=%.1f"
                        % (run["id"], name, build_name, json.dumps(params), json.dumps(exit_record),
                           len(events), (ended - started) / 1e9))
    except BaseException as error:
        summary["error"] = repr(error)
        raise
    finally:
        # Written however the loop ended, so a boot that was told to stop, or
        # that failed, still says what it ran and what it did not.
        if stopping():
            summary["stopped_by"] = Stop.signal
        summary["ended_at"] = rfc3339(time.time_ns())
        boot_path = os.path.join(out, "boots", day.strftime("%Y/%m/%d"), (boot or "unknown") + ".json")
        write_atomically(boot_path, as_json(summary))
        log("wrote %d runs; %d failures; %d not run" % (
            len(summary["runs"]), len(summary["build_failures"]), len(summary["not_run"])))

    if Stop.signal is not None:
        return 128 + Stop.signal
    return 1 if summary["build_failures"] else 0

if __name__ == "__main__":
    sys.exit(main())
