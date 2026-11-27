# sort

How fast one thread sorts 64-bit integer keys: a copy of `size_bytes` of unsorted keys,
sorted by an LSD radix sort.

## What a figure means

How fast one core sorts 64-bit integer keys. One repetition copies 1 MiB of unsorted
keys (131,072 of them) into a scratch buffer and sorts the copy with an LSD radix sort,
eight passes of one byte each, with no comparison function. The copy is part of the
measured work, as it was in napkin-math's model and in July's.

Each Run that Method `series` v1 counts gives one figure, the time of one repetition in
nanoseconds (`time_per_repetition_ns`): the median, over the Run's counted samples, of a
sample's time divided by its repetitions. A Run it does not count gives none. The harness
reads the clock once at each edge of a sample, around the whole loop of its repetitions,
and never inside that loop. Before the counted samples it runs warmup samples, doubling the
repetitions until a sample lasts at least a second; each of the 10 counted samples the
schedule asks for then runs that many repetitions. Bytes per second (`bytes_per_second`) is `bytes_per_repetition` × 10^9 divided by the time
per repetition, where `bytes_per_repetition` is the bytes of keys copied and sorted in one
repetition. A Series gives the 5th, 50th and 95th percentiles of its counted Runs' figures
([Methods](https://ledgermath.com/docs/methods)).

So a figure is the time one thread takes to copy and sort `size_bytes` of keys, on one
instance type.

## What a figure does not show

- The radix sort makes eight passes whatever the keys are. A sort that compares keys is
  not measured.
- The keys are bare 64-bit integers, with no records attached.
- Each repetition also copies the input, and reads a sample of the sorted keys for its
  checksum, so the figure is not the sort alone.
- Every repetition sorts the same keys, the first outputs of one pseudo-random sequence
  from a fixed seed. The input, its copy and the sort's second buffer take three times
  `size_bytes`; whether they fit in a cache depends on the machine, whose cache sizes the
  Run's dump sections `lscpu` and `sys_cpu` record.

## Parameters

The parameter set runs on every instance type in the schedule. Each instance type is a
Series of its own.

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_SIZE_BYTES` | `1048576` | Bytes of keys copied and sorted per repetition; a positive multiple of 8 |

`--quick` uses 1 MiB when `LM_PARAM_SIZE_BYTES` is unset. The keys are the first
*n* outputs of xorshift64* from a fixed seed, so every size is a prefix of the same
sequence.

## Observed values

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes of keys one repetition copies and sorts |

The program holds the input, the scratch copy and the radix sort's second buffer: three
times `size_bytes`.

## Findings

No finding of its own so far.

## How it works

### Elision guard

One repetition returns a sum over the sorted copy: its first, middle and last keys,
XORed, plus every 512th key. Before measuring, the program sorts once and checks that the
result is in order and holds the same keys as the input (by their sum), and exits 1 if
not.

## Building and testing

```bash
make -C benchmarks/sort                            # build/static/sort
LM_PARAM_SIZE_BYTES=1048576 LM_SAMPLES=10 ./benchmarks/sort/build/static/sort
```
