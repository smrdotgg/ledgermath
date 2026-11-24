# The agent tools read the data API

The agent skill's lookup tool and answer checker (#47) read one file, `derivations.json` (about 28 MB for 187 Series on 2026-11-23), from a directory or a web address. The data API (ADR-0030) is LedgerMath's product, its first readers are agents, and the skill is its first real reader. So the tools read the API, and an agent fetches a few small files, not 28 MB; and an awkward shape in the API shows up now, while changing it is free (#64). `scripts/lib/ledger-data.ts` reads the tree, `scripts/lib/lookup.ts` and `scripts/lib/citation.ts` answer and resolve from it, `tests/lookup-tree.test.ts` holds them to it, and the README ("The agent skill") says how they read.

## The decisions

1. **One source, the tree.** A location is `https://api.ledgermath.com` (when neither `--data` nor `LEDGERMATH_DATA` gives one) or any address or directory laid out the same way: `v1/`, with `runs/` and `boots/` beside it for the evidence the citations point to. The tools no longer read `derivations.json` or `requests-derivations.json`; nothing else in the repository read them through the tools (the page reads the Derivations directly). Citations keep their syntax: a Series citation resolves in its Series file under `series_v1` or `requests_v1`, a price citation in the price file the table of contents lists under that path.

2. **Links are followed, never built**, as the tree's rule 2 says: `v1/index.json` → the list → a row's `url` → the Series file → each month's `url`. Every link is absolute, under the address the tree was built for, which the table of contents gives as its own `url`; a link is read from the location at its path under that address. A directory, a copy at another address, the workflow's artifact and the API itself so read alike.

3. **Each command reads only what it needs.** `about` and `series`: the table of contents and the list. `show`: those and one Series file; month files only for Runs older than the Series file's newest points, newest month first, as far back as the Runs it lists. `prices`: the table of contents and one price file. The checker: the Series file of each Series an answer cites; for a citation of an earlier moment, the month files up to it; each Run file the answer links.

4. **The contract a reader is given is kept.** A `layout` the tool does not know (`KNOWN_LAYOUTS`) is refused, in words, before anything else is read; a test holds `KNOWN_LAYOUTS` to contain the generator's `LAYOUT`, so raising it fails until the tool is looked at. A month file's bytes must have the sha256 and size its Series file lists. On a mismatch, or a month file missing, the Series file is read again, then the month file, three times in all (`ATTEMPTS`), two seconds apart at a web address; while they still differ, neither is used and the error says the data are being updated and to try again in a few minutes (in a directory, that it holds two builds and should be put together again). A file that is not there is a 404, or a 403, which S3 answers behind the API for a key it does not hold (ADR-0031).

5. **Fetching is bounded.** 20 seconds per request, from the request to the body's last byte; a size limit per kind of file equal to the tree's own ceilings (`CEILINGS`, which a test holds `LIMITS` to), checked against `Content-Length` and again while the body is read, and 1 MB for a Run file (14 KB at most on 2026-11-23); no retry but the one of decision 4. Every failure is a sentence for the agent, never a stack trace.

6. **What the answers lose, because the tree does not hold it.** `show` no longer gives each group's number of Runs and its first and newest start, nor `series` a Series' number of boots: the Series file and the list hold neither, and reading every month file for them would make every `show` cost a year of month files. A group's counted Runs are still given, with its percentiles' count citation; a Series has one Run per boot. `about` reads no price file, so it names the price files and the one in use but no longer lists what that file holds; `prices` does, when no price matches.

7. **A Run link must be a Run of a Series the answer cites.** The checker finds it among those Series' points (newest points first, then the month its path names, then the others), and holds its bytes to the point's `sha256`. A link is also accepted as the Run file's address in the data API. The old rule, a Run of any Series, would need every month file of every Series.

8. **A trial's location is put together, not served.** `scripts/assemble-location.ts` copies `v1/` from the artifact `api` and the Run files and boot summaries it links from a clone of the Runs repository, reading the tree as the tools do and copying nothing unless all of it holds.

## What the tree does not tell a reader

Found while building this, for the API's maintainer; none is changed here.

- **How to read a copy.** That every link starts with the table of contents' `url` minus `v1/index.json`, and that a copy is read by stripping it, is nowhere in the tree's words.
- **One Series costs the list.** A reader may not build `v1/series/<id>.json`, so `show <id>` and every checked citation first fetch `v1/series.json` (193 KB, up to its 1 MB ceiling) for one address. A `series_url_template` in the table of contents, as `blob_url_template` is for blobs, would make it two small requests.
- **How long a cached copy may lag, and what a reader should wait.** The Series file and month file of one Series can be of different rounds for up to five minutes (the `max-age` of ADR-0031) or until the next upload after one that stopped. The tree says to compare sha256s (and, with #76, to fetch the Series file again), but not for how long, nor how many times; "a few minutes" has no number in its words.
- **Size limits.** The ceilings are in `scripts/lib/api-check.ts`; a reader outside the repository has no figure for what a sane limit per file is.
- **A refusal and a missing file look alike.** Behind the API, S3 answers 403 for a key it does not hold; the tree's words say nothing of 403.
- **What `layout` means to a reader.** Its description says a reader holding copies of month files made under another layout fetches them again, and v1 only gains fields, so a new layout never breaks a reader that parses JSON; refusing an unknown layout, as decision 4 does, stops the tool on a change of white space. Only a v2 changes meaning.
- **Group spans and boots** (decision 6): a group in the Series file has its facts and percentiles, not its count of Runs (counted or not) or its first and newest start. v1 may gain them.
- **The list and a Series file are not tied.** Rows carry no sha256 of their Series file, so a list and a Series file of different rounds cannot be told apart; the counts `series` and `show` print may differ by a round for a few minutes. Numbers are not affected: each citation names its moment.
- **A price file's copy cannot be checked.** The table of contents lists each price file's date, path and address, but no sha256 or size.

## Rejected

- **Building a Series file's address from its id** to skip the list: it breaks the tree's rule 2, and a reader that did would break the day the layout of addresses changed.
- **Reading every month file in `show`** to keep each group's Runs and span and the count of boots: a year on, `show` of one `http_get` Series would fetch about 32 MB, more than the one file it replaces.
- **Telling an agent to try a directory again later**: a directory does not change by waiting. It is read again without a pause, and the error says it holds two builds and how to put it together again.
- **Keeping `derivations.json` as a second source** for the checker: two sources would let the tool and the API drift apart, which is what reading the API is meant to show.
- **A cache on disk between commands**: each command reads afresh, so an agent's numbers are never older than what the location serves.
