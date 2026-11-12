# A silent state key is declared by the Target's as-booted value

_Superseded by ADR-0029._

A Variant declares only the state keys it requires. For every other key of the bound Kind, the Run's declared value is the Target's as-booted value: captured on a fresh box by the resolve job, or pinned in the Provisioner bundle for a key the box cannot see (the S3 route, the credit option, bandwidth weighting). The Provisioner sets that value and reads it back before every Run, so a kept box never carries a previous Station's tuning into the next Run. This looks like the schema default the #13 amendment forbids; it is not one, because the value is captured, hashed in the Target entry, observed on every Run, and compared exactly. Requiring every Variant to declare every realizable key was rejected because it multiplies Variants by the sorts of box (Intel and AMD metal, Nitro guests, Graviton) and leaks the sort of box into Variant names.
