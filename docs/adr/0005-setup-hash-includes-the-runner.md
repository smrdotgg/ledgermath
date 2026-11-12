# The setup hash includes the on-box runner

_Superseded by ADR-0029._

The setup hash that puts boundaries on a Series covers the Variant, the bound Targets, the provisioner bundles, and the on-box runner bundle, so a change to the runner's on-box code puts a boundary on every Series. The runner shares the box during measured intervals and can move numbers, for example by writing logs to disk during a disk benchmark or sending heartbeats during a network one, and excluding it would let numbers move with no boundary. The on-box runner is kept minimal so this is rare, and a runner change is verifiable by an ordinary transition run because old and new runner can be alternated on one box.
