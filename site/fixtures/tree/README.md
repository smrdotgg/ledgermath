# The test fixture tree

A small tree of LedgerMath's data API, in the API's own layout, for the site's tests
(`bun test` in `site/`). **The site is never built from it for publishing**: a build is
always given a tree on purpose (`--tree DIR` or `LEDGERMATH_TREE`), and the published site
is built from a tree fetched from the API (`bun run fetch-tree DIR`) or, later, from the
tree the `runs` workflow builds.

| File | What it is |
|------|------------|
| `v1/index.json` | The table of contents, with `recent_rounds` added by hand (below) |
| `v1/series.json` | The list of the 187 Series, each with its figures |
| `v1/prices/2026-11-19.json` | The newest price file the table of contents names |

These are the three files the site reads; the Series files, month files and schemas are left
out. The figures are real: the API as its generator wrote it on 2026-11-19, the snapshot
every home-page design was drawn from (issue #64). Generator: `scripts/build-api.ts` at
commit `4d7a71d`; newest Run 2026-11-19T17:07:23.182448102Z. The tree predates the API's
split by month, so its table of contents has no `layout` or `months`; version 1 only gains
fields, so it is still a version 1 tree.

**`recent_rounds` is added by hand**, in the shape the API is to give it (each round's
`started_at`, `boots`, `runs` and `failed_runs`, newest first). Its three rounds were counted
by hand from that day's boot records, the boots that started at or before the newest Run:
five boots and 187 Runs each, every one of them exited 0, and the tree counts no failed Run.
When the API gives `recent_rounds`, replace this fixture with a tree it wrote.

The tests change copies of these files in memory or in temporary directories (a Series
removed, a round with failed Runs, no `recent_rounds`), never the files themselves.
