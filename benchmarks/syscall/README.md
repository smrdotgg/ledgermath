# syscall

The cost of one call into the kernel, beside one the C library answers without entering
it. One repetition makes one call:

| `call` | What one repetition does |
|---|---|
| `getpid` | `syscall(SYS_getpid)`: enters the kernel every time, where `getpid()` may not |
| `gettimeofday` | `gettimeofday()`: answered in user space by the vDSO, normally without entering the kernel |
| `getrusage` | `getrusage(RUSAGE_SELF)` |
| `stat` | `stat()` of `LM_PARAM_PATH` |

```bash
make -C benchmarks/syscall                         # build/static/syscall
LM_PARAM_CALL=stat LM_PARAM_PATH=/tmp LM_SAMPLES=10 ./benchmarks/syscall/build/static/syscall
```

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_CALL` | `getpid`, `gettimeofday`, `getrusage`, `stat` | The call one repetition makes |
| `LM_PARAM_PATH` | `/tmp`, with `stat` only | The path `stat()` is given. Read only when the call is `stat` |

`--quick` uses `getpid`, and `/tmp` for `stat`, when the variables are unset.

## Observed

| Key | What it is |
|---|---|
| `call_made` | The call the measured loop makes |
| `path_fs_type` | With `stat` only: `statfs()`'s `f_type` for the path, in hex. `0x1021994` is tmpfs, `0x58465342` XFS, `0xef53` ext4, `0x794c7630` overlayfs. The cost of `stat()` depends on the filesystem that answers it |

Whether `gettimeofday` went through the vDSO is not observed by the binary; the dump's
clock source (`current_clocksource`) is what decides it.

## Elision guard

Each repetition adds a field of what its call returned (the pid; the seconds and
microseconds; user time, system time and minor faults; the inode and size) to a running
sum, which it returns. A call that fails exits 1, naming the call and the error.

## Differences from July's version

July's is `benchmarks/c/bench_syscall.c`, variants `getpid`, `gettimeofday`, `getrusage`
and `stat`.

- **The same calls.** Each call and the field it adds to the sum are unchanged. Built by
  the same compiler with the same flags (checked with gcc 11.5, `-march=native`, on an
  Ice Lake Xeon), the four functions differ from July's only in their error paths (which
  now name the error) and, for `getpid`, in the stack frame around the call: one or two
  instructions beside a call into the kernel.
- **One call per process.** July measured the four in one process, in that order. Each is
  now its own execution, chosen by `call`.
- **The path `stat()` is given is a parameter** (`path`), so the Run says which path was
  measured, and the filesystem behind it is observed. July's was the constant `/tmp`, the
  scheduled value. The measured function now loads the path from memory instead of using
  a constant address: one load beside the system call.
- **Static linking moves two of the numbers slightly.** Static glibc 2.34 still answers
  `gettimeofday` through the vDSO, but through a wrapper that loads the vDSO function's
  address and calls it, where a dynamic binary's `gettimeofday` resolves to the vDSO
  function itself. And `syscall()` is now called directly, where July's dynamic binary
  called it through the PLT. On the development machine (Ice Lake, gcc 11.5), July's and
  this binary run back to back gave `gettimeofday` 21.0 ns against July's 20.5 ns, and
  `getpid` 106.3 ns against July's 108.4 ns (the fastest sample of several runs each).
  `getrusage` and `stat` agreed within 0.2%.
- **What is common to every port:** the output is the event stream
  (`docs/dev-log.md` section 2) instead of July's JSON record, whose `median_ns` is now
  the Method's median of each sample's time over its repetitions. The binary is linked
  statically; July's was dynamic. The harness takes samples the way July's did (one
  repetition, then doubling until a sample lasts a second, then the counted samples at
  that count), but emits the warmup samples July discarded, and takes the count of
  counted samples from `LM_SAMPLES`.
