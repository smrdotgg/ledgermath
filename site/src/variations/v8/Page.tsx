// Design v8, "Editorial landing": one claim, one figure traced to its evidence, three proofs, then the numbers.
// Every figure comes from src/data as the snapshot holds it; see ../README.md.
// Round 3: the page says as little as it can. Labels, not sentences; anything longer is behind a link.
import "./page.css";
import {
	benchmarks,
	type DurationUnit,
	durationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	headlineSeries,
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
	shift,
	snapshot,
} from "../../data";

// ------------------------------------------------------------------ figures

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const runs = formatCount(snapshot.runCount);
const seriesCount = formatCount(snapshot.seriesCount);
const failed = formatCount(snapshot.failedRuns);
const SCHEDULE = ["04:10", "10:10", "16:10", "22:10"];
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

function cellTitle(choice: HeadlineChoice, row: SeriesRow, u: RowUnit): string {
	const f = leadFigure(choice, row);
	const p50 = show(f.p50, u);
	const p5 = show(f.p5, u);
	const p95 = show(f.p95, u);
	const per = u.kind === "time" && u.per ? ` One repetition is ${formatCount(u.per.count).full} ${u.per.of}s.` : "";
	return `${choice.label} on ${row.instance_type}: ${p50.full} ${p50.unit}, the median of ${f.count} counted Runs. 5th percentile ${p5.full}, 95th ${p95.full}.${per} As the snapshot holds it: ${p50.source}.`;
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
const tracedPrice = formatUsd(tracedCell.machine.price.usdPerHour);
const tracedIsSample = tracedCell.series.id === seriesFileContents.sample.id;

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
				<a href={links.seriesFile(s)}>
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
						{point.boot_summary ? (
							<a href={point.boot_summary} class="tl-v">
								boot
							</a>
						) : null}
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
			<p class="traced-figure" title={`${tracedP50.full} ${unitWords(tracedU)}. As the Series holds it: ${tracedP50.source}`}>
				<span class="tf-head">{tracedDigits.head}</span>
				<span class="tf-tail">{tracedDigits.tail}</span>
			</p>
			<p class="traced-unit">{unitWords(tracedU)}, median</p>
			<RangeStrip />
			<dl class="traced-facts">
				<div>
					<dt>Runs</dt>
					<dd>
						{formatCount(tracedDerivation.counted_runs).full} counted, {formatCount(tracedDerivation.failed_runs).full} failed
					</dd>
				</div>
				<div>
					<dt>Dates</dt>
					<dd>
						<time datetime={s.oldest_run_started_at}>{formatMoment(s.oldest_run_started_at).date}</time> –{" "}
						<time datetime={s.newest_run_started_at}>{formatMoment(s.newest_run_started_at).date}</time>
					</dd>
				</div>
				<div>
					<dt>Method</dt>
					<dd>
						<a class="mono" href={links.docs}>
							{tracedDerivation.method.name} v{tracedDerivation.method.version}
						</a>
					</dd>
				</div>
				<div>
					<dt>Zone</dt>
					<dd>
						<span class="mono">{s.availability_zone_id}</span> · ${tracedPrice.full}/h
					</dd>
				</div>
			</dl>
			<Trail />
		</figure>
	);
}

// ------------------------------------------------------------------ small drawings

function ScheduleLine() {
	// One UTC day as a ruler: the four scheduled boots, and where the newest Run started.
	const x = (hhmm: string) => {
		const [h, m] = hhmm.split(":").map(Number) as [number, number];
		return 8 + ((h + m / 60) / 24) * 304;
	};
	const now = x(newest.minute);
	return (
		<svg class="dayline" viewBox="0 0 320 52" aria-hidden="true">
			<line x1="8" x2="312" y1="30" y2="30" class="dl-axis" />
			{Array.from({ length: 25 }, (_, h) => (
				<line x1={x(`${h}:00`)} x2={x(`${h}:00`)} y1={h % 6 === 0 ? 24 : 27} y2="30" class="dl-hour" />
			))}
			{[0, 6, 12, 18, 24].map((h) => (
				<text x={x(`${h}:00`)} y="46" text-anchor="middle" class="dl-label">
					{String(h).padStart(2, "0")}
				</text>
			))}
			{SCHEDULE.map((t) => (
				<circle cx={x(t)} cy="30" r="4.5" class="dl-boot" />
			))}
			<line x1={now} x2={now} y1="12" y2="30" class="dl-now-line" />
			<circle cx={now} cy="30" r="3" class="dl-now" />
			<text x={now} y="9" text-anchor="middle" class="dl-now-label">
				newest Run {newest.minute}
			</text>
		</svg>
	);
}

function MachineGlyph() {
	return (
		<svg class="step-art" viewBox="0 0 200 120" aria-hidden="true">
			<line x1="0" y1="60" x2="40" y2="60" class="flow" />
			{machines.map((m, i) => (
				<g transform={`translate(44 ${14 + i * 19})`}>
					<rect width="112" height="15" rx="2.5" class={i === 0 ? "art-fill-accent" : "art-box"} />
					<circle cx="9" cy="7.5" r="2.2" class={i === 0 ? "art-on-accent" : "art-dot"} />
					<text x="18" y="11" class={i === 0 ? "art-text-on-accent" : "art-text"}>
						{m.instanceType}
					</text>
				</g>
			))}
			<line x1="160" y1="60" x2="200" y2="60" class="flow" />
		</svg>
	);
}

function BenchGlyph() {
	// The fourteen benchmarks as bars, grouped by section, in the home table's order.
	let x = 44;
	let last: Section | undefined;
	const bars = benchmarks.map((b) => {
		if (last && b.section !== last) x += 5;
		last = b.section;
		const bar = { x, section: b.section };
		x += 7;
		return bar;
	});
	return (
		<svg class="step-art" viewBox="0 0 200 120" aria-hidden="true">
			<line x1="0" y1="60" x2="40" y2="60" class="flow" />
			{bars.map((b) => (
				<rect x={b.x} y="44" width="5" height="32" rx="1.5" class="art-fill-ink" />
			))}
			<line x1={x + 2} y1="60" x2="200" y2="60" class="flow" />
		</svg>
	);
}

function EvidenceGlyph() {
	return (
		<svg class="step-art" viewBox="0 0 200 120" aria-hidden="true">
			<line x1="0" y1="60" x2="58" y2="60" class="flow" />
			<path d="M62 18 h58 l18 18 v68 h-76 z" class="art-paper" />
			<path d="M120 18 v18 h18 z" class="art-fill-accent" />
			<text x="70" y="34" class="art-text">stdout</text>
			{[0, 1, 2, 3].map((i) => (
				<line x1="70" x2={i % 2 ? 116 : 128} y1={46 + i * 8} y2={46 + i * 8} class="art-line" />
			))}
			<text x="70" y="88" class="art-text">machine</text>
			<line x1="70" x2="112" y1="96" y2="96" class="art-line" />
			<line x1="142" y1="60" x2="200" y2="60" class="flow" />
		</svg>
	);
}

function DeriveGlyph() {
	// A diagram of percentiles, not data: evenly spread ticks with three marked.
	const xs = [52, 60, 66, 71, 75, 79, 82, 86, 89, 93, 97, 102, 108, 116, 128];
	return (
		<svg class="step-art" viewBox="0 0 200 120" aria-hidden="true">
			<line x1="0" y1="60" x2="40" y2="60" class="flow" />
			<line x1="44" y1="60" x2="156" y2="60" class="art-box-line" />
			{xs.map((x) => (
				<line x1={x} x2={x} y1="50" y2="60" class="art-line" />
			))}
			<line x1="56" x2="56" y1="40" y2="74" class="art-mark" />
			<line x1="89" x2="89" y1="34" y2="80" class="art-mark-accent" />
			<line x1="124" x2="124" y1="40" y2="74" class="art-mark" />
			<text x="56" y="90" text-anchor="middle" class="art-text">p5</text>
			<text x="89" y="96" text-anchor="middle" class="art-text-strong">p50</text>
			<text x="124" y="90" text-anchor="middle" class="art-text">p95</text>
			<line x1="160" y1="60" x2="200" y2="60" class="flow" />
		</svg>
	);
}

function ApiGlyph() {
	return (
		<svg class="step-art" viewBox="0 0 200 120" aria-hidden="true">
			<line x1="0" y1="60" x2="36" y2="60" class="flow" />
			<rect x="40" y="26" width="132" height="68" rx="6" class="art-fill-ink" />
			<text x="52" y="46" class="art-text-on-ink">GET /v1/</text>
			<text x="52" y="62" class="art-text-on-ink-dim">index.json</text>
			<text x="52" y="76" class="art-text-on-ink-dim">series.json</text>
			<text x="52" y="90" class="art-text-on-ink-dim">prices/…json</text>
			<circle cx="160" cy="40" r="3.5" class="art-fill-accent" />
		</svg>
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
						<li>
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
					<p class="eyebrow">AWS server benchmarks, as JSON</p>
					<h1 id="claim">Server numbers you can trace to their Runs.</h1>
					<p class="lede">
						{formatCount(snapshot.machineCount).full} AWS machine types, booted four times a day; {formatCount(snapshot.benchmarkCount).full} benchmarks on each; every Run
						kept with its evidence.
					</p>
					<p class="fresh">
						<span class="pulse" aria-hidden="true" />
						<span class="fresh-at">
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
					<p class="way-in">
						<span class="mono">api.ledgermath.com</span>: static JSON for agents, a source for every figure.
					</p>
					<Curl url={links.index} light />
					<a class="btn btn-primary" href="#numbers">
						All {formatCount(headlineSeries.length).full} figures <span aria-hidden="true">↓</span>
					</a>
				</div>
			</div>
		</section>
	);
}

function Proofs() {
	return (
		<section class="proofs" aria-labelledby="proofs-title">
			<div class="wrap">
				<h2 id="proofs-title" class="section-kicker">
					On the record
				</h2>
				<div class="proof-grid">
					<article class="proof">
						<p class="big">{runs.full}</p>
						<h3>
							Runs kept, {failed.full} failed, since{" "}
							<time datetime={oldest.iso} title={oldest.full}>
								{oldest.date}
							</time>
						</h3>
					</article>
					<article class="proof">
						<ScheduleLine />
						<h3>
							Boots at <span class="times">{SCHEDULE.join(" · ")}</span> UTC
						</h3>
					</article>
					<article class="proof">
						<p class="big">
							{formatCount(headlineSeries.length).full}
							<span class="big-of"> of {seriesCount.full}</span>
						</p>
						<h3>Series in the table below</h3>
					</article>
				</div>
			</div>
		</section>
	);
}

function HowItWorks() {
	const steps = [
		{ art: <MachineGlyph />, title: "A machine boots" },
		{ art: <BenchGlyph />, title: `${formatCount(snapshot.benchmarkCount).full} benchmarks run` },
		{ art: <EvidenceGlyph />, title: "Evidence is kept" },
		{ art: <DeriveGlyph />, title: "A Method derives" },
		{ art: <ApiGlyph />, title: "The API serves" },
	];
	return (
		<section class="how" id="how" aria-labelledby="how-title">
			<div class="wrap">
				<h2 id="how-title" class="section-kicker">
					From a cold boot to a figure
				</h2>
				<ol class="steps">
					{steps.map((s, i) => (
						<li class="step">
							<div class="step-figure">{s.art}</div>
							<h3>
								<span class="step-n">{String(i + 1).padStart(2, "0")}</span> {s.title}
							</h3>
						</li>
					))}
				</ol>
			</div>
		</section>
	);
}

/**
 * AWS's network words in one unit, for scanning: "Up to 15000 Megabit" reads "≤ 15 Gbit/s".
 * Only the decimal point moves (Megabit to Gigabit); AWS's own words are the cell's title.
 */
function network(words: string): { value: string; upTo: boolean } | null {
	const m = /^(Up to )?(\d+(?:\.\d+)?) (Gigabit|Megabit)$/i.exec(words.trim());
	if (!m) return null;
	return { value: m[3]!.toLowerCase() === "megabit" ? shift(m[2]!, -3) : m[2]!, upTo: Boolean(m[1]) };
}

function Network(props: { words: string }) {
	const n = network(props.words);
	if (!n) return <>{props.words}</>;
	return (
		<span class="net" title={`AWS: “${props.words}”`}>
			{n.upTo ? "≤ " : ""}
			{n.value} Gbit/s
		</span>
	);
}

function priceTitle(m: (typeof machines)[number]): string {
	return `${m.price.description}. In the price file at ${m.price.path.pointer}`;
}

const SPEC_COLS = ["vCPU", "Memory", "Processor", "Clock", "Network", "Storage"] as const;

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
										<span class="usd">${formatUsd(m.price.usdPerHour).full}</span>
									</td>
									<td data-l="vCPU">{m.vcpu}</td>
									<td data-l="Memory">{m.memory}</td>
									<td data-l="Processor">{m.processor}</td>
									<td data-l="Clock">{m.clockSpeed}</td>
									<td data-l="Network">
										<Network words={m.network} />
									</td>
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
				<nav class="jump" aria-label="Benchmark groups">
					{SECTIONS.map((section) => (
						<a href={`#${sectionId(section)}`}>{section}</a>
					))}
				</nav>

				<div class="table-box" role="region" aria-label="The headline table">
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
														{row.choice.label}
													</a>
													<span class="row-unit">
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
																	<span class="cell-m mono">{cell.machine.instanceType}</span>
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
						All {seriesCount.full} Series <span aria-hidden="true">→</span>
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
	return <>{parts.map((p) => (typeof p === "string" ? p : <span class={p.cls}>{p.t}</span>))}</>;
}

/** JSON as text, one block per line, each indented by its depth so a long line wraps under itself, not under the margin. */
function Json(props: { value: unknown }) {
	const lines = JSON.stringify(props.value, null, 2).split("\n");
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

function Api() {
	const s = tracedCell.series;
	const d = s.derivations.series_v1;
	const excerpt = {
		id: s.id,
		url: s.url,
		instance_type: s.instance_type,
		derivations: {
			series_v1: {
				counted_runs: d.counted_runs,
				percentiles: tracedRow.choice.lead === "rate" ? { bytes_per_second: d.percentiles.bytes_per_second } : { time_per_repetition_ns: d.percentiles.time_per_repetition_ns },
			},
		},
	};
	const endpoints = [
		{ label: "Start here", url: links.index },
		{ label: "Every Series", url: links.seriesList },
		{ label: `Prices, ${snapshot.priceDate}`, url: links.prices },
	];
	return (
		<section class="api" id="api" aria-labelledby="api-title">
			<div class="wrap api-grid">
				<div class="api-copy">
					<h2 id="api-title">Point your agent at the source.</h2>
					<ul class="endpoints">
						{endpoints.map((e) => (
							<li>
								<p class="ep-label">{e.label}</p>
								<Curl url={e.url} />
							</li>
						))}
					</ul>
					<p class="api-more">
						<a href={links.docs}>Docs</a>
						<span class="dot-sep" aria-hidden="true">
							·
						</span>
						Schemas:{" "}
						{links.schemas.map((sc, i) => (
							<>
								{i > 0 ? ", " : ""}
								<a href={sc.url}>{sc.name}</a>
							</>
						))}
					</p>
				</div>
				<div class="api-code">
					<div class="code-head">
						<span class="mono">GET /v1/series.json</span>
						<span class="code-tag">one entry</span>
					</div>
					<pre tabindex="0" aria-label={`Series ${s.id}'s entry in series.json, shortened`}>
						<code>
							<Json value={excerpt} />
						</code>
					</pre>
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
				<Proofs />
				<NumbersTable />
				<Api />
				<HowItWorks />
				<Machines />
			</main>
			<Footer />
		</>
	);
}
