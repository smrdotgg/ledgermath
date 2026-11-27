# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`site/content/docs/glossary.md`**: the public glossary, the words a reader of the data API meets, as the built system uses them. This is the project's vocabulary.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in, starting with ADR-0029 (`docs/adr/0029-record-every-run-and-judge-afterwards.md`), which says which of the earlier ones are in force as built.
- **ADR-0029's table "The terms of `CONTEXT.md`, as built"**: for each term of the design specified before anything was built (ADR-0001 to ADR-0028), whether it is in force as defined, in force with a difference, or was never built. Read it when an older ADR, issue or dev-log entry uses one of those terms.

There is no `CONTEXT.md` and no `CONTEXT-MAP.md`. `CONTEXT.md` was retired on 2026-11-27; do not create one, or any other glossary file. A skill that would create or update `CONTEXT.md` (such as `/domain-modeling`) puts vocabulary in the public glossary instead, and decisions in a new ADR.

## File structure

```
/
├── site/content/docs/glossary.md      ← the vocabulary
├── docs/adr/
│   ├── 0001-run-is-the-only-record.md
│   ├── …
│   ├── 0029-record-every-run-and-judge-afterwards.md   ← what stands as built; the old terms' table
│   └── …
└── …
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as the public glossary defines it. A term of the earlier design that ADR-0029's table marks "Not built" names nothing that exists; don't use it for the built system.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it in the issue or pull request you are working on).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0026 (nothing between the clock and the wire) — but worth reopening because…_
