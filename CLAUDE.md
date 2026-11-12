# LedgerMath

LedgerMath is a server benchmarking tool.

It will initially only run on AWS.

It will run daily.

The benchmarking will need to be as precise as possible, so we will be using a low level language for that. (Whatever language we pick will likely use assemble for the hot path between when the "main event" runs - ensuring we get peak performance and minimal noise during that period.)
I have no strong opinion on what low level language we decide to use. C seems like a fine option, but at the end of the day I don't really care.
One thing I do care about is ensuring that we set up the benchmark in such a way that its not locked down to one language. This project will likely be open source. We want to allow people to write new benchmarks for new scenerios or new platforms or whatever, using whatever low-level language they want. We don't necessarily need the benchmark as a whole to be super-duper fast. We just need to make sure that the measured-path is absolutely as fast as possible with no noise leaking into it. Hope that makes sense.


This will then make its way to a database.


We will then have a website that displays all the numbers.

We will also set up a skill that allows agents to query the website for particular numbers and make estimates. For example, how much money will it cost to distribute a new update of Fortnite to 30 million players? We would probably multiple some bandwidth numbers, some storage numbers, etc and come up with a rough guestimate. This process will be documented in a skill in the future.



This project is heavily inspired by "NapkinMath"

note: the "NapkinMath" repo is available in "local/". It may seem invisible because it is part of `.gitignore`.

be sure to read "local/AGENTS.md" to get context that will not make it to GitHub.

## Current direction

Build plan: GitHub issue #36, "Build plan: record every Run, judge afterwards". Read it before designing, specifying, or building anything. It pauses the wayfinder map (#12); where the plan disagrees with the map's tickets or `docs/adr/`, follow the plan. ADR-0029 (`docs/adr/0029-record-every-run-and-judge-afterwards.md`) records which ADRs stand as built, which have changed and which are superseded, and which terms of `CONTEXT.md` are in force.

Dated checks: GitHub issue #38, "Dated checks: what to verify, and when". Some of the plan's finish lines can only be checked after a date has passed, so the build assumes they pass and lists them there. At the start of a session, read it. If a check's date has passed, make the check with the AWS CLI and record the result on that issue.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `smrdotgg/ledgermath`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
