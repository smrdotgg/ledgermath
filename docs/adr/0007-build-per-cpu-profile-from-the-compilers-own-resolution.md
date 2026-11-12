# Build per CPU profile, from the compiler's own resolution of native

_Superseded by ADR-0029._

A Benchmark is built once per CPU profile: the line each compiler resolves `-march=native` to on the Machine, captured there by CI with the builder image and frozen in the manifest beside the raw Capture it came from, rather than once per instruction-set level or per model name. Levels and model names were rejected because the project's numbers are meant to be the fastest the hardware can do, and only the compiler's own resolution enables every feature and cache parameter it knows for that silicon while staying reproducible in a container anywhere, since the resolved line is explicit. The cost is one build per profile and a re-capture whenever the compiler or the hardware changes, which CI performs in the pull request that causes it. Amends ADR-0002, where "architecture" now reads "CPU profile".

Amended by ADR-0017: native stays the default, and a Variant may opt into a named level.
