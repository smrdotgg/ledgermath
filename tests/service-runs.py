#!/usr/bin/env python3
"""Drives runner/run.py through a schedule whose entry measures a Service.
Used by tests/service.test.ts.

    python3 tests/service-runs.py CASE DIR

It makes, under DIR (which must not exist):

    root/        a source tree: runner/ (for the runner manifest) and a fake
                 benchmark, a shell script that writes the LM_SERVICE_* values
                 it was given to DIR/sink/<n>/ and prints a valid stream whose
                 observed event names the LM_SERVICE_* variables it got (never
                 their values)
    bin/aws      a stand-in for the aws CLI: `sts assume-role` answers with the
                 stand-in keys below, or fails as the case says; every call's
                 arguments are appended to DIR/aws-calls.log
    out/         runs/, blobs/ and boots/, as run.py writes them
    log          everything run.py printed, as box.sh's log would hold it
    result.json  run.py's exit status, and whether its own environment held a key

then runs run.py's main() with the dump and the EC2 API stubbed and IMDS
answering with the documentation's example ids. The schedule has three
executions: plain (n=1) measures no Service; measured (n=2 and n=3) names
s3_fixtures.

    keys          assume-role works: every execution runs, measured's get the keys
    refused       assume-role is refused (AccessDenied): measured's are not run
    garbled       assume-role exits 0 but prints the keys in no JSON: not run,
                  and what it printed is recorded nowhere
    unshaped      assume-role prints JSON whose AccessKeyId is not a key ID
    no-values     run.py is given no s3_fixtures values: not run, aws never called
    text          no Service: plain (n=1), and n=6, whose binary prints a line that is
                  not JSON before verified
    undumpable    the runner cannot mark itself not dumpable: no keys are asked for

The keys are stand-ins, not credentials; each must still reach the measured
executions' environment and nowhere else.
"""

import ctypes
import importlib.util
import json
import os
import resource
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = ("keys", "refused", "garbled", "unshaped", "no-values", "text", "undumpable")

KEY_ID = "ASIAQSTANDINTESTKEY7"
SECRET = "stand+in/Secret/Access/Key/0123456789abcdefghijk"
TOKEN = "IQoJb3JpZ2luX2VjEStandIn//////////wEaCXVzLWVhc3QtMiJHMEUCIQStandInSessionToken+test=="
SECRETS = {"aws_access_key_id": KEY_ID, "aws_secret_access_key": SECRET, "aws_session_token": TOKEN}
ENDPOINT = "https://ledgermath-test-fixtures.s3.us-east-2.amazonaws.com"
ROLE = "arn:aws:iam::123456789012:role/ledgermath-test-fixtures"

# What IMDS answers: the documentation's example ids.
METADATA = {
    "meta-data/instance-id": "i-0123456789abcdef0",
    "meta-data/instance-type": "m5.large",
    "meta-data/ami-id": "ami-0123456789abcdef0",
    "meta-data/placement/region": "us-east-2",
    "meta-data/placement/availability-zone": "us-east-2c",
    "meta-data/placement/availability-zone-id": "use2-az3",
}

# The fake benchmark. It finds DIR/sink from its own path (root/benchmarks/fake/build/static/fake).
FAKE = r'''#!/bin/sh
sink="$(dirname "$0")/../../../../../sink/$LM_PARAM_N"
mkdir -p "$sink"
# Whether this process is dumpable, and its core-file limit, beside the sink.
process="$(dirname "$0")/../../../../../process"
mkdir -p "$process"
python3 -I -c 'import ctypes; print(ctypes.CDLL(None).prctl(3, 0, 0, 0, 0))' > "$process/$LM_PARAM_N.dumpable"
grep "^Max core file size" /proc/self/limits > "$process/$LM_PARAM_N.core"
# The kernel gives a process's /proc directory to root while it is not dumpable.
echo "$(stat -c %u /proc/$$) $(id -u)" > "$process/$LM_PARAM_N.owner"
for name in $(env | sed -n 's/^\(LM_SERVICE_[A-Z_]*\)=.*/\1/p' | sort); do
  printenv "$name" > "$sink/$name"
done
names="$(env | sed -n 's/^\(LM_SERVICE_[A-Z_]*\)=.*/\1/p' | sort | tr '\n' ' ')"
echo '{"event":"started","t":1,"schema":"ledgermath.events/1","wall_utc":"2026-11-11T00:00:00.000000000Z","clock":"CLOCK_MONOTONIC_RAW","clock_read_ns":20}'
echo "{\"event\":\"observed\",\"t\":2,\"values\":{\"service_variables\":\"$names\"}}"
echo '{"event":"sample_started","t":3,"sample":0,"warmup":false,"repetitions":1}'
echo '{"event":"sample_ended","t":4,"sample":0}'
[ "$LM_PARAM_N" = 6 ] && echo "a line that is not JSON"
echo '{"event":"verified","t":5,"checksum":"0x0000000000000000"}'
echo '{"event":"finished","t":6}'
'''

MAKEFILE = ("build:\n\tmkdir -p build/$(BUILD)\n\tcp fake.sh build/$(BUILD)/fake\n\tchmod +x build/$(BUILD)/fake\n"
            "compiler:\n\t@echo fake-cc 1.0\nresolved:\n\t@echo nothing to resolve\n")


def aws_stub(case, calls):
    answer = {
        "keys": json.dumps({"Credentials": {"AccessKeyId": KEY_ID, "SecretAccessKey": SECRET, "SessionToken": TOKEN,
                                            "Expiration": "2026-11-11T01:00:00+00:00"},
                            "AssumedRoleUser": {"AssumedRoleId": "AROAEXAMPLEID:ledgermath", "Arn": ROLE}}, indent=4),
        # The keys, in no JSON: run.py must say so and record none of it.
        "garbled": "AccessKeyId %s SecretAccessKey %s SessionToken %s" % (KEY_ID, SECRET, TOKEN),
        "unshaped": json.dumps({"Credentials": {"AccessKeyId": KEY_ID.lower(), "SecretAccessKey": SECRET, "SessionToken": TOKEN,
                                                "Expiration": "2026-11-11T01:00:00+00:00"}}),
    }.get(case, json.dumps({"Credentials": {"AccessKeyId": KEY_ID, "SecretAccessKey": SECRET, "SessionToken": TOKEN,
                                            "Expiration": "2026-11-11T01:00:00+00:00"}}))
    lines = ["#!/bin/sh", "printf '%%s\\n' \"$*\" >> '%s'" % calls,
             '[ "$1 $2" = "sts assume-role" ] || { echo "aws (stub): not stubbed: $*" >&2; exit 2; }']
    if case == "refused":
        lines += ["echo 'An error occurred (AccessDenied) when calling the AssumeRole operation: User: "
                  "arn:aws:sts::123456789012:assumed-role/BoxRole/i-0123456789abcdef0 is not authorized to perform: "
                  "sts:AssumeRole on resource: %s' >&2" % ROLE, "exit 254"]
    else:
        lines += ["cat <<'EOF'", answer, "EOF"]
    return "\n".join(lines) + "\n"


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)
    os.chmod(path, mode)


def main():
    case, directory = sys.argv[1], os.path.abspath(sys.argv[2])
    if case not in CASES:
        sys.exit("unknown case %s; one of %s" % (case, ", ".join(CASES)))
    os.makedirs(directory)
    root, out = os.path.join(directory, "root"), os.path.join(directory, "out")
    write(os.path.join(root, "runner", "stand-in"), "the runner's files, for the runner manifest\n")
    write(os.path.join(root, "benchmarks", "fake", "fake.sh"), FAKE)
    write(os.path.join(root, "benchmarks", "fake", "Makefile"), MAKEFILE)
    calls = os.path.join(directory, "aws-calls.log")
    write(os.path.join(directory, "bin", "aws"), aws_stub(case, calls), 0o755)

    entry = {"name": "fake", "builds": ["static"], "samples": 1, "timeout_seconds": 60}
    schedule = {"benchmarks": [dict(entry, params=[{"n": 1}]), dict(entry, params=[{"n": 2}, {"n": 3}], service="s3_fixtures")]}
    if case == "text":
        schedule = {"benchmarks": [dict(entry, params=[{"n": 1}, {"n": 6}])]}
    write(os.path.join(directory, "schedule.json"), json.dumps(schedule))
    # The source archive, as git archive would make it: run.py hashes it, and
    # check-runs.ts reads runner/ from it to check the runner manifest.
    archive = os.path.join(directory, "source.tar.gz")
    with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as tar:
        for relative in ("runner/stand-in", "benchmarks/fake/fake.sh", "benchmarks/fake/Makefile"):
            tar.add(os.path.join(root, relative), arcname=relative)

    spec = importlib.util.spec_from_file_location("ledgermath_run", os.path.join(HERE, "..", "runner", "run.py"))
    run = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(run)
    run.Imds.get = lambda self, path: METADATA.get(path)
    run.Imds.section = lambda self: {"stub": "IMDS is stubbed in this test"}
    run.dump_sections = lambda cpuid_tool, imds: {"kernel": {"stub": "the dump is stubbed in this test"}}
    run.ec2_sections = lambda imds: {"ec2_instance": {"stub": "the EC2 API is stubbed in this test"}}
    if case == "undumpable":
        run.mark_not_dumpable = lambda: "prctl(PR_SET_DUMPABLE, 0) failed: a stand-in failure"
    core_before = resource.getrlimit(resource.RLIMIT_CORE)

    os.environ["PATH"] = os.path.join(directory, "bin") + os.pathsep + os.environ["PATH"]
    for variable in ("ENDPOINT", "REGION", "ROLE"):
        os.environ.pop("LEDGERMATH_FIXTURES_" + variable, None)
    sys.argv = ["run.py", "--root", root, "--out", out, "--schedule", os.path.join(directory, "schedule.json"),
                "--source-commit", "0" * 40, "--source-archive", archive]
    if case != "no-values":
        sys.argv += ["--fixtures-endpoint", ENDPOINT, "--fixtures-region", "us-east-2", "--fixtures-role", ROLE]

    # Everything run.py and its children print goes to DIR/log, as on a box.
    log = os.open(os.path.join(directory, "log"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    saved = os.dup(1), os.dup(2)
    sys.stdout.flush()
    os.dup2(log, 1)
    os.dup2(log, 2)
    try:
        status = run.main()
    finally:
        sys.stdout.flush()
        os.dup2(saved[0], 1)
        os.dup2(saved[1], 2)
    environ = "\n".join("%s=%s" % item for item in os.environ.items())
    # What the dump reads of this process, read again now that it is not dumpable.
    readable = {path: run.read_text(path) is not None for path in ("/proc/self/limits", "/proc/self/cgroup", "/proc/self/mountinfo")}
    with open(os.path.join(directory, "result.json"), "w") as handle:
        json.dump({"status": status, "environ_holds_a_key": any(value in environ for value in SECRETS.values()),
                   "argv_holds_a_key": any(value in " ".join(sys.argv) for value in SECRETS.values()),
                   "runner_dumpable": ctypes.CDLL(None).prctl(3, 0, 0, 0, 0),
                   "core_limit_unchanged": resource.getrlimit(resource.RLIMIT_CORE) == core_before,
                   "core_limit": list(core_before), "proc_self_readable": readable, "uid": os.getuid()}, handle)


if __name__ == "__main__":
    main()
