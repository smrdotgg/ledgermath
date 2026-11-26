# hash

How long one thread takes to hash a 64-byte input with CRC32C, with SipHash-1-3 under a
fixed key (the variant Rust's `DefaultHasher` uses), or with SHA-256, using the SHA
extensions when the processor has them.

## What a figure means

How long one core takes to hash a 64-byte input, at three points between a checksum and
a cryptographic hash. One repetition hashes the same 64 bytes once:

| `algorithm` | What runs |
|---|---|
| `crc32` | CRC32C (Castagnoli), eight `crc32` instructions of SSE4.2 over 8 bytes each |
| `siphash` | SipHash-1-3 with a fixed key, the shape Rust's `DefaultHasher` uses |
| `sha256` | SHA-256, one 64-byte block and its padding block, with the SHA extensions (`sha256rnds2` and friends) when the processor has them, otherwise in scalar code |

A Run's figure is the time of one repetition, in nanoseconds (`time_per_repetition_ns`):
the median, over the Run's counted samples, of a sample's time divided by its repetitions.
The binary reads the clock only at the two edges of a sample. Before the counted samples
it runs warmup samples, doubling the repetitions until a sample lasts at least a second;
each of the 10 counted samples the schedule asks for then runs that many repetitions.
Bytes per second (`bytes_per_second`) is `bytes_per_repetition` × 10^9 divided by the time
per repetition, where `bytes_per_repetition` is the 64 bytes hashed. A Series gives the
5th, 50th and 95th percentiles of its counted Runs' figures
([Methods](https://ledgermath.com/docs/methods)).

So a figure is the time of one hash of 64 bytes, computed again and again by one thread,
on one instance type.

## What a figure does not show

- Only a 64-byte input is implemented. The figure is not the time to hash a longer one.
- Every repetition hashes the same 64 bytes, and no repetition uses the result of the one
  before. The figure is of hashes computed back to back, not the latency of one hash on
  its own.
- `sha256` takes the SHA extensions where the processor has them and scalar code where it
  does not, so its code differs between instance types; `path_taken` says which (see
  "Findings").

## Parameters

Each parameter set runs on every instance type in the schedule. Each parameter set and
instance type is a Series of its own.

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_ALGORITHM` | `crc32`, `siphash`, `sha256` | The hash one repetition computes |
| `LM_PARAM_SIZE_BYTES` | `64` | Bytes hashed per repetition. Only 64 is implemented; any other value exits 2 |

`--quick` uses `crc32` and 64 bytes when the variables are unset. `crc32` needs SSE4.2;
on a processor without it the program exits 1 and says so.

## Observed values

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes one repetition hashes: 64 |
| `algorithm_run` | The function the measured loop calls: `crc32c`, `siphash-1-3` or `sha256` |
| `path_taken` | How it computes: `sse4.2` (`crc32c`), `scalar` (`siphash-1-3`, or `sha256` without the SHA extensions), or `sha-ni` (`sha256` with them) |

## Findings

`sha256` has two paths and the processor decides which: of the types scheduled in step 4,
`m5.large` has no SHA extensions and takes `scalar`; the others take `sha-ni`. A Series
of `sha256` therefore means the fastest SHA-256 this program has for that processor, and
`path_taken` says which it was.

## How it works

### Elision guard

One repetition returns 64 bits of the hash (the CRC itself; SipHash's 64-bit result; the
last 8 bytes of the SHA-256 digest). Before measuring, the program checks the hash it
will measure against a known answer (`0xf8a5dd8c` and a bitwise CRC32C for `crc32`,
`0xf17997ec4b4a6065` for `siphash`, `0x8c447cd1d9151108` for `sha256`, and the SHA-NI
result against the scalar one), and exits 1 if it is wrong.

## Building and testing

```bash
make -C benchmarks/hash                            # build/static/hash
LM_PARAM_ALGORITHM=sha256 LM_PARAM_SIZE_BYTES=64 LM_SAMPLES=10 ./benchmarks/hash/build/static/hash
```
