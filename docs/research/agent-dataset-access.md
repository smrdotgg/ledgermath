# Agent access patterns for open datasets

- **Date:** 2026-08-08
- **Ticket:** [#17 — Agent access patterns for open datasets](https://github.com/smrdotgg/ledgermath/issues/17)
- **Question:** What are the current (2026) best patterns for exposing an open dataset to AI agents such that agents cite real sources instead of hallucinating? Covering: MCP servers, llms.txt / llms-full.txt, plain HTTP APIs with stable per-record citation URLs, published agent skills, and downloadable locally-queryable formats (SQLite/DuckDB/Parquet).

## TL;DR

There is one base layer that makes citations verifiable — **a stable, human-viewable canonical URL per record, that also serves machine-readable data** — and everything else (MCP, skills, llms.txt, downloadable files) is an access layer that should return those URLs. An agent "cites correctly" when the tool result it consumed *contains* the canonical URL next to the number; agents hallucinate citations when they have to reconstruct URLs from memory. So: bake the citation URL into every payload, at every layer.

For LedgerMath: give every Observation and Derivation an immutable ID and a stable URL serving HTML (human view) and JSON (agent view) for the same ID; publish the whole dataset as Parquet/SQLite snapshots; then add a SKILL.md and a small read-only MCP server on top. llms.txt is a cheap nice-to-have, not a discovery mechanism.

---

## 1. MCP servers over datasets

**What it is.** The Model Context Protocol is an open JSON-RPC protocol for exposing tools/resources to LLM clients. The spec defines two standard transports: **stdio** (client launches the server as a subprocess) and **Streamable HTTP** (a single HTTP endpoint accepting POST/GET, optionally streaming via SSE), which replaced the older HTTP+SSE transport from the 2024-11-05 revision ([MCP spec 2025-06-18, Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)). A remote dataset server is just a public HTTPS endpoint speaking Streamable HTTP; the spec requires Origin-header validation and recommends auth, but anonymous read-only servers are allowed.

**Adoption (what consumes it today).** This is the one dataset-access protocol with first-party support in every major agent product:

- Claude: Claude Code, Claude.ai connectors, and the Claude API's MCP connector.
- OpenAI: ChatGPT **developer mode** shipped full MCP client support (announced 2025-09-09), and remote MCP servers are a first-class tool in the OpenAI API — "a public HTTPS endpoint speaking SSE or Streamable HTTP, with OAuth, no-auth, or mixed auth" ([OpenAI: MCP and connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [ChatGPT developer mode help page](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)).
- Gemini CLI, Cursor, VS Code/Copilot, Goose, etc. all ship MCP clients.

**Citation verifiability.** MCP itself does nothing for citations — a tool result is just content. The pattern that works is: every tool result row includes the record's canonical URL as a field, so the model never has to invent one. MCP *resources* can also be addressed by URI, and if that URI is the same public HTTPS URL a human can open, the citation is directly checkable.

**Maintenance burden.** Moderate. A read-only MCP server over a static dataset is small (a few tools: `search_observations`, `get_observation`, `list_metrics`), and official SDKs exist in TypeScript/Python. Costs: hosting a public endpoint, keeping up with spec revisions (the protocol version is negotiated; clients send `MCP-Protocol-Version` headers — see [Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)), and the fact that end users must still *add* your server to their client — there is no automatic discovery yet.

---

## 2. llms.txt / llms-full.txt

**What it is.** A proposal by Jeremy Howard (Answer.AI), 2024-09-03: serve a Markdown file at `/llms.txt` with an H1 (required), an optional blockquote summary, and H2-delimited lists of `[name](url)` links to LLM-friendly pages; additionally serve `.md` versions of HTML pages by appending `.md` to URLs ([llmstxt.org](https://llmstxt.org/)). "llms-full.txt" (all content inlined in one file) is a widespread convention popularized by docs hosts, not mandated by the spec — the spec's own expanded variants are FastHTML's `llms-ctx.txt`/`llms-ctx-full.txt`.

**Adoption — the critical caveat.** There is no evidence any major AI system consumes llms.txt *autonomously*. Google's John Mueller stated in June 2025: "FWIW no AI system currently uses llms.txt," comparing it to the keywords meta tag; server-log analyses corroborate that major crawlers don't even request it ([Search Engine Roundtable](https://www.seroundtable.com/google-ai-llms-txt-39607.html), [Search Engine Journal](https://www.searchenginejournal.com/google-says-llms-txt-is-purely-speculative-for-now/577576/), [Ahrefs analysis](https://ahrefs.com/blog/what-is-llms-txt/)).

**Where it *does* work.** As an inference-time index for tool-driven agents that are *already* fetching your site. Notably, modelcontextprotocol.io itself prepends "Fetch the complete documentation index at: https://modelcontextprotocol.io/llms.txt" to fetched pages — i.e., docs sites use it as a sitemap for agents with a fetch tool, not as a discovery standard. Mueller's own characterization: a "temporary crutch... to save some tokens" for AI coding tools parsing developer docs.

**Verdict.** Near-zero cost if generated from the same metadata as the site (it's one Markdown file), and genuinely useful to agents a user has pointed at your domain. But it does not make agents find or cite your data on its own, and per-record citation must still come from stable URLs.

---

## 3. Plain HTTP API / static JSON with stable per-record citation URLs

**What it is.** One canonical, permanent URL per record, serving a human-readable HTML view and machine-readable data at predictable derived URLs (or via content negotiation). This is the oldest pattern and the one that actually makes citations *verifiable*: a citation is verifiable iff a human can click the URL the agent emitted and see the same number the agent used.

**Prior art (verified):** Our World in Data's Chart API: every chart has a canonical URL (e.g. `https://ourworldindata.org/grapher/life-expectancy`) and "simply append `.csv` to the URL to download the data or `.metadata.json` to retrieve the metadata" (also `.zip` for data + metadata + README); query params select country/time subsets so a *specific data subset* is citable as one URL; licensed CC BY 4.0 ([OWID Chart API docs](https://docs.owid.io/projects/etl/api/chart-api/)). Other long-standing examples of the same idea: Wikidata entity URIs (one URI per entity, HTML for browsers / JSON for machines) and ClinicalTrials.gov's per-study NCT URLs.

**Why agents get citations right with this pattern.** Frontier agent products (Claude, ChatGPT) already have web fetch/search tools; a JSON payload with a `"url"` field per record means the model copies rather than reconstructs. Static JSON on a CDN also means no server code: the "API" can be files.

**Maintenance burden.** Lowest of all options if done as static generation (records are immutable → files never change → cache forever). The one hard commitment is *URL permanence*: never break an ID's URL. Cool URIs don't change.

**Design details that matter:**
- Immutable record IDs (an Observation is a fact about a run at a time — it should never be edited, only superseded).
- Human HTML page and machine JSON at trivially-derivable URLs (`/o/{id}` and `/o/{id}.json`, OWID-style suffixes are simpler and more debuggable than `Accept`-header negotiation, though serving both is ideal).
- Every JSON payload embeds its own canonical `url`, plus provenance (instance type, region, date, benchmark version, and for Derivations: the formula and input Observation URLs).
- An explicit license (CC BY 4.0 like OWID) so downstream use is unambiguous.

---

## 4. Published agent skills (SKILL.md)

**What it is.** Anthropic's Agent Skills: a folder containing a `SKILL.md` with YAML frontmatter (`name`, `description`) and a Markdown body of instructions; the body loads only when relevant ("progressive disclosure"), so long reference material costs ~nothing until used ([Claude Code skills docs](https://code.claude.com/docs/en/skills)). A dataset publisher ships a skill that teaches the agent: what the dataset is, the URL scheme, how to query the API/files, and *how to cite* (e.g. "always include the observation URL next to every number").

**Portability.** The SKILL.md format has spread beyond Claude — community marketplaces index tens of thousands of skills and list support across Claude, VS Code, Cursor, OpenAI Codex, Gemini CLI, Goose, OpenCode and others ([agent-skills.md](https://agent-skills.md/); note this is a community source — support depth varies by product). Because a skill is just Markdown, worst case it degrades to documentation a human pastes in.

**Citation angle.** Skills are the only layer where you can *instruct* citation behavior ("when you use a LedgerMath number, cite its `/o/{id}` URL"). That plus URLs embedded in payloads is the belt-and-suspenders combination. CLAUDE.md already anticipates this ("we will also set up a skill that allows agents to query the website...").

**Maintenance burden.** Very low — one Markdown folder in the repo, versioned with the dataset. The main cost is keeping examples in sync with the API.

---

## 5. Downloadable formats agents query locally (SQLite / DuckDB / Parquet)

**What it is.** Publish the full dataset as files agents can query with code: Parquet on object storage/CDN, a SQLite database file, or DuckDB. This suits the (now standard) agent shape of "LLM + code-execution sandbox": Claude Code, Codex, and analysis sandboxes can run `duckdb`/`sqlite3`/pandas directly.

**Key enabler — remote Parquet without downloading.** DuckDB's `httpfs` extension queries files straight over HTTPS (`SELECT * FROM 'https://…/observations.parquet'`) and "can use a combination of the Parquet metadata and HTTP range requests to only download the parts of the file that are actually required by the query" — column pruning, and `COUNT(*)`-style queries may touch only metadata ([DuckDB httpfs docs](https://duckdb.org/docs/current/core_extensions/httpfs/https.html)). So a single Parquet file on a static host is, in practice, a query API — zero server code.

**Citation angle.** Weakest layer for verifiability *unless* the citation URL is a column: a number pulled from a local file has no provenance the reader can click. Fix: include `url` (canonical record URL) as a column in every export, and teach (via the skill) that citations use that column, not the file path.

**Maintenance burden.** Very low: regenerate snapshot files in the daily pipeline, upload to the same static host. SQLite is friendliest for "download once, query offline"; Parquet is friendliest for "query in place over HTTP." Publishing both from the same pipeline is cheap.

---

## Comparison

| Pattern | Verifiable citations | Consumable today w/o custom integration | Maintenance | Role |
|---|---|---|---|---|
| Stable per-record URLs (HTML+JSON) | **Yes — this is what a citation *is*** | Yes (any agent with fetch; also humans) | Lowest (static, immutable) | **Base layer** |
| Parquet/SQLite snapshots | Only if URL is a column | Yes (any agent with a sandbox; DuckDB over HTTP needs no server) | Very low (pipeline artifact) | Bulk/analysis layer |
| SKILL.md | Indirect — instructs citation behavior | Claude natively; format spreading to Codex/Gemini CLI/Cursor etc. | Very low (one folder) | Teaching layer |
| MCP server | Only if URLs embedded in results | Yes in Claude/ChatGPT/Gemini-CLI etc., but user must add the server | Moderate (hosted endpoint, spec drift) | Interactive query layer |
| llms.txt / llms-full.txt | No per-record story | Only when an agent is already fetching your site; no autonomous consumer known (Mueller, 2025) | Trivial (generated file) | Site index, optional |

## How they compose

The layers stack cleanly because they all *carry* the same canonical URLs rather than replacing them:

1. **Base:** immutable record IDs → stable URLs → HTML + JSON per record. Everything cites these.
2. **Bulk:** daily Parquet/SQLite snapshots whose rows include the canonical URL column. DuckDB-over-HTTPS makes the Parquet file itself a query endpoint.
3. **Teaching:** SKILL.md in the repo documents the URL scheme, the snapshot locations, example DuckDB/curl queries, and the citation rule.
4. **Interactive:** an MCP server whose tools are thin wrappers over the same JSON endpoints and always return `url` fields.
5. **Index:** llms.txt pointing at the docs, the URL scheme, and the snapshot files — for agents already on the domain.

Because layers 2–5 are all derived from layer 1, none of them can drift into un-citable territory, and dropping any one of them later costs nothing.

## Recommendation for LedgerMath Observation/Derivation records

**Canonical citation unit: one immutable URL per Observation and per Derivation.**

- `https://<site>/o/{observation_id}` — human HTML view; `…/o/{observation_id}.json` — machine view. Same for `/d/{derivation_id}`. IDs are permanent; records are never edited (a corrected run is a new Observation; the old one gets a `superseded_by`).
- Derivation JSON must embed the formula and the *URLs* of its input Observations, so an agent's napkin-math answer can cite a Derivation and a human can walk the whole provenance chain by clicking.
- Every JSON payload includes its own `url`, license (recommend CC BY 4.0, per OWID precedent), benchmark version, and run metadata (instance type, region, date).

**Build order:**
1. **Stable URLs + static JSON** (with the daily pipeline writing them) — this is the citation substrate and works with every agent that has a fetch tool, today, with zero extra integration.
2. **Daily Parquet (+ SQLite) snapshots** at stable URLs, with `url` as a column — instantly queryable via DuckDB over HTTPS, no server code.
3. **SKILL.md** in the repo (and published for install) documenting the URL scheme, snapshots, example queries, and the rule "always cite the record URL next to every number." This is the planned estimation skill's foundation.
4. **Read-only MCP server** (Streamable HTTP, no auth) with 3–4 tools wrapping the JSON endpoints — worth it once the site is live, since Claude and ChatGPT both consume remote MCP natively now.
5. **llms.txt** generated from site metadata — trivial, do it whenever, expect no autonomous pickup.

The single non-negotiable: **never break a record URL.** Everything else is replaceable.

## Sources

- MCP specification 2025-06-18, Transports (Streamable HTTP, stdio, sessions, protocol-version header): https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- OpenAI — MCP and connectors (remote MCP as first-class API tool): https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- OpenAI Help — ChatGPT developer mode and MCP apps: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- llms.txt proposal (Jeremy Howard, 2024-09-03): https://llmstxt.org/
- Google's John Mueller on llms.txt non-adoption: https://www.seroundtable.com/google-ai-llms-txt-39607.html and https://www.searchenginejournal.com/google-says-llms-txt-is-purely-speculative-for-now/577576/
- Ahrefs server-log evidence on llms.txt: https://ahrefs.com/blog/what-is-llms-txt/
- Our World in Data Chart API (canonical chart URLs, `.csv`/`.metadata.json` suffixes, CC BY 4.0): https://docs.owid.io/projects/etl/api/chart-api/ (overview: https://docs.owid.io/projects/etl/api/)
- Claude Code — Agent Skills / SKILL.md: https://code.claude.com/docs/en/skills
- Community skill marketplace claiming cross-product SKILL.md support (secondary source): https://agent-skills.md/
- DuckDB httpfs — HTTP(S) reads and Parquet range requests: https://duckdb.org/docs/current/core_extensions/httpfs/https.html
