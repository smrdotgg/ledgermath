# sort

How fast one core sorts 64-bit integer keys. One repetition copies 1 MiB of unsorted
keys (131,072 of them) into a scratch buffer and sorts the copy with an LSD radix sort,
eight passes of one byte each, with no comparison function. The copy is part of the
measured work, as it was in napkin-math's model and in July's.

```bash
make -C benchmarks/sort                            # build/static/sort
LM_PARAM_SIZE_BYTES=1048576 LM_SAMPLES=10 ./benchmarks/sort/build/static/sort
```

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_SIZE_BYTES` | `1048576` | Bytes of keys copied and sorted per repetition; a positive multiple of 8 |

`--quick` uses 1 MiB when `LM_PARAM_SIZE_BYTES` is unset. The keys are the first
*n* outputs of xorshift64* from a fixed seed, so every size is a prefix of the same
sequence.

## Observed

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes of keys one repetition copies and sorts |

The program holds the input, the scratch copy and the radix sort's second buffer: three
times `size_bytes`.

## Elision guard

One repetition returns a sum over the sorted copy: its first, middle and last keys,
XORed, plus every 512th key. Before measuring, the program sorts once and checks that the
result is in order and holds the same keys as the input (by their sum), and exits 1 if
not.

## Differences from July's version

July's is `benchmarks/c/bench_sort.c`, variant `u64`.

- **The same measured work.** The input, its seed, the copy, the radix sort and the
  checksum are unchanged. Built by the same compiler with the same flags (checked with gcc 11.5, `-march=native`, on an Ice Lake Xeon), the measured
  function and the radix sort have machine code identical to July's.
- **The size is a parameter** (`size_bytes`). It was the constant 1 MiB, the scheduled
  value.
- **The startup check also compares sums.** July checked only that the sorted copy was
  in order; a sort that lost or duplicated keys could have passed it.
- **What is common to every port:** the output is the event stream
  (`docs/dev-log.md` section 2) instead of July's JSON record, whose `median_ns` is now
  the Method's median of each sample's time over its repetitions, and whose
  `bytes_per_op` is now `bytes_per_repetition`. The binary is linked statically; July's
  was dynamic. The harness takes samples the way July's did (one repetition, then
  doubling until a sample lasts a second, then the counted samples at that count), but
  emits the warmup samples July discarded, and takes the count of counted samples from
  `LM_SAMPLES`.
