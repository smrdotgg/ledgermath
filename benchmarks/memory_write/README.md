# memory_write

How fast one thread writes a buffer, front to back or in random order, one 64-byte element
at a time: two 32-byte AVX2 stores, then a read of the element's last word.

## What a figure means

How fast one core writes a large buffer, front to back or in random order. The buffer,
1 GiB by default, is divided into 64-byte elements, one cache line each. One repetition
writes every element once: two 32-byte AVX2 stores of the element's index, then a
volatile read of its last word. `sequential` writes the elements in order; `random`
writes them in an order shuffled once at startup from a fixed seed.

Each Run that Method `series` v1 counts gives one figure, the time of one repetition in
nanoseconds (`time_per_repetition_ns`): the median, over the Run's counted samples, of a
sample's time divided by its repetitions. A Run it does not count gives none. The harness
reads the clock once at each edge of a sample, around the whole loop of its repetitions,
and never inside that loop. Before the counted samples it runs warmup samples, doubling the
repetitions until a sample lasts at least a second; each of the 10 counted samples the
schedule asks for then runs that many repetitions. Bytes per second (`bytes_per_second`)
is `bytes_per_repetition` × 10^9 divided by the time per repetition, where
`bytes_per_repetition` is the bytes of the elements the loop writes in one repetition. A
Series gives the 5th, 50th and 95th percentiles of its counted Runs' figures
([Methods](https://ledgermath.com/docs/methods)).

So a figure is the time one thread takes to write every element of `size_bytes` once, in
one order, on one instance type.

## What a figure does not show

- Each element's last 8-byte word is read back right after the element is written, so a
  repetition is not stores alone.
- The stores are ordinary AVX2 stores, not non-temporal ones.
- `random` also reads the shuffled order front to back, 8 bytes per element, during each
  repetition.
- Bytes per second counts the bytes of the elements the loop writes. Nothing measures the
  traffic to memory, and nothing requires a write to miss the cache: a buffer, and with
  `random` its order array, small enough for a cache can be served from it. The Run's dump
  sections `lscpu` and `sys_cpu` record the cache sizes.

## Parameters

Each parameter set runs on every instance type in the schedule. Each parameter set and
instance type is a Series of its own.

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_SIZE_BYTES` | `1073741824` | Bytes written per repetition; a multiple of 64, at least 128 |
| `LM_PARAM_THREADS` | `1` | `1` writes on the main thread, unpinned. The only value implemented; any other exits 2 |
| `LM_PARAM_ORDER` | `sequential`, `random` | The order the elements are written in |

`--quick` uses 64 MiB, `sequential`, when the variables are unset. The write loops use
AVX2; on a processor without it the program exits 1 and says so.

## Observed values

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes the write loop covers in one repetition |
| `threads_used` | Threads that wrote: 1 |
| `order_taken` | The write loop that was dispatched: `sequential` or `random` |

`random` also holds the shuffled order, 8 bytes per element (128 MiB for 1 GiB), read
front to back during each repetition. Peak memory is about 1.0 GiB for `sequential` and
1.13 GiB for `random`.

## Findings

No finding of its own so far.

## How it works

### Elision guard

Each element's last word is read back through a volatile load right after it is
written, and one repetition returns the sum of those words: 0 + 1 + … + (*n* − 1). The
program checks that sum before measuring and exits 1 if it is wrong; `random` also exits
1 if the shuffled order came out unshuffled.

## Building and testing

```bash
make -C benchmarks/memory_write                    # build/static/memory_write
LM_PARAM_SIZE_BYTES=1073741824 LM_PARAM_THREADS=1 LM_PARAM_ORDER=random LM_SAMPLES=10 \
  ./benchmarks/memory_write/build/static/memory_write
```
