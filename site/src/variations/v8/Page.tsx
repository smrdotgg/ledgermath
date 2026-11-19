// Design v8, "Editorial landing": one claim, three proofs, how it works, then the numbers.
// Every figure comes from src/data as the snapshot holds it; see ../README.md.
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
	plain,
	snapshot,
} from "../../data";

// ------------------------------------------------------------------ figures

const plainNs = (n: number | null | undefined) => (n == null ? "" : plain(n));

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const runs = formatCount(snapshot.runCount);
const seriesCount = formatCount(snapshot.seriesCount);
const failed = formatCount(snapshot.failedRuns);
const pricesFetched = formatMoment(snapshot.pricesFetchedAt);
const SCHEDULE = ["04:10", "10:10", "16:10", "22:10"];
const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
/** The scheduled boot the newest Run started after (the times compare as text, HH:MM). */
const bootBefore = [...SCHEDULE].reverse().find((t) => t <= newest.minute);

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
	return `${p50.full} ${p50.unit}: the median of ${f.count} counted Runs on ${row.instance_type}. 5th percentile ${p5.full}, 95th ${p95.full}. As the snapshot holds it: ${p50.source}.`;
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
			<span class="sp-mid" />
		</span>
	);
}

// ------------------------------------------------------------------ the traced figure (hero)

const traced = headline[0]!;
const tracedCell = traced.cells[0]!;
const tracedLead = leadFigure(traced.choice, tracedCell.series);
const tracedP50 = formatRate(tracedLead.p50);
const tracedP5 = formatRate(tracedLead.p5, { unit: "GB" });
const tracedP95 = formatRate(tracedLead.p95, { unit: "GB" });
const tracedDerivation = tracedCell.series.derivations.series_v1;
const tracedDigits = splitDigits(tracedP50.full);
const tracedPrice = formatUsd(tracedCell.machine.price.usdPerHour, { per: "hour" });

function RangeStrip() {
	// p5, p50 and p95 placed on a scale padded beyond p5 and p95: positions for drawing only.
	const lo = tracedLead.p5;
	const hi = tracedLead.p95;
	const pad = (hi - lo) * 0.35;
	const x = (v: number) => 12 + ((v - (lo - pad)) / (hi - lo + 2 * pad)) * 296;
	return (
		<svg class="range" viewBox="0 0 320 44" aria-hidden="true">
			<line x1="12" x2="308" y1="16" y2="16" class="range-axis" />
			<line x1={x(lo)} x2={x(hi)} y1="16" y2="16" class="range-span" />
			<line x1={x(lo)} x2={x(lo)} y1="9" y2="23" class="range-tick" />
			<line x1={x(hi)} x2={x(hi)} y1="9" y2="23" class="range-tick" />
			<circle cx={x(tracedLead.p50)} cy="16" r="6" class="range-dot" />
			<text x={x(lo)} y="40" text-anchor="middle" class="range-label">p5</text>
			<text x={x(tracedLead.p50)} y="40" text-anchor="middle" class="range-label">p50</text>
			<text x={x(hi)} y="40" text-anchor="middle" class="range-label">p95</text>
		</svg>
	);
}

function TracedFigure() {
	const s = tracedCell.series;
	return (
		<figure class="traced" aria-labelledby="traced-caption">
			<div class="traced-head">
				<p class="eyebrow" id="traced-caption">
					One figure, traced to its source
				</p>
				<span class="traced-id">Series {s.id}</span>
			</div>
			<p class="traced-what">
				{traced.choice.label} <span class="sep">on</span> <span class="mono">{tracedCell.machine.instanceType}</span>
			</p>
			<p class="traced-figure" title={`${tracedP50.full} ${tracedP50.unit}`}>
				<span class="traced-num">{tracedDigits.head}</span>
				<span class="traced-tail">{tracedDigits.tail}</span>
				<span class="traced-unit">{tracedP50.unit}</span>
			</p>
			<p class="traced-full">
				The median, every digit. As the Series holds it: <span class="mono">{tracedP50.source}</span>
			</p>
			<RangeStrip />
			<p class="traced-pcts mono">
				<span>
					<span class="pct-k">p5</span> {tracedP5.full}
				</span>
				<span>
					<span class="pct-k">p95</span> {tracedP95.full}
				</span>
			</p>
			<dl class="traced-facts">
				<div>
					<dt>Runs</dt>
					<dd>
						{formatCount(tracedDerivation.counted_runs).full} counted, {formatCount(tracedDerivation.failed_runs).full} failed; each one listed in the Series file, with a link to its evidence
					</dd>
				</div>
				<div>
					<dt>Between</dt>
					<dd>
						<time datetime={s.oldest_run_started_at} title={formatMoment(s.oldest_run_started_at).full}>
							{formatMoment(s.oldest_run_started_at).date}
						</time>{" "}
						and{" "}
						<time datetime={s.newest_run_started_at} title={formatMoment(s.newest_run_started_at).full}>
							{formatMoment(s.newest_run_started_at).date}
						</time>
					</dd>
				</div>
				<div>
					<dt>Setting</dt>
					<dd>{traced.choice.setting}</dd>
				</div>
				<div>
					<dt>Method</dt>
					<dd>
						<span class="mono">
							{tracedDerivation.method.name} v{tracedDerivation.method.version}
						</span>
						: the median across counted Runs
					</dd>
				</div>
				<div>
					<dt>Zone, price</dt>
					<dd>
						<span class="mono">{s.availability_zone_id}</span>, ${tracedPrice.full} an hour
					</dd>
				</div>
			</dl>
			<a class="traced-source" href={links.seriesFile(s)}>
				<span class="ts-label">Series file: every Run behind this figure</span>
				<span class="ts-url mono">
					{links.seriesFile(s).replace("https://", "")}
					<span aria-hidden="true"> →</span>
				</span>
			</a>
		</figure>
	);
}

// ------------------------------------------------------------------ small drawings

function ScheduleDial() {
	// A 24-hour dial: the four scheduled boots, and where the newest Run started.
	const r = 46;
	const at = (hhmm: string, radius: number) => {
		const [h, m] = hhmm.split(":").map(Number) as [number, number];
		const a = ((h + m / 60) / 24) * 2 * Math.PI - Math.PI / 2;
		return { x: 60 + radius * Math.cos(a), y: 60 + radius * Math.sin(a) };
	};
	const now = at(newest.minute, r);
	return (
		<svg class="dial" viewBox="0 0 120 120" aria-hidden="true">
			<circle cx="60" cy="60" r={r} class="dial-ring" />
			{Array.from({ length: 24 }, (_, h) => {
				const a = at(`${h}:00`, r);
				const b = at(`${h}:00`, h % 6 === 0 ? r - 7 : r - 3.5);
				return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} class="dial-hour" />;
			})}
			{SCHEDULE.map((t) => {
				const p = at(t, r);
				return <circle cx={p.x} cy={p.y} r="4.5" class="dial-boot" />;
			})}
			<line x1="60" y1="60" x2={now.x} y2={now.y} class="dial-hand" />
			<circle cx={now.x} cy={now.y} r="3.2" class="dial-now" />
			<circle cx="60" cy="60" r="2.5" class="dial-now" />
			<text x="60" y="35" text-anchor="middle" class="dial-label">00</text>
			<text x="60" y="91" text-anchor="middle" class="dial-label">12</text>
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
			<text x="44" y="34" class="art-text">
				{formatCount(snapshot.benchmarkCount).full} benchmarks
			</text>
			{bars.map((b) => (
				<rect x={b.x} y="44" width="5" height="32" rx="1.5" class="art-fill-ink" />
			))}
			<text x="44" y="92" class="art-text">
				{SECTIONS.length} sections
			</text>
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
							<a href="#how">How it works</a>
						</li>
						<li>
							<a href="#machines">Machines</a>
						</li>
						<li>
							<a href="#numbers">Numbers</a>
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

function Hero() {
	return (
		<section class="hero" aria-labelledby="claim">
			<div class="wrap hero-grid">
				<div class="hero-copy">
					<p class="eyebrow">
						<span>AWS server benchmarks</span>
						<span class="dot-sep" aria-hidden="true">·</span>
						<span class="eb-2">a data API for agents</span>
					</p>
					<h1 id="claim">Server numbers you can trace to the Runs behind them.</h1>
					<p class="lede">
						LedgerMath boots {formatCount(snapshot.machineCount).full} AWS machine types four times a day, runs{" "}
						{formatCount(snapshot.benchmarkCount).full} benchmarks on each freshly booted machine, and keeps every Run with its evidence. The figures, the
						evidence and AWS's hourly prices are published as static JSON, made so AI agents can decide from measured numbers, with a source for each.
					</p>
					<div class="actions">
						<a class="btn btn-primary" href="#api">
							Use the data API <span aria-hidden="true">→</span>
						</a>
						<a class="btn btn-ghost" href="#numbers">
							See the numbers
						</a>
					</div>
					<p class="fresh">
						<span class="pulse" aria-hidden="true" />
						Newest Run started{" "}
						<time datetime={newest.iso} title={newest.full}>
							{newest.longDate}, {newest.minute} UTC
						</time>
					</p>
				</div>
				<TracedFigure />
			</div>
		</section>
	);
}

function Proofs() {
	return (
		<section class="proofs" aria-labelledby="proofs-title">
			<div class="wrap">
				<h2 id="proofs-title" class="section-kicker">
					Why the numbers can be checked
				</h2>
				<div class="proof-grid">
					<article class="proof">
						<p class="proof-figure">
							<span class="big">{runs.full}</span>
							<span class="big-unit">Runs kept</span>
						</p>
						<h3>Every Run kept with its evidence</h3>
						<p>
							Each execution is stored as a Run, with what the benchmark printed and what was recorded about the machine. A failed Run is kept and shown, never
							dropped; this snapshot has {failed.full}. The oldest Run here started on{" "}
							<time datetime={oldest.iso} title={oldest.full}>
								{oldest.longDate}
							</time>
							.
						</p>
					</article>
					<article class="proof">
						<div class="proof-figure proof-figure-dial">
							<ScheduleDial />
							<p>
								<span class="big">{newest.minute}</span>
								<span class="big-unit">UTC, newest Run</span>
							</p>
						</div>
						<p class="dial-key" aria-hidden="true">
							<span class="k-boot" /> boot <span class="k-hand" /> newest Run, on a 24-hour UTC dial
						</p>

						<h3>Measured four times a day</h3>
						<p>
							A fresh machine boots at <span class="times">{SCHEDULE.join(", ").replace(/, (?=[^,]*$)/, " and ")} UTC</span>. The newest Run in this snapshot
							started at{" "}
							<time datetime={newest.iso} title={newest.full}>
								{newest.second} UTC on {newest.longDate}
							</time>
							{bootBefore ? `, after the ${bootBefore} boot` : ""}.
						</p>
					</article>
					<article class="proof">
						<p class="proof-figure">
							<span class="big">{seriesCount.full}</span>
							<span class="big-unit">Series served</span>
						</p>
						<h3>A data API made for agents</h3>
						<p>
							Static JSON at <span class="mono">api.ledgermath.com</span>: every Series with its percentiles, a file for each, the day's On-Demand prices, and a
							JSON schema for each kind of file. Version 1 only ever gains fields.
						</p>
					</article>
				</div>
			</div>
		</section>
	);
}

function HowItWorks() {
	const steps = [
		{
			art: <MachineGlyph />,
			title: "A machine boots",
			text: `One of ${formatCount(snapshot.machineCount).full} EC2 machine types in ${snapshot.region} starts fresh, at a scheduled time.`,
		},
		{
			art: <BenchGlyph />,
			title: "Benchmarks run",
			text: `${formatCount(snapshot.benchmarkCount).full} benchmarks run on the freshly booted machine: memory, compute, the operating system, disk and network.`,
		},
		{
			art: <EvidenceGlyph />,
			title: "Evidence is kept",
			text: "Each execution is kept as a Run: what the benchmark printed, and what was recorded about the machine.",
		},
		{
			art: <DeriveGlyph />,
			title: "Numbers are derived",
			text: "A versioned Method turns the Runs of a Series into figures: the 5th, 50th and 95th percentiles across its counted Runs.",
		},
		{
			art: <ApiGlyph />,
			title: "The API serves them",
			text: "Static JSON files, each kind with a schema, beside AWS's public On-Demand prices, copied daily.",
		},
	];
	return (
		<section class="how" id="how" aria-labelledby="how-title">
			<div class="wrap">
				<div class="section-head">
					<p class="eyebrow">How it works</p>
					<h2 id="how-title">From a cold boot to a figure with a source.</h2>
				</div>
				<ol class="steps">
					{steps.map((s, i) => (
						<li class="step">
							<div class="step-figure">{s.art}</div>
							<div class="step-copy">
								<p class="step-n">{String(i + 1).padStart(2, "0")}</p>
								<h3>{s.title}</h3>
								<p>{s.text}</p>
							</div>
						</li>
					))}
				</ol>
			</div>
		</section>
	);
}

const SPECS: { key: "vcpu" | "memory" | "processor" | "clockSpeed" | "storage" | "network"; label: string }[] = [
	{ key: "vcpu", label: "vCPU" },
	{ key: "memory", label: "Memory" },
	{ key: "processor", label: "Processor" },
	{ key: "clockSpeed", label: "Clock" },
	{ key: "storage", label: "Storage" },
	{ key: "network", label: "Network" },
];

function priceTitle(m: (typeof machines)[number]): string {
	return `${m.price.description}. In the price file at ${m.price.path.pointer}`;
}

function Machines() {
	return (
		<section class="machines" id="machines" aria-labelledby="machines-title">
			<div class="wrap">
				<div class="section-head section-head-split">
					<div>
						<p class="eyebrow">The machines</p>
						<h2 id="machines-title">Five EC2 types, and what an hour of each costs.</h2>
					</div>
					<p class="section-note">
						AWS's public On-Demand Linux prices for {snapshot.region}, from the price file of {snapshot.priceDate}, copied from AWS at{" "}
						<time datetime={snapshot.pricesFetchedAt} title={snapshot.pricesFetchedAt}>
							{pricesFetched.minute} UTC
						</time>
						. The specifications are AWS's own words from the same file. <a href={links.prices}>The price file</a>
					</p>
				</div>

				<div class="spec-box">
					<table class="spec">
						<caption class="visually-hidden">The five machine types: hourly On-Demand price and AWS's specifications</caption>
						<thead>
							<tr>
								<th scope="col" class="spec-corner">
									Machine type
								</th>
								{machines.map((m) => (
									<th scope="col" class="mono spec-type">
										{m.instanceType}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							<tr class="spec-price-row">
								<th scope="row">Per hour, On-Demand</th>
								{machines.map((m) => (
									<td title={priceTitle(m)}>
										<span class="usd">${formatUsd(m.price.usdPerHour).full}</span>
									</td>
								))}
							</tr>
							{SPECS.map((spec) => (
								<tr>
									<th scope="row">{spec.label}</th>
									{machines.map((m) => (
										<td>{m[spec.key]}</td>
									))}
								</tr>
							))}
							<tr class="spec-meta">
								<th scope="row">In this snapshot</th>
								{machines.map((m) => (
									<td>
										{formatCount(m.series.length).full} Series, zone <span class="mono">{m.availabilityZoneIds.join(", ")}</span>
									</td>
								))}
							</tr>
						</tbody>
					</table>
				</div>

				<ul class="machine-list" aria-label="The five machine types">
					{machines.map((m) => (
						<li>
							<p class="ml-head">
								<span class="mono ml-type">{m.instanceType}</span>
								<span class="ml-price" title={priceTitle(m)}>
									<span class="usd">${formatUsd(m.price.usdPerHour).full}</span> <span class="per">/ hour</span>
								</span>
							</p>
							<p class="ml-specs">
								<span>{m.vcpu} vCPU</span>
								<span>{m.memory}</span>
								<span>{m.processor}</span>
								<span>{m.clockSpeed}</span>
								<span>Storage: {m.storage}</span>
								<span>Network: {m.network}</span>
							</p>
							<p class="ml-meta">
								{formatCount(m.series.length).full} Series, zone <span class="mono">{m.availabilityZoneIds.join(", ")}</span>
							</p>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}

const sectionId = (section: Section) => `t-${section.toLowerCase().replace(/\s+/g, "-")}`;
const ioUring = headline.find((row) => row.choice.benchmark === "disk_read_io_uring")!;
const SECTION_NOTES: Partial<Record<Section, string>> = {
	Disk: `Every row here reads or writes the machine's root EBS gp3 volume, the same kind of volume on all five types. ${ioUring.choice.reason ?? ""}`,
};

function NumbersTable() {
	return (
		<section class="numbers" id="numbers" aria-labelledby="numbers-title">
			<div class="wrap">
				<div class="section-head section-head-split">
					<div>
						<p class="eyebrow">The headline table</p>
						<h2 id="numbers-title">
							{formatCount(snapshot.benchmarkCount).full} benchmarks × {formatCount(snapshot.machineCount).full} machines, every digit.
						</h2>
					</div>
					<p class="section-note">
						Each figure is the median (p50) across a Series' counted Runs, exactly as the API holds it: a rate where the benchmark moves bytes, otherwise the
						time of one repetition. The first four significant digits are dark, the rest lighter; the bar under each is its 5th to 95th percentile.
					</p>
				</div>

				<input type="checkbox" id="digits" class="digits-toggle" />
				<div class="table-tools">
					<nav class="jump" aria-label="Benchmark groups">
						{SECTIONS.map((section) => (
							<a href={`#${sectionId(section)}`}>{section}</a>
						))}
					</nav>
					<p class="table-hint">Select a figure for its percentiles, its Runs and its Series file.</p>
					<label for="digits" class="switch">
						<span class="switch-track" aria-hidden="true">
							<span class="switch-thumb" />
						</span>
						Round to four figures
					</label>
				</div>

				<div class="table-box" role="region" aria-label={`The headline table: ${formatCount(snapshot.benchmarkCount).full} benchmarks on ${formatCount(snapshot.machineCount).full} machine types`}>
					<table class="ht">
						<thead>
							<tr>
								<th scope="col" class="col-bench">
									Benchmark
								</th>
								{machines.map((m) => (
									<th scope="col" class="col-machine">
										<span class="mono">{m.instanceType}</span>
										<span class="th-sub">
											{m.vcpu} vCPU · ${formatUsd(m.price.usdPerHour).full}/h
										</span>
									</th>
								))}
							</tr>
						</thead>
						{SECTIONS.map((section) => (
							<tbody>
								<tr class="section-row" id={sectionId(section)}>
									<th scope="colgroup" colspan={machines.length + 1}>
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
										return (
											<tr style={{ "--iw": `${intWidth}ch` }}>
												<th scope="row" class="row-head">
													<a class="row-label" href={row.choice.readme} title={row.choice.what}>
														{row.choice.label}
													</a>
													<span class="row-unit">
														{unitWords(u)}
														<span class="row-dir">{u.kind === "time" ? " · less is faster" : " · more is faster"}</span>
													</span>
													<span class="row-what">{u.kind === "time" ? `Each repetition: ${row.choice.repetition.charAt(0).toLowerCase()}${row.choice.repetition.slice(1)}` : row.choice.what}</span>
												</th>
												{row.cells.map((cell, i) => {
													const f = figures[i]!;
													const s = shown[i]!;
													const p5 = show(f.p5, u);
													const p95 = show(f.p95, u);
													const d = cell.series.derivations.series_v1;
													return (
														<td>
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
																	<p class="pop-head">
																		{row.choice.label} on <span class="mono">{cell.machine.instanceType}</span>, {s.unit}
																	</p>
																	<dl class="pop-pcts mono">
																		<div>
																			<dt>p95</dt>
																			<dd>{p95.full}</dd>
																		</div>
																		<div class="pop-mid">
																			<dt>p50</dt>
																			<dd>{s.full}</dd>
																		</div>
																		<div>
																			<dt>p5</dt>
																			<dd>{p5.full}</dd>
																		</div>
																	</dl>
																	<p class="pop-runs">
																		{formatCount(f.count).full} counted Runs, {formatCount(d.failed_runs).full} failed, zone{" "}
																		<span class="mono">{cell.series.availability_zone_id}</span>
																	</p>
																	<a class="pop-link" href={links.seriesFile(cell.series)}>
																		Series {cell.series.id}: each Run and its evidence <span aria-hidden="true">→</span>
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
					Lock and unlock a mutex is shown per critical section: one repetition is 10,000 critical sections, and its time is divided by exactly that. Figures
					from {formatCount(headlineSeries.length).full} Series in a snapshot of {seriesCount.full}; the others measure other settings and builds.{" "}
					<a href={links.seriesList}>Every Series, in one file</a>
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

function Api() {
	const s = tracedCell.series;
	const excerpt = {
		id: s.id,
		url: s.url,
		benchmark: s.benchmark,
		params: s.params,
		build: s.build,
		instance_type: s.instance_type,
		runs: s.runs,
		derivations: {
			series_v1: {
				method: s.derivations.series_v1.method,
				counted_runs: s.derivations.series_v1.counted_runs,
				failed_runs: s.derivations.series_v1.failed_runs,
				percentiles: { bytes_per_second: s.derivations.series_v1.percentiles.bytes_per_second },
			},
		},
	};
	const endpoints = [
		{ label: "Table of contents", url: links.index, note: "Start here: every file, and what each holds." },
		{ label: "Every Series", url: links.seriesList, note: `All ${seriesCount.full} Series with their percentiles, and the Methods' definitions.` },
		{ label: "Today's prices", url: links.prices, note: `AWS's On-Demand prices for the ${formatCount(snapshot.machineCount).full} types, copied ${snapshot.priceDate}.` },
	];
	return (
		<section class="api" id="api" aria-labelledby="api-title">
			<div class="wrap api-grid">
				<div class="api-copy">
					<p class="eyebrow eyebrow-on-dark">For agents and developers</p>
					<h2 id="api-title">Point your agent at the source.</h2>
					<p>
						An agent that reads the index finds every Series, its percentiles, how many Runs stand behind it and the Method that made it, and the hourly price of
						each machine. So when it estimates what a workload costs, every number it uses has an address it can cite.
					</p>
					<ul class="endpoints">
						{endpoints.map((e) => (
							<li>
								<p class="ep-label">{e.label}</p>
								<div class="cmd" data-copy={`curl ${e.url}`}>
									<code>
										<span class="prompt" aria-hidden="true">
											${" "}
										</span>
										curl <Address url={e.url} />
									</code>
								</div>
								<p class="ep-note">{e.note}</p>
							</li>
						))}
					</ul>
					<p class="api-more">
						<a href={links.docs}>Read the API documentation</a>
						<span class="dot-sep" aria-hidden="true">
							·
						</span>
						JSON schemas:{" "}
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
						<span class="mono">GET {s.url.replace("https://api.ledgermath.com", "")}</span>
						<span class="code-tag">excerpt</span>
					</div>
					<pre tabindex="0" aria-label={`An excerpt of Series ${s.id}'s entry in series.json`}>
						<code>
							<Json value={excerpt} />
						</code>
					</pre>
					<p class="code-foot">
						The Series behind the figure at the top of this page, as <span class="mono">series.json</span> lists it. Numbers are exactly as the Method's
						Derivation holds them: nothing rounded.
					</p>
					<OneRun />
				</div>
			</div>
		</section>
	);
}

function OneRun() {
	const point = seriesFileContents.point.example;
	const sample = seriesFileContents.sample;
	const started = formatMoment(point.started_at);
	return (
		<div class="one-run">
			<p class="one-run-title">One step further: a Run inside a Series file</p>
			<p class="one-run-what">
				The Series file of <span class="mono">{sample.id}</span> ({sample.benchmark} on <span class="mono">{sample.instanceType}</span>) lists its{" "}
				{formatCount(sample.points).full} Runs, each with its figure and its evidence. The first:
			</p>
			<dl class="one-run-facts">
				<div>
					<dt>Run</dt>
					<dd class="mono">{point.run}</dd>
				</div>
				<div>
					<dt>Started</dt>
					<dd>
						<time class="mono" datetime={point.started_at} title={started.full}>
							{point.started_at}
						</time>
					</dd>
				</div>
				<div>
					<dt>Counted</dt>
					<dd class="mono">
						{String(point.counted)}, group {point.group}
					</dd>
				</div>
				<div>
					<dt>Its figure</dt>
					<dd>
						<span class="mono">{plainNs(point.time_per_repetition_ns)}</span> ns per repetition
					</dd>
				</div>
				<div>
					<dt>Evidence</dt>
					<dd>
						<Address url={point.evidence} />
					</dd>
				</div>
				{point.boot_summary ? (
					<div>
						<dt>Its boot</dt>
						<dd>
							<Address url={point.boot_summary} />
						</dd>
					</div>
				) : null}
			</dl>
		</div>
	);
}

function Methods() {
	const series = snapshot.methods.find((m) => m.key === "series_v1")!;
	const defs = series.definitions as Record<string, string>;
	return (
		<section class="methods" aria-labelledby="methods-title">
			<div class="wrap methods-grid">
				<div>
					<p class="eyebrow">Behind every figure</p>
					<h2 id="methods-title">A Method, versioned and written down.</h2>
					<p class="methods-lede">
						Every figure names the Method that made it. These are Method{" "}
						<span class="mono">
							{series.name} v{series.version}
						</span>
						's own definitions, as the API publishes them.
					</p>
				</div>
				<dl class="defs">
					{(["series", "time_per_repetition", "bytes_per_second", "percentiles"] as const).map((k) => (
						<div>
							<dt class="mono">{k}</dt>
							<dd>{defs[k]}</dd>
						</div>
					))}
				</dl>
			</div>
		</section>
	);
}

function Closing() {
	return (
		<section class="closing" aria-labelledby="closing-title">
			<div class="wrap closing-inner">
				<h2 id="closing-title">Measured numbers, each with a source.</h2>
				<p>
					{runs.full} Runs, {seriesCount.full} Series, {formatCount(snapshot.machineCount).full} machine types. Newest Run{" "}
					<time datetime={newest.iso} title={newest.full}>
						{newest.date} {newest.minute} UTC
					</time>
					.
				</p>
				<div class="actions actions-center">
					<a class="btn btn-primary" href={links.index}>
						Open index.json <span aria-hidden="true">→</span>
					</a>
					<a class="btn btn-ghost" href={links.docs}>
						API documentation
					</a>
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
					Snapshot of the data API: newest Run{" "}
					<time datetime={newest.iso} title={newest.full}>
						{newest.full}
					</time>
					; prices of {snapshot.priceDate}.
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
				<HowItWorks />
				<Machines />
				<NumbersTable />
				<Api />
				<Methods />
				<Closing />
			</main>
			<Footer />
		</>
	);
}
