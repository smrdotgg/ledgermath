# compressed_memory_read

How fast one core unpacks integers stored at 8 bits each into 32-bit integers. One
repetition unpacks one block: 256 bytes in, 256 `u32`s (1024 bytes) out. Successive
repetitions take successive blocks of a pool, by default 1,000,000 blocks (256,000,000
bytes, 244 MiB), so that the packed input comes from memory rather than cache. Whether
the pool exceeds the cache depends on the machine: some have an L3 of hundreds of MiB.
The Run's dump records the machine's cache sizes (`lscpu` and `cache/index*/size` in
`/sys`). It stands for the decode step of a compressed column or posting list, as
napkin-math's `compressed_memory_read / bitpacker` (BitPacker8x at 8 bits) did.

```bash
make -C benchmarks/compressed_memory_read          # build/static/compressed_memory_read
LM_PARAM_BLOCKS=1000000 LM_PARAM_BITS=8 LM_SAMPLES=10 \
  ./benchmarks/compressed_memory_read/build/static/compressed_memory_read
```

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_BLOCKS` | `1000000` | Blocks in the pool the repetitions cycle through |
| `LM_PARAM_BITS` | `8` | Bits per packed value. Only 8 is implemented; any other value exits 2 |

`--quick` uses 100,000 blocks when `LM_PARAM_BLOCKS` is unset.

## Observed

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes one repetition writes out: 1024 (256 `u32`s) |
| `compressed_bytes_per_repetition` | Bytes one repetition reads: 256 |
| `blocks_verified` | Blocks in the pool, each unpacked and compared value by value with the source block at startup |
| `bits_per_value` | The bits the largest unpacked value needs, computed from the unpacked data the way `bitpacking`'s `num_bits` does |

## Elision guard

One repetition returns the sum of the 256 values it unpacked (32640 for every block),
and writes them to an output array that outlives it. Every block is unpacked and checked
at startup, and the program exits 1 if any differs.

## Differences from July's version

July's is `benchmarks/c/bench_compressed_memory_read.c`, variant `bitpacker`.

- **The same measured work.** The unpack loop, the block layout, the pool of 1,000,000
  blocks and the cycling are unchanged. Built by the same compiler with the same flags (checked with gcc 11.5, `-march=native`, on an Ice Lake Xeon),
  the unpack function's machine code is identical to July's.
- **The pool size and the bit width are parameters** (`blocks`, `bits`). They were
  constants. Their scheduled values are July's.
- **Every block is checked at startup.** July unpacked and checked block 0 only. As a
  result the first measured repetition unpacks block 0, where July's unpacked block 1.
- **What is common to every port:** the output is the event stream
  (`docs/dev-log.md` section 2) instead of July's JSON record, whose `median_ns` is now
  the Method's median of each sample's time over its repetitions, and whose
  `bytes_per_op` is now `bytes_per_repetition`. The binary is linked statically; July's
  was dynamic. The harness takes samples the way July's did (one repetition, then
  doubling until a sample lasts a second, then the counted samples at that count), but
  emits the warmup samples July discarded, and takes the count of counted samples from
  `LM_SAMPLES`.
