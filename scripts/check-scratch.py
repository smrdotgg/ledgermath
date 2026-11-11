#!/usr/bin/env python3
"""Shows that every static build in schedule.json runs alone.

    python3 scripts/check-scratch.py              every benchmark with a static build
    python3 scripts/check-scratch.py syscall hash only these

For each benchmark whose builds in schedule.json include "static", it builds
benchmarks/<name>/build/static/<name> once, however many entries name it, makes
an image FROM scratch holding that file and nothing else, and runs it there once
for every parameter set the schedule gives it in any entry, with --quick and the
set's LM_PARAM_* variables, as runner/run.py would pass them. Each stream must
pass scripts/check-events.py. An entry's instance_types are not consulted: this
machine is not any of them.

Some parameter sets ask for CPUs this machine may not have: `mutex`'s
`distinct_cores` needs as many cores as threads, and `smt_siblings` a core with
that many hardware threads. Whether this machine can provide them is decided
here, from the topology in /sys of the CPUs this process may run on, and the
container is given exactly those CPUs. A set this machine cannot provide is
still run once, and is reported as skipped only when the binary agrees in its
own words: it exits 2, its stream is `started` and nothing after it, and its
stderr has the line that refuses exactly that set (`error: placement
<placement> is impossible here: ...`). Anything else, such as an exit 2 for
another reason, fails. Every other set must pass, and every benchmark must have
at least one set that runs (for `mutex`, the one-thread sets need one CPU, so
they always run).

The container's only addition is an empty tmpfs at /tmp, which `syscall`'s
`stat` set is given as its path; the box's /tmp is a tmpfs too. No measured Run
goes through Docker: this only shows that the binary needs no other file.

The disk benchmarks read a Fixture the box makes at boot, and write a scratch
file of their own, in the directory their `dir` names. Here runner/fixture.c
(built with this machine's compiler) makes a 64 MiB Fixture in a new directory
under /tmp (or $LM_SCRATCH_DISK_DIR), which must be on a file system that
does direct I/O, and that directory is mounted at each set's `dir`. Under
--quick the binaries read at most 64 MiB of a span and write at most 16 MiB,
so the schedule's sets run against it as they are. The directory is removed
at the end. disk_read_io_uring runs without Docker's seccomp filter, whose
default refuses io_uring (the box has no such filter); when this machine's
kernel refuses io_uring itself (kernel.io_uring_disabled), its sets are
skipped, held to the same standard: the binary must exit 2 after `started`
alone, saying `error: io_uring is not available here: ...`.

Needs make, a C compiler with the static C library, Docker, and Python 3.
Exit status 0 when every execution ran and every stream is valid, 1 when not.
"""

import collections
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DOCKERFILE = "FROM scratch\nCOPY {name} /bench\nENTRYPOINT [\"/bench\"]\n"
CPU = "/sys/devices/system/cpu"


def param_text(value):
    """A parameter as runner/run.py gives it to the binary."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def parse_cpulist(text):
    """The CPUs of a kernel CPU list such as "0-3,8"."""
    cpus = set()
    for part in text.strip().split(","):
        first, _, last = part.partition("-")
        cpus.update(range(int(first), int(last or first) + 1))
    return cpus


def cpu_list(cpus):
    return ",".join(str(cpu) for cpu in sorted(cpus))


class Topology:
    """The CPUs this process may run on, and the core each is on (named by the
    lowest CPU of its thread_siblings_list, as the mutex binary names it)."""

    def __init__(self):
        self.cpus = sorted(os.sched_getaffinity(0))
        self.core_of = {}
        for cpu in self.cpus:
            with open("%s/cpu%d/topology/thread_siblings_list" % (CPU, cpu), encoding="ascii") as handle:
                self.core_of[cpu] = min(parse_cpulist(handle.read()))
        self.per_core = collections.Counter(self.core_of.values())

    def describe(self):
        cores = len(self.per_core)
        return "CPUs %s, on %d core%s, at most %d on one core" % (
            cpu_list(self.cpus), cores, "" if cores == 1 else "s", max(self.per_core.values()))


FIXTURE_BYTES = 64 << 20  # the most a --quick disk binary reads of a span


def io_uring_refused():
    """Why this machine's kernel refuses io_uring to a container's root, or None.
    kernel.io_uring_disabled (Linux 6.6 and later): 0 allows it, 1 allows it to
    CAP_SYS_ADMIN or io_uring_group only (a container has neither), 2 to no one."""
    try:
        with open("/proc/sys/kernel/io_uring_disabled", encoding="ascii") as handle:
            value = handle.read().strip()
    except OSError:
        return None
    if value in ("1", "2"):
        return "this machine's kernel.io_uring_disabled is %s" % value
    return None


def make_fixture_directory():
    """A new directory holding a --quick Fixture, made as the box makes one."""
    base = os.environ.get("LM_SCRATCH_DISK_DIR", "/tmp")
    directory = tempfile.mkdtemp(prefix="lm-scratch-disk-", dir=base)
    tool = os.path.join(directory, "fixture")
    harness = os.path.join(ROOT, "benchmarks", "harness", "c")
    built = subprocess.run(["cc", "-O2", "-I", harness, "-o", tool, os.path.join(ROOT, "runner", "fixture.c")])
    if built.returncode != 0:
        shutil.rmtree(directory, ignore_errors=True)
        sys.exit("runner/fixture.c did not build")
    done = subprocess.run([tool, os.path.join(directory, "ledgermath-fixture-v1"), str(FIXTURE_BYTES)],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    os.remove(tool)
    if done.returncode != 0:
        shutil.rmtree(directory, ignore_errors=True)
        sys.exit("cannot make a Fixture under %s, which must be on a file system that does direct I/O "
                 "(set LM_SCRATCH_DISK_DIR to one): %s" % (base, done.stderr.decode("utf-8", "replace")))
    print("a %d MiB Fixture in %s, mounted at each disk set's dir: %s" % (FIXTURE_BYTES >> 20, directory, done.stdout.decode().strip()))
    return directory


def unmet(name, params, topology):
    """Why this machine cannot provide what the parameter set asks for, or None."""
    if name == "disk_read_io_uring":
        return io_uring_refused()
    if name != "mutex":
        return None
    threads = int(params.get("threads", 1))
    placement = params.get("placement")
    cores = len(topology.per_core)
    if placement == "distinct_cores" and cores < threads:
        return "distinct_cores with %d threads needs %d cores, and the CPUs this check may use (%s) are on %d" % (
            threads, threads, cpu_list(topology.cpus), cores)
    most = max(topology.per_core.values())
    if placement == "smt_siblings" and most < threads:
        return "smt_siblings with %d threads needs %d hardware threads of one core, and of the CPUs this check may use (%s) no core has more than %d" % (
            threads, threads, cpu_list(topology.cpus), most)
    return None


def refusal(name, params):
    """The start of the stderr line with which the binary refuses a parameter set
    this machine cannot provide, or None for a benchmark that never does."""
    if name == "mutex":
        return "error: placement %s is impossible here: " % params.get("placement")
    if name == "disk_read_io_uring":
        return "error: io_uring is not available here: "
    return None


def skip_problem(name, params, returncode, stdout, stderr):
    """Why a run of a set this machine cannot provide is not the binary refusing
    it, or None when it is: exit 2, a stream of `started` and nothing after it,
    and the refusal line for this very set on stderr. stdout and stderr are bytes."""
    problems = []
    if returncode != 2:
        problems.append("it exited %d, not 2" % returncode)
    lines = stdout.decode("utf-8", "replace").splitlines()
    try:
        events = [json.loads(line) for line in lines]
    except ValueError:
        events = None
    alone = (events is not None and len(events) == 1 and isinstance(events[0], dict)
             and events[0].get("event") == "started" and events[0].get("schema") == "ledgermath.events/1")
    if not alone:
        problems.append("its stream is not `started` alone (%d line%s)" % (len(lines), "" if len(lines) == 1 else "s"))
    expected = refusal(name, params)
    if expected is None:
        problems.append("%s never refuses a parameter set" % name)
    elif not any(line.startswith(expected) for line in stderr.decode("utf-8", "replace").splitlines()):
        problems.append("its stderr has no line starting %r" % expected)
    return "; ".join(problems) or None


def main():
    with open(os.path.join(ROOT, "schedule.json"), encoding="utf-8") as handle:
        schedule = json.load(handle)
    only = set(sys.argv[1:])
    # Each benchmark once, with the parameter sets of all its entries, in the schedule's order.
    benchmarks = collections.OrderedDict()
    for entry in schedule["benchmarks"]:
        if "static" in entry["builds"] and (not only or entry["name"] in only):
            sets = benchmarks.setdefault(entry["name"], [])
            sets.extend(params for params in entry["params"] if params not in sets)
    unknown = only - set(benchmarks)
    if unknown:
        print("no static build of %s in schedule.json" % ", ".join(sorted(unknown)), file=sys.stderr)
        return 2

    topology = Topology()
    print("the CPUs this check may use, and gives the container: %s" % topology.describe())
    cpuset = ["--cpuset-cpus", cpu_list(topology.cpus)]
    disk = make_fixture_directory() if any(name.startswith("disk_") for name in benchmarks) else None
    try:
        return check_all(benchmarks, topology, cpuset, disk)
    finally:
        if disk is not None:
            shutil.rmtree(disk, ignore_errors=True)


def check_all(benchmarks, topology, cpuset, disk):
    failures = []
    for name, sets in benchmarks.items():
        directory = os.path.join(ROOT, "benchmarks", name)
        subprocess.run(["make", "--no-print-directory", "-C", directory, "-B", "BUILD=static"], check=True)
        context = os.path.join(directory, "build", "static")
        image = "lm-scratch-" + name.replace("_", "-")
        subprocess.run(["docker", "build", "-q", "-t", image, "-f", "-", context],
                       input=DOCKERFILE.format(name=name).encode(), stdout=subprocess.DEVNULL, check=True)
        ran = 0
        for params in sets:
            environment = []
            for key, value in params.items():
                environment += ["-e", "LM_PARAM_%s=%s" % (key.upper(), param_text(value))]
            label = "%s %s" % (name, json.dumps(params))
            reason = unmet(name, params, topology)
            extra = []
            if "dir" in params and disk is not None:
                extra += ["-v", "%s:%s" % (disk, params["dir"])]
            if name == "disk_read_io_uring":
                extra += ["--security-opt", "seccomp=unconfined"]
            done = subprocess.run(["docker", "run", "--rm", "--tmpfs", "/tmp"] + cpuset + extra + environment + [image, "--quick"],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stderr = done.stderr.decode("utf-8", "replace")
            if reason is not None:
                problem = skip_problem(name, params, done.returncode, done.stdout, done.stderr)
                if problem is not None:
                    failures.append(label)
                    print("FAIL %s: this machine cannot provide it (%s), but the binary did not refuse it: %s\n%s"
                          % (label, reason, problem, stderr))
                    continue
                said = next(line for line in stderr.splitlines() if line.startswith(refusal(name, params)))
                print("skip %s: %s; the binary agrees: exit 2 after `started` alone, %s" % (label, reason, said))
                continue
            ran += 1
            if done.returncode != 0:
                failures.append(label)
                print("FAIL %s: exit %d\n%s" % (label, done.returncode, stderr))
                continue
            check = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "check-events.py"), "--quick"],
                                   input=done.stdout, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            if check.returncode != 0:
                failures.append(label)
                print("FAIL %s: the stream is not valid\n%s" % (label, check.stdout.decode("utf-8", "replace")))
                continue
            print("ok   %s: %s" % (label, check.stdout.decode().strip()))
        if ran == 0:
            failures.append(name)
            print("FAIL %s: this machine can run none of its parameter sets, so nothing was shown" % name)
        subprocess.run(["docker", "rmi", "-f", image], stdout=subprocess.DEVNULL, check=False)

    if failures:
        print("%d of the executions failed" % len(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
