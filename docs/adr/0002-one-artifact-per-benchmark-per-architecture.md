# One Artifact per Benchmark per architecture, no build-time parameters

A Benchmark builds to one Artifact per target architecture and has no build-time parameters, even though compiling per parameter value would give sharper hash boundaries. Any source change therefore puts a boundary on every Station of the Benchmark, and the transition run, which already runs on every affected Station before merge, shows which moved. This removes the author's judgement about which parameters select code; the cost is minutes of instance time per pull request.
