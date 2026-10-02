# Reproducibility is a merge gate

Every Artifact is built twice on independent runners and the pull request fails if the hashes differ; after merge CI builds again from the merge commit and must match, and pull requests must be up to date with main before merge. Provenance-only, trusting a single CI build, was rejected because the Artifact tested on the branch would then be tied to a commit no clone keeps after a squash merge, and a non-deterministic rebuild from main would run bytes nobody transition-tested. The gate costs one extra build per Artifact per pull request.
