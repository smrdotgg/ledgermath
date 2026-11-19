// Design v5, "Swiss poster": one grotesque, one strict grid, one accent colour, few words.
// Every figure comes from ../../data exactly as the snapshot holds it (see ../README.md).
import "./page.css";
import {
	durationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	leadFigure,
	links,
	machines,
	seriesFileContents,
	snapshot,
	type DurationUnit,
	type HeadlineRow,
	type Section,
	type Shown,
} from "../../data";

// ---------------------------------------------------------------- figures

type Lead = ReturnType<typeof leadFigure>;
type RowUnit = { kind: "rate"; unit: "B" | "kB" | "MB" | "GB" | "TB" } | { kind: "time"; unit: DurationUnit };

/**
 * One unit for a whole row, so its five figures read against each other: the unit the
 * largest of them would take on its own. Where a repetition holds many units of work (the
 * mutex), the row is set in the time of one, divided exactly by the module. Only the unit is
 * chosen here.
 */
function rowUnit(row: HeadlineRow): RowUnit {
	const leads = row.cells.map((cell) => leadFigure(row.choice, cell.series));
	const largest = leads.reduce((a, b) => (b.p50 > a.p50 ? b : a));
	if (row.choice.lead === "rate") return { kind: "rate", unit: formatRate(largest.p50).unit.replace("/s", "") as "GB" };
	if (row.choice.per) return { kind: "time", unit: formatDurationPerUnit(largest.p50, row.choice.per).unit as DurationUnit };
	return { kind: "time", unit: durationUnit(largest.p50) };
}

/** A figure of the row, in the row's unit; the time of one unit of work where the row has `per`. */
function show(row: HeadlineRow, value: number): Shown {
	const u = rowUnit(row);
	if (u.kind === "rate") return formatRate(value, { unit: u.unit });
	if (row.choice.per) return formatDurationPerUnit(value, row.choice.per, { unit: u.unit });
	return formatDuration(value, { unit: u.unit });
}

/** Places after the point that give `full` four significant digits. */
function placesFor(full: string): number {
	const [int = "", frac = ""] = full.replace("-", "").split(".");
	if (/[1-9]/.test(int)) return Math.max(0, 4 - int.replace(/^0+/, "").length);
	const zeros = frac.search(/[1-9]/);
	return zeros < 0 ? 0 : zeros + 4;
}

/** One count of places for the whole row: enough for its smallest figure to keep four significant digits. */
function rowPlaces(row: HeadlineRow): number {
	return Math.max(...row.cells.map((cell) => placesFor(show(row, leadFigure(row.choice, cell.series).p50).full)));
}

/**
 * The exact figure, cut into three for setting: the integer part, the point and the digits a
 * reader compares (to the row's places), and the rest. Nothing is rounded: read together they
 * are `full`, every digit.
 */
function split(full: string, places: number): { int: string; head: string; tail: string } {
	const [int = "", frac] = full.split(".");
	if (frac === undefined) return { int, head: "", tail: "" };
	return { int, head: "." + frac.slice(0, places), tail: frac.slice(places) };
}

/** Per row: the widest integer part and tail, so the five figures share one decimal point. */
function rowWidths(row: HeadlineRow, places: number): { int: number; tail: number } {
	const parts = row.cells.map((cell) => split(show(row, leadFigure(row.choice, cell.series).p50).full, places));
	return { int: Math.max(...parts.map((p) => p.int.length)), tail: Math.max(...parts.map((p) => p.tail.length)) };
}

/** The widest tail in the whole table: one slot for every tail, so every head ends on one line per column. */
const TAIL = Math.max(...headline.map((row) => rowWidths(row, rowPlaces(row)).tail));

/** The largest p95 of a row: the end of its zero-based scale, so every bracket fits. */
function rowMax(row: HeadlineRow): number {
	return Math.max(...row.cells.map((cell) => leadFigure(row.choice, cell.series).p95));
}

const pct = (v: number, max: number) => `${((v / max) * 100).toFixed(3)}%`;

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

/** What a section measured where its name alone does not say (the headline rule's own words). */
const SECTION_NOTE: Partial<Record<Section, string>> = { Disk: "root EBS gp3 volume" };

const sectionId = (s: Section) => `s-${s.toLowerCase().replaceAll(" ", "-")}`;

const anchor = (row: HeadlineRow) => `b-${row.choice.benchmark.replaceAll("_", "-")}`;

/** The row's unit as its label shows it, once. */
function unitLabel(row: HeadlineRow): string {
	const unit = show(row, leadFigure(row.choice, row.cells[0]!.series).p50).unit;
	return row.choice.per ? `${unit} per ${row.choice.per.of}` : unit;
}

/** Every written value of a cell, for the visitor who hovers: exact p5, p50, p95 and the count. */
function cellTitle(row: HeadlineRow, lead: Lead, machine: string): string {
	const s = (v: number) => show(row, v).full;
	return `${machine}, ${unitLabel(row)}\np50 ${s(lead.p50)}\np5 ${s(lead.p5)}\np95 ${s(lead.p95)}\n${lead.count} Runs`;
}

// The poster's figure: the table's first cell, read memory sequentially on the first machine type.
const heroRow = headline[0]!;
const heroCell = heroRow.cells[0]!;
const heroLead = leadFigure(heroRow.choice, heroCell.series);
const heroShown = show(heroRow, heroLead.p50);
const heroSplit = split(heroShown.full, rowPlaces(heroRow));

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const pricesFetched = formatMoment(snapshot.pricesFetchedAt);

function price(m: (typeof machines)[number]): Shown {
	return formatUsd(m.price.usdPerHour, { per: "hour" });
}

/** "11–19 Nov 2026" for two moments in one month; otherwise "30 Oct–19 Nov 2026". */
function span(a: ReturnType<typeof formatMoment>, b: ReturnType<typeof formatMoment>): string {
	const [ad, am, ay] = a.longDate.split(" ");
	const [bd, bm, by] = b.longDate.split(" ");
	if (am === bm && ay === by) return `${ad}–${bd} ${bm!.slice(0, 3)} ${by}`;
	return `${ad} ${am!.slice(0, 3)}–${bd} ${bm!.slice(0, 3)} ${by}`;
}

/** The fewest and most Runs behind a machine type's 14 figures, as they stand: "34–36", or one count where all agree. */
function runsOf(instanceType: string): string {
	const counts = headline.map((row) => leadFigure(row.choice, row.cells.find((c) => c.machine.instanceType === instanceType)!.series).count);
	const lo = Math.min(...counts);
	const hi = Math.max(...counts);
	return lo === hi ? formatCount(lo).full : `${formatCount(lo).full}–${formatCount(hi).full}`;
}

/** The processor in one short line: AWS's words, without "Processor" and "Scalable". */
const proc = (p: string) => p.replace(/ Processor$/, "").replace(" Scalable ", " ");

const faster = (row: HeadlineRow) => (row.choice.lead === "rate" ? "↑ faster" : "↓ faster");

// ---------------------------------------------------------------- parts

function Masthead() {
	return (
		<header class="mast grid">
			<div class="mast-name">
				<a href="#top">LedgerMath</a>
			</div>
			<p class="mast-cell">
				Newest Run started{" "}
				<time datetime={newest.iso} title={newest.full}>
					{newest.longDate}, {newest.minute} UTC
				</time>
			</p>
			<nav class="mast-nav" aria-label="On this page">
				<a href="#figures">Figures</a>
				<a href="#api">API</a>
			</nav>
		</header>
	);
}

function Poster() {
	return (
		<section class="poster grid" aria-labelledby="top">
			<h1 id="top" class="headline">
				AWS machines, measured four times a&nbsp;day.
			</h1>
			<p class="boots">
				<span class="boots-k">Scheduled boots</span>
				<span class="boots-t">04:10 10:10 16:10 22:10</span> UTC
			</p>
			<div class="intro">
				<p>
					{formatCount(snapshot.benchmarkCount).full} benchmarks on {formatCount(snapshot.machineCount).full} freshly booted machine types in{" "}
					<span class="nowrap">{snapshot.region}</span>. Every Run kept with its evidence, published as JSON for agents.
				</p>
				<div class="cmd" data-copy={`curl ${links.index}`}>
					<code tabindex="0">
						<span class="prompt" aria-hidden="true">
							${" "}
						</span>
						curl <span class="cmd-url">{links.index}</span>
					</code>
				</div>
				<Facts />
			</div>

			<div class="hero" role="group" aria-labelledby="hero-k">
				<p id="hero-k" class="hero-kicker">
					<a class="hero-kicker-b" href={`#${anchor(heroRow)}`}>
						{heroRow.choice.label}
					</a>
					<span class="hero-kicker-sep" aria-hidden="true">
						{" "}
						/{" "}
					</span>
					<span>{heroCell.machine.instanceType}</span>
					<span class="hero-kicker-sep" aria-hidden="true">
						{" "}
						/{" "}
					</span>
					<a class="hero-kicker-m" href={links.seriesFile(heroCell.series)}>
						p50 of {formatCount(heroLead.count).full} Runs
					</a>
				</p>
				{/* The table's own form, set enormous: the compared digits, every other digit on the same baseline, the unit. */}
				<p class="hero-figure">
					<span class="sr">
						{heroShown.full} {heroShown.unit}
					</span>
					<span class="hero-head" aria-hidden="true">
						{heroSplit.int}
						{heroSplit.head}
					</span>
					<span class="hero-tail" aria-hidden="true">
						{heroSplit.tail}
					</span>
					<span class="hero-unit" aria-hidden="true">
						{heroShown.unit}
					</span>
				</p>
			</div>
		</section>
	);
}

/** Freshness and provenance, beside the headline: each fact a link to its file where it has one. */
function Facts() {
	return (
		<dl class="facts">
				<div>
					<dt>Runs started</dt>
					<dd>
						<time datetime={oldest.iso} title={`${oldest.full} to ${newest.full}`}>
							{span(oldest, newest)}
						</time>
					</dd>
				</div>
				<div>
					<dt>Runs kept</dt>
					<dd>
						<a href={links.seriesList}>{formatCount(snapshot.runCount).full}</a>
					</dd>
				</div>
				<div>
					<dt>Methods</dt>
					<dd>
						<a href={links.docs}>{snapshot.methods.map((m) => `${m.name} v${m.version}`).join(", ")}</a>
					</dd>
				</div>
				<div>
					<dt>AWS prices</dt>
					<dd>
						<a href={links.prices}>
							<time datetime={pricesFetched.iso} title={pricesFetched.full}>
								{snapshot.priceDate}
							</time>
						</a>
					</dd>
				</div>
			</dl>
	);
}

/** A drawn key: the two marks every cell carries, each named once. */
function Key() {
	return (
		<p class="key">
			<span class="key-i">
				<span class="km km-f" aria-hidden="true" />0 to p50
			</span>
			<span class="key-i">
				<span class="km km-s" aria-hidden="true" />
				p5 to p95
			</span>
		</p>
	);
}

function FigureTable() {
	return (
		<section id="figures" class="figures" aria-labelledby="figures-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					01
				</p>
				<h2 id="figures-h">The figures</h2>
				<div class="sec-side">
					<Key />
					<nav class="jump" aria-label="Sections of the figures">
						{SECTIONS.map((s) => (
							<a href={`#${sectionId(s)}`}>{s}</a>
						))}
					</nav>
				</div>
			</div>

			<div class="table-box" role="region" aria-label="The figures, 14 benchmarks by 5 machine types">
				<table style={{ "--wt": `${TAIL}ch` }}>
					<thead>
						<tr>
							<th scope="col" class="corner">
								On-Demand, cheapest first
							</th>
							{machines.map((m) => (
								<th scope="col" class="mach">
									<span class="mach-name">{m.instanceType}</span>
									<span class="mach-spec">
										{m.vcpu} vCPU · {m.memory}
									</span>
									<span class="mach-proc">{proc(m.processor)}</span>
									<span class="mach-runs">{runsOf(m.instanceType)} Runs</span>
									<a class="mach-price" href={links.prices} title={`$${price(m).full} an hour: ${m.price.path.pointer}`}>
										${price(m).full}/h
									</a>
								</th>
							))}
						</tr>
					</thead>
					{SECTIONS.map((section) => (
						<tbody>
							<tr class="group" id={sectionId(section)}>
								<th scope="rowgroup" colspan={machines.length + 1} class="group-h">
									{section}
									{SECTION_NOTE[section] && <span class="group-note"> · {SECTION_NOTE[section]}</span>}
								</th>
							</tr>
							{headline
								.filter((row) => row.choice.section === section)
								.map((row) => {
									const places = rowPlaces(row);
									const w = rowWidths(row, places);
									const max = rowMax(row);
									return (
										<tr class="row" id={anchor(row)} style={{ "--wi": `${w.int}ch` }}>
											<th scope="row">
												<a class="row-label" href={row.choice.readme}>
													{row.choice.label}
												</a>
												<span class="row-fig">
													<span class="row-unit">{unitLabel(row)}</span>
													<span class="row-dir">{faster(row)}</span>
												</span>
											</th>
											{row.cells.map((cell) => {
												const lead = leadFigure(row.choice, cell.series);
												const f = split(show(row, lead.p50).full, places);
												const isHero = cell.series === heroCell.series;
												return (
													<td class={isHero ? "hero-cell" : undefined}>
														<span class="cm">{cell.machine.instanceType}</span>
														<a class="fig" href={links.seriesFile(cell.series)} title={cellTitle(row, lead, cell.machine.instanceType)}>
															<span class="fi">{f.int}</span>
															<span class="fh">{f.head}</span>
															<span class="ft">{f.tail}</span>
														</a>
														<span class="bar" aria-hidden="true">
															<span class="bar-f" style={{ width: pct(lead.p50, max) }} />
															<span class="bar-s" style={{ left: pct(lead.p5, max), right: `calc(100% - ${pct(lead.p95, max)})` }} />
														</span>
													</td>
												);
											})}
										</tr>
									);
								})}
						</tbody>
					))}
				</table>
			</div>
		</section>
	);
}

// The worked example: the poster's own Series, as series.json lists it, cut to valid JSON. Its p50 is the
// poster's figure in bytes per second, the same digits; its count is the poster's count of Runs.
const J = (v: unknown) => JSON.stringify(v);
const walkKey = heroRow.choice.lead === "rate" ? "bytes_per_second" : "time_per_repetition_ns";
const walkP = heroCell.series.derivations.series_v1.percentiles[walkKey]!;
const excerptHead = [
	`{ "id": ${J(heroCell.series.id)},`,
	`  "instance_type": ${J(heroCell.series.instance_type)},`,
	`  "derivations": { "series_v1": {`,
	`    "percentiles": { ${J(walkKey)}: {`,
	`      "count": ${J(walkP.count)},`,
	`      "p5": ${J(walkP.p5)},`,
	`      "p50": `,
].join("\n");
const excerptP50 = J(walkP.p50);
const excerptTail = [`,`, `      "p95": ${J(walkP.p95)} } } } } }`].join("\n");

/** One real Run's evidence: the first point of the Series file the snapshot keeps as a sample. */
const run = seriesFileContents.point.example;
const runAt = formatMoment(run.started_at);
const runLabel = headline.find((row) => row.choice.benchmark === seriesFileContents.sample.benchmark)!.choice.label;

/** The API's three files under its one base address. */
const BASE = links.index.slice(0, links.index.lastIndexOf("/") + 1);
const files = [
	{ url: links.index, what: "contents" },
	{ url: links.seriesList, what: "every Series" },
	{ url: links.prices, what: "AWS prices" },
];

function Api() {
	return (
		<section id="api" class="api" aria-labelledby="api-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					02
				</p>
				<h2 id="api-h">The API</h2>
				<p class="sec-lede">Static JSON, version 1. It only gains fields.</p>
			</div>

			<div class="grid">
				<div class="api-main">
					<div class="addr">
						<p class="addr-base">{BASE}</p>
						<ul class="addr-files">
							{files.map((f) => (
								<li>
									<a href={f.url}>{f.url.slice(BASE.length)}</a>
									<span class="addr-what">{f.what}</span>
								</li>
							))}
						</ul>
					</div>

					<dl class="api-side">
						<div>
							<dt>Evidence of one Run</dt>
							<dd>
								<a class="api-run" href={run.evidence} title={`${runLabel}, ${seriesFileContents.sample.instanceType}, ${runAt.full}`}>
									{seriesFileContents.sample.instanceType}, {runAt.date} {runAt.minute} UTC
								</a>
								<span class="mono api-tpl">
									{links.evidenceBlobTemplate.split("blobs/")[0]}
									<wbr />
									blobs/{links.evidenceBlobTemplate.split("blobs/")[1]}
								</span>
							</dd>
						</div>
						<div>
							<dt>Schemas</dt>
							<dd class="api-links">
								{links.schemas.map((s) => (
									<a href={s.url}>{s.name}</a>
								))}
							</dd>
						</div>
						<div>
							<dt>Docs</dt>
							<dd>
								<a href={links.docs}>{links.docs.replace("https://", "")}</a>
							</dd>
						</div>
					</dl>
				</div>

				<div class="api-walk">
					<h3 class="walk-h">
						<a href={`#${anchor(heroRow)}`}>
							{heroRow.choice.label}, {heroCell.machine.instanceType}
						</a>
						, in series.json
					</h3>
					<pre class="json" role="region" tabindex="0" aria-label="An excerpt of series.json">
						<code>
							{excerptHead}
							<b class="json-hit">{excerptP50}</b>
							{excerptTail}
						</code>
					</pre>
				</div>
			</div>
		</section>
	);
}

function Footer() {
	return (
		<footer class="foot grid">
			<div class="foot-name">LedgerMath</div>
		</footer>
	);
}

export default function Page() {
	return (
		<>
			<Masthead />
			<main>
				<Poster />
				<FigureTable />
				<Api />
			</main>
			<Footer />
		</>
	);
}
