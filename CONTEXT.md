# LedgerMath

Continuous napkin math: an open, permanent ledger of raw performance measurements from real data-center hardware and services, plus the auditable math that turns them into usable numbers.

## Language

### Data model

**Run**:
One execution of one Artifact for one Station, recorded whether it succeeded or failed, holding everything the binary emitted and every fact observed about the Targets involved. Exactly one per execution; the citable unit.
_Avoid_: observation, result, data point, job, invocation

**Series**:
The time-ordered Runs of one Station that count: completed, with a latest Verdict of ok. One chart line; what Annotations segment and alarms watch.

**Annotation**:
An append-only Ledger record, anchored at an Artifact hash or a timestamp and scoped to a set of Series, saying why those Series stop being comparable there. Superseded or cancelled, never edited or deleted.
_Avoid_: note, comment, version bump

**Verdict**:
Ingest's judgement that a Run's declared values matched their observed counterparts, made by a versioned Method and recorded with its version. Superseded by a later Verdict when the Method changes, never edited.
_Avoid_: status (for the judgement), validation result

**Ledger**:
The append-only, permanent, open store of all Runs, Annotations, Verdicts, and Build records.
_Avoid_: database, warehouse, data lake

**Method**:
A versioned, auditable procedure that turns Runs into a Derivation.
_Avoid_: formula, model, calculation

**Derivation**:
A number derived from Runs by a Method, citing both. Every published number is one.
_Avoid_: inference, estimate, insight, observation

### Measurement

**Benchmark**:
A program: one source directory declaring its parameters and roles, one PRD, built to one Artifact per CPU profile. An ownership unit, not a category.
_Avoid_: suite, test, category

**Variant**:
One fixed, named set of values for a Benchmark: the parameters delivered to its binary, and what it requires of the Target bound to each role. Immutable once merged; unique within its Benchmark.
_Avoid_: configuration, config, condition

**Role**:
A named slot a Benchmark declares for a Target it involves. Exactly one role runs the binary.
_Avoid_: vantage (as a Target field)

**Target**:
An offering of one Kind that the provider names at a place, such as an instance type in a zone or a storage class in a Region, which a Station binds to one of its Benchmark's roles. Identified by a structured identity in the provider's own words, rendered once to a slug; exists whether or not we have created anything. For a one-role Benchmark, the thing measured.
_Avoid_: platform, environment, host, resource

**Machine**:
A Target that boots our image and runs our binary as root for the duration of a Run. The machine type is the measurement; bare metal or guest is a fact of the type.

**Service**:
A managed Target we cannot see inside, measured from the outside.

**Kind**:
The provider product a Target belongs to, such as EC2 or S3, named `<provider>.<product>`. Each Kind has one Provisioner, one identity schema, one registry, and one environment schema, and is either a Machine kind or a Service kind. The same role as `kind` in a Kubernetes manifest.
_Avoid_: type, class, product (for this); kind (for Machine or Service)

**Target Instance**:
A resource a Provisioner creates from a Target for a Station or a Visit: an EC2 instance, a bucket, a function. Configured by the Station's requirements, it holds the Station's Fixtures and is named in the Run by the provider's own identifiers.
_Avoid_: instance (bare), resource, deployment

**Station**:
A Variant with each of its Benchmark's roles bound to a Target. The identity of a Series and the unit the schedule is written in. Exists before it has data; retired by date, never deleted.
_Avoid_: job, deployment, config

**Visit**:
One boot of the Machine Target Instance bound to the role that runs the binary, launched fresh or rebooted if kept and preceded by any launch attempts it took, during which every Station due there gets one Run.
_Avoid_: session, batch

**Artifact**:
The exact binary that ran, identified forever by the hash of its bytes, with build records attached. Two builds that yield identical bytes are the same Artifact.
_Avoid_: script, build (as a noun for the binary)

**Event**:
A timestamped fact the binary emits at a phase boundary. A Run's payload is events plus observed facts and nothing else.
_Avoid_: log line, metric, measured region

**Observed counterpart**:
The fact recorded at Run time that proves a declared value held. Every declared value has one; a value with none cannot be declared.

**As-booted value**:
The value a state key has on a fresh box of a Target before the Provisioner writes anything, captured in the Capture, or pinned in the Provisioner bundle for a key the box cannot see. What a Variant silent on that key declares.
_Avoid_: default, baseline

**Fixture**:
The content a measured interval reads, created by a Provisioner for a Station and pinned by recipe and checksum. What a binary writes during a Run goes to an area of its own and is never a Fixture.
_Avoid_: test data, asset, payload (for the fixture)

**Provisioner**:
Code, one per Kind, that declares which state and fixture keys it can realize and how each is observed back, and that creates Target Instances and Fixtures and establishes state before a Run.
_Avoid_: bootstrap, setup script, Visitor

**Manifest**:
The typed TypeScript files in git, one per Benchmark, one per Variant with its Stations, and one per Target, that together declare every Target, Benchmark, Variant, and Station.
_Avoid_: config, registry (for the manifest)

### Build and Archive

**CPU profile**:
What a Machine's processor is, for building: the processor section of one Capture plus the line each compiler resolved `native` to on that Machine, identified by the hash over both. Bound by one Target, never shared, never edited.
_Avoid_: architecture, arch, target triple

**Capture**:
Everything a Machine's box and its provider's API report about it, dumped raw and unmasked by the runner on every Run and when a CPU profile is made: a processor section (what the processor and kernel report about the CPU), the kernel's view of memory, NUMA layout, devices, and controls, and the instance type's catalog record. Identified by the hash of its bytes; frozen per Target as booted.
_Avoid_: cpuinfo, fingerprint, hardware id, inventory, facts dump

**Build record**:
The record of one build: the source commit, the builder image digest, and the CPU profile it was built for. Several may attach to one Artifact.
_Avoid_: provenance (as a noun for the record), build metadata

**Archive**:
The content-addressed, public, permanent store of the bytes behind every hash a Run cites: Artifacts, provisioner and runner bundles, builder images, and Captures. Indexed by the Ledger.
_Avoid_: artifact store, blob store, bucket (for the store)

**Checkpoint**:
The signed statement published with every append to the Archive's index, naming the index commit, its tree hash, the entry count, and the time. What mirrors and verifiers pin, and what a Run cites for its Artifact's publication.
_Avoid_: snapshot, tag

**Withdrawn**:
The state of an Archive entry whose bytes have been removed from public copies by a reviewed index commit recording the reason and the date. The hash and the Build records stay, and Runs that cite it remain valid.
_Avoid_: deleted, yanked, removed

### Comparability

**Setup hash**:
The hash of everything about a Station other than its Artifact that could move its numbers: its Variant, its bound Targets with their CPU profiles, the Provisioners involved, and the on-box runner. The second boundary signal beside the Artifact hash.

**Boundary**:
A point on a Series where the Artifact hash or the setup hash differs between consecutive Runs. Splits the Series by default.

**Transition run**:
Old and new alternated on one Machine within one hour, per Station, reporting whether the numbers moved. The controlled experiment that resolves a boundary. Its result is keyed by the pair of hashes and the Station, so an unrelated merge never forces a re-run.

**Boundary state**:
Verified unchanged, declared changed, changed but unexplained, or unverified.
