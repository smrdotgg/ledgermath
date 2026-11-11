# mutex

What a critical section under a `pthread_mutex_t` costs, with nobody contending and with
a fixed number of threads handing the lock between CPUs the binary chooses itself. One
repetition is exactly K = 10,000 critical sections, done by whichever threads win the
lock. Every thread, the main thread included, loops: lock; if the counter has reached
the repetition's target, unlock and stop; otherwise increment the counter and the other
protected lines, then unlock. A sample's time divided by (repetitions × 10,000) is the
time per critical section across all threads: a Method's division, not the binary's.

The study of July's data and the design is section 1 of the step-4 brief's study (#42).

| Parameter set (`threads`, `placement`, `critical_section_lines`) | What it measures | Scheduled on |
|---|---|---|
| `1`, `one_cpu`, `1` | The cost of one lock and unlock that nobody contends | every target |
| `2`, `distinct_cores`, `1` | Lock handoff throughput when the lock and the counter move between two physical cores | `c6i.8xlarge`, `c8i.2xlarge`, `c8a.2xlarge`, `i4i.2xlarge` |
| `2`, `distinct_cores`, `8` | The same with eight protected cache lines moving with the lock, which includes glibc's futex sleep and wake-up | the same four |
| `2`, `smt_siblings`, `1` | Lock handoff between the two hardware threads of one core, which share its L1 and L2 | `m5.large`, `c6i.8xlarge`, `c8i.2xlarge`, `i4i.2xlarge` |

All four use `lock` `pthread_mutex_default`. `m5.large` has one core with two
hardware threads, so it runs no distinct-cores set; `c8a.2xlarge` has one hardware thread
per core, so it runs no siblings set. The schedule keeps them off with `instance_types`;
the binary would exit 2 there.

```bash
make -C benchmarks/mutex                           # build/static/mutex
LM_PARAM_THREADS=2 LM_PARAM_PLACEMENT=distinct_cores LM_PARAM_CRITICAL_SECTION_LINES=1 \
  LM_PARAM_LOCK=pthread_mutex_default LM_SAMPLES=10 ./benchmarks/mutex/build/static/mutex
```

A sample lasts one to two seconds (the harness doubles the repetitions until one lasts at
least a second), so an execution takes about 15 to 25 seconds, and the sets a box runs
together about a minute to a minute and a half. On the shared development machine,
under load, they took 15 to 47 seconds each.

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_THREADS` | `1`, `2` | Threads that take the lock, the main thread included; 1 to 1024 |
| `LM_PARAM_PLACEMENT` | `one_cpu`, `distinct_cores`, `smt_siblings` | Where the binary pins them; see below. `one_cpu` takes 1 thread, `smt_siblings` 2 or more |
| `LM_PARAM_CRITICAL_SECTION_LINES` | `1`, `8` | 64-byte cache lines each critical section increments, the counter's included; 1 to 64 |
| `LM_PARAM_LOCK` | `pthread_mutex_default` | `pthread_mutex_default`, a mutex made from a default attribute (glibc's `PTHREAD_MUTEX_NORMAL`, which never spins), or `pthread_mutex_adaptive` (`PTHREAD_MUTEX_ADAPTIVE_NP`, which spins briefly before sleeping; not scheduled: the study measured it no better) |

`--quick` uses 1 thread, `one_cpu`, 1 line and `pthread_mutex_default` when the
variables are unset.

### Placement

The binary reads the CPUs it may run on (`sched_getaffinity`) and, for each,
`/sys/devices/system/cpu/cpuN/topology/thread_siblings_list`: two CPUs are on one core
when their sibling lists are the same. Cores are taken in the order of their first
allowed CPU.

- `one_cpu`: the first allowed CPU.
- `distinct_cores`: the first allowed CPU of each of the first `threads` cores.
- `smt_siblings`: the first `threads` allowed CPUs of the first core that has that many.

Thread 0, the main thread, gets the first CPU, and thread *i* the *i*-th. Each thread pins
itself, reads its affinity back (it must be exactly its CPU) and reads `sched_getcpu()`;
either differing exits 1. When the CPUs this process may run on cannot provide the
placement, the binary exits 2 after `started`, saying why on stderr. Under
`taskset -c 1,3` (the two hardware threads of one core) and `taskset -c 0,1` (one of each
of two cores) on the development machine:

```
error: placement distinct_cores is impossible here: 2 threads need CPUs on 2 different cores, and the CPUs this process may run on (1,3) are on 1 core
error: placement smt_siblings is impossible here: 2 threads need 2 hardware threads of one core, and of the CPUs this process may run on (0-1) no core has more than 1
```

It never falls back to another placement.

### How a repetition starts and ends

Thread 0 runs `lm_measure`. It starts a repetition by writing the target (the counter
plus 10,000) and bumping a generation word, which the other threads spin on with
`pause`; it then works like the others, and ends the repetition when every other thread
has written that generation to its own line. No barrier: `pthread_barrier_wait` sleeps
on a futex and would add microsecond wake-ups to every repetition. Each thread makes one
acquisition per repetition that finds the target reached and does nothing under it; with
two threads that adds 0.02% to the acquisitions.

The lock is alone in a 128-byte block (Intel's adjacent-line prefetcher moves lines in
pairs), and the protected lines follow, 64 bytes apart, the first holding the counter.

## Observed

Emitted once, before measuring, after one checked repetition.

| Key | What it is |
|---|---|
| `threads_used` | Threads that ran the checked repetition and checked in |
| `cpus` | Each thread's CPU, read back with `sched_getcpu()` after pinning, in thread order, such as `"0,1"` |
| `core_ids` | Each of those CPUs' `topology/core_id` |
| `package_ids` | Each of those CPUs' `topology/physical_package_id` |
| `lock_type` | The mutex type read back from the attribute the mutex was made with (`pthread_mutexattr_gettype`): `PTHREAD_MUTEX_NORMAL` or `PTHREAD_MUTEX_ADAPTIVE_NP` |
| `libc` | `gnu_get_libc_version()`: the C library linked in, `2.34` on the box |
| `critical_sections_per_repetition` | Critical sections the threads counted, each in its own register, in the checked repetition: 10000 |
| `protected_lines` | Protected lines found equal to the counter after it |

```json
{"event":"observed","t":302910207268930,"values":{"threads_used":2,"cpus":"0,2","core_ids":"0,0","package_ids":"0,0","lock_type":"PTHREAD_MUTEX_NORMAL","libc":"2.34","critical_sections_per_repetition":10000,"protected_lines":1}}
```

(The siblings set, in the Amazon Linux 2023 container on the development machine, whose
CPUs 0 and 2 are the two hardware threads of core 0.)

`cpus` with `core_ids` and `package_ids` are the observed counterparts of `threads` and
`placement`: distinct cores show distinct core ids, siblings one. The Run's dump holds the
whole topology.

## Events of its own

Both pass `schemas/events.schema.json` and `scripts/check-events.py` as a benchmark's own
events; the harness file `benchmarks/harness/c/lm_event.{h,c}` emits them.

**`cpu_pair`**, before measuring, once for each thread after the first (once with two
threads, never with one): the round trip of one cache line between thread 0's CPU and
that thread's. Thread 0 writes an odd value and spins until the other thread writes the
next even one, without `pause` on either side; 10,000 round trips of warmup, then 10
batches of 100,000 (10,000 under `--quick`), each timed by two clock reads. About 0.05
to 0.2 seconds. It explains spread that comes from which two cores the pair landed on.

```json
{"event":"cpu_pair","t":301635096352260,"cpus":[0,1],"warmup_round_trips":10000,"round_trips_per_batch":100000,"batch_ns":[19417633,9858676,12869288,18858494,54144633,13268226,57880689,18705976,10670837,51811787]}
```

(From the shared development machine under load, where the threads were often preempted;
the fastest batch, 98.6 ns a round trip, is the closest to the cache's own figure.)

| Field | What it is |
|---|---|
| `cpus` | Thread 0's CPU, then the other thread's |
| `warmup_round_trips` | Round trips made before the first batch, untimed |
| `round_trips_per_batch` | Round trips in each batch |
| `batch_ns` | Each batch's duration; one round trip is a batch over `round_trips_per_batch` |

**`mutex_threads`**, after measuring (after `verified`, before `finished`): one entry per
thread, over the whole of `lm_measure` (its warmup samples included, the checked
repetition and `cpu_pair` not).

```json
{"event":"mutex_threads","t":301654414329209,"threads":[{"thread":0,"cpu":0,"cpu_at_end":0,"critical_sections":64500898,"acquisitions":64513186,"voluntary_switches":1997,"involuntary_switches":1796,"user_time_us":9108888,"system_time_us":2688647},{"thread":1,"cpu":1,"cpu_at_end":1,"critical_sections":58379102,"acquisitions":58391390,"voluntary_switches":2117,"involuntary_switches":2090,"user_time_us":9122884,"system_time_us":2484444}]}
```

| Field | What it is |
|---|---|
| `thread`, `cpu` | The thread's number and its CPU after pinning |
| `cpu_at_end` | `sched_getcpu()` after measuring |
| `critical_sections` | Critical sections it did; the threads' shares of the work |
| `acquisitions` | Locks it took: its critical sections plus one per repetition |
| `voluntary_switches`, `involuntary_switches` | `getrusage(RUSAGE_THREAD)`'s `ru_nvcsw` and `ru_nivcsw`: a voluntary switch is mostly a futex sleep on the lock; an involuntary one is preemption |
| `user_time_us`, `system_time_us` | Its CPU time in user space and in the kernel (futex calls) |

## Elision guard

`verified` is the counter after the last repetition. After measuring, and after
`mutex_threads` is emitted, the binary checks three things and exits 1, naming the one
that failed, if any does not hold:

1. The counter equals 10,000 × every repetition run, the checked one and the warmups
   included: no repetition did less work.
2. The critical sections the threads counted, each in a register of its own, add up to
   the counter: no increment was lost. This is what proves mutual exclusion with one
   protected line, whose counter is also the loop's stopping condition: when two threads
   race, the counter still ends at its target, but the threads have done more increments
   than it moved by.
3. Every other protected line equals the counter.

The checked repetition before measuring makes the same checks and exits 1 too. With the
lock skipped in one thread, the binary exits 1 at the first of them that sees the race.

## What will stay unstable

- **1 thread:** a busy hardware sibling of its CPU slows it, up to 2.5× in the study. On
  a box running nothing else the sibling should be idle, so it should be about as steady
  as `syscall / getpid`; that is not yet shown on a box.
- **Distinct cores:** a distribution across boots, from where the two cores sit on the
  host (mesh or CCX distance), on top of about 5% from run to run. `cpu_pair` is recorded
  to explain it.
- **8 lines:** wide (a CV of about 12% in the study), because whether the waiting thread
  sleeps on the futex is the lock's real behaviour; `voluntary_switches` shows it. Read it
  with percentiles across Runs.
- **Which thread does the work** varies from run to run: glibc's mutex is unfair, so the
  thread that unlocks often locks again. Counting every thread's work makes the time per
  critical section hold still regardless; the shares are in `mutex_threads`.

## July's `mutex / contended` ends here

July's is `benchmarks/c/bench_mutex.c`, variant `contended`. Its Series ends here: this
is a different measurement, not a port.

- **July counted only the measured thread's acquisitions,** while its contender, unlimited
  and uncounted, did between 22% and 87% of the work, depending on the day; its number
  was roughly the time per acquisition over the measured thread's share, which is why it
  ranged from half to double its median. Here every thread's work is counted, and a
  repetition is a fixed total.
- **July had one shape, two threads on the first two allowed CPUs,** whatever cores those
  were. Here the placement is a parameter the binary carries out from the topology, and
  the Run says which CPUs and cores it used.
- **New:** the uncontended set, the siblings set, the eight-line set, the events
  `cpu_pair` and `mutex_threads`, and the guard's count of lost increments. July's guard
  was the shared counter alone.
- **What is common to every port:** the output is the event stream
  (`docs/dev-log.md` section 2), the binary is linked statically, and the harness takes
  samples the way July's did (one repetition, then doubling until a sample lasts a second,
  then `LM_SAMPLES` counted samples), emitting the warmup samples July discarded.
