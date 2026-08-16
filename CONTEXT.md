# LedgerMath

Continuous napkin math: an open, permanent ledger of raw performance observations from real data-center hardware and services, plus the auditable math that turns them into usable numbers.

## Language

### Data model

**Observation**:
An immutable, timestamped record of what one Variant measured raw when a specific Artifact ran against a specific Target. Never edited, never deleted.
_Avoid_: fact, result, data point, measurement (as a noun for the record)

**Run**:
One execution of an Artifact against a Target. Every execution produces exactly one Run record — success or failure — holding its outcome; a failed Run has no Observations.
_Avoid_: job, invocation

**Annotation**:
An append-only Ledger record declaring that the Series in its scope stop being comparable at a stated boundary, and why. May supersede or cancel an earlier Annotation; never edited, never deleted.

**Ledger**:
The append-only, permanent, open store of all Observations, Runs, and Annotations.
_Avoid_: database, warehouse, data lake

**Method**:
A versioned, auditable procedure that turns Observations into a Derivation. Observations + Method = Derivation, deterministically.
_Avoid_: formula, model, calculation

**Derivation**:
A number derived from Observations by a Method, citing both. Versioned and supersedable; recomputable by anyone.
_Avoid_: inference, estimate, insight

### Measurement

**Target**:
The thing a benchmark measures: a Machine or a Service, identified durably by a provider-specific structured identity (for an AWS EC2 Machine: instance type, region, availability zone, operating system), rendered canonically as a slug.
_Avoid_: platform, environment

**Machine**:
A Target we own and control root-to-metal for the duration of a run (e.g. an EC2 bare-metal instance type). The machine type is the measurement.

**Service**:
A managed Target we cannot control internally (e.g. S3, Lambda), measured from the outside.

**Artifact**:
The exact binary that ran, identified forever by its content hash, together with the build record(s) — source commit, containerized build environment, build parameters — that reproduce it. Two builds that yield byte-identical binaries are builds of the same Artifact.
_Avoid_: script

**Benchmark**:
A program measuring one class of operation (e.g. `memory_read`); emits result records per Variant.

**Variant**:
One specific configuration of a Benchmark (e.g. "1 thread, SIMD"). Unique within its Benchmark.

**Series**:
The time-ordered history of Observations for one Variant on one Target — one chart line. What regression alarms watch and Annotations apply to.
