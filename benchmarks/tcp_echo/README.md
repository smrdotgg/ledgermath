# tcp_echo

The round trip of a buffer over loopback TCP inside one process, between its main thread
and a server thread that echoes it back: the kernel's TCP stack and system calls, with no
network card and no network.

## What a figure means

The round trip of a buffer over loopback TCP: the kernel's TCP stack and system calls,
with no network card. A server thread in the same process accepts one connection on
`127.0.0.1` and echoes back whatever it receives. One repetition sends the whole buffer,
32 KiB by default, from the main thread and reads all of it back.

Each Run that Method `series` v1 counts gives one figure, the time of one repetition in
nanoseconds (`time_per_repetition_ns`): the median, over the Run's counted samples, of a
sample's time divided by its repetitions. A Run it does not count gives none. The harness
reads the clock once at each edge of a sample, around the whole loop of its repetitions,
and never inside that loop. Before the counted samples it runs warmup samples, doubling the
repetitions until a sample lasts at least a second; each of the 10 counted samples the
schedule asks for then runs that many repetitions. Bytes per second (`bytes_per_second`) is `bytes_per_repetition` × 10^9 divided by the time
per repetition, where `bytes_per_repetition` is the bytes sent in one repetition, counted
once, not once each way. A Series gives the 5th, 50th and 95th percentiles of its counted
Runs' figures ([Methods](https://ledgermath.com/docs/methods)).

So a figure is the time of one round trip of `size_bytes` through the kernel's loopback,
on one instance type.

## What a figure does not show

- Loopback involves no network card and no other machine. It is not a figure for traffic
  between two machines.
- One connection, opened before measuring, carries every repetition, so opening a
  connection is not in the figure.
- A repetition also hashes every 997th byte it read back, and the last, so the figure is
  not the kernel's work alone.
- The two threads are not pinned, so on a 2-vCPU box they share
  both vCPUs with everything else.

## Parameters

The parameter set runs on every instance type in the schedule. Each instance type is a
Series of its own.

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_SIZE_BYTES` | `32768` | Bytes sent, and read back, per repetition; 1 to 65536 |

`--quick` uses 32 KiB when `LM_PARAM_SIZE_BYTES` is unset. The limit of 64 KiB keeps the
buffer within the default loopback socket buffers: a larger one could fill both
directions before the client starts reading, and stall into the one-second timeout.

## Observed values

| Key | What it is |
|---|---|
| `bytes_per_repetition` | Bytes one repetition sends and reads back, counted once |

## Findings

No finding of its own so far.

## How it works

Both sockets have `TCP_NODELAY` and one-second send and receive timeouts; a timeout or
a short connection exits 1.

### Elision guard

One repetition returns an FNV-1a hash of every 997th byte it read back, and the last.
Before measuring, the program does one round trip and checks every byte read back
against the bytes sent, and exits 1 if any differs.

## Building and testing

```bash
make -C benchmarks/tcp_echo                        # build/static/tcp_echo
LM_PARAM_SIZE_BYTES=32768 LM_SAMPLES=10 ./benchmarks/tcp_echo/build/static/tcp_echo
```
