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
reported as skipped, with the reason, and is still run once to show that the
binary agrees: it must exit 2 without a `finished` event. Every other set must
pass, and every benchmark must have at least one set that runs (for `mutex`, the
one-thread set needs one CPU, so it always runs).

The container's only addition is an empty tmpfs at /tmp, which `syscall`'s
`stat` set is given as its path; the box's /tmp is a tmpfs too. No measured Run
goes through Docker: this only shows that the binary needs no other file.

Needs make, a C compiler with the static C library, Docker, and Python 3.
Exit status 0 when every execution ran and every stream is valid, 1 when not.
"""

import collections
import json
import os
import subprocess
import sys

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


def unmet(name, params, topology):
    """Why this machine cannot provide what the parameter set asks for, or None."""
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
            done = subprocess.run(["docker", "run", "--rm", "--tmpfs", "/tmp"] + cpuset + environment + [image, "--quick"],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stderr = done.stderr.decode("utf-8", "replace")
            if reason is not None:
                finished = '"event":"finished"' in done.stdout.decode("utf-8", "replace").replace(" ", "")
                if done.returncode != 2 or finished:
                    failures.append(label)
                    print("FAIL %s: this machine cannot provide it (%s), yet the binary exited %d%s\n%s"
                          % (label, reason, done.returncode, " with a finished event" if finished else "", stderr))
                    continue
                said = (stderr.strip().splitlines() or ["nothing on stderr"])[-1]
                print("skip %s: %s; the binary agrees: exit 2, %s" % (label, reason, said))
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
