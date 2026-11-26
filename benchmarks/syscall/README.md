# syscall

The cost of one call into the kernel on one thread (`getpid`, `getrusage`, `stat`), beside
`gettimeofday`, which the vDSO normally answers without entering the kernel.

## What a figure means

The cost of one call into the kernel, beside one the C library answers without entering
it. One repetition makes one call:

| `call` | What one repetition does |
|---|---|
| `getpid` | `syscall(SYS_getpid)`: enters the kernel every time, where `getpid()` may not |
| `gettimeofday` | `gettimeofday()`: answered in user space by the vDSO, normally without entering the kernel |
| `getrusage` | `getrusage(RUSAGE_SELF)` |
| `stat` | `stat()` of `LM_PARAM_PATH` |

A Run's figure is the time of one repetition, in nanoseconds (`time_per_repetition_ns`):
the median, over the Run's counted samples, of a sample's time divided by its repetitions.
The binary reads the clock only at the two edges of a sample. Before the counted samples
it runs warmup samples, doubling the repetitions until a sample lasts at least a second;
each of the 10 counted samples the schedule asks for then runs that many repetitions. The
binary observes no `bytes_per_repetition`, so no bytes per second is derived. A Series
gives the 5th, 50th and 95th percentiles of its counted Runs' figures
([Methods](https://ledgermath.com/docs/methods)).

So a figure is the time of one call, made again and again by one thread, on one instance
type.

## What a figure does not show

- `gettimeofday` normally does not enter the kernel, and whether it did is not observed:
  the clock source in the Run's dump section `kernel` decides it.
- Every repetition stats the same path. The cost of `stat` depends on the file system
  that answers it, which `path_fs_type` records.
- The binary is linked statically, which changes how `gettimeofday` is reached; it can
  cost a dynamically linked program less (see "Findings").

## Parameters

Each parameter set runs on every instance type in the schedule. Each parameter set and
instance type is a Series of its own.

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_CALL` | `getpid`, `gettimeofday`, `getrusage`, `stat` | The call one repetition makes |
| `LM_PARAM_PATH` | `/tmp`, with `stat` only | The path `stat()` is given. Read only when the call is `stat` |

`--quick` uses `getpid`, and `/tmp` for `stat`, when the variables are unset.

## Observed values

| Key | What it is |
|---|---|
| `call_made` | The call the measured loop makes |
| `path_fs_type` | With `stat` only: `statfs()`'s `f_type` for the path, in hex. `0x1021994` is tmpfs, `0x58465342` XFS, `0xef53` ext4, `0x794c7630` overlayfs. The cost of `stat()` depends on the filesystem that answers it |

Whether `gettimeofday` went through the vDSO is not observed by the binary; the dump's
clock source (`current_clocksource`) is what decides it.

## Findings

The binary is linked statically. Static glibc 2.34 still answers `gettimeofday` through
the vDSO, but through a wrapper that loads the vDSO function's address and calls it, where
a dynamic binary's `gettimeofday` resolves to the vDSO function itself. Against a
dynamically linked binary making the same calls, `gettimeofday` measured 2.4% slower on an
idle machine and 10% slower on a busy one; the measurements are in
[`docs/dev-log.md`](../../docs/dev-log.md), section 8, under `syscall`.

## How it works

### Elision guard

Each repetition adds a field of what its call returned (the pid; the seconds and
microseconds; user time, system time and minor faults; the inode and size) to a running
sum, which it returns. A call that fails exits 1, naming the call and the error.

## Building and testing

```bash
make -C benchmarks/syscall                         # build/static/syscall
LM_PARAM_CALL=stat LM_PARAM_PATH=/tmp LM_SAMPLES=10 ./benchmarks/syscall/build/static/syscall
```
