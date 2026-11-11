# Sample Runs

Directories laid out like a `-runs` stage's bucket (`runs/`, `blobs/sha256/`,
`boots/`), used by `tests/schemas.test.ts` and readable as examples of the record. The
first three below were recorded by `tests/samples/record.sh` on 2026-11-10 from commit `fc12694`,
the commit before the one that added them, in `amazonlinux:2023.12.20260710.0`.

| Directory | What it holds | How it was recorded |
|---|---|---|
| `scheduled/` | 8 Runs: the four `memory_read` parameter sets of `schedule.json`, each under the static and the dynamic build, all exiting 0 | `scripts/box-in-container/run.sh --scenario ok`: `runner/box.sh` booted as user-data |
| `interrupted/` | A boot whose runner was sent TERM while its second binary ran: one complete Run, one Run of the interrupted execution (`"exit": {"signal": 9, "runner_signal": 15}`), and a boot summary with `stopped_by` and the six executions it did not start under `not_run` | `scripts/box-in-container/run.sh --scenario terminated` |
| `failures/` | 2 failed executions, which are Runs like any other: one killed by the runner's timeout (`"exit": {"signal": 9, "timeout_seconds": 1}`), one the binary refused with exit status 2 (`path: "sse"`) | `runner/run.py` with `failures/schedule.json`, in the same container, called as `box.sh` calls it |

They are full runs (10 samples, 1 GiB), not `--quick`. Their numbers measure a container
on a development machine; they are examples of the record, not data.

## They describe the dev machine, not a runner

They were recorded in a container on the development machine, an `m6id.xlarge` in
`us-east-2a`. A container shares the host's kernel and CPU, its `/proc` and `/sys` are
the host's, and the instance metadata service answered for the host. So the `provider`
block, the cpuid, cpuinfo, kernel and device sections, and the instance identity document
describe that machine. The packages section and the compiler (`gcc 11.5.0`,
`glibc-static 2.34`, Python 3.9.25) are the container's, from the pinned image's release.
The container starts with fewer packages than the image, so the packages section lists
fewer than a box's will.

## What was changed after recording

`tests/samples/prepare.ts` made these directories from the recorded bucket. It changed
two things and nothing else.

### 1. Every field that identifies the machine or the account

Each of these fields was replaced with the example value beside it, wherever its value
appeared. `tests/samples/identifying.ts` defines the list, and the test asserts that every
one of these fields, in every sample blob, holds its example value.

| Field | Where | Example value |
|---|---|---|
| `provider.instance_id` | every Run and boot summary | `i-0123456789abcdef0` (AWS's documentation example) |
| `provider.image_id` | every Run and boot summary | `ami-0123456789abcdef0` (AWS's documentation example) |
| `meta-data/instance-id` | dump section `provider` | `i-0123456789abcdef0` |
| `meta-data/ami-id` | dump section `provider` | `ami-0123456789abcdef0` |
| `accountId` | `provider`, instance identity document | `123456789012` (AWS's documentation example) |
| `instanceId` | `provider`, instance identity document | `i-0123456789abcdef0` |
| `imageId` | `provider`, instance identity document | `ami-0123456789abcdef0` |
| `privateIp` | `provider`, instance identity document | `192.0.2.10` (RFC 5737 documentation address) |
| `pendingTime` | `provider`, instance identity document | `2026-01-01T00:00:00Z` |
| `billingProducts`, `devpayProductCodes`, `marketplaceProductCodes`, `kernelId`, `ramdiskId` | `provider`, instance identity document | must be `null`, which they are; `prepare.ts` refuses a recording where they are not |
| the host name in `uname -a` | dump section `kernel` | `ip-192-0-2-10`; the container is started with this name |
| UUIDs on `/proc/cmdline` (`root=PARTUUID=…`) | dump section `kernel` | `01234567-89ab-cdef-0123-456789abcdef` |
| `/sys/class/nvme/nvme*/serial` | dump section `devices` | `vol0123456789abcdef0` for an EBS volume, `AWS0123456789ABCDEF0` for any other device |
| `serial` of every device in `lsblk -J` | dump section `devices` | the same |
| `wwn` in `lsblk -J` | dump section `devices` | must be absent; `run.py` does not ask for it, and reads no `wwid` file |
| docker container IDs in `findmnt -J` mount sources | dump section `devices` | `0123456789abcdef` four times |
| any MAC address | anywhere | `00:00:5e:00:53:01` (RFC 7042 documentation address); none was recorded |
| any private IPv4 address, or EC2 host name `ip-a-b-c-d` | anywhere | `192.0.2.10`, `ip-192-0-2-10` |
| any instance, image or volume ID | anywhere | the examples above |

Every blob whose bytes changed was renamed to its new hash, and the new hash replaced the
old one wherever it was cited, up through the dump indexes to the Runs. So the files are
schema-valid and every hash still resolves, but those blobs are not byte-for-byte what the
box wrote.

Not replaced, and why: the boot ID (a random number the kernel draws at every boot); the
region, zone, zone ID and instance type (the provider's words for where it ran, shared
with every instance there); kernel and package versions; the processor's cpuid, cpuinfo
and microcode (they name the processor model, not this machine); and the `/tmp` paths of
the test's own mounts.

### 2. Omitted blobs

The benchmark binaries (the static one is 1.2 MB) and the source archive are not
committed. `omitted-blobs.json` lists each with its size. The source archive can be
rebuilt: `git archive --format=tar.gz fc12694 | sha256sum` prints
`47e2fbfd596df3359e093ba5ee3fff2b3fd6304b028b3468c8391b81a0626e5c` with git 2.43. Without
it, `scripts/check-runs.ts` cannot check the runner manifests, and says so.

## `service/`: an entry that measures a Service

`service/` holds 3 Runs of a boot whose schedule (`service/schedule.json`) has an entry
naming the `s3_fixtures` Service. It shows the record's `service` object: the endpoint and
Region delivered by value, the three keys by name only. It was made by
`python3 tests/service-runs.py keys DIR` on 2026-11-11, and `DIR/out/{runs,blobs,boots}`
copied here unchanged:

- the benchmark is a stand-in, a shell script that prints a valid stream naming the
  `LM_SERVICE_*` variables it got;
- the keys came from a stand-in `aws` CLI and are not credentials; the test asserts that
  no file here holds one, in any of the forms `scripts/lib/secret-search.ts` looks for;
- the dump, the EC2 API and IMDS were stubbed, so the dumps hold a stub section and the
  provider fields are the documentation's example ids;
- the source archive is the stand-in tree's, so the runner manifests check out.

It describes no machine. Re-record it with the same command and copy, when `runner/run.py`
changes what such a Run holds.

## Re-recording

```bash
sg docker -c tests/samples/record.sh   # about ten minutes, from HEAD
```

Commit the result on top of the commit it was recorded from, and update the commit and
hash above.
