# memory_read

How fast a buffer of 64-bit words is read front to back and summed, on one unpinned thread
or on one pinned thread per allowed CPU, with a hand-written x86 scalar loop or with AVX2
loads. Whether the buffer comes from memory or from cache depends on its size and the
machine.

## What a figure means

How fast a buffer is read front to back. The buffer, 1 GiB in the schedule, holds 64-bit
words; one repetition reads every word once and adds it to a sum. It reads on one
unpinned thread, or on one pinned thread per allowed CPU, each reading its own slice. The
read loop is either a hand-written x86 assembly loop (`scalar`) or AVX2 loads (`avx2`).
The source is `memory_read.c`; the comment at its top lists the same parameters.

With `threads` `all`, a repetition ends once every thread has read its slice and the main
thread has added up their sums: the main thread releases the threads at one barrier, waits
at another until all of them are done, and adds up their sums. The measured time includes that synchronisation and that sum.

Each Run that Method `series` v1 counts gives one figure, the time of one repetition in
nanoseconds (`time_per_repetition_ns`): the median, over the Run's counted samples, of a
sample's time divided by its repetitions. A Run it does not count gives none. The harness
reads the clock once at each edge of a sample, around the whole loop of its repetitions,
and never inside that loop. Before the counted samples it runs warmup samples, doubling the
repetitions until a sample lasts at least a second; each of the 10 counted samples the
schedule asks for then runs that many repetitions. Bytes per second (`bytes_per_second`) is `bytes_per_repetition` × 10^9 divided by the time
per repetition, where `bytes_per_repetition` is the bytes read in one repetition, by all
threads together. A Series gives the 5th, 50th and 95th percentiles of its counted Runs'
figures ([Methods](https://ledgermath.com/docs/methods)).

So a figure is the time one build of this binary takes to read `size_bytes` once, with one
read loop, on one thread or on all allowed CPUs, on one instance type.

## What a figure does not show

- Whether the buffer is read from memory or from cache depends on `size_bytes` and on the
  machine's caches. A size that fits in a cache gives a cache figure, not a memory figure.
  The Run's dump sections `lscpu` and `sys_cpu` record the cache sizes.
- `threads` `1` is one unpinned thread: it is not what the whole box can read.
- The figure is of these two loops. A program that reads memory with other code is not
  measured here.
- The two builds have given different figures on the `scalar` path on some Intel instance
  types. The investigation of the difference found its cause in where the loop lands in
  each binary, not in how they are linked. A difference between them does not show that
  dynamic linking is faster; see "The two builds, and why their numbers differ" below.

## Parameters

Each parameter set runs on every instance type in the schedule, in both builds, `static`
and `dynamic`. Each parameter set, build and instance type is a Series of its own.

The benchmark's Series and their figures are listed at
[https://api.ledgermath.com/v1/benchmarks/memory_read.json](https://api.ledgermath.com/v1/benchmarks/memory_read.json),
which says in `left_out` how many it leaves out.

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_SIZE_BYTES` | `1073741824` | Bytes read per repetition; a positive multiple of 8 |
| `LM_PARAM_THREADS` | `1`, `all` | `1` reads on the main thread, unpinned; `all` reads on one pinned thread per allowed CPU |
| `LM_PARAM_PATH` | `scalar`, `avx2` | The read loop: `scalar`, a loop of five x86 instructions written in assembly, or `avx2`, four 32-byte loads per step |

Unset, the variables mean 64 MiB, `1` and `avx2`. Any positive multiple of 8 is accepted as
a size, with at least one 8-byte word per allowed CPU when `threads` is `all`; `threads`
takes only `1` or `all`, and `path` only `scalar` or `avx2`. Anything else exits 2. `avx2`
on a processor without AVX2 exits 1 and says so.

## Observed values

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes the read loops cover in one repetition |
| `threads_used` | Threads that read |
| `path_taken` | The read loop that was dispatched: `scalar` or `avx2` |

## Findings

### The two builds, and why their numbers differ

`memory_read` is the one benchmark built two ways in every boot: `static` (the default,
as every benchmark is) and `dynamic`, which loads the C library at run time. Each build has
Series of its own. Both builds run the same read loops: the source is the same, and the
`scalar` loop is the same five instructions in both binaries.

**What the Runs recorded up to the check of 2026-11-18 show.** That check (issue #38,
check 5) paired every counted `memory_read` Run with the other build's Run in the same
boot: 604 pairs from 151 boots between 2026-11-10 and 2026-11-18. Most of those boots were
started by the schedule; some, the first ones among them, were started by hand. The table gives,
for the `scalar` path, the median over the boots of how much faster the dynamic build was
than the static one in the same boot:

| Instance type | Processor | One thread | All threads |
|---|---|---|---|
| `m5.large` | Intel Cascade Lake | 15.1% | 13.7% |
| `i4i.2xlarge` | Intel Ice Lake | 4.6% | 13.7% |
| `c6i.8xlarge` | Intel Ice Lake | 8.5% | 1.3% |
| `c8i.2xlarge` | Intel Granite Rapids | −0.5% | 0.0% |
| `c8a.2xlarge` | AMD Zen 5 | 0.0% | 0.0% |

On `m5.large`, `i4i.2xlarge` and `c6i.8xlarge` the dynamic build was faster in nearly
every boot. On `c8i.2xlarge` and `c8a.2xlarge` neither build had a consistent advantage:
the dynamic build was faster in 11 to 16 of the 29 or 30 boots. On the `avx2` path the medians were
between −0.07% and +0.23% on every type and thread count: no difference.

**What the difference is.** It is not static against dynamic linking. It is where the
`scalar` loop lands in the binary. The loop is 15 bytes long, and code, like data, sits in
memory in 64-byte lines. `m5.large`, `i4i.2xlarge` and `c6i.8xlarge` build the same bytes.
In their static binary the loop starts 56 bytes into a line, so it crosses into the next
line. In their dynamic binary it starts 24 bytes into a line and stays inside it. On the
Intel processors of these three types, this loop ran slower when it crossed a line. The
two builds put the loop in different places only because the static binary carries about
1.3 KB of rarely run code from the C library (glibc) and GCC's runtime library (libgcc)
ahead of the benchmark's own code.

**What it is not.** It does not show that dynamic linking is faster, or that a program
linked statically gives up speed. For this loop, linking only moved it. Another compiler,
a change to the harness or a longer source file can move it again, and could make the
static build the fast one. What was tested is this one loop on these processors, not
other loops or every change to come. Each build's number is the number of that binary,
with the loop where that binary has it.

**How it was shown.** An investigation on 2026-11-23 and 2026-11-24 (issue #84) took the
exact binaries that ran. In each, it copied the whole 24-byte scalar function, which holds
the loop, into the body of the AVX2 function, which a `scalar` run never executes, at a
chosen offset in a 64-byte line. Then it changed the 4-byte address in `main` that names
the scalar function, so that `main` calls the copy. The loop's instructions stayed the
same, and apart from the copy and that address every byte of the file stayed as it was:
what ran was the same, only where it sits moved.
These were one-off measurements on boxes started by hand, not Runs of the pipeline:
1 GiB, `scalar`, the builds taken in turn within one boot, the median of five rounds (four
for all threads). Figures in GB/s:

| Box | static (loop at 56) | dynamic (24) | static, loop moved to 24 | dynamic, loop moved to 56 |
|---|---|---|---|---|
| `m5.large`, one thread | 9.88 | 11.99 | 11.98 | 10.03 |
| `m5.large`, all threads | 11.58 | 13.42 | 13.47 | 11.57 |
| `i4i.2xlarge`, one thread | 10.73 | 11.47 | 11.40 | 10.74 |
| `i4i.2xlarge`, all threads | 47.89 | 54.11 | 54.20 | 47.74 |
| `c6i.8xlarge`, all threads | 137.12 | 138.70 | 138.95 | 137.14 |

The static binary with its loop moved is as fast as the dynamic one, and the dynamic
binary with its loop moved is as slow as the static one. Moving the loop to another
address with the same offset in its line changed nothing. On `c6i.8xlarge` with one
thread, all 15 runs with the loop at 24 were faster than all 15 with it at 56.

With a buffer small enough to stay in the processor's fastest cache (16 KiB, one thread),
so that memory does not hide it, the loop that crosses a line lost 38 to 44% of its speed
on `m5.large` and a third on `c6i.8xlarge`. From memory less of it shows, because the loop also waits for
memory. That is likely why the gap is small on `c6i.8xlarge` with all threads, where each
thread waits most; this reading was not tested on its own.

`c8i.2xlarge` and `c8a.2xlarge` barely care. On `c8i.2xlarge` the compiler builds other
bytes and neither build's loop crosses a line. On `c8a.2xlarge` the static loop crosses a
line just as on the Intel types, and it makes no difference. Moved across a line on real
boxes of both types, with one thread, the loop lost about 1% from the fastest cache and
nothing measurable from memory.

Why these processors are slower when the loop crosses a line is not measured: the
machines expose no performance counters.

**What would remove it, and the decision.** Aligning the loop to the start of a 64-byte
line (`.p2align 6` before it) would put it in the same place in both builds. On a real
`m5.large`, built that way, both builds were equal and fast: 10.13 GB/s static and 10.08
dynamic, against 8.86 and 10.12 for the builds as they are (1 GiB read from memory, one
thread, five rounds). This box gave lower numbers than the one above for the same static
binary, 8.86 against 9.88 GB/s, and a smaller gap between the builds as they are, in the
same direction: the dynamic build was 13.4% faster there, against 21.0% on the first box
(each the investigation's median of the per-round ratios). The maintainer decided on 2026-11-25 (issue #84) to document the finding and leave
the benchmark and its build as they are, for now: no alignment of the loop, no new fact
recorded about the build, no scheduled check of where code lands. The two Series stay as
they are, and so does the difference between them.

## How it works

### Sum check

The buffer holds 0, 1, 2 and so on, and one repetition returns the sum of what it read:
0 + 1 + … + (*n* − 1). The program checks that sum before measuring and exits 1 if it is
wrong.

## Building and testing

```bash
make -C benchmarks/memory_read                      # build/static/memory_read
make -C benchmarks/memory_read BUILD=dynamic        # build/dynamic/memory_read
LM_PARAM_SIZE_BYTES=1073741824 LM_PARAM_THREADS=1 LM_PARAM_PATH=scalar LM_SAMPLES=10 \
  ./benchmarks/memory_read/build/static/memory_read
```
