# memory_read_random

How fast one thread reads a buffer in random order: the first word of every 64-byte
element, in a shuffled order, with reads that do not depend on one another, so that many
cache misses can be in flight at once. It is the throughput of random reads, not the
latency of one.

## What a figure means

How fast one core reads a large buffer in random order. The buffer, 1 GiB by default, is
divided into 64-byte elements, one cache line each. One repetition reads the first 8
bytes of every element once, in an order shuffled once at startup from a fixed seed, and
sums them.

The reads do not depend on one another, so the core may have many cache misses in flight
at once. This is the throughput of random reads, not the latency of one: divide a
repetition's time by `reads_per_repetition` for the time per read at that throughput.

Each Run that Method `series` v1 counts gives one figure, the time of one repetition in
nanoseconds (`time_per_repetition_ns`): the median, over the Run's counted samples, of a
sample's time divided by its repetitions. A Run it does not count gives none. The harness
reads the clock once at each edge of a sample, around the whole loop of its repetitions,
and never inside that loop. Before the counted samples it runs warmup samples, doubling the
repetitions until a sample lasts at least a second; each of the 10 counted samples the
schedule asks for then runs that many repetitions. Bytes per second (`bytes_per_second`)
is `bytes_per_repetition` × 10^9 divided by the time per repetition, where
`bytes_per_repetition` is 64 bytes for every element read, the element each read lands
in, not the 8 bytes the thread uses. A Series gives the 5th, 50th and 95th percentiles of
its counted Runs' figures ([Methods](https://ledgermath.com/docs/methods)).

So a figure is the time one thread takes to read every element of `size_bytes` once, in
random order, on one instance type.

## What a figure does not show

- It is not the latency of one read. Each read's address comes from the shuffled order,
  not from the read before it, so the reads can overlap; nothing records whether they did.
- Each repetition also reads the shuffled order front to back, 8 bytes per element.
- Bytes per second counts the 64 bytes of every element the loop reads from, of which the
  thread uses 8. Nothing measures the traffic to memory, and nothing requires a read to
  miss the cache: a buffer and order array small enough for a cache can be served from it.
  The Run's dump sections `lscpu` and `sys_cpu` record the cache sizes.

## Parameters

The parameter set runs on every instance type in the schedule. Each instance type is a
Series of its own.

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_SIZE_BYTES` | `1073741824` | Bytes of the buffer; a multiple of 64, at least 128 |
| `LM_PARAM_THREADS` | `1` | `1` reads on the main thread, unpinned. The only value implemented; any other exits 2 |

`--quick` uses 64 MiB when `LM_PARAM_SIZE_BYTES` is unset, which may fit in a large
processor cache.

## Observed values

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes of the elements one repetition reads from: 64 per read, the cache line the read brings in |
| `reads_per_repetition` | Elements one repetition reads, each exactly once |
| `threads_used` | Threads that read: 1 |

The program also holds the shuffled order: 8 bytes per element (128 MiB for 1 GiB),
read front to back during each repetition. Its peak memory is about 1.13 GiB.

## Findings

No finding of its own so far.

## How it works

### Elision guard

One repetition returns the sum of the words it read. Element *i*'s first word is *i*, so
the sum of one pass is 0 + 1 + … + (*n* − 1); the program checks that before measuring
and exits 1 if it is wrong.

## Building and testing

```bash
make -C benchmarks/memory_read_random              # build/static/memory_read_random
LM_PARAM_SIZE_BYTES=1073741824 LM_PARAM_THREADS=1 LM_SAMPLES=10 \
  ./benchmarks/memory_read_random/build/static/memory_read_random
```
