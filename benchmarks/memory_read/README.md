# memory_read

How fast a buffer is read front to back. The buffer, 1 GiB in the schedule, holds 64-bit
words; one repetition reads every word once and adds it to a sum. It reads on one
unpinned thread, or on one pinned thread per allowed CPU, each reading its own slice. The
read loop is either a hand-written x86 assembly loop (`scalar`) or AVX2 loads (`avx2`).
The source is `memory_read.c`; the comment at its top lists the same parameters.

```bash
make -C benchmarks/memory_read                      # build/static/memory_read
make -C benchmarks/memory_read BUILD=dynamic        # build/dynamic/memory_read
LM_PARAM_SIZE_BYTES=1073741824 LM_PARAM_THREADS=1 LM_PARAM_PATH=scalar LM_SAMPLES=10 \
  ./benchmarks/memory_read/build/static/memory_read
```

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_SIZE_BYTES` | `1073741824` | Bytes read per repetition; a positive multiple of 8 |
| `LM_PARAM_THREADS` | `1`, `all` | `1` reads on the main thread, unpinned; `all` reads on one pinned thread per allowed CPU |
| `LM_PARAM_PATH` | `scalar`, `avx2` | The read loop: `scalar`, a loop of five x86 instructions written in assembly, or `avx2`, four 32-byte loads per step |

Unset, the variables mean 64 MiB, `1` and `avx2`. Any other value exits 2. `avx2` on a
processor without AVX2 exits 1 and says so.

## Observed

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes the read loops cover in one repetition |
| `threads_used` | Threads that read |
| `path_taken` | The read loop that was dispatched: `scalar` or `avx2` |

## Elision guard

The buffer holds 0, 1, 2 and so on, and one repetition returns the sum of what it read:
0 + 1 + … + (*n* − 1). The program checks that sum before measuring and exits 1 if it is
wrong.

## The two builds, and why their numbers differ

`memory_read` is the one benchmark built two ways in every boot: `static` (the default,
as every benchmark is) and `dynamic`, which loads the C library at run time. Each build has
Series of its own. Both builds run the same read loops: the source is the same, and the
`scalar` loop is the same five instructions in both binaries.

**What the scheduled Runs show.** Over 604 pairs of Runs in the same boot, from 151 boots
between 2026-11-10 and 2026-11-18 (the median of the per-boot ratio), the dynamic build
is faster on the `scalar` path:

| Instance type | Processor | One thread | All threads |
|---|---|---|---|
| `m5.large` | Intel Cascade Lake | 15.1% | 13.7% |
| `i4i.2xlarge` | Intel Ice Lake | 4.6% | 13.7% |
| `c6i.8xlarge` | Intel Ice Lake | 8.5% | 1.3% |
| `c8i.2xlarge` | Intel Granite Rapids | none | none |
| `c8a.2xlarge` | AMD Zen 5 | none | none |

There is no difference on the `avx2` path on any type (within 0.25%).

**What the difference is.** It is not static against dynamic linking. It is where the
`scalar` loop lands in the binary. The loop is 15 bytes long, and code, like data, sits in
memory in 64-byte lines. `m5.large`, `i4i.2xlarge` and `c6i.8xlarge` build the same bytes.
In their static binary the loop starts 56 bytes into a line, so it crosses into the next
line. In their dynamic binary it starts 24 bytes into a line and stays inside it. On the
Intel processors of these three types, a loop that crosses a line runs slower. The two builds put the loop in
different places only because the static binary carries about 1.3 KB of the C library's
code ahead of the benchmark's own.

**What it is not.** It does not show that dynamic linking is faster, or that a program
linked statically gives up speed. Linking only moved the loop. Another compiler, a change
to the harness or a longer source file would move it again, and could make the static
build the fast one. Each build's number is the number of that binary, with the loop where
that binary has it.

**How it was shown.** An investigation on 2026-11-23 and 2026-11-24 (issue #84) moved the
loop inside the exact binaries that ran, changing one 4-byte address in `main` and nothing
else. These were one-off measurements on boxes started by hand, not Runs of the schedule:
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

With a buffer small enough to stay in the processor's fastest cache, so that memory does
not hide it, the loop that crosses a line loses 38 to 44% of its speed on `m5.large` and
a third on `c6i.8xlarge`. From memory less of it shows, because the loop also waits for
memory. That is likely why the gap is small on `c6i.8xlarge` with all threads, where each
thread waits most; this reading was not tested on its own.

`c8i.2xlarge` and `c8a.2xlarge` barely care. On `c8i.2xlarge` the compiler builds other
bytes and neither build's loop crosses a line. On `c8a.2xlarge` the static loop crosses a
line just as on the Intel types, and it makes no difference. Moved across a line on real
boxes of both types, the loop lost about 1% from the fastest cache and nothing measurable
from memory.

Why these processors are slower when the loop crosses a line is not measured: the
machines expose no performance counters.

**What would remove it, and the decision.** Aligning the loop to the start of a 64-byte
line (`.p2align 6` before it) would put it in the same place in both builds. On a real
`m5.large`, built that way, both builds were equal and fast: 10.13 GB/s static and 10.08
dynamic, against 8.86 and 10.12 for the builds as they are (one thread, five rounds; this
box gave lower numbers than the one above for the same binary, with a gap of the same
size). The maintainer decided on 2026-11-25 (issue #84) to document the finding and leave
the benchmark and its build as they are, for now: no alignment of the loop, no new fact
recorded about the build, no scheduled check of where code lands. The two Series stay as
they are, and so does the difference between them.

## Differences from July's version

The hot loops are the ones the July 2026 proof of concept ran, unchanged. July's binary
was linked dynamically; the `static` build is not, and the `dynamic` build is, as July's
was. What is common to every port (the event stream, the harness's samples) is in
`benchmarks/memory_write/README.md`, under the same heading.
