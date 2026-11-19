// Design v5, "Swiss poster": one grotesque, one strict grid, one accent colour, and in this spare form almost no words.
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
	roundPlaces,
	snapshot,
	type DurationUnit,
	type HeadlineRow,
	type Section,
	type Shown,
} from "../../data";

// ---------------------------------------------------------------- figures

type Lead = ReturnType<typeof leadFigure>;

/**
 * One unit for a whole row, so its five figures read against each other: the unit the
 * largest of them would take on its own. Only the unit is chosen here.
 */
function rowUnit(row: HeadlineRow): { kind: "rate"; unit: "B" | "kB" | "MB" | "GB" | "TB" } | { kind: "time"; unit: DurationUnit } {
	const leads = row.cells.map((cell) => leadFigure(row.choice, cell.series));
	const largest = leads.reduce((a, b) => (b.p50 > a.p50 ? b : a));
	if (row.choice.lead === "rate") return { kind: "rate", unit: formatRate(largest.p50).unit.replace("/s", "") as "GB" };
	return { kind: "time", unit: durationUnit(largest.p50) };
}

function show(row: HeadlineRow, value: number): Shown {
	const u = rowUnit(row);
	return u.kind === "rate" ? formatRate(value, { unit: u.unit }) : formatDuration(value, { unit: u.unit });
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

/** `full` rounded to `places`, for display beside the exact figure. */
function atPlaces(full: string, places: number): string {
	return roundPlaces(full, places);
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

/** The largest p95 of a row: the end of its zero-based scale, so every bracket fits. */
function rowMax(row: HeadlineRow): number {
	return Math.max(...row.cells.map((cell) => leadFigure(row.choice, cell.series).p95));
}

const pct = (v: number, max: number) => `${((v / max) * 100).toFixed(3)}%`;

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

const anchor = (row: HeadlineRow) => `b-${row.choice.benchmark.replaceAll("_", "-")}`;

/** Every written value of a cell, for the visitor who hovers: exact p5, p50, p95 and the count. */
function cellTitle(row: HeadlineRow, lead: Lead, machine: string): string {
	const s = (v: number) => show(row, v).full;
	const u = show(row, lead.p50).unit;
	return `${machine}, ${u}\np50 ${s(lead.p50)}\np5 ${s(lead.p5)}\np95 ${s(lead.p95)}\n${lead.count} counted Runs`;
}

// The poster's figure: the table's first cell, read memory sequentially on the first machine type.
const heroRow = headline[0]!;
const heroCell = heroRow.cells[0]!;
const heroLead = leadFigure(heroRow.choice, heroCell.series);
const heroShown = show(heroRow, heroLead.p50);
const heroPlaces = rowPlaces(heroRow);
const heroShort = atPlaces(heroShown.full, heroPlaces);

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const pricesFetched = formatMoment(snapshot.pricesFetchedAt);

function price(m: (typeof machines)[number]): Shown {
	return formatUsd(m.price.usdPerHour, { per: "hour" });
}

const faster = (row: HeadlineRow) => (row.choice.lead === "rate" ? "Higher is faster" : "Lower is faster");

// ---------------------------------------------------------------- parts

function Masthead() {
	return (
		<header class="mast grid">
			<div class="mast-name">
				<a href="#top">LedgerMath</a>
			</div>
			<nav class="mast-nav" aria-label="On this page">
				<a href="#figures">Figures</a>
				<a href="#machines">Machines</a>
			</nav>
		</header>
	);
}

function Compare() {
	const max = Math.max(...heroRow.cells.map((c) => leadFigure(heroRow.choice, c.series).p50));
	return (
		<figure class="compare" aria-label={`${heroRow.choice.label} on all five machine types, ${heroShown.unit}`}>
			<ol>
				{heroRow.cells.map((cell) => {
					const lead = leadFigure(heroRow.choice, cell.series);
					const s = show(heroRow, lead.p50);
					const here = cell.series === heroCell.series;
					return (
						<li class={here ? "is-hero" : undefined}>
							<span class="compare-m">{cell.machine.instanceType}</span>
							<span class="compare-bar" aria-hidden="true">
								<span style={{ width: pct(lead.p50, max) }} />
							</span>
							<a class="compare-v" href={links.seriesFile(cell.series)} title={`${s.full} ${s.unit}, exact`}>
								{atPlaces(s.full, heroPlaces)}
							</a>
						</li>
					);
				})}
			</ol>
		</figure>
	);
}

function Poster() {
	const [exactHead, exactTail] = heroShown.full.startsWith(heroShort)
		? [heroShort, heroShown.full.slice(heroShort.length)]
		: [heroShown.full, ""];
	return (
		<section class="poster grid" aria-labelledby="top">
			<h1 id="top" class="headline">
				AWS machines, measured four times a&nbsp;day.
			</h1>
			<div class="intro">
				<p class="intro-k">Every Run, as JSON</p>
				<div class="intro-curl" data-copy={`curl ${links.index}`}>
					<code tabindex="0">
						<span class="prompt" aria-hidden="true">
							${" "}
						</span>
						curl {links.index}
					</code>
				</div>
			</div>

			<div class="hero grid-inner" role="group" aria-labelledby="hero-k">
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
					<span class="hero-kicker-m">p50 of {formatCount(heroLead.count).full} Runs</span>
				</p>
				<p class="hero-figure" aria-hidden="true">
					<span class="hero-head">{heroShort}</span>
					<span class="hero-unit">{heroShown.unit}</span>
				</p>
				<p class="hero-exact">
					<a href={links.seriesFile(heroCell.series)}>
						<b>{exactHead}</b>
						{exactTail}
					</a>{" "}
					<span class="hero-exact-u">{heroShown.unit}</span>
				</p>
				<Compare />
			</div>

			<dl class="facts">
				<div>
					<dt>Newest Run</dt>
					<dd>
						<time datetime={newest.iso} title={`${newest.full}; the oldest ${oldest.full}`}>
							{newest.longDate.replace(/ (\w{3})\w+ /, " $1 ")}, {newest.minute}
						</time>
					</dd>
				</div>
				<div>
					<dt>Runs · Series</dt>
					<dd>
						<span title={`${formatCount(snapshot.failedRuns).full} failed`}>{formatCount(snapshot.runCount).full}</span> <span class="facts-s">·</span>{" "}
						<a href={links.seriesList}>{formatCount(snapshot.seriesCount).full}</a>
					</dd>
				</div>
				<div>
					<dt>Method</dt>
					<dd>
						<a href={links.docs}>
							{snapshot.methods.map((m) => `${m.name} v${m.version}`).join(", ")}
						</a>
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
		</section>
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
			<span class="key-i">↑↓ faster</span>
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
					<p class="sec-lede">p50 of counted Runs, every digit.</p>
					<Key />
				</div>
			</div>

			<div class="table-box" role="region" aria-label="The figures, 14 benchmarks by 5 machine types">
				<table>
					<thead>
						<tr>
							<th scope="col" class="corner">
								Cheapest first
							</th>
							{machines.map((m) => (
								<th scope="col" class="mach">
									<span class="mach-name">{m.instanceType}</span>
								</th>
							))}
						</tr>
					</thead>
					{SECTIONS.map((section) => (
						<tbody>
							<tr class="group">
								<th scope="rowgroup" class="group-h" colspan={machines.length + 1}>
									{section}
								</th>
							</tr>
							{headline
								.filter((row) => row.choice.section === section)
								.map((row) => {
									const unit = show(row, leadFigure(row.choice, row.cells[0]!.series).p50).unit;
									const places = rowPlaces(row);
									const w = rowWidths(row, places);
									const max = rowMax(row);
									return (
										<tr class="row" id={anchor(row)} style={{ "--wi": `${w.int}ch`, "--wt": `${w.tail}ch` }}>
											<th scope="row">
												<a class="row-label" href={row.choice.readme}>
													{row.choice.label}
												</a>
												<span class="row-fig">
													<span class="row-unit">{row.choice.per ? `${unit} per ${formatCount(row.choice.per.count).full}` : unit}</span>
													<span class="row-dir" title={faster(row)}>
														{row.choice.lead === "rate" ? "↑" : "↓"}
													</span>
												</span>
											</th>
											{row.cells.map((cell) => {
												const lead = leadFigure(row.choice, cell.series);
												const s = show(row, lead.p50);
												const f = split(s.full, places);
												const isHero = cell.series === heroCell.series;
												const each = row.choice.per ? formatDurationPerUnit(lead.p50, row.choice.per, { unit: "ns" }) : undefined;
												return (
													<td class={isHero ? "hero-cell" : undefined} data-m={cell.machine.instanceType}>
														<a class="fig" href={links.seriesFile(cell.series)} title={cellTitle(row, lead, cell.machine.instanceType)}>
															<span class="fi">{f.int}</span>
															<span class="fh">{f.head}</span>
															<span class="ft">{f.tail}</span>
														</a>
														<span class="bar" aria-hidden="true">
															<span class="bar-f" style={{ width: pct(lead.p50, max) }} />
															<span class="bar-s" style={{ left: pct(lead.p5, max), right: `calc(100% - ${pct(lead.p95, max)})` }} />
														</span>
														{each ? (
															<span class="each" title={`${each.full} ns per ${each.per.of}, exact`}>
																{each.short} ns each
															</span>
														) : null}
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

function Machines() {
	return (
		<section id="machines" class="machines" aria-labelledby="machines-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					02
				</p>
				<h2 id="machines-h">The machines</h2>
				<p class="sec-lede">
					On-Demand, {snapshot.region}, <a href={links.prices}>{snapshot.priceDate}</a>
				</p>
			</div>

			<div class="table-box">
				<table class="mtable">
					<thead>
						<tr>
							<th scope="col">Type</th>
							<th scope="col" class="num">
								vCPU
							</th>
							<th scope="col" class="num">
								Memory
							</th>
							<th scope="col" class="num">
								$/hour
							</th>
						</tr>
					</thead>
					<tbody>
						{machines.map((m) => (
							<tr>
								<th scope="row" title={m.processor}>
									{m.instanceType}
								</th>
								<td class="num">{m.vcpu}</td>
								<td class="num">{m.memory}</td>
								<td class="num m-usd" title={m.price.path.pointer}>
									{price(m).full}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function Footer() {
	return (
		<footer class="foot grid">
			<div class="foot-name">LedgerMath</div>
			<p class="foot-cell">
				<a href={links.index}>index.json</a> · <a href={links.seriesList}>series.json</a> · <a href={links.prices}>prices</a> ·{" "}
				<a href={links.schema.index}>schemas</a> · <a href={links.docs}>docs</a>
			</p>
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
				<Machines />
			</main>
			<Footer />
		</>
	);
}
