# The Run is the only measurement record

The Ledger stores one record per binary execution, the Run, with a status field, and has no separate Observation record. Merging them lets a failed execution keep its partial event log as evidence and gives one URL scheme, `/r/{id}`. The word Observation was dropped because to a reader outside the project an observation is a conclusion, which is what this project calls a Derivation.
