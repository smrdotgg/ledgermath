#!/usr/bin/env python3
"""Drives runner/run.py through races a real box can hit. Used by tests/runner.test.ts.

    python3 tests/runner-races.py CASE OUT [RUN_PY]

It makes a fake benchmark (a shell script, so no compiler is needed), stubs
out run.py's environment dump and instance metadata, runs a schedule of two
executions through run.py's main(), and forces one case:

    timeout-kills       the binary sleeps; the runner's 1-second timeout kills it
    alarm-after-exit    the binary ends at once, and the timeout's alarm fires
                        after it was reaped, before the runner cancels it
    stop-while-running  the runner is sent SIGTERM while the binary sleeps
    stop-after-exit     the runner is sent SIGTERM just after it reaped the binary
    stop-in-after-dump  the runner is sent SIGTERM as the dump after the binary starts

OUT gets runs/, blobs/ and boots/ as run.py writes them, and status, run.py's
exit status. RUN_PY defaults to runner/run.py of this checkout.
"""

import importlib.util
import json
import os
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = ("timeout-kills", "alarm-after-exit", "stop-while-running", "stop-after-exit", "stop-in-after-dump")


def main():
    case, out = sys.argv[1], os.path.abspath(sys.argv[2])
    if case not in CASES:
        sys.exit("unknown case %s; one of %s" % (case, ", ".join(CASES)))
    run_py = sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, "..", "runner", "run.py")
    spec = importlib.util.spec_from_file_location("ledgermath_run", run_py)
    run = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(run)

    root = os.path.join(out, "root")
    benchmark = os.path.join(root, "benchmarks", "fake")
    os.makedirs(benchmark)
    os.makedirs(os.path.join(root, "runner"))
    with open(os.path.join(root, "runner", "stand-in"), "w") as handle:
        handle.write("the runner's files, for the runner manifest\n")
    with open(os.path.join(benchmark, "fake.sh"), "w") as handle:
        handle.write('#!/bin/sh\nif [ "$LM_PARAM_MODE" = sleep ]; then exec /bin/sleep 30; fi\nexit 0\n')
    with open(os.path.join(benchmark, "Makefile"), "w") as handle:
        handle.write("build:\n\tmkdir -p build/$(BUILD)\n\tcp fake.sh build/$(BUILD)/fake\n\tchmod +x build/$(BUILD)/fake\n"
                     "compiler:\n\t@echo fake-cc 1.0\nresolved:\n\t@echo nothing to resolve\n")
    sleeping = case in ("timeout-kills", "stop-while-running")
    schedule = {"benchmarks": [{
        "name": "fake",
        "builds": ["static"],
        "samples": 1,
        "timeout_seconds": 1 if case in ("timeout-kills", "alarm-after-exit") else 60,
        "params": [{"mode": "sleep" if sleeping else "quick", "n": n} for n in (1, 2)],
    }]}
    with open(os.path.join(out, "schedule.json"), "w") as handle:
        json.dump(schedule, handle)
    archive = os.path.join(out, "source.tar.gz")
    with open(archive, "wb") as handle:
        handle.write(b"a stand-in source archive\n")

    run.Imds.get = lambda self, path: None
    run.dump_sections = lambda cpuid_tool, imds: {"kernel": {"stub": "the dump is stubbed in this test"}}

    real_wait = subprocess.Popen.wait
    reaped = []

    def wait(self, timeout=None):
        status = real_wait(self, timeout)
        if str(self.args[0]).endswith("/fake") and not reaped:
            reaped.append(True)
            if case == "alarm-after-exit":
                time.sleep(1.5)  # the 1-second alarm fires now, after the binary was reaped
            if case == "stop-after-exit":
                os.kill(os.getpid(), signal.SIGTERM)
        return status

    subprocess.Popen.wait = wait

    real_take_dump = run.take_dump
    dumps = []

    def take_dump(*args):
        dumps.append(True)
        if case == "stop-in-after-dump" and len(dumps) == 2:
            os.kill(os.getpid(), signal.SIGTERM)
        return real_take_dump(*args)

    run.take_dump = take_dump
    if case == "stop-while-running":
        threading.Timer(2.0, os.kill, (os.getpid(), signal.SIGTERM)).start()

    sys.argv = ["run.py", "--root", root, "--out", out, "--schedule", os.path.join(out, "schedule.json"),
                "--source-commit", "0" * 40, "--source-archive", archive]
    status = run.main()
    with open(os.path.join(out, "status"), "w") as handle:
        handle.write("%d\n" % status)


if __name__ == "__main__":
    main()
