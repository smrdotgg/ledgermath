# The Archive lives outside git, with a checkpointed index in the Ledger

_Superseded by ADR-0029._

Artifact bytes, bundles, builder images, and Captures live in a content-addressed object store (Cloudflare R2 as the serving copy, an S3 compliance-mode copy as the undeletable one), while their index and build records live in the Ledger, a data repository separate from this code repository, as files that are added and never modified, with a signed Checkpoint published on every append that mirrors and verifiers pin and refuse to fork. Keeping bytes in git was rejected once static glibc made Artifacts a megabyte each, which would have grown the Ledger by gigabytes a year. The index is a transparency log rather than a plain repository because branch protection does not bind administrators and git's SHA-1 is not the strong hash; cryptographic strength comes from the sha256 values in the index files and the signed Checkpoint.
