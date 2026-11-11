# memory_write

How fast one core writes a large buffer, front to back or in random order. The buffer,
1 GiB by default, is divided into 64-byte elements, one cache line each. One repetition
writes every element once: two 32-byte AVX2 stores of the element's index, then a
volatile read of its last word. `sequential` writes the elements in order; `random`
writes them in an order shuffled once at startup from a fixed seed.

```bash
make -C benchmarks/memory_write                    # build/static/memory_write
LM_PARAM_SIZE_BYTES=1073741824 LM_PARAM_THREADS=1 LM_PARAM_ORDER=random LM_SAMPLES=10 \
  ./benchmarks/memory_write/build/static/memory_write
```

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_SIZE_BYTES` | `1073741824` | Bytes written per repetition; a multiple of 64, at least 128 |
| `LM_PARAM_THREADS` | `1` | `1` writes on the main thread, unpinned. The only value implemented; any other exits 2 |
| `LM_PARAM_ORDER` | `sequential`, `random` | The order the elements are written in |

`--quick` uses 64 MiB, `sequential`, when the variables are unset. The write loops use
AVX2; on a processor without it the program exits 1 and says so.

## Observed

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes the write loop covers in one repetition |
| `threads_used` | Threads that wrote: 1 |
| `order_taken` | The write loop that was dispatched: `sequential` or `random` |

`random` also holds the shuffled order, 8 bytes per element (128 MiB for 1 GiB), read
front to back during each repetition. Peak memory is about 1.0 GiB for `sequential` and
1.13 GiB for `random`.

## Elision guard

Each element's last word is read back through a volatile load right after it is
written, and one repetition returns the sum of those words: 0 + 1 + … + (*n* − 1). The
program checks that sum before measuring and exits 1 if it is wrong; `random` also exits
1 if the shuffled order came out unshuffled.

## Differences from July's version

July's is `benchmarks/c/bench_memory_write.c`, variants `1 thread, Sequential` and
`1 thread, Random`.

- **The same measured work.** The two write loops, the element layout, the AVX2 stores,
  the volatile read-back, the shuffle, its seed and the `MADV_RANDOM` hint are unchanged.
  Built by the same compiler with the same flags (checked with gcc 11.5, `-march=native`, on an Ice Lake Xeon), both loops' machine code is identical
  to July's.
- **One order per process.** July measured `Sequential` then `Random` in one process, on
  one buffer. Each is now its own execution, chosen by `order`, on a buffer of its own.
- **The buffer size and the thread count are parameters** (`size_bytes`, `threads`). They
  were constants, 1 GiB and one thread. July's `--quick` size was 512 MiB; it is now
  64 MiB.
- **Only the loop that is measured is checked, and only `random` builds the order.** July
  built and shuffled the order array, and checked both loops, before measuring either.
  `sequential` now allocates no order array, so its process holds 128 MiB less.
- **AVX2 is checked at run time.** The write functions are marked `target("avx2")` and the
  program exits 1 on a processor without AVX2. July relied on its harness refusing to
  compile without AVX2. On an AVX2 machine the attribute changes no instruction.
- **What is common to every port:** the output is the event stream
  (`docs/dev-log.md` section 2) instead of July's JSON record, whose `median_ns` is now
  the Method's median of each sample's time over its repetitions, and whose
  `bytes_per_op` is now `bytes_per_repetition`. The binary is linked statically; July's
  was dynamic. The harness takes samples the way July's did (one repetition, then
  doubling until a sample lasts a second, then the counted samples at that count), but
  emits the warmup samples July discarded, and takes the count of counted samples from
  `LM_SAMPLES`.
