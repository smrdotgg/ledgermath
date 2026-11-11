#!/usr/bin/env python3
"""Runs runner/provision.py for real, with fixture tools that misbehave, and
reports what each run left: its exit status, its record, and whether any
process it started is still alive. Used by tests/provision-stops.test.ts.

    python3 tests/provision-stops.py OUT [CASE...]

Every case runs provision.py as its own process on a fake sysfs tree with no
instance store (so its one long step is making the root volume's Fixture, in a
directory under OUT/<case>), with no instance type (so no AWS call), and with a
fixture tool that is a shell script:

    hangs              prints a line, writes a partial Fixture, sleeps
    ignores-term       ignores SIGTERM, and so does every child it starts
    grandchild         starts a child of its own that ignores SIGTERM, then waits
    leftover           starts such a child, then exits 0 at once, leaving it
    sigterm            ignores SIGTERM; provision.py is sent SIGTERM mid-step
    deadline           sleeps; provision.py's own deadline is short
    supervised-limit   ignores SIGTERM; under a short --supervise-seconds
    supervised-killed  starts a grandchild, then sleeps; under --supervise-seconds 330,
                       provision.py's worker is sent SIGKILL mid-step
    outer-limit-suspended
                       starts a grandchild, then sleeps; as box.sh runs it, under
                       `timeout --kill-after=10 30` with --supervise-seconds 330, and
                       the supervisor is suspended (SIGSTOP) once the step runs.
                       GNU timeout sends SIGCONT with its TERM, so the supervisor
                       resumes and stops the worker itself; then box.sh's
                       runner/provision-leftovers.py runs, and finds only what the test left
    outer-limit-killed starts a grandchild, then sleeps; under --supervise-seconds 330
                       the supervisor is suspended once the step runs, then killed
                       (SIGKILL, as timeout's --kill-after kills one that does not
                       exit), so it does nothing more: the worker, its tool and the
                       partial Fixture are left; then runner/provision-leftovers.py
                       runs, with the arguments box.sh gives it
In both outer-limit cases the test also leaves an empty directory at the
instance-store mount point, as a preparation killed between making the mount
point and mounting would.

No case depends on how fast this machine is. Every wait is for a condition (a
record reaching a state, a file appearing, a process being gone) with an upper
bound of WAIT_SECONDS, and the short limits a case sets on purpose (6 to 10
seconds) are far longer than the stand-in tools need to start. The cases run
side by side, so those limits do not add up.

Each tool writes the pids it and its children have to OUT/<case>/pids/. A pid
is a survivor if it still names a process that is not a zombie WAIT_SECONDS
after provision.py exited. Prints one JSON object, one entry per case.
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
PROVISION = os.path.join(ROOT, "runner", "provision.py")
LEFTOVERS = os.path.join(ROOT, "runner", "provision-leftovers.py")
EBS = "Amazon Elastic Block Store              "
WAIT_SECONDS = 120

TOOLS = {
    "hangs": 'echo $$ > "$PIDS/tool"\necho "writing $1"\nprintf partial > "$1"\nexec sleep 600\n',
    "ignores-term": 'trap "" TERM\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.1; done\n',
    "grandchild": '(trap "" TERM; exec sleep 600) &\necho $! > "$PIDS/grandchild"\necho $$ > "$PIDS/tool"\necho started\nwait\n',
    "leftover": '(trap "" TERM; exec sleep 600) &\necho $! > "$PIDS/grandchild"\necho $$ > "$PIDS/tool"\nprintf whole > "$1"\necho \'{"bytes": 1}\'\nexit 0\n',
    "sigterm": 'trap "" TERM\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.1; done\n',
    "deadline": 'echo $$ > "$PIDS/tool"\necho started\nexec sleep 600\n',
    "supervised-limit": 'trap "" TERM\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.1; done\n',
    "supervised-killed": '(trap "" TERM; exec sleep 600) &\necho $! > "$PIDS/grandchild"\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwait\n',
    "outer-limit-suspended": '(trap "" TERM; exec sleep 600) &\necho $! > "$PIDS/grandchild"\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.2; done\n',
    "outer-limit-killed": 'trap "" TERM\n(trap "" TERM; exec sleep 600) &\necho $! > "$PIDS/grandchild"\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.2; done\n',
}

# The deliberate limits, in seconds: each far longer than a stand-in tool
# needs to start, print and write its pid, even on a loaded machine.
OPTIONS = {
    "hangs": ["--fixture-timeout-seconds", "6"],
    "ignores-term": ["--fixture-timeout-seconds", "6"],
    "grandchild": ["--fixture-timeout-seconds", "6"],
    "leftover": [],
    "sigterm": [],
    "deadline": ["--deadline-seconds", "10"],
    "supervised-limit": ["--supervise-seconds", "10", "--supervise-grace-seconds", "10", "--deadline-seconds", "300"],
    "supervised-killed": ["--supervise-seconds", "330", "--deadline-seconds", "300"],
    "outer-limit-suspended": ["--supervise-seconds", "330", "--deadline-seconds", "300"],
    "outer-limit-killed": ["--supervise-seconds", "330", "--deadline-seconds", "300"],
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


def wait_for(condition, what):
    end = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < end:
        value = condition()
        if value:
            return value
        time.sleep(0.05)
    raise RuntimeError("waited %d seconds for %s" % (WAIT_SECONDS, what))


def running_step(record_path, pids):
    """The record, once its fixture step is running with a process group and
    the tool has written its pid and said it started."""
    record = load(record_path)
    if not record or not os.path.exists(os.path.join(pids, "tool")):
        return None
    for step in record.get("steps", []):
        if step["step"].startswith("fixture") and step.get("state") == "running" and step.get("pgid"):
            out = step.get("stdout_file")
            if out and os.path.exists(out) and os.path.getsize(out) > 0:
                return record
    return None


def parent_of(pid):
    with open("/proc/%d/stat" % pid) as handle:
        text = handle.read()
    return int(text[text.rindex(")") + 2:].split()[1])


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
    session_path = os.path.join(case, "provision.session")
    root_dir = os.path.join(case, "disk")
    mount_point = os.path.join(case, "mnt")
    arguments = [sys.executable, PROVISION, "--record", record_path, "--fixture-tool", tool, "--session-file", session_path,
                 "--sys", sys_root, "--proc", os.path.join(case, "proc"), "--node-dir", os.path.join(case, "node"),
                 "--instance-store-mount", mount_point, "--root-volume-dir", root_dir,
                 "--steps-dir", os.path.join(case, "steps"), "--kill-grace-seconds", "2"] + OPTIONS[name]
    if name == "outer-limit-suspended":
        # box.sh's own limit, its 360 seconds scaled to 30 but its kill delay as
        # it is: the supervisor, told to stop, gives the worker 5 seconds, so it
        # is done well within box.sh's 10.
        arguments = ["timeout", "--kill-after=10", "30"] + arguments
    started = time.monotonic()
    # Into a file, not a pipe: a worker left behind would hold a pipe open.
    output_path = os.path.join(case, "output")
    output_file = open(output_path, "wb")
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=output_file, stderr=subprocess.STDOUT,
                               env=dict(os.environ, PIDS=pids))
    output_file.close()
    sent = None
    leftovers = None
    if name == "sigterm":
        wait_for(lambda: running_step(record_path, pids), "the fixture step to run")
        process.send_signal(signal.SIGTERM)
        sent = "SIGTERM to provision.py"
    elif name == "supervised-killed":
        record = wait_for(lambda: running_step(record_path, pids), "the fixture step to run")
        os.kill(record["pid"], signal.SIGKILL)  # the worker the supervisor started, not the supervisor
        sent = "SIGKILL to provision.py's worker, pid %d" % record["pid"]
    elif name.startswith("outer-limit"):
        record = wait_for(lambda: running_step(record_path, pids), "the fixture step to run")
        supervisor = parent_of(record["pid"])
        os.kill(supervisor, signal.SIGSTOP)
        sent = "SIGSTOP to the supervisor, pid %d" % supervisor
        if name == "outer-limit-killed":
            os.kill(supervisor, signal.SIGKILL)
            sent += ", then SIGKILL"
    process.wait(timeout=WAIT_SECONDS + 60)
    with open(output_path, "rb") as handle:
        output = handle.read().decode("utf-8", "replace")
    seconds = time.monotonic() - started
    if name.startswith("outer-limit"):
        # What a half-done preparation could have left besides: a mount point
        # made before its mount (here a plain directory, nothing mounted).
        os.makedirs(mount_point, exist_ok=True)
        state_before = {"record_state": (load(record_path) or {}).get("state"),
                        "worker_alive": alive(record["pid"]),
                        "tool_alive": alive(int(open(os.path.join(pids, "tool")).read())),
                        "fixture_exists": os.path.exists(os.path.join(root_dir, "ledgermath-fixture-v1"))}
        # As box.sh runs it, right after provisioning returns.
        done = subprocess.run([sys.executable, LEFTOVERS, record_path, session_path, mount_point, root_dir, str(process.returncode)],
                              capture_output=True, text=True, timeout=WAIT_SECONDS)
        leftovers = {"before": state_before, "status": done.returncode, "stdout": done.stdout, "stderr": done.stderr,
                     "worker_alive_after": alive(record["pid"]), "mount_point_exists": os.path.isdir(mount_point)}
    known = {}
    for entry in sorted(os.listdir(pids)):
        with open(os.path.join(pids, entry)) as handle:
            known[entry] = int(handle.read().strip())
    end = time.monotonic() + WAIT_SECONDS
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
        "session_file": open(session_path).read().strip() if os.path.exists(session_path) else None,
        "known_processes": sorted(known),
        "survivors": survivors,
        "root_volume_dir_exists": os.path.isdir(root_dir),
        "fixture_exists": os.path.exists(os.path.join(root_dir, "ledgermath-fixture-v1")),
        "record_temporary_left": os.path.exists(record_path + ".tmp"),
        "leftovers": leftovers,
    }


def main():
    base = os.path.abspath(sys.argv[1])
    os.makedirs(base, exist_ok=True)
    names = [name for name in TOOLS if len(sys.argv) < 3 or name in sys.argv[2:]]
    results, errors = {}, {}

    def one(name):
        try:
            results[name] = run_case(base, name)
        except Exception as error:  # reported, and fails the test, rather than hanging it
            errors[name] = repr(error)

    threads = [threading.Thread(target=one, args=(name,)) for name in names]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    if errors:
        sys.exit("cases failed to run: %s" % json.dumps(errors))
    print(json.dumps({name: results[name] for name in names}, indent=1))


if __name__ == "__main__":
    main()
