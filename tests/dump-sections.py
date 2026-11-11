#!/usr/bin/env python3
"""Exercises the dump sections runner/run.py gained for the disk benchmarks.
Used by tests/dump.test.ts.

    python3 tests/dump-sections.py OUT

It imports run.py and, with a stand-in `aws`, `nvme` and `ethtool` first on PATH (shell
scripts that print saved answers, or fail, and log how they were called), and
a stand-in IMDS, takes:

    ec2           ec2_sections() when the API answers
    ec2_refused   ec2_sections() when every call is refused
    ec2_no_imds   ec2_sections() when IMDS gives no instance id
    ec2_no_interface  ec2_sections() when IMDS gives no interface (no MAC)
    boot          boot_sections() and two dumps (take_dump()) that list them
    nvme          nvme_stats() over a fake sysfs tree
    xfs           xfs_mounts() over a sample /proc/self/mountinfo
    interfaces    primary_interface() over a sample /proc/net/route
    dump          the names of dump_sections() on this machine, its lsblk command,
                  and what its network sections hold, with a stand-in ethtool

and prints one JSON object with what each gave. No real AWS call is made.
"""

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")

FAKE_AWS = r'''#!/bin/sh
echo "$*" >> "$STUB_LOG"
if [ -n "$STUB_REFUSE" ]; then
  echo "An error occurred (UnauthorizedOperation) when calling the operation: You are not authorized" >&2
  exit 254
fi
case "$2" in
  describe-instance-types) echo '{"InstanceTypes": [{"InstanceType": "i4i.2xlarge"}]}' ;;
  describe-volumes) echo '{"Volumes": [{"VolumeId": "vol-0bbbbbbbbbbbbbbbb"}, {"VolumeId": "vol-0aaaaaaaaaaaaaaaa"}]}' ;;
  describe-volume-status) echo '{"VolumeStatuses": []}' ;;
  describe-instances) echo '{"Reservations": []}' ;;
  describe-route-tables) echo '{"RouteTables": []}' ;;
  describe-vpc-endpoints) echo '{"VpcEndpoints": []}' ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
'''

FAKE_ETHTOOL = r'''#!/bin/sh
echo "$*" >> "$STUB_LOG"
echo "ethtool $1 of $2"
'''

FAKE_NVME = r'''#!/bin/sh
echo "$*" >> "$STUB_LOG"
echo '{"total_read_ops": 1}'
'''


def load():
    spec = importlib.util.spec_from_file_location("ledgermath_run", os.path.join(ROOT, "runner", "run.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)
    os.chmod(path, mode)


class FakeImds:
    def __init__(self, answers):
        self.answers = answers

    def get(self, path):
        return self.answers.get(path)

    def section(self):
        return {}


MAC = "00:00:5e:00:53:01"
I4I = {"meta-data/instance-id": "i-0123456789abcdef0", "meta-data/instance-type": "i4i.2xlarge",
       "meta-data/placement/region": "us-east-2", "meta-data/mac": MAC + "\n",
       "meta-data/network/interfaces/macs/%s/subnet-id" % MAC: "subnet-0123456789abcdef0",
       "meta-data/network/interfaces/macs/%s/vpc-id" % MAC: "vpc-0123456789abcdef0"}
I4I_NO_INTERFACE = {key: value for key, value in I4I.items() if "/mac" not in key}

ROUTE_TABLE = (
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
    "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n"
    "eth1\t00000000\t010011AC\t0003\t0\t0\t600\t00000000\t0\t0\t0\n"
    "ens5\t00000000\t01001FAC\t0003\t0\t0\t512\t00000000\t0\t0\t0\n"
    "ens5\t00001FAC\t00000000\t0001\t0\t0\t512\t0000FFFF\t0\t0\t0\n")


def main():
    out = os.path.abspath(sys.argv[1])
    stubs = os.path.join(out, "bin")
    write(os.path.join(stubs, "aws"), FAKE_AWS, 0o755)
    write(os.path.join(stubs, "nvme"), FAKE_NVME, 0o755)
    write(os.path.join(stubs, "ethtool"), FAKE_ETHTOOL, 0o755)
    os.environ["PATH"] = stubs + os.pathsep + os.environ["PATH"]
    log = os.path.join(out, "calls.log")
    os.environ["STUB_LOG"] = log
    run = load()
    results = {}

    def calls():
        if not os.path.exists(log):
            return []
        with open(log) as handle:
            lines = handle.read().splitlines()
        os.remove(log)
        return lines

    results["ec2"] = {"sections": run.ec2_sections(FakeImds(I4I)), "calls": calls()}
    os.environ["STUB_REFUSE"] = "1"
    results["ec2_refused"] = {"sections": run.ec2_sections(FakeImds(I4I)), "calls": calls()}
    del os.environ["STUB_REFUSE"]
    results["ec2_no_imds"] = {"sections": run.ec2_sections(FakeImds({})), "calls": calls()}
    results["ec2_no_interface"] = {"sections": run.ec2_sections(FakeImds(I4I_NO_INTERFACE)), "calls": calls()}

    # Taken once, stored once, listed in every dump.
    record = os.path.join(out, "provision.json")
    write(record, '{"schema": "ledgermath.provision/1", "steps": []}\n')
    blobs = run.Blobs(os.path.join(out, "blobs-out"))
    once = run.boot_sections(blobs, FakeImds(I4I), record)
    run.dump_sections = lambda cpuid_tool, imds: {"kernel": {"stub": True}}
    indexes = []
    for _ in range(2):
        index_hash = run.take_dump(blobs, None, FakeImds(I4I), once)
        with open(os.path.join(blobs.directory, index_hash.split(":")[1])) as handle:
            indexes.append(json.load(handle)["sections"])
    with open(os.path.join(blobs.directory, once["provision"].split(":")[1])) as handle:
        provision_section = json.load(handle)
    missing = run.boot_sections(blobs, FakeImds({}), os.path.join(out, "no-such-record.json"))
    with open(os.path.join(blobs.directory, missing["provision"].split(":")[1])) as handle:
        missing_section = json.load(handle)
    results["boot"] = {"once": once, "indexes": indexes, "provision": provision_section, "missing": missing_section,
                       "without_record": sorted(run.boot_sections(blobs, FakeImds({}), None)), "calls": calls()}

    # nvme amzn stats of the Amazon controllers' namespaces only.
    sys_root = os.path.join(out, "sys")
    for controller, model, namespaces in (("nvme0", "Amazon Elastic Block Store              ", ["nvme0n1"]),
                                          ("nvme1", "Amazon EC2 NVMe Instance Storage        ", ["nvme1n1"]),
                                          ("nvme2", "Samsung SSD 990 PRO 2TB", ["nvme2n1"])):
        write(os.path.join(sys_root, "class", "nvme", controller, "model"), model + "\n")
        for namespace in namespaces:
            os.makedirs(os.path.join(sys_root, "class", "nvme", controller, namespace))
    results["nvme"] = {"section": run.nvme_stats(sys_root), "calls": calls()}

    results["xfs"] = run.xfs_mounts(
        "25 1 259:2 / / rw,noatime shared:1 - xfs /dev/nvme0n1p1 rw,attr2\n"
        "26 25 259:4 / /boot/efi rw - vfat /dev/nvme0n1p128 rw\n"
        "40 25 259:1 / /mnt/lm/instance-store rw,relatime shared:5 - xfs /dev/nvme1n1 rw,attr2,inode64\n"
        "41 25 259:1 /sub /mnt/again rw - xfs /dev/nvme1n1 rw\n"
        "42 25 259:7 / /mnt/with\\040space rw - xfs /dev/nvme2n1 rw\n"
        "43 25 0:5 / /tmp rw - tmpfs tmpfs rw\n")

    results["interfaces"] = {"default": run.primary_interface(ROUTE_TABLE), "none": run.primary_interface(ROUTE_TABLE.split("eth1")[0]),
                             "empty": run.primary_interface("")}

    real = load()
    calls()
    # As run.py takes it: after the runner has marked itself not dumpable.
    undumpable = real.mark_not_dumpable()
    sections = real.dump_sections(None, FakeImds({}))
    with open("/proc/net/route") as handle:
        interface = real.primary_interface(handle.read())
    results["dump"] = {"names": sorted(sections), "devices": sorted(k for k in sections["devices"] if k.startswith("$ ")),
                       "kernel_dirty": sorted(k for k in sections["kernel"] if "/proc/sys/vm/dirty" in k),
                       "block_stat": sorted(sections["block_stat"])[:3],
                       "interface": interface, "network": sorted(sections["network"]), "net_counters": sorted(sections["net_counters"]),
                       "ethtool_calls": [line for line in calls() if line.startswith("-")],
                       "not_dumpable": undumpable is None,
                       "process": {key: value is not None for key, value in sections["process"].items()}}
    print(json.dumps(results, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
