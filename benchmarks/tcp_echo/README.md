# tcp_echo

The round trip of a buffer over loopback TCP: the kernel's TCP stack and system calls,
with no network card. A server thread in the same process accepts one connection on
`127.0.0.1` and echoes back whatever it receives. One repetition sends the whole buffer,
32 KiB by default, from the main thread and reads all of it back.

```bash
make -C benchmarks/tcp_echo                        # build/static/tcp_echo
LM_PARAM_SIZE_BYTES=32768 LM_SAMPLES=10 ./benchmarks/tcp_echo/build/static/tcp_echo
```

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_SIZE_BYTES` | `32768` | Bytes sent, and read back, per repetition; 1 to 65536 |

`--quick` uses 32 KiB when `LM_PARAM_SIZE_BYTES` is unset. The limit of 64 KiB keeps the
buffer within the default loopback socket buffers: a larger one could fill both
directions before the client starts reading, and stall into the one-second timeout.

## Observed

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes one repetition sends and reads back, counted once |

Both sockets have `TCP_NODELAY` and one-second send and receive timeouts; a timeout or
a short connection exits 1. The two threads are not pinned, so on a 2-vCPU box they share
both vCPUs with everything else.

## Elision guard

One repetition returns an FNV-1a hash of every 997th byte it read back, and the last.
Before measuring, the program does one round trip and checks every byte read back
against the bytes sent, and exits 1 if any differs.

## Differences from July's version

July's is `benchmarks/c/bench_tcp_echo.c`, variant `32 KiB`.

- **The same round trip.** The connection, its socket options, the server, the
  send-then-read loop and the hash of the bytes read back are unchanged.
- **The size is a parameter** (`size_bytes`). It was the constant 32 KiB, the scheduled
  value. So the length is now a variable where July's compiler saw a constant: the
  measured function differs from July's in how it loads the length and counts the hash's
  33 steps, beside at least two system calls on each side of the connection and a
  32 KiB copy each way.
- **What is common to every port:** the output is the event stream
  (`docs/dev-log.md` section 2) instead of July's JSON record, whose `median_ns` is now
  the Method's median of each sample's time over its repetitions, and whose
  `bytes_per_op` is now `bytes_per_repetition`. The binary is linked statically; July's
  was dynamic. The harness takes samples the way July's did (one repetition, then
  doubling until a sample lasts a second, then the counted samples at that count), but
  emits the warmup samples July discarded, and takes the count of counted samples from
  `LM_SAMPLES`.
