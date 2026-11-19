// Design v8, "Editorial landing", spare form: one claim, one figure traced to its evidence, then every digit.
// Every figure comes from src/data as the snapshot holds it; see ../README.md.
// The spare form keeps only what the page cannot do without: the claim, the traced figure, the 14 × 5
// figures, where they come from, one command and the machines. Everything else is a link.
import "./page.css";
import {
	type DurationUnit,
	durationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	type HeadlineChoice,
	type HeadlineRow,
	leadFigure,
	links,
	machines,
	type Section,
	seriesFileContents,
	type SeriesRow,
	type Shown,
	perUnit,
	snapshot,
} from "../../data";

// ------------------------------------------------------------------ figures

const newest = formatMoment(snapshot.newestRunStartedAt);
const runs = formatCount(snapshot.runCount);
const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

/** The unit a row is shown in: the one its smallest figure reads at least 1 in, so a row compares digit for digit. */
type RowUnit = { kind: "rate"; unit: string } | { kind: "time"; unit: DurationUnit; per?: { count: number; of: string } };

function rowUnit(row: HeadlineRow): RowUnit {
	const per = row.choice.per;
	const values = row.cells.map((c) => leadFigure(row.choice, c.series).p50);
	const least = Math.min(...values);
	if (row.choice.lead === "rate") return { kind: "rate", unit: formatRate(least).unit.replace("/s", "") };
	if (per) return { kind: "time", unit: formatDurationPerUnit(least, per).unit as DurationUnit, per };
	return { kind: "time", unit: durationUnit(least) };
}

function show(value: number, u: RowUnit): Shown {
	if (u.kind === "rate") return formatRate(value, { unit: u.unit as "GB" });
	if (u.per) return formatDurationPerUnit(value, u.per, { unit: u.unit });
	return formatDuration(value, { unit: u.unit });
}

/** The unit as the page prints it: a time is of one repetition unless the row says otherwise. */
function unitWords(u: RowUnit): string {
	if (u.kind === "rate") return `${u.unit}/s`;
	if (u.per) return `${u.unit} per ${u.per.of}`;
	return u.unit;
}

function unitLong(u: RowUnit): string {
	if (u.kind === "time" && !u.per) return `${u.unit} per repetition`;
	return unitWords(u);
}

function cellTitle(choice: HeadlineChoice, row: SeriesRow, u: RowUnit): string {
	const f = leadFigure(choice, row);
	const p50 = show(f.p50, u);
	const p5 = show(f.p5, u);
	const p95 = show(f.p95, u);
	const per = u.kind === "time" && u.per ? ` One repetition is ${formatCount(u.per.count).full} ${u.per.of}s.` : "";
	return `${choice.label} on ${row.instance_type}: ${p50.full} ${unitLong(u)}, the median of ${f.count} counted Runs. 5th percentile ${p5.full}, 95th ${p95.full}.${per} As the snapshot holds it: ${p50.source}.`;
}

/**
 * Every digit of an exact decimal, the first `lead` significant ones set apart from the rest.
 * Nothing is dropped or rounded: the text is `full`, split in two for the eye.
 */
function splitDigits(full: string, lead = 4): { head: string; tail: string } {
	let seen = 0;
	let started = false;
	for (let i = 0; i < full.length; i++) {
		const c = full[i]!;
		if (c >= "1" && c <= "9") started = true;
		if (started && c >= "0" && c <= "9") seen++;
		if (seen === lead) return { head: full.slice(0, i + 1), tail: full.slice(i + 1) };
	}
	return { head: full, tail: "" };
}

/** An exact figure for the table: integer part right-aligned in the row's width, so every decimal point in a row sits in one place. */
function Exact(props: { full: string }) {
	const [int = "", frac] = props.full.split(".");
	const { head, tail } = splitDigits(props.full);
	const headInt = head.slice(0, int.length);
	const tailInt = int.slice(headInt.length);
	const fracText = frac === undefined ? "" : `.${frac}`;
	const headFrac = head.length > int.length ? head.slice(int.length) : "";
	const tailFrac = fracText.slice(headFrac.length);
	return (
		<span class="exact">
			<span class="x-int">
				{headInt}
				{tailInt ? <span class="x-tail">{tailInt}</span> : null}
			</span>
			<span class="x-frac">
				{headFrac}
				{tailFrac ? <span class="x-tail">{tailFrac}</span> : null}
			</span>
		</span>
	);
}

/** p5, p50 and p95 placed on a scale from zero to the row's largest p95: positions for drawing, never printed. */
function Spread(props: { f: { p5: number; p50: number; p95: number }; max: number }) {
	const at = (v: number) => `${((v / props.max) * 100).toFixed(2)}%`;
	return (
		<span class="spread" aria-hidden="true" style={{ "--p5": at(props.f.p5), "--p50": at(props.f.p50), "--p95": at(props.f.p95) }}>
			<span class="sp-bar" />
			<span class="sp-whisk" />
		</span>
	);
}

/** The way a row reads faster, as one glyph; the key above the table says it once in words. */
function Direction(props: { u: RowUnit }) {
	const more = props.u.kind === "rate";
	return (
		<span class={`dir ${more ? "dir-more" : "dir-less"}`} role="img" aria-label={more ? "more is faster" : "less is faster"} title={more ? "more is faster" : "less is faster"}>
			{more ? "↑" : "↓"}
		</span>
	);
}

/**
 * The name a phone row gives each machine: its family ("c8i"), which tells the five apart, and the
 * whole type in the title. If two families ever share a name, the whole type is used.
 */
const families = machines.map((m) => m.instanceType.split(".")[0]!);
const familiesUnique = new Set(families).size === families.length;
const machineTag = (instanceType: string) => (familiesUnique ? instanceType.split(".")[0]! : instanceType);

// ------------------------------------------------------------------ the traced figure (hero)

/**
 * The figure the page traces: the headline figure whose Series file the snapshot keeps as a sample,
 * so one figure can be followed from the table to its Series, to one of its Runs and that Run's evidence.
 */
const tracedRow = headline.find((row) => row.cells.some((c) => c.series.id === seriesFileContents.sample.id)) ?? headline[0]!;
const tracedCell = tracedRow.cells.find((c) => c.series.id === seriesFileContents.sample.id) ?? tracedRow.cells[0]!;
const tracedU = rowUnit(tracedRow);
const tracedLead = leadFigure(tracedRow.choice, tracedCell.series);
const tracedP50 = show(tracedLead.p50, tracedU);
const tracedP5 = show(tracedLead.p5, tracedU);
const tracedP95 = show(tracedLead.p95, tracedU);
const tracedDerivation = tracedCell.series.derivations.series_v1;
const tracedDigits = splitDigits(tracedP50.full);
const tracedIsSample = tracedCell.series.id === seriesFileContents.sample.id;

/** The traced figure's p5 to p95 on a zoomed scale (p5 and p95 a quarter in from each end): positions for drawing only. */
function RangeStrip() {
	const lo = tracedLead.p5;
	const hi = tracedLead.p95;
	const pad = (hi - lo) * 0.5;
	const at = (v: number) => `${(((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100).toFixed(2)}%`;
	return (
		<div class="strip" style={{ "--p5": at(lo), "--p50": at(tracedLead.p50), "--p95": at(hi) }}>
			<span class="st-zoom">zoomed</span>
			<span class="st-draw" aria-hidden="true">
				<span class="st-axis" />
				<span class="st-span" />
				<span class="st-tick st-t5" />
				<span class="st-tick st-t95" />
				<span class="st-dot" />
			</span>
			<span class="st-l st-l5 mono">
				<span class="pct-k">p5</span> {tracedP5.full}
			</span>
			<span class="st-l st-l95 mono">
				<span class="pct-k">p95</span> {tracedP95.full}
			</span>
		</div>
	);
}

/** Series file, one of its Runs, that Run's evidence: the trail, walked once, as links. */
function Trail() {
	const s = tracedCell.series;
	const point = seriesFileContents.point.example;
	const per = tracedRow.choice.per;
	const ns = point.time_per_repetition_ns;
	return (
		<ol class="trail">
			<li>
				<a href={links.seriesFile(s)} title={`${formatCount(tracedDerivation.counted_runs).full} counted Runs, ${formatCount(tracedDerivation.failed_runs).full} failed; derived by ${tracedDerivation.method.name} v${tracedDerivation.method.version}`}>
					<span class="tl-k">Series</span>
					<span class="mono">{s.id}</span>
				</a>
			</li>
			{tracedIsSample ? (
				<>
					<li>
						<a href={point.evidence} title={point.run}>
							<span class="tl-k">Run</span>
							<span class="mono">{point.run.slice(0, 8)}</span>
						</a>
						{ns != null ? (
							<span class="tl-v mono" title={`${ns} ns for one repetition`}>
								{per ? perUnit(ns, per.count) : String(ns)} ns
							</span>
						) : null}
					</li>
					<li>
						<a href={point.evidence}>
							<span class="tl-k">Evidence</span>
						</a>
					</li>
				</>
			) : null}
		</ol>
	);
}

function TracedFigure() {
	const s = tracedCell.series;
	return (
		<figure class="traced" aria-labelledby="traced-caption">
			<p class="eyebrow traced-eyebrow" id="traced-caption">
				<span class="trace-mark" aria-hidden="true" />
				One figure, traced
			</p>
			<p class="traced-what">
				<a href={tracedRow.choice.readme} title={tracedRow.choice.setting}>
					{tracedRow.choice.label}
				</a>{" "}
				<span class="mono">{tracedCell.machine.instanceType}</span>
			</p>
			<p class="traced-figure" title={`${tracedP50.full} ${unitLong(tracedU)}. As the Series holds it: ${tracedP50.source}`}>
				<span class="tf-head">{tracedDigits.head}</span>
				<span class="tf-tail">{tracedDigits.tail}</span>
			</p>
			<p class="traced-unit">{unitWords(tracedU)}, median</p>
			<p class="traced-span mono">
				{formatCount(tracedDerivation.counted_runs).full} Runs ·{" "}
				<time datetime={s.oldest_run_started_at}>{formatMoment(s.oldest_run_started_at).date}</time> –{" "}
				<time datetime={s.newest_run_started_at}>{formatMoment(s.newest_run_started_at).date}</time>
			</p>
			<RangeStrip />
			<Trail />
		</figure>
	);
}

// ------------------------------------------------------------------ the page

function Mark() {
	return (
		<svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
			<rect x="2.5" y="2.5" width="19" height="19" rx="4" class="mark-box" />
			<line x1="7" x2="17" y1="8.5" y2="8.5" class="mark-line" />
			<line x1="7" x2="17" y1="12" y2="12" class="mark-line" />
			<line x1="7" x2="12.5" y1="15.5" y2="15.5" class="mark-accent" />
		</svg>
	);
}

function Header() {
	return (
		<header class="site-head">
			<div class="wrap head-row">
				<a class="brand" href="./" aria-label="LedgerMath, home">
					<Mark />
					<span>LedgerMath</span>
				</a>
				<nav aria-label="Elsewhere">
					<ul class="nav">
						<li class="nav-api">
							<a href={links.docs} class="btn btn-small">
								Docs
							</a>
						</li>
					</ul>
				</nav>
			</div>
		</header>
	);
}

/** An API address with its host quiet and its path, the part that tells addresses apart, plain. */
function Address(props: { url: string }) {
	const host = "https://api.ledgermath.com";
	const path = props.url.startsWith(host) ? props.url.slice(host.length) : props.url;
	// A line may break only after a slash, so a wrapped address still reads in whole names.
	const breakable = (text: string) => text.split(/(?<=\/)/).map((part, i) => (i > 0 ? [<wbr />, part] : part));
	return (
		<a href={props.url} class="addr">
			{props.url.startsWith(host) ? <span class="addr-host">{host}</span> : null}
			<span class="addr-path">{breakable(path)}</span>
		</a>
	);
}

function Curl(props: { url: string; light?: boolean }) {
	return (
		<div class={props.light ? "cmd cmd-light" : "cmd"} data-copy={`curl ${props.url}`}>
			<code>
				<span class="prompt" aria-hidden="true">
					${" "}
				</span>
				curl <Address url={props.url} />
			</code>
		</div>
	);
}

function Hero() {
	return (
		<section class="hero" aria-labelledby="claim">
			<div class="wrap hero-grid">
				<div class="hero-top">
					<p class="eyebrow">AWS server benchmarks, as JSON</p>
					<h1 id="claim">Server numbers you can trace to their Runs.</h1>
					<p class="lede">
						{formatCount(snapshot.machineCount).full} AWS machine types, booted four times a day; {formatCount(snapshot.benchmarkCount).full} benchmarks on each; every Run kept
						with its evidence.
					</p>
					<p class="fresh">
						<span class="fresh-at">
							<span class="pulse" aria-hidden="true" />
							Newest Run{" "}
							<time datetime={newest.iso} title={newest.full}>
								{newest.date} {newest.minute} UTC
							</time>
						</span>
						<a href={links.seriesList}>{runs.full} Runs</a>
						<a href={links.prices}>prices {snapshot.priceDate}</a>
					</p>
				</div>
				<TracedFigure />
				<div class="hero-rest">
					<Curl url={links.index} light />
				</div>
			</div>
		</section>
	);
}

function priceTitle(m: (typeof machines)[number]): string {
	return `${m.price.description}. In the price file at ${m.price.path.pointer}`;
}

function Machines() {
	return (
		<section class="machines" id="machines" aria-labelledby="machines-title">
			<div class="wrap">
				<div class="section-head">
					<h2 id="machines-title">The machines, by the hour</h2>
					<p class="section-note">
						On-Demand Linux, {snapshot.region} · <a href={links.prices}>price file {snapshot.priceDate}</a>
					</p>
				</div>
				<div class="spec-box">
					<table class="spec spec-spare">
						<thead>
							<tr>
								<th scope="col">Type</th>
								<th scope="col" class="spec-num">
									Per hour
								</th>
								<th scope="col">vCPU</th>
								<th scope="col">Memory</th>
							</tr>
						</thead>
						<tbody>
							{machines.map((m) => (
								<tr>
									<th scope="row" class="mono spec-type" title={`${m.processor}, ${m.clockSpeed}; network ${m.network}; storage ${m.storage}`}>
										{m.instanceType}
									</th>
									<td class="spec-num spec-price" title={priceTitle(m)}>
										<span class="usd">${formatUsd(m.price.usdPerHour).full}</span>
									</td>
									<td data-l="vCPU">{m.vcpu}</td>
									<td data-l="Memory">{m.memory}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</section>
	);
}

const sectionId = (section: Section) => `t-${section.toLowerCase().replace(/\s+/g, "-")}`;

/** The key to the drawing under every figure, drawn with the same parts, said once. */
function SpreadKey() {
	return (
		<p class="key">
			<span class="key-item">
				<span class="kg kg-bar" aria-hidden="true" />
				p50 from 0
			</span>
			<span class="key-item">
				<span class="kg kg-whisk" aria-hidden="true" />
				p5–p95
			</span>
			<span class="key-item">
				<span class="dir dir-more" aria-hidden="true">
					↑
				</span>
				more is faster
			</span>
			<span class="key-item">
				<span class="dir dir-less" aria-hidden="true">
					↓
				</span>
				less is faster
			</span>
		</p>
	);
}

function NumbersTable() {
	return (
		<section class="numbers" id="numbers" aria-labelledby="numbers-title">
			<div class="wrap">
				<h2 id="numbers-title">
					{formatCount(snapshot.benchmarkCount).full} benchmarks × {formatCount(snapshot.machineCount).full} machines, every digit
				</h2>
				<input type="checkbox" id="digits" class="digits-toggle" />
				<div class="table-tools">
					<SpreadKey />
					<label for="digits" class="switch">
						<span class="switch-track" aria-hidden="true">
							<span class="switch-thumb" />
						</span>
						Round to 4 figures
					</label>
				</div>

				<div class="table-box" role="region" aria-label="The headline table">
					<table class="ht">
						<thead>
							<tr>
								<th scope="col" class="col-bench">
									<span class="visually-hidden">Benchmark</span>
								</th>
								{machines.map((m) => (
									<th scope="col" class="col-machine">
										<span class="mono">{m.instanceType}</span>
										<span class="th-sub">${formatUsd(m.price.usdPerHour).full}/h</span>
									</th>
								))}
							</tr>
						</thead>
						{SECTIONS.map((section) => (
							<tbody>
								<tr class="section-row" id={sectionId(section)}>
									<th scope="colgroup" colspan={machines.length + 1} class="sr-head">
										<span class="sr-name">{section}</span>
									</th>
								</tr>
								{headline
									.filter((row) => row.choice.section === section)
									.map((row) => {
										const u = rowUnit(row);
										const figures = row.cells.map((cell) => leadFigure(row.choice, cell.series));
										const max = Math.max(...figures.map((f) => f.p95));
										const shown = figures.map((f) => show(f.p50, u));
										const intWidth = Math.max(...shown.map((v) => v.full.split(".")[0]!.length));
										const fracWidth = Math.max(...shown.map((v) => (v.full.split(".")[1] ?? "").length + 1));
										return (
											<tr style={{ "--iw": `${intWidth}ch`, "--fw": `${fracWidth}ch` }}>
												<th scope="row" class="row-head">
													<a class="row-label" href={row.choice.readme} title={`${row.choice.what} ${row.choice.setting}`}>
														{row.choice.label}
													</a>
													<span class="row-unit" title={unitLong(u)}>
														{unitWords(u)} <Direction u={u} />
													</span>
												</th>
												{row.cells.map((cell, i) => {
													const f = figures[i]!;
													const s = shown[i]!;
													const here = cell === tracedCell;
													return (
														<td class={here ? "is-traced" : undefined}>
															<details class="cell">
																<summary title={cellTitle(row.choice, cell.series, u)}>
																	<span class="cell-m mono">{machineTag(cell.machine.instanceType)}</span>
																	<span class="cell-v">
																		<span class="v-full">
																			<Exact full={s.full} />
																		</span>
																		<span class="v-short">{s.short}</span>
																		<Spread f={f} max={max} />
																	</span>
																</summary>
																<div class="pop">
																	<dl class="pop-pcts mono">
																		<div>
																			<dt>p95</dt>
																			<dd>{show(f.p95, u).full}</dd>
																		</div>
																		<div class="pop-mid">
																			<dt>p50</dt>
																			<dd>{s.full}</dd>
																		</div>
																		<div>
																			<dt>p5</dt>
																			<dd>{show(f.p5, u).full}</dd>
																		</div>
																	</dl>
																	<a class="pop-link" href={links.seriesFile(cell.series)}>
																		{formatCount(f.count).full} Runs <span aria-hidden="true">→</span>
																	</a>
																</div>
															</details>
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
				<p class="table-foot">
					<a href={links.seriesList}>
						All {formatCount(snapshot.seriesCount).full} Series <span aria-hidden="true">→</span>
					</a>
				</p>
			</div>
		</section>
	);
}

function Footer() {
	return (
		<footer class="site-foot">
			<div class="wrap foot-row">
				<span class="brand brand-small">
					<Mark />
					<span>LedgerMath</span>
				</span>
				<p class="foot-links">
					<a href={links.seriesList}>Series</a>
					<a href={links.schema.index}>Schemas</a>
					<a href="third-party-notices.txt">Fonts</a>
				</p>
			</div>
		</footer>
	);
}

export default function Page() {
	return (
		<>
			<Header />
			<main>
				<Hero />
				<NumbersTable />
				<Machines />
			</main>
			<Footer />
		</>
	);
}
