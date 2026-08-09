# LedgerMath

Continuous napkin math: an open, permanent ledger of raw performance observations from real data-center hardware and services, plus the auditable math that turns them into usable numbers.

## Language

### Data model

**Observation**:
An immutable, timestamped record that a specific Artifact ran against a specific Target and what was measured raw. Never edited, never deleted.
_Avoid_: fact, result, data point, measurement (as a noun for the record)

**Ledger**:
The append-only, permanent, open store of all Observations.
_Avoid_: database, warehouse, data lake

**Method**:
A versioned, auditable procedure that turns Observations into a Derivation. Observations + Method = Derivation, deterministically.
_Avoid_: formula, model, calculation

**Derivation**:
A number derived from Observations by a Method, citing both. Versioned and supersedable; recomputable by anyone.
_Avoid_: inference, estimate, insight

### Measurement

**Target**:
The thing a benchmark measures: a Machine or a Service, identified durably (type, region, zone).
_Avoid_: platform, environment

**Machine**:
A Target we own and control root-to-metal for the duration of a run (e.g. an EC2 bare-metal instance type). The machine type is the measurement.

**Service**:
A managed Target we cannot control internally (e.g. S3, Lambda), measured from the outside.

**Artifact**:
The exact benchmark code and build recipe that produced an Observation, preserved forever so the Observation is auditable.
_Avoid_: binary, script

**Benchmark**:
A program measuring one class of operation (e.g. `memory_read`); emits result records per Variant.

**Variant**:
One specific configuration of a Benchmark (e.g. "1 thread, SIMD"). Unique within its Benchmark.
