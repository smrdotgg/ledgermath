# The home-page variations: a guide for design workers

Eight very different designs of LedgerMath's home page, built side by side on the branch
`home-variations` and judged from screenshots, round after round (issue #64). Each design
lives in its own directory, `site/src/variations/v<n>/`, and is built, screenshotted and
checked on its own. Nothing here is merged to `main`: `main` deploys to the public site.

## What you may touch

**Only your design's directory, `site/src/variations/v<n>/`.** Not another design's, not
`src/data/`, not the scripts, not `package.json`. The publish script refuses to merge a branch
that changes anything outside its directory, and the build fails if your page imports a file
outside it (other than `src/data/` and installed packages). If you need something shared
changed, say so in your report instead.

Your directory holds:

| File | |
|------|---|
| `Page.tsx` | Required. The page's content: a Solid component, default export, no props |
| `Document.tsx` | Required. The whole `<html>` document around the page: `lang`, `<head>` (title, meta, preloads), `<body>{props.children}</body>`. The build adds your stylesheet to `<head>` |
| `meta.json` | Required. `{"name": "…", "idea": "…"}`: the design's name (up to 40 characters) and its idea in one line (up to 200), shown on the picker |
| `*.css` | Your styles: import them from `Page.tsx` (`import "./page.css"`). They are bundled into one file |
| fonts, images | Import them from CSS (`url("./fonts/x.woff2")`) or TSX (`import mark from "./mark.svg"`); they are hashed and served beside the page |
| `public/` | Optional. Copied as it is to the page's directory (`/v<n>/…`); link with relative URLs |
| `client.ts` | Optional. Behaviour in the browser (copy a command, sort a table), bundled on its own and loaded as a module script. Plain TypeScript and the DOM: it must not import `src/data/` |
| `third-party-notices.txt` | Required if you serve a font or other third-party file: its name, copyright and licence text. Served at `/v<n>/third-party-notices.txt` |

## How the page is built

`Page.tsx` is rendered **once, at build time**, to static HTML and CSS (Solid's server
renderer; `src/variations/entry-server.tsx`). Nothing hydrates: signals, effects and event
handlers in your components never run in the browser. Write the page as markup. Anything that
must happen in the browser goes in `client.ts`, and the page must read the same without it.

## The data, and its rules

Import everything from `src/data/` (`import { headline, machines, snapshot, links, formatRate } from "../../data"`).
It reads one snapshot of the data API (`site/data/snapshot/`), the same for all eight designs.
Read the header of `src/data/index.ts`; in short:

1. **Every figure comes from the module, exactly as the snapshot holds it.** Never invent,
   estimate or compute a statistic: no averages across machines, no ratios ("price per GB/s",
   "3× faster"), no trends, no "typical" values. The only arithmetic allowed is a change of unit,
   and the helpers do it exactly.
2. **Exact figures.** `formatRate`, `formatDuration`, `formatBytes`, `formatUsd`, `formatCount`
   and `formatMoment` return `full` (every digit) and `short` (rounded, with `rounded: true`).
   If you show `short`, give `full` too: a `title` attribute, a second line, a footnote.
3. **The home table is the headline selection**: `headline`, 14 rows (one per benchmark) × 5
   machine types, chosen by the written rule in `src/data/headline.ts`. Each row has its
   `choice` (label, what it measures, what one repetition is, the settings) and `leadFigure()`
   names the figure that leads it. You may show more Series (`series`, `benchmarks[i].settings`),
   never other figures for the headline rows.
4. **Links** go to the snapshot's own addresses: `links.index`, `links.seriesList`,
   `links.prices`, `links.docs`, `links.schemas`, and each Series' `url`. They do not answer yet:
   link them, never fetch them.

Also there: `machines` (five types, cheapest first, with vCPU, memory, processor and the hourly
On-Demand price), `benchmarks`, and `snapshot` (newest and oldest Run, counts of Series and
Runs, the price file's date, the API's own words about itself, the Methods' definitions).

## What every design must do

- Light and dark, following `prefers-color-scheme`.
- Phone (390 px) and desktop (1440 px) widths, with no horizontal scroll on a phone (a wide table
  may scroll inside its own box).
- Read fully with JavaScript off.
- Load nothing from another origin: system fonts, or font files you serve yourself under an open
  licence, with `third-party-notices.txt`.
- Transfer under 300 KB compressed, everything included.
- Pass axe-core's contrast and structure rules in light and dark: one `<main>`, one `<h1>`,
  headings in order, all content inside landmarks.

`bun run check:variation v<n>` checks all of this. Run it before you take your screenshots.

## Commands

Once, in your checkout:

```bash
git fetch origin
git switch -c home-v<n> origin/home-variations   # or, in later rounds: git switch home-v<n> && git merge origin/home-variations
cd site
bun install --frozen-lockfile
bunx playwright install chromium                 # once per machine; already done on the dev machine
```

Then, inside `site/`:

```bash
bun run dev v<n>                    # build, serve at http://127.0.0.1:4174/v<n>/, rebuild on every change (reload to see it)
bun run build:variation v<n>        # build only your design, into dist/variations/v<n>/
bun run check:variation v<n>        # every check above; exit 1 on any failure
bun run shots v<n> --out DIR        # the eight screenshots the judges see, plus shots.json
```

`shots` writes `desktop-{light,dark}-{first,full}.png` and `phone-{light,dark}-{first,full}.png`
(1440×900, and 390×844 at device scale 2; `first` is the first screen, `full` the whole page),
and exits 1 if the page logs an error, fails to load something or reaches another origin.

## Committing and pushing

- Work on your branch, `home-v<n>`, made from `home-variations`. Commit only files under
  `site/src/variations/v<n>/`.
- **Commit before you take the round's screenshots.** `shots.json` records the commit, and a
  checkpoint tags the commit that was screenshotted and judged.
- Push your branch: `git push origin home-v<n>`. **Never push `home-variations`**, and open no
  pull request: the orchestrator's publish script merges the eight branches and pushes
  `home-variations` once a round, which makes the round's one preview deployment.
- At the start of a round, merge the latest `home-variations` into your branch
  (`git merge origin/home-variations`) to pick up shared fixes.

## How a round ends (for reference)

The judges score every design's screenshots in eight categories, 1 to 10. The orchestrator runs
`bun run variations:publish` (`site/scripts/variations-publish.ts`), which merges the design
branches, records the scores in `site/variations/scores.json`, and freezes a design at
checkpoint T (7, 8, 8.5, 9, 9.5, 10) the first time every judge gives it at least T in every
category: tag `home/v<n>/cp-<T>`, a copy served at `/checkpoints/v<n>/cp-<T>/`. The picker at `/`
of the preview lists the designs, their checkpoints and every round's scores.
