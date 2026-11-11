# memory_read_random

How fast one core reads a large buffer in random order. The buffer, 1 GiB by default, is
divided into 64-byte elements, one cache line each. One repetition reads the first 8
bytes of every element once, in an order shuffled once at startup from a fixed seed, and
sums them.

The reads do not depend on one another, so the core may have many cache misses in flight
at once. This is the throughput of random reads, not the latency of one: divide a
repetition's time by `reads_per_repetition` for the time per read at that throughput.

```bash
make -C benchmarks/memory_read_random              # build/static/memory_read_random
LM_PARAM_SIZE_BYTES=1073741824 LM_PARAM_THREADS=1 LM_SAMPLES=10 \
  ./benchmarks/memory_read_random/build/static/memory_read_random
```

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_SIZE_BYTES` | `1073741824` | Bytes of the buffer; a multiple of 64, at least 128 |
| `LM_PARAM_THREADS` | `1` | `1` reads on the main thread, unpinned. The only value implemented; any other exits 2 |

`--quick` uses 64 MiB when `LM_PARAM_SIZE_BYTES` is unset, which may fit in a large
processor cache.

## Observed

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes of the elements one repetition reads from: 64 per read, the cache line the read brings in |
| `reads_per_repetition` | Elements one repetition reads, each exactly once |
| `threads_used` | Threads that read: 1 |

The program also holds the shuffled order: 8 bytes per element (128 MiB for 1 GiB),
read front to back during each repetition. Its peak memory is about 1.13 GiB.

## Elision guard

One repetition returns the sum of the words it read. Element *i*'s first word is *i*, so
the sum of one pass is 0 + 1 + … + (*n* − 1); the program checks that before measuring
and exits 1 if it is wrong.

## Differences from July's version

July's is `benchmarks/c/bench_memory_read_random.c`, variant `1 thread`.

- **The same measured work.** The read loop, the element layout, the shuffle, its seed
  and the `madvise` hints (`MADV_RANDOM` on the data, `MADV_SEQUENTIAL` on the order) are
  unchanged. Built by the same compiler with the same flags (checked with gcc 11.5, `-march=native`, on an Ice Lake Xeon), the read loop's machine code
  is identical to July's.
- **The buffer size and the thread count are parameters** (`size_bytes`, `threads`). They
  were constants, 1 GiB and one thread. July's `--quick` size was 512 MiB; it is now
  64 MiB.
- **What is common to every port:** the output is the event stream
  (`docs/dev-log.md` section 2) instead of July's JSON record, whose `median_ns` is now
  the Method's median of each sample's time over its repetitions, and whose
  `bytes_per_op` is now `bytes_per_repetition`. The binary is linked statically; July's
  was dynamic. The harness takes samples the way July's did (one repetition, then
  doubling until a sample lasts a second, then the counted samples at that count), but
  emits the warmup samples July discarded, and takes the count of counted samples from
  `LM_SAMPLES`.
