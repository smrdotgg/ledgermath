# LedgerMath

Continuous napkin math: an open, permanent ledger of raw performance measurements from real data-center hardware and services, plus the auditable math that turns them into usable numbers.

## Language

### Data model

**Run**:
One execution of one Artifact for one Station, recorded whether it succeeded or failed, holding everything the binary emitted and every fact observed about the Targets involved. Exactly one per execution; the citable unit.
_Avoid_: observation, result, data point, job, invocation

**Series**:
The time-ordered Runs with status ok for one Station. One chart line; what Annotations segment and alarms watch.

**Annotation**:
An append-only Ledger record, anchored at an Artifact hash or a timestamp and scoped to a set of Series, saying why those Series stop being comparable there. Superseded or cancelled, never edited or deleted.
_Avoid_: note, comment, version bump

**Ledger**:
The append-only, permanent, open store of all Runs and Annotations.
_Avoid_: database, warehouse, data lake

**Method**:
A versioned, auditable procedure that turns Runs into a Derivation.
_Avoid_: formula, model, calculation

**Derivation**:
A number derived from Runs by a Method, citing both. Every published number is one.
_Avoid_: inference, estimate, insight, observation

### Measurement

**Benchmark**:
A program: one source directory declaring its parameters and roles, one PRD, built to one Artifact per architecture. An ownership unit, not a category.
_Avoid_: suite, test, category

**Variant**:
One fixed, named set of values for a Benchmark: the parameters delivered to its binary, and what it requires of the Target bound to each role. Immutable once merged; unique within its Benchmark.
_Avoid_: configuration, config, condition

**Role**:
A named slot a Benchmark declares for a Target it involves. Exactly one role runs the binary.
_Avoid_: vantage (as a Target field)

**Target**:
A Machine or Service that a Station binds to one of its Benchmark's roles, identified by a provider-specific structured identity rendered to a slug. For a one-role Benchmark, the thing measured.
_Avoid_: platform, environment, host

**Machine**:
A Target we control root-to-metal for the duration of a Run. The machine type is the measurement.

**Service**:
A managed Target we cannot see inside, measured from the outside.

**Station**:
A Variant with each of its Benchmark's roles bound to a Target. The identity of a Series and the unit the schedule is written in. Exists before it has data; retired by date, never deleted.
_Avoid_: job, deployment, config

**Visit**:
One launch of the Machine bound to the role that runs the binary, during which every Station due there gets one Run.
_Avoid_: session, batch

**Artifact**:
The exact binary that ran, identified forever by the hash of its bytes, with build records attached. Two builds that yield identical bytes are the same Artifact.
_Avoid_: script, build (as a noun for the binary)

**Event**:
A timestamped fact the binary emits at a phase boundary. A Run's payload is events plus observed facts and nothing else.
_Avoid_: log line, metric, measured region

**Observed counterpart**:
The fact recorded at Run time that proves a declared value held. Every declared value has one; a value with none cannot be declared.

**Fixture**:
The content a measured interval reads or writes, created by a Provisioner for a Station and pinned by recipe and checksum.
_Avoid_: test data, asset, payload (for the fixture)

**Provisioner**:
Code, one per Target kind, that declares which state and fixture keys it can realize and how each is observed back, and that creates fixtures and establishes state before a Run.
_Avoid_: bootstrap, setup script, Visitor

**Manifest**:
The typed file in git that declares every Target, Benchmark, Variant, and Station.
_Avoid_: config, registry (for the manifest)

### Comparability

**Setup hash**:
The hash of everything about a Station other than its Artifact that could move its numbers: its Variant, its bound Targets, the Provisioners involved, and the on-box runner. The second boundary signal beside the Artifact hash.

**Boundary**:
A point on a Series where the Artifact hash or the setup hash differs between consecutive Runs. Splits the Series by default.

**Transition run**:
Old and new alternated on one Machine within one hour, per Station, reporting whether the numbers moved. The controlled experiment that resolves a boundary.

**Boundary state**:
Verified unchanged, declared changed, changed but unexplained, or unverified.
