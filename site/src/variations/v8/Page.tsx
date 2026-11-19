// Design v8, "Editorial landing": one claim, one figure traced to its evidence, then the numbers.
// Every figure comes from src/data as the snapshot holds it; see ../README.md.
// Round 4: each fact said once. Freshness and the boot schedule live in the hero; the pipeline band and the
// proofs strip are gone, because the traced figure already shows both.
// Round 5: one command in the hero and no button; the API band is a list of addresses, each beside its schema,
// and the JSON shows the file as it is, the division that joins it to the traced figure set under it.
// Round 6: a figure's dark digits are the ones its p5 and p95 share, so the emphasis says how settled it is; the
// day ruler, the cell underline and the card's caption are gone; whiskers are drawn darker than the bars.
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
const seriesCount = formatCount(snapshot.seriesCount);
const failed = formatCount(snapshot.failedRuns);
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

function unitWords(u: RowUnit): string {
	if (u.kind === "rate") return `${u.unit}/s`;
	if (u.per) return `${u.unit} per ${u.per.of}`;
	return `${u.unit} per repetition`;
}

/**
 * The unit as a row shows it: a time is the time of one repetition, the row's own action ("Hash 64 bytes with
 * SHA-256", 571 ns), so the bare unit says it; the title gives "per repetition" and what one repetition is. The mutex
 * row's "per critical section" is in its title, on the traced card and in the JSON's division line.
 */
function rowUnitShort(u: RowUnit): string {
	if (u.kind === "rate") return `${u.unit}/s`;
	return u.unit;
}

function cellTitle(choice: HeadlineChoice, row: SeriesRow, u: RowUnit): string {
	const f = leadFigure(choice, row);
	const p50 = show(f.p50, u);
	const p5 = show(f.p5, u);
	const p95 = show(f.p95, u);
	const per = u.kind === "time" && u.per ? ` One repetition is ${formatCount(u.per.count).full} ${u.per.of}s.` : "";
	return `${choice.label} on ${row.instance_type}: ${p50.full} ${p50.unit}, the median of ${f.count} counted runs. 5th percentile ${p5.full}, 95th ${p95.full}.${per} As the snapshot holds it: ${p50.source}.`;
}

/**
 * Every digit of the median, split where it stops agreeing with p5 and p95: the three written in one unit and
 * aligned on the decimal point, the head is the digits all three share. Nothing is dropped, rounded or computed:
 * the text is `full`, compared character by character with the other two and split in two for the eye.
 */
function splitDigits(p50: string, p5: string, p95: string): { head: string; tail: string } {
	const intLen = (s: string) => s.split(".")[0]!.length;
	const width = Math.max(intLen(p5), intLen(p50), intLen(p95));
	const pad = (s: string) => " ".repeat(width - intLen(s)) + s;
	const [a, b, c] = [pad(p5), pad(p50), pad(p95)];
	let n = 0;
	while (n < b.length && a[n] === b[n] && c[n] === b[n]) n++;
	let len = Math.max(0, n - (width - intLen(p50)));
	if (p50[len - 1] === ".") len--;
	return { head: p50.slice(0, len), tail: p50.slice(len) };
}

/** An exact figure for the table: integer part right-aligned in the row's width, so every decimal point in a row sits in one place. */
function Exact(props: { full: string; p5: string; p95: string }) {
	const [int = "", frac] = props.full.split(".");
	const { head, tail } = splitDigits(props.full, props.p5, props.p95);
	const headInt = head.slice(0, int.length);
	const tailInt = int.slice(headInt.length);
	const fracText = frac === undefined ? "" : `.${frac}`;
	const headFrac = head.length > int.length ? head.slice(int.length) : "";
	const tailFrac = fracText.slice(headFrac.length);
	return (
		<span class="exact">
			<span class="x-int">
				{headInt ? <span class="x-head">{headInt}</span> : null}
				{tailInt ? <span class="x-tail">{tailInt}</span> : null}
			</span>
			<span class="x-frac">
				{headFrac ? <span class="x-head">{headFrac}</span> : null}
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

/** The way a row reads faster, as one glyph; the key above the table says what the two glyphs mean, once. */
function Direction(props: { u: RowUnit }) {
	const more = props.u.kind === "rate";
	return (
		<span class={`dir ${more ? "dir-more" : "dir-less"}`} role="img" aria-label={more ? "more is faster" : "less is faster"} title={more ? "more is faster" : "less is faster"}>
			{more ? "↑" : "↓"}
		</span>
	);
}

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
const tracedDigits = splitDigits(tracedP50.full, tracedP5.full, tracedP95.full);
const tracedIsSample = tracedCell.series.id === seriesFileContents.sample.id;

/**
 * p5 or p95 of the traced figure with the digits all three share set as the median's are, so the card shows what the
 * table's dark digits mean: the same digits, dark in all three. Only when all three have one integer width.
 */
function Shared(props: { text: string }) {
	const intLen = (s: string) => s.split(".")[0]!.length;
	const n = tracedDigits.head.length;
	if (n === 0 || intLen(props.text) !== intLen(tracedP50.full)) return <>{props.text}</>;
	return (
		<>
			<span class="sh-head">{props.text.slice(0, n)}</span>
			<span class="sh-tail">{props.text.slice(n)}</span>
		</>
	);
}

/** The traced figure's p5 to p95 on a zoomed scale (p5 and p95 a quarter in from each end): positions for drawing only. */
function RangeStrip() {
	const lo = tracedLead.p5;
	const hi = tracedLead.p95;
	const pad = (hi - lo) * 0.5;
	const at = (v: number) => `${(((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100).toFixed(2)}%`;
	return (
		<div class="strip" style={{ "--p5": at(lo), "--p50": at(tracedLead.p50), "--p95": at(hi) }}>
			<span class="st-zoom">zoomed, not from 0</span>
			<span class="st-draw" aria-hidden="true">
				<span class="st-axis" />
				<span class="st-span" />
				<span class="st-tick st-t5" />
				<span class="st-tick st-t95" />
				<span class="st-dot" />
			</span>
			<span class="st-l st-l5 mono">
				<span class="pct-k">p5</span> <Shared text={tracedP5.full} />
			</span>
			<span class="st-l st-l95 mono">
				<span class="pct-k">p95</span> <Shared text={tracedP95.full} />
			</span>
		</div>
	);
}

/** The Series file, then one of its Runs' evidence: two links of one kind, joined by an arrow. A Run has no address of its own. */
function Trail() {
	const s = tracedCell.series;
	const point = seriesFileContents.point.example;
	// One of the Series' Runs, by id only: its own figure would read as a rival to the median above.
	return (
		<p class="trail">
			<a href={links.seriesFile(s)}>
				Series <span class="mono">{s.id}</span>
			</a>
			{tracedIsSample ? (
				<>
					<span class="tl-arrow" aria-hidden="true">
						→
					</span>
					<a href={point.evidence} title={`Run ${point.run}: ${point.evidence}`}>
						One run’s evidence <span class="mono">{point.run.slice(0, 8)}</span>
					</a>
				</>
			) : null}
		</p>
	);
}

function TracedFigure() {
	const s = tracedCell.series;
	return (
		<figure class="traced" aria-labelledby="traced-caption">
			<p class="traced-what" id="traced-caption">
				<span class="trace-mark" aria-hidden="true" />
				<a href={tracedRow.choice.readme} title={tracedRow.choice.setting}>
					{tracedRow.choice.label}
				</a>{" "}
				<span class="mono">{tracedCell.machine.instanceType}</span>
			</p>
			<p class="traced-figure" title={`${tracedP50.full} ${unitWords(tracedU)}. As the Series holds it: ${tracedP50.source}`}>
				<span class="tf-head">{tracedDigits.head}</span>
				<span class="tf-tail">{tracedDigits.tail}</span>
			</p>
			<p class="traced-unit">{unitWords(tracedU)}, median</p>
			<RangeStrip />
			{/* two set lines: what the median is of, then where and by which Method */}
			<div class="traced-facts">
				<p>
					<span>
						{formatCount(tracedDerivation.counted_runs).full} runs, {formatCount(tracedDerivation.failed_runs).full} failed
					</span>
					<span>
						<time datetime={s.oldest_run_started_at}>{formatMoment(s.oldest_run_started_at).date}</time> to{" "}
						<time datetime={s.newest_run_started_at}>{formatMoment(s.newest_run_started_at).date}</time>
					</span>
				</p>
				<p>
					<span class="mono" title="Availability Zone ID">
						{s.availability_zone_id}
					</span>
					<span>
						<a href={links.docs}>
							Method <span class="mono">{tracedDerivation.method.name} v{tracedDerivation.method.version}</span>
						</a>
					</span>
				</p>
			</div>
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
				<nav aria-label="Sections">
					<ul class="nav">
						<li class="nav-keep">
							<a href="#numbers">Numbers</a>
						</li>
						<li>
							<a href="#machines">Machines</a>
						</li>
						<li class="nav-api">
							<a href="#api" class="btn btn-small">
								Data API
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
					<p class="eyebrow">AWS {snapshot.region} server benchmarks as JSON, for agents</p>
					<h1 id="claim">Server numbers you can trace to their runs.</h1>
					{/* the cadence beside the newest Run; the claim and the card say the rest */}
					<div class="fresh">
						<p class="fresh-line">
							<span>
								newest run{" "}
								<time datetime={newest.iso} title={newest.full}>
									{newest.date} {newest.minute} UTC
								</time>
							</span>
							<span>booted four times a day</span>
							<span>
								<a href={links.seriesList}>{runs.full} runs</a>, {failed.full} failed
							</span>
						</p>
					</div>
				</div>
				<TracedFigure />
				<div class="hero-rest">
					<Curl url={links.index} light />
				</div>
			</div>
		</section>
	);
}

/**
 * AWS's words as the price file gives them. Nothing is added: no unit, no symbol, no number. The one change is a
 * word left out, a trailing "Processor", and then AWS's whole phrase is the cell's title.
 */
function Aws(props: { words: string }) {
	const w = props.words.trim();
	const shown = w.replace(/ Processor$/, "");
	return shown === w ? <>{w}</> : <span title={`AWS: “${w}”`}>{shown}</span>;
}

function priceTitle(m: (typeof machines)[number]): string {
	return `${m.price.description}. In the price file at ${m.price.path.pointer}`;
}

const SPEC_COLS = ["vCPU", "Memory", "Processor", "Clock", "Network", "Storage"] as const;

/** Hourly prices in the table's mono, every decimal point in one column. */
const PRICES = machines.map((m) => formatUsd(m.price.usdPerHour).full);
const PRICE_INT = Math.max(...PRICES.map((p) => p.split(".")[0]!.length)) + 1;
const PRICE_FRAC = Math.max(...PRICES.map((p) => (p.split(".")[1] ?? "").length + 1));

function Price(props: { full: string }) {
	const [int = "", frac] = props.full.split(".");
	return (
		<span class="usd" style={{ "--iw": `${PRICE_INT}ch`, "--fw": `${PRICE_FRAC}ch` }}>
			<span class="x-int">${int}</span>
			<span class="x-frac">{frac === undefined ? "" : `.${frac}`}</span>
		</span>
	);
}

function Machines() {
	return (
		<section class="machines" id="machines" aria-labelledby="machines-title">
			<div class="wrap">
				<div class="section-head">
					<h2 id="machines-title">The machines, by the hour</h2>
					<p class="section-note">
						On-Demand, Linux, {snapshot.region} · <a href={links.prices}>AWS price file, {snapshot.priceDate}</a>
					</p>
				</div>
				<div class="spec-box">
					<table class="spec">
						<thead>
							<tr>
								<th scope="col">Type</th>
								<th scope="col" class="spec-num">
									Per hour
								</th>
								{SPEC_COLS.map((c) => (
									<th scope="col">{c}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{machines.map((m) => (
								<tr>
									<th scope="row" class="mono spec-type">
										{m.instanceType}
									</th>
									<td class="spec-num spec-price" title={priceTitle(m)}>
										<Price full={formatUsd(m.price.usdPerHour).full} />
									</td>
									<td data-l="vCPU">
										{m.vcpu}
										<span class="spec-l"> vCPU</span>
									</td>
									<td data-l="Memory">{m.memory}</td>
									<td data-l="Processor">
										<Aws words={m.processor} />
									</td>
									<td data-l="Clock">{m.clockSpeed}</td>
									<td data-l="Network">{m.network}</td>
									<td data-l="Storage">{m.storage}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</section>
	);
}

/** The widest figure column any row needs, in characters, so on a phone every card's bars start at one x. */
const FIGURE_WIDTH = Math.max(
	...headline.map((row) => {
		const u = rowUnit(row);
		const shown = row.cells.map((cell) => show(leadFigure(row.choice, cell.series).p50, u).full);
		const int = Math.max(...shown.map((v) => v.split(".")[0]!.length));
		const frac = Math.max(...shown.map((v) => (v.split(".")[1] ?? "").length + 1));
		return int + frac;
	}),
);

const sectionId = (section: Section) => `t-${section.toLowerCase().replace(/\s+/g, "-")}`;
const SECTION_NOTES: Partial<Record<Section, string>> = { Disk: "root EBS gp3 volume" };

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
				<span class="dir" aria-hidden="true">
					↑
				</span>
				more is faster
			</span>
			<span class="key-item">
				<span class="dir" aria-hidden="true">
					↓
				</span>
				less is faster
			</span>
			<span class="key-item">
				<b class="kg-bold">full-tone</b> digits: same at p5 and p95
			</span>
		</p>
	);
}

/** A group's name for the jump chips: the long one shortened, its full name kept. */
const CHIP: Partial<Record<Section, string>> = { "Operating system": "OS" };

function NumbersTable() {
	return (
		<section class="numbers" id="numbers" aria-labelledby="numbers-title">
			<div class="wrap">
				<div class="numbers-head">
					<h2 id="numbers-title">
						{formatCount(snapshot.benchmarkCount).full} benchmarks × {formatCount(snapshot.machineCount).full} machines
					</h2>
					<SpreadKey />
				</div>
				<nav class="jump" aria-label="Benchmark groups">
					{SECTIONS.map((section) => (
						<a href={`#${sectionId(section)}`}>{CHIP[section] ? <abbr title={section}>{CHIP[section]}</abbr> : section}</a>
					))}
				</nav>

				<div class="table-box" role="region" aria-label="The headline table" style={{ "--vw": `${FIGURE_WIDTH}ch` }}>
					<table class="ht">
						<thead>
							<tr>
								<th scope="col" class="col-bench">
									Benchmark
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
										{SECTION_NOTES[section] ? <span class="sr-note">{SECTION_NOTES[section]}</span> : null}
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
													<a class="row-label" href={row.choice.readme} title={row.choice.what}>
														{/* a name never breaks at its hyphen: "SHA-256" stays whole */}
														{row.choice.label.replaceAll("-", "‑")}
													</a>{" "}
													<span class="row-unit" title={u.kind === "time" ? `${unitWords(u)}. One repetition: ${row.choice.repetition}` : undefined}>
														{rowUnitShort(u)} <Direction u={u} />
													</span>
												</th>
												{row.cells.map((cell, i) => {
													const f = figures[i]!;
													const s = shown[i]!;
													const here = cell === tracedCell;
													return (
														<td class={here ? "is-traced" : undefined}>
															{/* every figure leads to its own Series: its runs, its p5 and p95, its Method */}
															<a class="cell" href={links.seriesFile(cell.series)} title={cellTitle(row.choice, cell.series, u)}>
																<span class="cell-m mono">{cell.machine.instanceType}</span>
																<span class="cell-v">
																	<Exact full={s.full} p5={show(f.p5, u).full} p95={show(f.p95, u).full} />
																	<Spread f={f} max={max} />
																</span>
															</a>
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
						All {seriesCount.full} Series, every setting <span aria-hidden="true">→</span>
					</a>
				</p>
			</div>
		</section>
	);
}

/** One line of JSON, with keys, strings and numbers in spans for colour. */
function JsonLine(props: { text: string }) {
	const parts: (string | { cls: string; t: string })[] = [];
	const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
	let last = 0;
	for (const m of props.text.matchAll(re)) {
		parts.push(props.text.slice(last, m.index));
		if (m[1]) {
			parts.push({ cls: m[2] ? "j-key" : "j-str", t: m[1] });
			if (m[2]) parts.push(m[2]);
		} else parts.push({ cls: "j-num", t: m[3]! });
		last = m.index! + m[0].length;
	}
	parts.push(props.text.slice(last));
	// A string that wraps breaks after a slash, never inside a name or a hash.
	const slashes = (t: string) => t.split(/(?<=\/)/).map((part, i) => (i > 0 ? [<wbr />, part] : part));
	return <>{parts.map((p) => (typeof p === "string" ? p : <span class={p.cls}>{p.cls === "j-str" ? slashes(p.t) : p.t}</span>))}</>;
}

/**
 * JSON as text, one block per line, each indented by its depth so a long line wraps under itself, not under the margin.
 * A run of closing braces shares one line, so the nesting costs no height.
 */
function Json(props: { value: unknown }) {
	const lines: string[] = [];
	for (const line of JSON.stringify(props.value, null, 2).split("\n")) {
		const prev = lines[lines.length - 1];
		if (prev !== undefined && /^\s*[}\]]/.test(line) && /^\s*[}\]][\s}\]]*$/.test(prev)) lines[lines.length - 1] = `${prev} ${line.trim()}`;
		else lines.push(line);
	}
	return (
		<>
			{lines.map((line) => {
				const depth = line.length - line.trimStart().length;
				return (
					<span class="jl" style={{ "--d": `${depth}ch` }}>
						{" ".repeat(depth)}
						<JsonLine text={line.trimStart()} />
					</span>
				);
			})}
		</>
	);
}

const API_HOST = "https://api.ledgermath.com";

/** Every address an agent needs, path only under the host, each beside its schema. */
const ENDPOINTS: { url: string; schema: string; link: boolean }[] = [
	{ url: links.index, schema: links.schema.index, link: true },
	{ url: links.seriesList, schema: links.schema.seriesList, link: true },
	// One Series' own file, the traced one, so the address shown is one that answers when copied.
	{ url: links.seriesFile(tracedCell.series), schema: links.schema.series, link: true },
	{ url: links.prices, schema: links.schema.prices, link: true },
];

function Api() {
	const s = tracedCell.series;
	const d = s.derivations.series_v1;
	// The entry cut to what ties it to the traced figure: whose it is, how many Runs, the three percentiles.
	const pcts = (p: { p5: number; p50: number; p95: number } | null | undefined) => (p ? { p5: p.p5, p50: p.p50, p95: p.p95 } : p);
	const excerpt = {
		id: s.id,
		benchmark: s.benchmark,
		instance_type: s.instance_type,
		derivations: {
			series_v1: {
				counted_runs: d.counted_runs,
				percentiles: tracedRow.choice.lead === "rate" ? { bytes_per_second: pcts(d.percentiles.bytes_per_second) } : { time_per_repetition_ns: pcts(d.percentiles.time_per_repetition_ns) },
			},
		},
	};
	// The page shows the mutex time per critical section; the file holds it per repetition. One line of figures joins them,
	// under the JSON, so the JSON stays as the file has it.
	const per = tracedRow.choice.per;
	const p50 = d.percentiles.time_per_repetition_ns?.p50;
	const join =
		per && p50 != null && tracedRow.choice.lead !== "rate" ? (
			<p class="j-join mono" title={`One repetition is ${formatCount(per.count).full} ${per.of}s: ${p50} ns ÷ ${formatCount(per.count).full}, the figure traced at the top`}>
				<span class="trace-mark" aria-hidden="true" />
				<span>
					<span class="j-k">p50</span> ÷ {formatCount(per.count).full} <span class="j-u">{per.of}s</span> = {perUnit(p50, per.count)}{" "}
					<span class="j-u">{tracedU.unit}</span>
				</span>
			</p>
		) : null;
	return (
		<section class="api" id="api" aria-labelledby="api-title">
			<div class="wrap api-grid">
				<div class="api-copy">
					<h2 id="api-title">Point your agent at the source.</h2>
					<p class="ep-host">
						<span class="mono">{API_HOST}</span>
						<a href={links.docs}>Docs</a>
					</p>
					<ul class="endpoints">
						{ENDPOINTS.map((e) => {
							// Whole names only: a wrapped path breaks after a slash, never at a date's dash.
							const path = e.url
								.slice(API_HOST.length)
								.split(/(?<=\/)/)
								.map((part) => <span class="ep-seg">{part}</span>);
							return (
								<li data-copy={e.url}>
									{e.link ? (
										<a class="ep-path mono" href={e.url}>
											{path}
										</a>
									) : (
										<code class="ep-path mono">{path}</code>
									)}
									<a class="ep-schema" href={e.schema}>
										schema
									</a>
								</li>
							);
						})}
					</ul>
				</div>
				<div class="api-code">
					<div class="code-head">
						<span class="mono">GET /v1/series.json</span>
						<span>one entry</span>
					</div>
					<pre tabindex="0" aria-label={`Series ${s.id}'s entry in series.json, shortened`}>
						<code>
							<Json value={excerpt} />
						</code>
					</pre>
					{join}
				</div>
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
				<p>
					Snapshot:{" "}
					<time datetime={newest.iso} title={newest.full}>
						{newest.full}
					</time>
				</p>
				<p>
					<a href="third-party-notices.txt">Font licences</a>
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
				<Api />
				<Machines />
			</main>
			<Footer />
		</>
	);
}
