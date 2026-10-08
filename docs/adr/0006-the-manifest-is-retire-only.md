# The manifest is retire-only

Nothing in the manifest is deleted. Variants, Stations, and parameter keys are retired by date, keep their names forever, and can be un-retired through the normal gate. A key may be renamed only by a commit that CI can prove, by diff, changed nothing but the name, in the schema and in every entry that uses it. Deletion was rejected because a dormant entry can outlive a key and a freed name can be reused with a new meaning, and neither can be caught by a diff, while a pure rename can.

Amended by the resolution of #18: Targets are retired by date as well, and retirement and revival are recorded as an append-only list of events on the entry rather than a single date.
