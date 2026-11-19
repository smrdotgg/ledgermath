# The data snapshot the home-page variations show

Five files of LedgerMath's data API, exactly as its generator wrote them, so that every
design on the `home-variations` branch shows the same true figures. `site/src/data/` reads
them at build time; nothing reads them in the browser.

| File | What it is |
|------|------------|
| `v1/index.json` | The API's table of contents |
| `v1/series.json` | One summary row per Series (187) |
| `v1/prices/2026-11-19.json` | The newest price file the index names (`prices.newest`) |
| `v1/series/c2d748916b19.json` | One Series' own file, as a sample: mutex on c8i.2xlarge, a headline Series, the smallest of the 70 |
| `v1/schemas/series.schema.json` | The schema of a Series' own file, whose words the module quotes |

The other per-Series files (`v1/series/<id>.json`, 38 MB in all) are left out; the pages link
to them by the `url` each row carries. The one sample lets `site/src/data/` say exactly what
such a file holds (`seriesFileContents`).

**The Series file's layout will change.** It is to be split by month (issue #64), so a design
describes it in general terms ("each Run's figure and a link to its evidence"), never promising
a layout: not "one file per Series", not a field's place in it.

`index.json`'s `docs` field gives the README on GitHub, in a private repository. The file is
kept as the generator wrote it; the module gives the planned public address,
`https://ledgermath.com/docs/`, instead.

## What made it

- Generator: `scripts/build-api.ts` on pull request #67's branch `t3/build-static-data-api`,
  commit `4d7a71d4be1444296cd6374686a9a86da6728db7`, run with Bun 1.4.4 on 2026-11-19.
- Derivations: `derivations.json` (sha256
  `62aac0c0e7b8292b66fc4dd67e2a37414547792525fe65e1400726fb6c30702e`) and
  `requests-derivations.json` (sha256
  `85ea2cdcf08bd53e9a6d46f33e3d21ec386141af9eeafae1614a5a80289a526b`), the page-4 build of
  the production cutover.
- Runs repository: a checkout of `ledgermath-runs` at commit
  `9e106738487b377ca19ba8c9cd803eafcbe7c8f1`.

```bash
bun scripts/build-api.ts --derivations page-4/derivations.json \
  --requests-derivations page-4/requests-derivations.json \
  --runs ledgermath-runs-verify --out api-tree
bun scripts/check-api.ts --tree api-tree --derivations page-4/derivations.json \
  --requests-derivations page-4/requests-derivations.json --runs ledgermath-runs-verify
# data API v1: 202 files checked, 187 Series, 6335 Run files cited and found with their sha256, no problem
```

The five files were then copied from `api-tree/v1/` unchanged (the last two on 2026-11-19, from
the same tree):

| File | sha256 |
|------|--------|
| `v1/index.json` | `601578148c6d9a79794bf2ff46bd13be05b3c9e4c9708dabf1b09544c90c4140` |
| `v1/series.json` | `922722a46a0c659e3b64f81d50cc26050c74b19dfa687c43e3a0e998070531a7` |
| `v1/prices/2026-11-19.json` | `b001a3bb6ae619c80bbd4ecec244d7e870ce82c7ca969783490fa6d78691001d` |
| `v1/series/c2d748916b19.json` | `71dcdc0cc4446f9ea137a93af1967401e939d99faae60e0c9338f6b53181b041` |
| `v1/schemas/series.schema.json` | `afdd4e8da49ad366764d685041fb19314934cb2e6804f528bd1ef90051cf5db6` |

The newest Run in it started at 2026-11-19T17:07:23.182448102Z.

## Replacing it

Run the two commands above on newer inputs, copy the same five files over these (the price
file under its own date), change the price file's import in `site/src/data/snapshot.ts` to
the new date (and the sample Series file's, if its id changes), update this file, and run `bun test` in `site/`: the data module's tests check
that the price file is the one the index calls newest and that every headline row still
finds its Series.
