# Ingest verdicts are versioned and superseded, never edited

_Changed by ADR-0029: there is no ingest step and no Verdict record; whether a Run counts is decided by the Method that reads it, named with its version in its Derivations._

The declared-versus-observed comparison at ingest is a versioned Method; a Run records the Verdict and the version that reached it, and when the Method changes CI appends a new Verdict record for every Run whose verdict changed, so a Run counts when it completed and its latest Verdict is ok. An immutable status was rejected because a bug in the comparison, such as a mask that drops a field, would leave Runs recorded as ok that ran on undeclared hardware, with only an Annotation to say otherwise. Versioned Verdicts keep every Run a true record and every judgement attributable to the code that made it.
