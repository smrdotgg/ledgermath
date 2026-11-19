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
    slow-to-die        the same, with that child slow to die: SIGKILLed, it takes
                       HOLD_SECONDS to be gone (see hold_at_exit)
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
side by side, so those limits do not add up. A tool that starts a child of its
own goes no further until that child has said its trap is set (see GRANDCHILD),
so the tool cannot exit, write its pid or print a line while the child would
still end on SIGTERM; and the cases that act on the tool once it is running
wait, besides, for that child to be the `sleep` it execs.

Each tool writes the pids it and its children have to OUT/<case>/pids/. A pid
is a survivor if it still names a process that is not a zombie WAIT_SECONDS
after provision.py exited. Prints one JSON object, one entry per case.

What the cases need of the machine: a reaper for orphans. A step's children
that outlive it are orphans; killed, they are zombies until whoever adopted
them reaps them, and provision.py waits (up to 10 seconds) for a killed step's
processes to be gone, zombies included. On a box PID 1 is systemd, which reaps
them at once. In a container whose PID 1 reaps nothing (bun test run as the
container's command), they stay zombies, provision.py waits out its 10
seconds, and in the two supervisor cases the supervisor's grace runs out first.
So this harness is, for the processes it starts, what systemd is on a box:
their child subreaper (prctl PR_SET_CHILD_SUBREAPER), reaping every orphan
that comes to it, and never one of its own children, which subprocess waits for.

A process killed by SIGKILL can still be exiting at provision.py's next look,
so provision.py sends SIGKILL again, and records it. On a loaded machine that
happens by chance; slow-to-die makes it happen every time. The harness traces
that case's child (ptrace, which it may: it is the child's ancestor), so that,
killed, the child stops on its way out (PTRACE_EVENT_EXIT) and is not a zombie
until the harness lets it go, HOLD_SECONDS later. Further SIGKILLs do not end
that stop. Every other signal is passed on to the child as it came.
"""

import ctypes
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
# How long slow-to-die's child takes to be gone once SIGKILLed: many times
# provision.py's poll, and well inside the 10 seconds it waits for a killed
# group to be gone.
HOLD_SECONDS = 3
PTRACE_CONT, PTRACE_DETACH, PTRACE_SEIZE = 7, 17, 0x4206
PTRACE_O_TRACEEXIT, PTRACE_EVENT_EXIT = 0x40, 6
WALL = 0x40000000  # __WALL: wait for a tracee that is not a child, too

# A child that ignores SIGTERM, started in the background. It says so through
# the FIFO $READY once its trap is set, and the tool waits for that before it
# does anything else, so from then on a signal sent to the step's process group
# always meets a process that ignores TERM: TERM alone cannot end it, and only
# SIGKILL can. (Without the wait, a tool that exits at once could be signalled
# before the child had set its trap, and TERM would end it.)
GRANDCHILD = '(trap "" TERM; echo set > "$READY"; exec sleep 600) &\necho $! > "$PIDS/grandchild"\nread set < "$READY"\n'

TOOLS = {
    "hangs": 'echo $$ > "$PIDS/tool"\necho "writing $1"\nprintf partial > "$1"\nexec sleep 600\n',
    "ignores-term": 'trap "" TERM\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.1; done\n',
    "grandchild": GRANDCHILD + 'echo $$ > "$PIDS/tool"\necho started\nwait\n',
    "slow-to-die": GRANDCHILD + 'echo $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwait\n',
    "leftover": GRANDCHILD + 'echo $$ > "$PIDS/tool"\nprintf whole > "$1"\necho \'{"bytes": 1}\'\nexit 0\n',
    "sigterm": 'trap "" TERM\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.1; done\n',
    "deadline": 'echo $$ > "$PIDS/tool"\necho started\nexec sleep 600\n',
    "supervised-limit": 'trap "" TERM\necho $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.1; done\n',
    "supervised-killed": GRANDCHILD + 'echo $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwait\n',
    "outer-limit-suspended": GRANDCHILD + 'echo $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.2; done\n',
    "outer-limit-killed": 'trap "" TERM\n' + GRANDCHILD + 'echo $$ > "$PIDS/tool"\necho started\nprintf partial > "$1"\nwhile :; do sleep 0.2; done\n',
}

# The deliberate limits, in seconds: each far longer than a stand-in tool
# needs to start, print and write its pid, even on a loaded machine.
OPTIONS = {
    "hangs": ["--fixture-timeout-seconds", "6"],
    "ignores-term": ["--fixture-timeout-seconds", "6"],
    "grandchild": ["--fixture-timeout-seconds", "6"],
    "slow-to-die": ["--fixture-timeout-seconds", "6"],
    "leftover": [],
    "sigterm": [],
    "deadline": ["--deadline-seconds", "10"],
    "supervised-limit": ["--supervise-seconds", "10", "--supervise-grace-seconds", "10", "--deadline-seconds", "300"],
    "supervised-killed": ["--supervise-seconds", "330", "--deadline-seconds", "300"],
    "outer-limit-suspended": ["--supervise-seconds", "330", "--deadline-seconds", "300"],
    "outer-limit-killed": ["--supervise-seconds", "330", "--deadline-seconds", "300"],
}


class Reaper:
    """This process as the subreaper of everything it starts (see the module's
    docstring): orphans are reparented to it, and a thread reaps each one that
    has exited. Its own children are left to subprocess, which waits for them:
    Popen is wrapped so that a child is known before the thread can see it."""

    PR_SET_CHILD_SUBREAPER = 36

    def __init__(self):
        self.lock = threading.Lock()
        self.children = {}  # pid -> the Popen that started it

    def start(self):
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(self.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_CHILD_SUBREAPER)")
        real_init = subprocess.Popen.__init__
        reaper = self

        def init(popen, *args, **kwargs):
            with reaper.lock:
                real_init(popen, *args, **kwargs)
                reaper.children[popen.pid] = popen

        subprocess.Popen.__init__ = init
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        me = os.getpid()
        while True:
            with self.lock:
                for name in os.listdir("/proc"):
                    if not name.isdigit():
                        continue
                    pid = int(name)
                    own = self.children.get(pid)
                    if own is not None and own.returncode is None:
                        continue  # a child of ours: subprocess reaps it
                    try:
                        with open("/proc/%d/stat" % pid) as handle:
                            text = handle.read()
                    except OSError:
                        continue
                    fields = text[text.rindex(")") + 2:].split()
                    if fields[0] == "Z" and int(fields[1]) == me:
                        try:
                            os.waitpid(pid, os.WNOHANG)
                        except ChildProcessError:
                            pass
            time.sleep(0.05)


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


def comm(pid):
    try:
        with open("/proc/%d/comm" % pid) as handle:
            return handle.read().strip()
    except OSError:
        return None


def running_step(record_path, pids):
    """The record, once its fixture step is running with a process group, the
    tool has written its pid and said it started, and the child it started, if
    it starts one, is the `sleep` it execs (the tool writes the child's pid
    before its own, so that file is whole by then)."""
    record = load(record_path)
    if not record or not os.path.exists(os.path.join(pids, "tool")):
        return None
    grandchild = os.path.join(pids, "grandchild")
    if os.path.exists(grandchild):
        with open(grandchild) as handle:
            if comm(int(handle.read())) != "sleep":
                return None
    for step in record.get("steps", []):
        if step["step"].startswith("fixture") and step.get("state") == "running" and step.get("pgid"):
            out = step.get("stdout_file")
            if out and os.path.exists(out) and os.path.getsize(out) > 0:
                return record
    return None


def hold_at_exit(pid):
    """Traces `pid` until it is killed, then holds it at its exit stop for
    HOLD_SECONDS and lets it go: a process slow to die. Every signal it is sent
    before then is passed on as it came. Must run in one thread throughout (a
    tracer is a thread); a tracer thread that ends lets its tracee go."""
    libc = ctypes.CDLL(None, use_errno=True)
    libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]

    def ptrace(request, data):
        if libc.ptrace(request, pid, None, data) != 0:
            raise OSError(ctypes.get_errno(), "ptrace(%d) on pid %d" % (request, pid))

    ptrace(PTRACE_SEIZE, PTRACE_O_TRACEEXIT)
    passed_on = []
    end = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < end:
        got, status = os.waitpid(pid, os.WNOHANG | WALL)
        if got == 0:
            time.sleep(0.05)
            continue
        if not os.WIFSTOPPED(status):
            raise RuntimeError("pid %d ended (wait status %d) without stopping on its way out" % (pid, status))
        if status >> 16 == PTRACE_EVENT_EXIT:
            time.sleep(HOLD_SECONDS)
            ptrace(PTRACE_DETACH, 0)
            return {"pid": pid, "held_seconds": HOLD_SECONDS, "passed_on": passed_on}
        passed_on.append(signal.Signals(os.WSTOPSIG(status)).name)
        ptrace(PTRACE_CONT, os.WSTOPSIG(status))
    raise RuntimeError("waited %d seconds for pid %d to be killed" % (WAIT_SECONDS, pid))


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
    ready = os.path.join(case, "ready")
    os.mkfifo(ready)
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
                               env=dict(os.environ, PIDS=pids, READY=ready))
    output_file.close()
    sent = None
    leftovers = None
    held = None
    if name == "slow-to-die":
        wait_for(lambda: running_step(record_path, pids), "the fixture step to run")
        with open(os.path.join(pids, "grandchild")) as handle:
            held = hold_at_exit(int(handle.read()))
    elif name == "sigterm":
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
        "held": held,
    }


def main():
    Reaper().start()
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
