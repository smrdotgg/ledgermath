#!/usr/bin/env python3
"""What box.sh does once provisioning has returned, however it ended.

    python3 provision-leftovers.py RECORD SESSION_FILE INSTANCE_STORE_MOUNT ROOT_VOLUME_DIR STATUS

runner/box.sh runs it right after `provision.py --supervise-seconds`, which
writes its worker's session id to SESSION_FILE. Normally the supervisor has
already ended everything and this finds nothing to do, and writes nothing. If
the supervisor was itself stuck and box.sh's own limit ended it, this:

  - kills every process left in provisioning's session;
  - unmounts the instance store if the record does not say it was readied,
    and removes its mount point if nothing is mounted there;
  - removes a Fixture the record does not say was made whole (any Fixture
    there, when the record cannot be read), and the root volume's directory if
    it is then empty;
  - writes what it did into the record's file under `box_sh`, marking a step
    or a record still `running` as not having recorded its end.

STATUS is provisioning's exit status as box.sh saw it. Independent of
provision.py on purpose: it must work when provisioning is what went wrong.
Runs on the box's own Python (3.9) with no packages.
"""
import json, os, signal, subprocess, sys, time
record_path, session_path, mount_point, root_dir, status = sys.argv[1:6]
done = []
try:
    sid = int(open(session_path).read().strip())
except (OSError, ValueError):
    sid = None
def session_members():
    found = []
    for name in os.listdir("/proc"):
        try:
            text = open("/proc/%s/stat" % name).read() if name.isdigit() else ""
        except OSError:
            continue
        fields = text[text.rindex(")") + 2:].split() if ")" in text else []
        if len(fields) > 3 and int(fields[3]) == sid and fields[0] != "Z":
            found.append(int(name))
    return found
for attempt in range(100 if sid is not None else 0):
    left = session_members()
    if not left:
        break
    for pid in left:
        try:
            os.kill(pid, signal.SIGKILL)
            done.append("killed pid %d, left in provisioning's session %d" % (pid, sid))
        except ProcessLookupError:
            pass
    time.sleep(0.1)
try:
    record = json.load(open(record_path))
except (OSError, ValueError):
    record = None
known = record or {}
# Without a readable record, any Fixture there is of unknown making: removed.
fixtures = known.get("fixtures", []) if record is not None else [{"path": os.path.join(d, "ledgermath-fixture-v1"), "made": False} for d in (mount_point, root_dir)]
if os.path.ismount(mount_point) and (known.get("instance_store") or {}).get("state") != "ready":
    done.append("unmounted %s lazily, exit %d: the record does not say it was readied" % (mount_point, subprocess.call(["umount", "-l", mount_point])))
for fixture in fixtures:
    if not fixture.get("made") and not fixture.get("existed_before") and os.path.lexists(fixture["path"]):
        os.unlink(fixture["path"])
        done.append("removed %s, which the record does not say was made whole" % fixture["path"])
for directory, why in ((mount_point, "nothing is mounted there"), (root_dir, "it holds no Fixture")):
    if os.path.isdir(directory) and not os.path.ismount(directory) and not os.listdir(directory) and \
            (directory == mount_point or (known.get("root_volume") or {}).get("state") != "ready"):
        os.rmdir(directory)
        done.append("removed %s: %s" % (directory, why))
if done:
    if record is None:
        record = {"schema": "ledgermath.provision/2", "state": "no readable record", "steps": [], "decisions": [], "fixtures": []}
    for step in record.get("steps", []):
        if step.get("state") == "running":
            step["state"] = "unfinished"
            for key in ("stdout", "stderr"):
                try:
                    step[key] = open(step.get(key + "_file") or "", errors="replace").read()
                except OSError:
                    pass
    if record.get("state") == "running":
        record["state"] = "ended without recording its end"
    record["box_sh"] = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "provisioning_exit": int(status), "done": done}
    with open(record_path + ".tmp", "w") as handle:
        json.dump(record, handle, indent=1, sort_keys=True)
    os.replace(record_path + ".tmp", record_path)
for line in done:
    print("ledgermath-box: after provisioning: " + line)
