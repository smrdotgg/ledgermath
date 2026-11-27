# compressed_memory_read

How fast one thread unpacks integers stored at a width of `bits` into 32-bit integers,
the decode step of a compressed column, cycling through a pool of `blocks` blocks meant to
come from memory rather than cache. Whether the pool exceeds the cache depends on the
machine.

## What a figure means

How fast one core unpacks integers stored at 8 bits each into 32-bit integers. One
repetition unpacks one block: 256 bytes in, 256 `u32`s (1024 bytes) out. Successive
repetitions take successive blocks of a pool, by default 1,000,000 blocks (256,000,000
bytes, 244 MiB), so that the packed input comes from memory rather than cache. Whether
the pool exceeds the cache depends on the machine: some have an L3 of hundreds of MiB.
The Run's dump records the machine's cache sizes (`lscpu` and `cache/index*/size` in
`/sys`). It stands for the decode step of a compressed column or posting list, as the
`compressed_memory_read` benchmark of Simon Eskildsen's Napkin Math, the project LedgerMath
began from, does with the Rust crate `bitpacking` (BitPacker8x at 8 bits).

Each Run that Method `series` v1 counts gives one figure, the time of one repetition in
nanoseconds (`time_per_repetition_ns`): the median, over the Run's counted samples, of a
sample's time divided by its repetitions. A Run it does not count gives none. The harness
reads the clock once at each edge of a sample, around the whole loop of its repetitions,
and never inside that loop. Before the counted samples it runs warmup samples, doubling the
repetitions until a sample lasts at least a second; each of the 10 counted samples the
schedule asks for then runs that many repetitions. Bytes per second (`bytes_per_second`) is `bytes_per_repetition` × 10^9 divided by the time
per repetition, where `bytes_per_repetition` is the 1024 bytes one repetition writes out.
Those are four times the 256 bytes it reads (`compressed_bytes_per_repetition`), so bytes
per second counts the unpacked output, not the packed input. A Series gives the 5th, 50th
and 95th percentiles of its counted Runs' figures
([Methods](https://ledgermath.com/docs/methods)).

So a figure is the time one thread takes to unpack one block of 256 values, on one
instance type.

## What a figure does not show

- Only 8 bits per value is implemented. At that width, unpacking a value is widening one
  byte to a 32-bit integer, so the figure says nothing of other widths.
- Every repetition writes its 256 values to the same 1024-byte output array; only the
  packed input moves through the pool.
- Whether the pool is read from memory or from cache depends on its size and on the
  machine's caches, which the Run's dump sections `lscpu` and `sys_cpu` record. A pool that
  fits in a cache gives a cache figure.

## Parameters

The parameter set runs on every instance type in the schedule. Each instance type is a
Series of its own.

The benchmark's Series and their figures are listed at
[https://api.ledgermath.com/v1/benchmarks/compressed_memory_read.json](https://api.ledgermath.com/v1/benchmarks/compressed_memory_read.json),
which says in `left_out` how many it leaves out.

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_BLOCKS` | `1000000` | Blocks in the pool the repetitions cycle through |
| `LM_PARAM_BITS` | `8` | Bits per packed value. Only 8 is implemented; any other value exits 2 |

`--quick` uses 100,000 blocks when `LM_PARAM_BLOCKS` is unset.

## Observed values

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes one repetition writes out: 1024 (256 `u32`s) |
| `compressed_bytes_per_repetition` | Bytes one repetition reads: 256 |
| `blocks_verified` | Blocks in the pool, each unpacked and compared value by value with the source block at startup |
| `bits_per_value` | The bits the largest unpacked value needs, computed from the unpacked data the way `bitpacking`'s `num_bits` does |

## Findings

No finding of its own so far.

## How it works

### Elision guard

One repetition returns the sum of the 256 values it unpacked (32640 for every block),
and writes them to an output array that outlives it. Every block is unpacked and checked
at startup, and the program exits 1 if any differs.

## Building and testing

```bash
make -C benchmarks/compressed_memory_read          # build/static/compressed_memory_read
LM_PARAM_BLOCKS=1000000 LM_PARAM_BITS=8 LM_SAMPLES=10 \
  ./benchmarks/compressed_memory_read/build/static/compressed_memory_read
```
