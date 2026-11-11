#!/usr/bin/env python3
"""Runs runner/provision.py for real, with fixture tools that misbehave, and
reports what each run left: its exit status, its record, and whether any
process it started is still alive. Used by tests/provision-stops.test.ts.

    python3 tests/provision-stops.py OUT

Every case runs provision.py as its own process on a fake sysfs tree with no
instance store (so its one long step is making the root volume's Fixture, in a
directory under OUT/<case>), with no instance type (so no AWS call), and with a
fixture tool that is a shell script:

    hangs              prints a line, writes a partial Fixture, sleeps
    ignores-term       ignores SIGTERM, and so does every child it starts
    grandchild         starts a child of its own that ignores SIGTERM, then waits
    leftover           starts such a child, then exits 0 at once, leaving it
    sigterm            ignores SIGTERM; provision.py is sent SIGTERM mid-step
    deadline           sleeps; provision.py's own deadline is 2 seconds
    supervised-limit   ignores SIGTERM; under --supervise-seconds 2
    supervised-killed  starts a grandchild, then sleeps; under --supervise-seconds 120,
                       provision.py itself is sent SIGKILL mid-step

Each tool writes the pids it and its children have to OUT/<case>/pids/. A pid
is a survivor if, three seconds after provision.py exited, it still names a
process that is not a zombie. Prints one JSON object, one entry per case.
"""

import json
import os
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROVISION = os.path.join(HERE, "..", "runner", "provision.py")
EBS = "Amazon Elastic Block Store              "

TOOLS = {
    "hangs": 'echo $$ > "$PIDS/tool"\necho "writing $1"\nprintf partial > "$1"\nexec sleep 600\n',
    "ignores-term": 'trap "" TERM\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.1; done\n',
    "grandchild": '(trap "" TERM; exec sleep 600) &\necho $! > "$PIDS/grandchild"\necho $$ > "$PIDS/tool"\necho started\nwait\n',
    "leftover": '(trap "" TERM; exec sleep 600) &\necho $! > "$PIDS/grandchild"\necho $$ > "$PIDS/tool"\nprintf whole > "$1"\necho \'{"bytes": 1}\'\nexit 0\n',
    "sigterm": 'trap "" TERM\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.1; done\n',
    "deadline": 'echo $$ > "$PIDS/tool"\necho started\nexec sleep 600\n',
    "supervised-limit": 'trap "" TERM\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.1; done\n',
    "supervised-killed": '(trap "" TERM; exec sleep 600) &\necho $! > "$PIDS/grandchild"\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwait\n',
}

OPTIONS = {
    "hangs": ["--fixture-timeout-seconds", "1"],
    "ignores-term": ["--fixture-timeout-seconds", "1"],
    "grandchild": ["--fixture-timeout-seconds", "1"],
    "leftover": [],
    "sigterm": [],
    "deadline": ["--deadline-seconds", "2"],
    "supervised-limit": ["--supervise-seconds", "2", "--supervise-grace-seconds", "5", "--deadline-seconds", "100"],
    "supervised-killed": ["--supervise-seconds", "120", "--deadline-seconds", "120"],
}


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)
    os.chmod(path, mode)


def alive(pid):
    try:
        with open("/proc/%d/stat" % pid) as handle:
            text = handle.read()
    except OSError:
        return False
    return text[text.rindex(")") + 2:].split()[0] != "Z"


def load(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def wait_for_running_step(record_path, limit=30):
    """The record once its fixture step is running with a process group and
    the tool has said it started."""
    end = time.monotonic() + limit
    while time.monotonic() < end:
        record = load(record_path)
        if record:
            for step in record.get("steps", []):
                if step["step"].startswith("fixture") and step.get("state") == "running" and step.get("pgid"):
                    out = step.get("stdout_file")
                    if out and os.path.exists(out) and os.path.getsize(out) > 0:
                        return record
        time.sleep(0.05)
    raise RuntimeError("the fixture step never started running")


def run_case(base, name):
    case = os.path.join(base, name)
    pids = os.path.join(case, "pids")
    os.makedirs(pids)
    sys_root = os.path.join(case, "sys")
    write(os.path.join(sys_root, "class", "nvme", "nvme0", "model"), EBS + "\n")
    write(os.path.join(case, "proc", "self", "mountinfo"), "25 1 259:2 / / rw - xfs /dev/nvme0n1p1 rw\n")
    tool = os.path.join(case, "fixture-tool")
    write(tool, "#!/bin/sh\n" + TOOLS[name], 0o755)
    record_path = os.path.join(case, "provision.json")
    root_dir = os.path.join(case, "disk")
    arguments = [sys.executable, PROVISION, "--record", record_path, "--fixture-tool", tool,
                 "--sys", sys_root, "--proc", os.path.join(case, "proc"), "--node-dir", os.path.join(case, "node"),
                 "--instance-store-mount", os.path.join(case, "mnt"), "--root-volume-dir", root_dir,
                 "--steps-dir", os.path.join(case, "steps"), "--kill-grace-seconds", "1"] + OPTIONS[name]
    started = time.monotonic()
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               env=dict(os.environ, PIDS=pids))
    sent = None
    if name == "sigterm":
        wait_for_running_step(record_path)
        process.send_signal(signal.SIGTERM)
        sent = "SIGTERM to provision.py"
    elif name == "supervised-killed":
        record = wait_for_running_step(record_path)
        os.kill(record["pid"], signal.SIGKILL)  # the child the supervisor started, not the supervisor
        sent = "SIGKILL to provision.py's working child, pid %d" % record["pid"]
    output = process.communicate(timeout=120)[0].decode("utf-8", "replace")
    seconds = time.monotonic() - started
    known = {}
    for entry in sorted(os.listdir(pids)):
        with open(os.path.join(pids, entry)) as handle:
            known[entry] = int(handle.read().strip())
    end = time.monotonic() + 3
    while time.monotonic() < end and any(alive(pid) for pid in known.values()):
        time.sleep(0.05)
    survivors = {role: pid for role, pid in known.items() if alive(pid)}
    for pid in survivors.values():  # never leave them behind, whatever the test says
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return {
        "status": process.returncode,
        "seconds": round(seconds, 2),
        "sent": sent,
        "output": output,
        "record": load(record_path),
        "known_processes": sorted(known),
        "survivors": survivors,
        "root_volume_dir_exists": os.path.isdir(root_dir),
        "fixture_exists": os.path.exists(os.path.join(root_dir, "ledgermath-fixture-v1")),
        "record_temporary_left": os.path.exists(record_path + ".tmp"),
    }


def main():
    base = os.path.abspath(sys.argv[1])
    os.makedirs(base, exist_ok=True)
    only = sys.argv[2:]
    print(json.dumps({name: run_case(base, name) for name in TOOLS if not only or name in only}, indent=1))


if __name__ == "__main__":
    main()
