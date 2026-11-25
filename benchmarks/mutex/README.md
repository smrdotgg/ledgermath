# mutex

What a critical section under a `pthread_mutex_t` costs, with nobody contending and with
a fixed number of threads handing the lock between CPUs the binary chooses itself. One
repetition is exactly K = 10,000 critical sections, done by whichever threads win the
lock. Every thread, the main thread included, loops: lock; if the counter has reached
the repetition's target, unlock and stop; otherwise increment the counter and the other
protected lines, then unlock. A sample's time divided by (repetitions × 10,000) is the
time per critical section across all threads: a Method's division, not the binary's.

The study of July's data and the design is section 1 of the step-4 brief's study (#42).

| Parameter set (`threads`, `placement`, `critical_section_lines`, `idle_threads`) | What it measures | Scheduled on |
|---|---|---|
| `1`, `one_cpu`, `1`, `1` | The cost of one lock and unlock that nobody contends, in a program that has more than one thread. **Usually the number wanted**, and what napkin-math's "mutex lock/unlock" means | every target |
| `1`, `one_cpu`, `1`, `0` | The same in a process that has only ever had one thread, where glibc skips the atomic instructions | every target |
| `2`, `distinct_cores`, `1`, `0` | Lock handoff throughput when the lock and the counter move between two physical cores | `c6i.8xlarge`, `c8i.2xlarge`, `c8a.2xlarge`, `i4i.2xlarge` |
| `2`, `distinct_cores`, `8`, `0` | The same with eight protected cache lines moving with the lock, which includes glibc's futex sleep and wake-up | the same four |
| `2`, `smt_siblings`, `1`, `0` | Lock handoff between the two hardware threads of one core, which share its L1 and L2 | `m5.large`, `c6i.8xlarge`, `c8i.2xlarge`, `i4i.2xlarge` |

### The two one-thread sets

glibc (2.34 and later) locks and unlocks a default mutex with plain stores while the
process has only ever had one thread: it checks a per-thread word that the first
`pthread_create` sets, and only after that uses `lock cmpxchg` to lock and `xchg` to
unlock. So with one working thread and nothing else, the number is true only of a program
that never started a thread. `idle_threads` 1 adds one thread, before measuring, that
blocks for the life of the process with every signal blocked (in `pause()`): it never
runs, never spins and never touches the lock, but the process is multi-threaded, so the
working thread takes the atomic path, as it would in any program that uses threads at
all. That is the uncontended lock a reader usually means. `idle_threads` 0 is the
single-threaded special case, kept beside it so the difference is measured, not assumed.

On the development machine, the Amazon Linux build's glibc 2.34 took the plain path for
every one of the first 100,000 locks and unlocks of the benchmark's mutex with
`idle_threads` 0, and the atomic path for every one with `idle_threads` 1 (counted with
breakpoints on the four instructions; see the step-4 log entry in `docs/dev-log.md`).
With the machine otherwise quiet, that build gave 4.36 ns a critical section with
`idle_threads` 0 and 18.57 ns with `idle_threads` 1 (eight runs of each, within 4.35 to
4.39 ns and 18.56 to 18.59 ns): the two atomic instructions add about 14 ns to an
uncontended lock and unlock on that Ice Lake Xeon. Those are the figures of the slow level.
With `idle_threads` 1, Ice Lake boots give one of two usual levels, and the development
machine was at the slow one whenever the investigation of 2026-11-25 ran it. At the fast
level a critical section with `idle_threads` 1 takes about 14.1 ns, against about 4.3 ns
with `idle_threads` 0, so the atomic instructions add about 9.8 ns. See "What the
one-thread figures mean" below.

All five use `lock` `pthread_mutex_default`. `m5.large` has one core with two
hardware threads, so it runs no distinct-cores set; `c8a.2xlarge` has one hardware thread
per core, so it runs no siblings set. The schedule keeps them off with `instance_types`;
the binary would exit 2 there.

```bash
make -C benchmarks/mutex                           # build/static/mutex
LM_PARAM_THREADS=2 LM_PARAM_PLACEMENT=distinct_cores LM_PARAM_CRITICAL_SECTION_LINES=1 \
  LM_PARAM_LOCK=pthread_mutex_default LM_SAMPLES=10 ./benchmarks/mutex/build/static/mutex
```

A sample lasts one to two seconds (the harness doubles the repetitions until one lasts at
least a second), so an execution takes about 15 to 25 seconds (17 to 18 seconds each on
the development machine when it was quiet), and the three to five sets a box runs
together one to two minutes. On the shared development machine under load they took up
to 47 seconds each.

## Parameters

| Variable | Scheduled | Meaning |
|---|---|---|
| `LM_PARAM_THREADS` | `1`, `2` | Threads that take the lock, the main thread included; 1 to 1024 |
| `LM_PARAM_PLACEMENT` | `one_cpu`, `distinct_cores`, `smt_siblings` | Where the binary pins them; see below. `one_cpu` takes 1 thread, `smt_siblings` 2 or more |
| `LM_PARAM_CRITICAL_SECTION_LINES` | `1`, `8` | 64-byte cache lines each critical section increments, the counter's included; 1 to 64 |
| `LM_PARAM_LOCK` | `pthread_mutex_default` | `pthread_mutex_default`, a mutex made from a default attribute (glibc's `PTHREAD_MUTEX_NORMAL`, which never spins), or `pthread_mutex_adaptive` (`PTHREAD_MUTEX_ADAPTIVE_NP`, which spins briefly before sleeping; not scheduled: the study measured it no better) |
| `LM_PARAM_IDLE_THREADS` | `0`, `1` | `1` starts one more thread, after thread 0 is pinned and before any other thread or the first critical section, that blocks for the life of the process and never touches the lock; the binary waits, up to five seconds, until the kernel shows it sleeping. Not pinned. `0` starts none |

`--quick` uses 1 thread, `one_cpu`, 1 line, `pthread_mutex_default` and 0 idle threads
when the variables are unset.

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

In two `observed` events. The first is emitted after one checked repetition, before
`cpu_pair`:

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

The second is emitted just before measuring, after `cpu_pair`:

| Key | What it is |
|---|---|
| `libc_single_threaded` | glibc's `__libc_single_threaded` (`<sys/single_threaded.h>`), read at that moment: `true` while the process has only ever had one thread. The lock's own test is of a per-thread word the same `pthread_create` sets |
| `process_threads` | The `Threads:` line of `/proc/self/status` at that moment: the working threads plus any idle one |
| `idle_threads_sleeping` | Idle threads whose state in `/proc/self/task/<tid>/stat` is `S` (sleeping) at that moment: 0 or 1 |

```json
{"event":"observed","t":…,"values":{"libc_single_threaded":false,"process_threads":2,"idle_threads_sleeping":1}}
```

`cpus` with `core_ids` and `package_ids` are the observed counterparts of `threads` and
`placement`: distinct cores show distinct core ids, siblings one. `process_threads`,
`idle_threads_sleeping` and `libc_single_threaded` are those of `idle_threads`. The Run's
dump holds the whole topology.

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

- **1 thread, either set:** a busy hardware sibling of its CPU slows it, up to 2.5× in the
  study. On a box running nothing else the sibling should be idle. From boot to boot, the
  set with an idle thread sits at one of two usual levels on the Ice Lake instance types, while
  the set without one gives the same figure on fast and slow boots; see "What the
  one-thread figures mean".
- **Distinct cores:** a distribution across boots, from where the two cores sit on the
  host (mesh or CCX distance), on top of about 5% from run to run. `cpu_pair` is recorded
  to explain it.
- **8 lines:** wide (a CV of about 12% in the study), because whether the waiting thread
  sleeps on the futex is the lock's real behaviour; `voluntary_switches` shows it. Read it
  with percentiles across Runs.
- **Which thread does the work** varies from run to run: glibc's mutex is unfair, so the
  thread that unlocks often locks again. Counting every thread's work makes the time per
  critical section hold still regardless; the shares are in `mutex_threads`.

## What the one-thread figures mean

An investigation on 2026-11-25 (issue #84) found two separate things about the two
one-thread sets (`threads` 1, `one_cpu`):

- **With an idle thread, two levels by boot.** On `c6i.8xlarge` and `i4i.2xlarge` the
  figure sits, from boot to boot, at one of two usual levels, with one Run so far between
  them. Within each boot tested, with the sibling hardware thread idle or offline, every
  process gave the same level. That the level is a property of the physical host the boot
  lands on is inferred, not shown.
- **Without an idle thread, code placement.** The figure moves with where glibc's lock and
  unlock and the benchmark's loop land in the binary.

The two never mix in one Series. The set without an idle thread gives the same figure on
fast and slow boots, and the set with one moves far less with placement than the set
without.

Below, what the pipeline's recorded Runs show is kept apart from what the investigation
measured. The investigation's figures are one-off measurements on machines started by hand,
not Runs of the pipeline. Its evidence is on issue #84. What LedgerMath does about either
finding is not decided yet.

### With an idle thread: two levels, by boot

**Which Series.** `one_cpu` with `idle_threads` 1, on `c6i.8xlarge` and `i4i.2xlarge`.
Both have the same Intel Ice Lake processor (Xeon Platinum 8375C). On `m5.large`,
`c8i.2xlarge` and `c8a.2xlarge` this set shows one level, with an occasional single
outlier on `c8a.2xlarge`.

**What the recorded Runs show.** A Run's figure is the median of its counted samples. With
one binary, the figures of all but one Run sit at one of two levels:

| Level | ns per repetition | ns per critical section | Cycles per critical section, at 3.5 GHz |
|---|---|---|---|
| Fast | about 141,000 | about 14.1 | 49 |
| Slow | about 184,000 | about 18.4 | 64 |

The slow level is 30% slower. Counted on 2026-11-25 from the Runs published by then:

| Instance type | Runs | Fast | Slow | Between |
|---|---|---|---|---|
| `c6i.8xlarge` | 57, from 2026-11-11 16:17 to 2026-11-25 16:18 UTC | 15 (26%): 140,995 to 141,152 ns | 41: 183,757 to 184,019 ns | 1: 166,612 ns |
| `i4i.2xlarge` | 58, from 2026-11-11 13:51 to 2026-11-25 16:58 UTC | 5 (9%): 141,039 to 141,158 ns | 53: 183,804 to 184,045 ns | none |

The Run between ran on 2026-11-25 04:18 UTC on `c6i.8xlarge`. Its first six warm-up
samples gave 160,500 to 162,300 ns per repetition, and the later ones 163,400 to 168,000.
It is the only Run whose median lies between the levels. Single samples stray in other
Runs too (on `c6i.8xlarge`, counted samples up to 2.5% above their Run's median), but those
Runs' medians stay at a level. Whether the Run between is a third kind of host, or a host
that changed while it ran, is not known.

**How the percentiles read.** Method `series` v1 gives the 5th, 50th and 95th percentiles
across a Series' counted Runs, and across each group's. On `c6i.8xlarge`, in the 57 Runs
above, about a quarter of the Runs are fast, so the median (183,854 ns) is the slow level
and the 5th percentile (141,014 ns) is the fast one. The range between them, about 30%, is
two usual levels, not noise between Runs. The groups do not separate the levels: in the
same 57 Runs, group B holds 14 fast Runs, all 41 slow ones and the Run between, and group A
the one other fast Run. On `i4i.2xlarge`, in its 58 Runs, the 5th percentile was the fast
level too (141,066 ns, against a median of 183,871), but with 5 fast Runs in 58 it can fall
to the slow level as Runs are added. A figure from this set is a draw from the boots: say
which level you use, or carry both.

**Shown.**

- Within each boot tested, with the sibling hardware thread idle or offline, every process
  gave the same level (with the sibling busy, see below). On 13 Ice Lake boxes started
  by hand (one of them a `c6i.8xlarge`), all of them at the slow level, 732 processes of the
  pipeline's binary were all at the slow level (183,700 to 186,900 ns per repetition): on
  every CPU, at every stack offset tried, with address randomisation off, with the sibling
  hardware thread offline, and at the start and the end of each boot. On the one fast box
  found by hand (an `i4i.2xlarge`, the 15th of 19 Ice Lake boxes started; the other 18 were
  slow), all 69 processes run with the sibling idle or offline were fast, 140,990 to
  141,254 ns: on each of its 8 CPUs, with the sibling offline, with address randomisation
  off, with speculative store bypass disable on, and at the start and the end of the boot.
- No recorded fact tells the levels apart. For each published `c6i.8xlarge` Run, every key
  of ten sections of the dump taken before it (`cpuid`, `cpuinfo`, `lscpu`, `sys_cpu`,
  `kernel`, `memory`, `process`, `provider`, `provision`, `ec2_instance`) was compared
  between the fast Runs and the slow ones. A key whose value is new in nearly every Run,
  such as an address or a time, cannot tell levels apart and was set aside. Of the others,
  some values differ from Run to Run, but no key separates the fast Runs from the slow
  ones. Microcode (`0xd000433`), kernel, processor model, topology and the CPUs used are
  the same at both levels.
- The dumps read CPU 0's clock just before and just after each Run, not during it. Before
  the Run, the median reading was about 3,500 MHz at both levels; one fast Run read
  2,899.9 MHz before and 3,499.9 after. These readings show no difference in the clock
  around the Runs, but they cannot rule one out while the Run measured.
- In the published Runs, other Series run in the same boots do not move with the level:
  on `c6i.8xlarge`, this set without an idle thread, `smt_siblings`, memory latency
  (`memory_read_random`), and the core-to-core cache-line round trip are the same on fast
  and slow boots.
  (`distinct_cores` was 14% lower on fast boots, but it spreads by a factor of 2 from boot
  to boot, so that is not counted.)
- With the sibling hardware thread busy, the fast box was no faster. On the boxes started
  by hand, with a spin loop on the sibling, the fast box's three processes gave 240,258 to
  242,046 ns per repetition. The 13 slow boxes' 39 processes in the same test gave 238,213
  to 245,195 ns, apart from three that gave 257,425, 259,104 and 320,592. In the published
  Runs, the `smt_siblings` Series, where both hardware threads of a core are busy, does not
  split either.

**Inferred.** The level is a property of the physical host that the guest cannot see. From
the one fast box, it seems to concern what the host does with an idle sibling hardware
thread: the difference showed with the sibling idle or offline, and not in its three
processes with the sibling busy. The fast share differs between the two types (15 of 56
boots against 5 of 58, leaving out the Run between; two-sided Fisher's exact test,
p = 0.014), which fits a property of a pool of hosts.

**Unknown.** What makes a host fast or slow. Ruled out from inside the guest: where the
stack and heap land, address randomisation, the CPU used, the sibling's state as the guest
can set it, the clock, the microcode as reported, the guest kernel and its idle driver,
speculative store bypass disable, and the memory system outside the core. The machines
expose no performance counters, and only AWS sees the host. Also unknown is how common
fast hosts are: the boxes started by hand found one in 19 (none of 12 small `c6i` and
`m6i` boxes, not the one `c6i.8xlarge`, one of six `i4i.2xlarge`), fewer than among the
pipeline's `c6i.8xlarge` boots. Whether the share depends on the instance size, the pool of
hosts or the time is not known.

### Without an idle thread: where the code lands

**Which Series.** `one_cpu` with `idle_threads` 0. The investigation swept it on Ice Lake
(the processor of `c6i.8xlarge` and `i4i.2xlarge`) and on `m5.large` (Intel Cascade Lake).

**What the recorded Runs show.** Nothing of placement: nothing in a Run records where its
code landed. Where a Series' Runs ran one binary, its figure is that binary's, with the
code where that binary has it; version 1 can also put Runs of several binaries, each in
a group of its own, into one Series' percentiles. On `c6i.8xlarge` this set gives the same
figure on both kinds of boot (medians of 43,015 and 43,020 ns per repetition, fast and
slow boots).

**How far it moves.** Each box rebuilt the pipeline's exact binary (the same hash) from its
source archive, with the Run's own build command. Then it linked the same objects again,
with only their addresses changed: each hot object's code alignment set to one byte, and
padding with no code between the objects. The instruction bytes stayed the same. Four
sweeps moved `pthread_mutex_lock` alone, `pthread_mutex_unlock` alone, the benchmark's loop
alone, and all three together, each in 31 steps of 2 bytes across a 64-byte line: 125
builds with the one they start from, besides the pipeline's own binary. Each ran twice,
three samples each, with no idle thread, on CPU 0. The figure is the lowest of the six
samples. One clock cycle per critical section at 3.5 GHz is about 2,857 ns per repetition
of 10,000 critical sections, 0.29 ns per critical section.

- **Ice Lake** (four boxes: two `c6i.large`, an `m6i.large` and a `c6i.2xlarge`, with the
  same processor as `c6i.8xlarge` and `i4i.2xlarge`; they agree within 0.5% in nearly every
  build): the figure moves in steps of about one clock cycle per critical section, 6.2% of
  the build the sweeps start from (about 45,900 ns per repetition) and 6.6% of the published
  binary's (about 43,000). Across all 125 builds it spans about 43,000 to 51,600 ns per
  repetition on each box, 20%. In the sweep that moved the lock alone, which tried only odd
  offsets, `pthread_mutex_lock` was fast only when it started 39 to 47 bytes into a 64-byte
  line. At most other offsets it cost one or two cycles more; at offsets 1 and 3 it cost
  about 4% (on one box 47,646 and 47,869 ns, against 45,917 for the build the sweep starts
  from). The published binary measured 42,974 to 43,013 ns on these boxes, within about
  0.06% of the fastest build on each box: as fast as the fastest layout, within the
  variation of the measurement.
- **`m5.large`** (one box, two rounds that agree within 0.26%, median): across all 125
  builds the figure spans 67,900 to 100,300 ns per repetition, against 76,600 for the
  published binary. The best build is 11% faster than the published binary, the worst 31%
  slower.
- Where the functions land relative to each other matters as well as where each one lands.
- Not swept: `c8i.2xlarge`, `c8a.2xlarge`, and the `smt_siblings` set. An earlier
  investigation (2026-11-24, issue #84) moved the code to four places: on `c8a.2xlarge` the
  figure spread by 12.5%, with the published binary 7.7% slower than the best; on
  `m5.large`, `smt_siblings` spread by 11%.

**Shown.** Moving any one of the three functions within its 64-byte line, with its bytes
unchanged, switches the extra cycles on and off.

**Inferred.** The cause is the processor's front end, which feeds decoded instructions to
the core. A model of it fits most of the Ice Lake results. The model assumes that the
front end delivers up to six micro-operations per cycle from one 64-byte window and stops
at each taken branch; it counts each instruction as one micro-operation, a compare, test
or simple arithmetic instruction together with the conditional jump after it as one, and a
call or an instruction that reads, changes and writes memory as two. One critical section is 11 taken branches in about 15 cycles, so
under the model it is limited by how fast instructions arrive, and a short stretch of code
between two taken branches that spans two windows costs a cycle. Laid out from each
binary's function addresses, the model explains about 82% of the variation across the 126
binaries (the 125 builds and the pipeline's) on each Ice Lake box (R² 0.820, 0.826, 0.818
and 0.822); the same model with 32-byte windows explains about 37%. Some results do not
fit it, such as the lock at offsets 1 and 3. On `m5.large` this model explains almost none
of the variation (R² 0.020 with 64-byte windows, 0.010 with 32-byte ones). Counting the hot
branches that cross or end on a 32-byte boundary, which a known erratum of that processor
family slows, explains about half (R² 0.498); the rest is not explained. The machines
expose no performance counters, so the front end itself was not watched.

**With an idle thread, placement barely matters.** Compare the same 32 builds, the one the
sweeps start from and the 31 that move all the code together, with and without the idle
thread. With it (run once each, the lowest of three samples), they span 0.46 to 0.48% on
three Ice Lake boxes, 3.33% on the fourth (183,242 to 189,349 ns per repetition), and
2.94% on `m5.large` (174,544 to
179,682). Without it (the lowest of six samples), the same builds span 18.98 to 19.50% on
the four Ice Lake boxes and 33.75% on `m5.large` (67,914 to 90,831). Inferred: the two
atomic instructions take most of the time, so instruction delivery has time to spare.

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
- **New:** the two uncontended sets (single-threaded and multi-threaded), the siblings
  set, the eight-line set, the events `cpu_pair` and `mutex_threads`, and the guard's count
  of lost increments. July's guard
  was the shared counter alone.
- **What is common to every port:** the output is the event stream
  (`docs/dev-log.md` section 2), the binary is linked statically, and the harness takes
  samples the way July's did (one repetition, then doubling until a sample lasts a second,
  then `LM_SAMPLES` counted samples), emitting the warmup samples July discarded.
