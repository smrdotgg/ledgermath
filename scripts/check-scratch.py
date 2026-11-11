#!/usr/bin/env python3
"""Shows that every static build in schedule.json runs alone.

    python3 scripts/check-scratch.py              every benchmark with a static build
    python3 scripts/check-scratch.py syscall hash only these

For each benchmark whose builds in schedule.json include "static", it builds
benchmarks/<name>/build/static/<name>, makes an image FROM scratch holding that
file and nothing else, and runs it there once for every parameter set the
schedule gives it, with --quick and the set's LM_PARAM_* variables, as
runner/run.py would pass them. Each stream must pass scripts/check-events.py.

The container's only addition is an empty tmpfs at /tmp, which `syscall`'s
`stat` set is given as its path; the box's /tmp is a tmpfs too. No measured Run
goes through Docker: this only shows that the binary needs no other file.

Needs make, a C compiler with the static C library, Docker, and Python 3.
Exit status 0 when every execution ran and every stream is valid, 1 when not.
"""

import json
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DOCKERFILE = "FROM scratch\nCOPY {name} /bench\nENTRYPOINT [\"/bench\"]\n"


def param_text(value):
    """A parameter as runner/run.py gives it to the binary."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def main():
    with open(os.path.join(ROOT, "schedule.json"), encoding="utf-8") as handle:
        schedule = json.load(handle)
    only = set(sys.argv[1:])
    benchmarks = [b for b in schedule["benchmarks"] if "static" in b["builds"] and (not only or b["name"] in only)]
    unknown = only - {b["name"] for b in benchmarks}
    if unknown:
        print("no static build of %s in schedule.json" % ", ".join(sorted(unknown)), file=sys.stderr)
        return 2

    failures = []
    for benchmark in benchmarks:
        name = benchmark["name"]
        directory = os.path.join(ROOT, "benchmarks", name)
        subprocess.run(["make", "--no-print-directory", "-C", directory, "-B", "BUILD=static"], check=True)
        context = os.path.join(directory, "build", "static")
        image = "lm-scratch-" + name.replace("_", "-")
        subprocess.run(["docker", "build", "-q", "-t", image, "-f", "-", context],
                       input=DOCKERFILE.format(name=name).encode(), stdout=subprocess.DEVNULL, check=True)
        for params in benchmark["params"]:
            environment = []
            for key, value in params.items():
                environment += ["-e", "LM_PARAM_%s=%s" % (key.upper(), param_text(value))]
            label = "%s %s" % (name, json.dumps(params))
            done = subprocess.run(["docker", "run", "--rm", "--tmpfs", "/tmp"] + environment + [image, "--quick"],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if done.returncode != 0:
                failures.append(label)
                print("FAIL %s: exit %d\n%s" % (label, done.returncode, done.stderr.decode("utf-8", "replace")))
                continue
            check = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "check-events.py"), "--quick"],
                                   input=done.stdout, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            if check.returncode != 0:
                failures.append(label)
                print("FAIL %s: the stream is not valid\n%s" % (label, check.stdout.decode("utf-8", "replace")))
                continue
            print("ok   %s: %s" % (label, check.stdout.decode().strip()))
        subprocess.run(["docker", "rmi", "-f", image], stdout=subprocess.DEVNULL, check=False)

    if failures:
        print("%d of the executions failed" % len(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
