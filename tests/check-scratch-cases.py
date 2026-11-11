#!/usr/bin/env python3
"""Runs stub binaries in place of a benchmark that this machine cannot run, and
asks scripts/check-scratch.py's skip_problem() whether each one's exit, stream
and stderr count as the binary refusing the set. Used by
tests/check-scratch.test.ts.

    python3 tests/check-scratch-cases.py OUT

Each stub is a shell script under OUT that prints what the case says to stdout
and stderr and exits with its code; it is run, and its output judged. Prints
one JSON object: each case's skip_problem(), null when the skip is accepted.
"""

import importlib.util
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")

STARTED = ('{"event":"started","t":1,"schema":"ledgermath.events/1","wall_utc":"2026-11-11T00:00:00.000000000Z",'
           '"clock":"CLOCK_MONOTONIC_RAW","clock_read_ns":20.0,"quick":true}')
OBSERVED = '{"event":"observed","t":2,"values":{"threads_used":2}}'
DISTINCT = {"threads": 2, "placement": "distinct_cores", "critical_section_lines": 1, "lock": "pthread_mutex_default", "idle_threads": 0}
SIBLINGS = {"threads": 2, "placement": "smt_siblings", "critical_section_lines": 1, "lock": "pthread_mutex_default", "idle_threads": 0}
IO_URING = {"disk": "root_volume", "dir": "/var/tmp/ledgermath/disk", "access": "random", "request_bytes": 4096, "queue_depth": 64, "span_bytes": 1073741824}
REFUSE_DISTINCT = ("error: placement distinct_cores is impossible here: 2 threads need CPUs on 2 different cores, "
                   "and the CPUs this process may run on (1,3) are on 1 core")
REFUSE_IO_URING = ("error: io_uring is not available here: io_uring_setup: Operation not permitted (a kernel without it, "
                   "kernel.io_uring_disabled, or a seccomp filter such as Docker's default)")

# name: (benchmark, params, stdout lines, stderr lines, exit code)
CASES = {
    "mutex refuses its placement": ("mutex", DISTINCT, [STARTED], [REFUSE_DISTINCT], 2),
    "mutex exits 2 for another reason": ("mutex", DISTINCT, [STARTED], ["usage error: LM_PARAM_LOCK is not set"], 2),
    "a stub that says nothing and exits 2": ("mutex", DISTINCT, [], [], 2),
    "the refusal, but after more events": ("mutex", DISTINCT, [STARTED, OBSERVED], [REFUSE_DISTINCT], 2),
    "the refusal of another placement": ("mutex", SIBLINGS, [STARTED], [REFUSE_DISTINCT], 2),
    "the refusal, with no stream": ("mutex", DISTINCT, [], [REFUSE_DISTINCT], 2),
    "the refusal, with exit 1": ("mutex", DISTINCT, [STARTED], [REFUSE_DISTINCT], 1),
    "a stream that is not JSON": ("mutex", DISTINCT, ["started"], [REFUSE_DISTINCT], 2),
    "io_uring refused": ("disk_read_io_uring", IO_URING, [STARTED], [REFUSE_IO_URING], 2),
    "io_uring exits 2 for another reason": ("disk_read_io_uring", IO_URING, [STARTED],
                                            ['usage error: parameter access must be "sequential" or "random", got "x"'], 2),
    "a benchmark that never refuses": ("syscall", {"call": "getpid"}, [STARTED], [REFUSE_DISTINCT], 2),
}


def load():
    spec = importlib.util.spec_from_file_location("check_scratch", os.path.join(ROOT, "scripts", "check-scratch.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def shell_quote(text):
    return "'" + text.replace("'", "'\"'\"'") + "'"


def main():
    out = sys.argv[1]
    os.makedirs(out)
    check = load()
    results = {}
    for index, (case, (name, params, stdout, stderr, code)) in enumerate(CASES.items()):
        stub = os.path.join(out, "stub-%d" % index)
        with open(stub, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\n")
            for line in stdout:
                handle.write("printf '%%s\\n' %s\n" % shell_quote(line))
            for line in stderr:
                handle.write("printf '%%s\\n' %s >&2\n" % shell_quote(line))
            handle.write("exit %d\n" % code)
        os.chmod(stub, 0o755)
        done = subprocess.run([stub, "--quick"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        results[case] = check.skip_problem(name, params, done.returncode, done.stdout, done.stderr)
    print(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
