# hash

How long one core takes to hash a 64-byte input, at three points between a checksum and
a cryptographic hash. One repetition hashes the same 64 bytes once:

| `algorithm` | What runs |
|---|---|
| `crc32` | CRC32C (Castagnoli), eight `crc32` instructions of SSE4.2 over 8 bytes each |
| `siphash` | SipHash-1-3 with a fixed key, the shape Rust's `DefaultHasher` uses |
| `sha256` | SHA-256, one 64-byte block and its padding block, with the SHA extensions (`sha256rnds2` and friends) when the processor has them, otherwise in scalar code |

```bash
make -C benchmarks/hash                            # build/static/hash
LM_PARAM_ALGORITHM=sha256 LM_PARAM_SIZE_BYTES=64 LM_SAMPLES=10 ./benchmarks/hash/build/static/hash
```

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_ALGORITHM` | `crc32`, `siphash`, `sha256` | The hash one repetition computes |
| `LM_PARAM_SIZE_BYTES` | `64` | Bytes hashed per repetition. Only 64 is implemented; any other value exits 2 |

`--quick` uses `crc32` and 64 bytes when the variables are unset. `crc32` needs SSE4.2;
on a processor without it the program exits 1 and says so.

## Observed

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes one repetition hashes: 64 |
| `algorithm_run` | The function the measured loop calls: `crc32c`, `siphash-1-3` or `sha256` |
| `path_taken` | How it computes: `sse4.2` (`crc32c`), `scalar` (`siphash-1-3`, or `sha256` without the SHA extensions), or `sha-ni` (`sha256` with them) |

`sha256` has two paths and the processor decides which: of the types scheduled in step 4,
`m5.large` has no SHA extensions and takes `scalar`; the others take `sha-ni`. A Series
of `sha256` therefore means the fastest SHA-256 this program has for that processor, and
`path_taken` says which it was.

## Elision guard

One repetition returns 64 bits of the hash (the CRC itself; SipHash's 64-bit result; the
last 8 bytes of the SHA-256 digest). Before measuring, the program checks the hash it
will measure against a known answer (`0xf8a5dd8c` and a bitwise CRC32C for `crc32`,
`0xf17997ec4b4a6065` for `siphash`, `0x8c447cd1d9151108` for `sha256`, and the SHA-NI
result against the scalar one), and exits 1 if it is wrong.

## Differences from July's version

July's is `benchmarks/c/bench_hash.c`, variants `crc32`, `siphash` and `sha256`.

- **The same hash functions.** Every line from `load_be32` to `sha256_ni_run` is
  July's, unchanged, and so is the rule choosing SHA-256's path. Built by the same
  compiler with the same flags (checked with gcc 11.5, `-march=native`, on an Ice Lake
  Xeon), the measured functions' machine code is identical to July's apart from the
  addresses of their constants.
- **One algorithm per process.** July measured the three in one process, in that order.
  Each is now its own execution, chosen by `algorithm`.
- **The path SHA-256 took is observed** (`path_taken`). July printed it to stderr only,
  so its record could not say which it was.
- **Only the hash that is measured is checked, and SSE4.2 is required only for `crc32`.**
  July checked all three and refused to run any of them without SSE4.2.
- **The input size is a parameter** (`size_bytes`), accepting only July's 64.
- **What is common to every port:** the output is the event stream
  (`docs/dev-log.md` section 2) instead of July's JSON record, whose `median_ns` is now
  the Method's median of each sample's time over its repetitions, and whose
  `bytes_per_op` is now `bytes_per_repetition`. The binary is linked statically; July's
  was dynamic. The harness takes samples the way July's did (one repetition, then
  doubling until a sample lasts a second, then the counted samples at that count), but
  emits the warmup samples July discarded, and takes the count of counted samples from
  `LM_SAMPLES`.
