// Design v5, "Swiss poster": one grotesque, one strict grid, one accent colour.
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
	seriesFileContents,
	snapshot,
	type DurationUnit,
	type HeadlineRow,
	type Section,
	type SeriesRow,
	type Shown,
} from "../../data";

// ---------------------------------------------------------------- figures

type Lead = ReturnType<typeof leadFigure>;

/**
 * One unit for a whole row, so its five figures read against each other: the unit the
 * largest of them would take on its own. Only the unit is chosen here; nothing is shown
 * that the snapshot does not hold.
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

/**
 * One count of places for the whole row, so the five figures line up on their decimal point:
 * enough for the smallest of them to keep four significant digits. The larger ones keep more.
 * Rounding for display only; the exact figure always stands beneath.
 */
function rowPlaces(row: HeadlineRow): number {
	return Math.max(...row.cells.map((cell) => placesFor(show(row, leadFigure(row.choice, cell.series).p50).full)));
}

/** `full` rounded to `places`; where it has fewer, the gap is a figure space, never an invented zero. */
function atPlaces(full: string, places: number): string {
	const r = roundPlaces(full, places);
	const have = r.includes(".") ? r.split(".")[1]!.length : 0;
	if (have >= places) return r;
	return (have === 0 && places > 0 ? r + " " : r) + " ".repeat(places - have);
}

/**
 * The exact figure, cut into three for setting: the integer part, the point and the digits a
 * reader compares (to the row's places), and the rest. Nothing is rounded: the three read
 * together are `full`, every digit.
 */
function split(full: string, places: number): { int: string; head: string; tail: string } {
	const [int = "", frac] = full.split(".");
	if (frac === undefined) return { int, head: "", tail: "" };
	return { int, head: "." + frac.slice(0, places), tail: frac.slice(places) };
}

/** Per row: the widest integer part, head and tail, so the five figures share one decimal point. */
function rowWidths(row: HeadlineRow, places: number): { int: number; head: number; tail: number } {
	const parts = row.cells.map((cell) => split(show(row, leadFigure(row.choice, cell.series).p50).full, places));
	return {
		int: Math.max(...parts.map((p) => p.int.length)),
		head: Math.max(...parts.map((p) => p.head.length)),
		tail: Math.max(...parts.map((p) => p.tail.length)),
	};
}

/** The largest p95 of a row: the end of its zero-based scale, so every whisker fits. */
function rowMax(row: HeadlineRow): number {
	return Math.max(...row.cells.map((cell) => leadFigure(row.choice, cell.series).p95));
}

const pct = (v: number, max: number) => `${((v / max) * 100).toFixed(3)}%`;

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

const anchor = (row: HeadlineRow) => `b-${row.choice.benchmark.replaceAll("_", "-")}`;

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

/** "10–19" and "November 2026" for two moments in one month; otherwise "10 Oct–19" and "November 2026". */
function span(a: ReturnType<typeof formatMoment>, b: ReturnType<typeof formatMoment>): { big: string; rest: string } {
	const [ad, am, ay] = a.longDate.split(" ");
	const [bd, bm, by] = b.longDate.split(" ");
	if (am === bm && ay === by) return { big: `${ad}–${bd}`, rest: `${bm} ${by}` };
	return { big: `${ad} ${am!.slice(0, 3)}–${bd}`, rest: `${bm} ${by}` };
}

function dateRange(row: SeriesRow): string {
	const a = formatMoment(row.oldest_run_started_at);
	const b = formatMoment(row.newest_run_started_at);
	return `${a.longDate.replace(/ \d{4}$/, "")} to ${b.longDate}`;
}

function spreadTitle(row: HeadlineRow, lead: Lead): string {
	const s = (v: number) => show(row, v);
	return `p5 ${s(lead.p5).full} · p50 ${s(lead.p50).full} · p95 ${s(lead.p95).full} ${s(lead.p50).unit}, ${lead.count} counted Runs`;
}

// ---------------------------------------------------------------- parts

function Masthead() {
	return (
		<header class="mast grid">
			<div class="mast-name">
				<a href="#top">LedgerMath</a>
			</div>
			<p class="mast-cell">
				<span class="mast-label">Newest Run</span>{" "}
				<br />
				<time datetime={newest.iso} title={newest.full}>
					{newest.longDate}, {newest.minute} UTC
				</time>
			</p>
			<p class="mast-cell">
				<span class="mast-label">Boots daily, UTC</span>{" "}
				<br />
				04:10 10:10 16:10 22:10
			</p>
			<nav class="mast-nav" aria-label="On this page">
				<a href="#figures">Figures</a>
				<a href="#evidence">Evidence</a>
				<a href="#api">API</a>
				<a href="#machines">Machines</a>
			</nav>
		</header>
	);
}

function Compare() {
	const max = Math.max(...heroRow.cells.map((c) => leadFigure(heroRow.choice, c.series).p50));
	return (
		<figure class="compare">
			<figcaption>
				<span class="compare-h">The same benchmark on all five</span>
				<span class="compare-n">{heroShown.unit}, higher is faster</span>
			</figcaption>
			<ol>
				{heroRow.cells.map((cell) => {
					const lead = leadFigure(heroRow.choice, cell.series);
					const s = show(heroRow, lead.p50);
					const here = cell.series === heroCell.series;
					return (
						<li class={here ? "is-hero" : undefined}>
							<span class="compare-m">{cell.machine.instanceType}</span>
							<span class="compare-bar" aria-hidden="true">
								<span style={{ width: `${((lead.p50 / max) * 100).toFixed(3)}%` }} />
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
				<p>
					LedgerMath boots {formatCount(snapshot.machineCount).full} machine types in AWS's <span class="nowrap">{snapshot.region}</span> Region, runs{" "}
					{formatCount(snapshot.benchmarkCount).full} benchmarks on each freshly booted machine, and keeps every Run with its evidence.
				</p>
				<p>The figures, the evidence and AWS's prices are a static JSON API, for agents that choose infrastructure from measured numbers.</p>
				<div class="intro-curl" data-copy={`curl ${links.index}`}>
					<code>
						<span class="prompt" aria-hidden="true">
							${" "}
						</span>
						curl {links.index}
					</code>
				</div>
			</div>

			<div class="hero grid-inner" role="group" aria-labelledby="hero-k">
				<p id="hero-k" class="hero-kicker">
					<span class="hero-kicker-b">{heroRow.choice.label}</span>
					<span class="hero-kicker-sep" aria-hidden="true">
						{" "}
						/{" "}
					</span>
					<span>{heroCell.machine.instanceType}</span>
					<span class="hero-kicker-sep" aria-hidden="true">
						{" "}
						/{" "}
					</span>
					<span class="hero-kicker-m">median of {formatCount(heroLead.count).full} counted Runs</span>
				</p>
				<p class="hero-figure" aria-hidden="true">
					<span class="hero-head">{heroShort}</span>
					<span class="hero-unit">{heroShown.unit}</span>
				</p>
				<p class="hero-exact">
					<span class="hero-exact-l">Exact</span>
					<span class="hero-exact-v">
						<a href={links.seriesFile(heroCell.series)}>
							<b>{exactHead}</b>
							{exactTail}
						</a>{" "}
						<span class="hero-exact-u">{heroShown.unit}</span>
					</span>
				</p>
				<Compare />
				<dl class="hero-facts">
					<div>
						<dt>What</dt>
						<dd>
							<strong>{heroRow.choice.label}.</strong> {heroRow.choice.what}
						</dd>
					</div>
					<div>
						<dt>Where</dt>
						<dd>
							{heroCell.machine.instanceType}, {heroCell.machine.vcpu} vCPU, {heroCell.machine.memory}, {heroCell.machine.processor}. {heroRow.choice.setting}.
						</dd>
					</div>
					<div>
						<dt>Source</dt>
						<dd>
							<a href={links.seriesFile(heroCell.series)}>The Series file</a>: its {formatCount(heroLead.count).full} counted Runs, {dateRange(heroCell.series)}, each with its evidence.
						</dd>
					</div>
				</dl>
			</div>
		</section>
	);
}

function groupNote(section: Section): string | undefined {
	if (section !== "Disk") return undefined;
	const withReason = headline.find((row) => row.choice.section === "Disk" && row.choice.reason?.includes("limit"));
	// The reason is the module's own words; a benchmark's code name in it reads as that row's label.
	let reason = withReason?.choice.reason ?? "";
	for (const row of headline) reason = reason.replaceAll(`${row.choice.benchmark}'s row`, `the row “${row.choice.label}”`);
	return `Every row here reads or writes the machine's root EBS gp3 volume, the same kind of volume on all five. ${reason}`.trim();
}

function FigureTable() {
	return (
		<section id="figures" class="figures" aria-labelledby="figures-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					01
				</p>
				<h2 id="figures-h">The figures</h2>
				<p class="sec-lede">
					Each figure is the median (p50) of a Series' counted Runs: a rate where the benchmark moves bytes, otherwise the time of one repetition. Compare the strong digits; the light
					ones finish the figure. The bars share one zero-based scale per row; the bracket spans p5 to p95.
				</p>
			</div>

			<div class="table-box" role="region" aria-label="The figures, 14 benchmarks by 5 machine types">
				<table>
					<thead>
						<tr>
							<th scope="col" class="corner">
								<span>Benchmark</span>
								<span class="corner-note">Machine types, cheapest first</span>
							</th>
							{machines.map((m) => (
								<th scope="col" class="mach">
									<span class="mach-name">{m.instanceType}</span>
									<span class="mach-spec">
										{m.vcpu} vCPU · {m.memory}
									</span>
									<span class="mach-price">${price(m).full} an hour</span>
								</th>
							))}
						</tr>
					</thead>
					{SECTIONS.map((section) => {
						const note = groupNote(section);
						return (
							<tbody>
								<tr class="group">
									<th scope="rowgroup" class="group-h">
										<span class="group-name">{section}</span>
										{note ? <span class="group-note">{note}</span> : null}
									</th>
									{machines.map((m) => (
										<td class="group-m" aria-hidden="true">
											{m.instanceType}
										</td>
									))}
								</tr>
								{headline
									.filter((row) => row.choice.section === section)
									.map((row) => {
										const unit = show(row, leadFigure(row.choice, row.cells[0]!.series).p50).unit;
										const places = rowPlaces(row);
										const w = rowWidths(row, places);
										const max = rowMax(row);
										const better = row.choice.lead === "rate" ? "↑ faster" : "↓ faster";
										return (
											<tr class="row" id={anchor(row)} style={{ "--wi": `${w.int}ch`, "--wh": `${w.head}ch`, "--wt": `${w.tail}ch` }}>
												<th scope="row">
													<span class="row-label">{row.choice.label}</span>
													<span class="row-fig">
														<span class="row-unit">{row.choice.per ? `${unit} per ${formatCount(row.choice.per.count).full}` : unit}</span>
														<span class="row-dir" title={row.choice.lead === "rate" ? "Higher is faster" : "Lower is faster"}>
															{better}
														</span>
													</span>
													<span class="row-what">{row.choice.what}</span>
													<details class="row-set">
														<summary>Settings</summary>
														{row.choice.repetition} {row.choice.setting}.
													</details>
												</th>
												{row.cells.map((cell) => {
													const lead = leadFigure(row.choice, cell.series);
													const s = show(row, lead.p50);
													const p5 = show(row, lead.p5);
													const p95 = show(row, lead.p95);
													const f = split(s.full, places);
													const isHero = cell.series === heroCell.series;
													const each = row.choice.per ? formatDurationPerUnit(lead.p50, row.choice.per, { unit: "ns" }) : undefined;
													return (
														<td class={isHero ? "hero-cell" : undefined} data-m={cell.machine.instanceType}>
															<a class="fig" href={links.seriesFile(cell.series)} title={`${s.full} ${s.unit}, exact. Series ${cell.series.id}: every Run and its evidence`}>
																<span class="fi">{f.int}</span>
																<span class="fh">{f.head}</span>
																<span class="ft">{f.tail}</span>
															</a>
															<span class="bar" aria-hidden="true">
																<span class="bar-f" style={{ width: pct(lead.p50, max) }} />
																<span class="bar-s" style={{ left: pct(lead.p5, max), right: `calc(100% - ${pct(lead.p95, max)})` }} />
															</span>
															<span class="r" title={spreadTitle(row, lead)}>
																<span class="r-p">
																	p5 {atPlaces(p5.full, places).trim()} · p95 {atPlaces(p95.full, places).trim()}
																</span>
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
						);
					})}
				</table>
			</div>
		</section>
	);
}

function Evidence() {
	return (
		<section id="evidence" class="evidence" aria-labelledby="evidence-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					02
				</p>
				<h2 id="evidence-h">Where every figure comes from</h2>
				<p class="sec-lede">
					Nothing is typed in. Every Run is kept, and a published Method turns a Series' Runs into its figures.
				</p>
			</div>

			<dl class="stats grid">
				<div class="stat">
					<dt>Runs started, UTC</dt>
					<dd>
						<span class="stat-big">{span(oldest, newest).big}</span>
						<span class="stat-unit">{span(oldest, newest).rest}</span>
						<span class="stat-exact">
							First <time datetime={oldest.iso}>{oldest.full}</time>
							<br />
							Newest <time datetime={newest.iso}>{newest.full}</time>
						</span>
					</dd>
				</div>
				<div class="stat">
					<dt>Runs kept</dt>
					<dd>
						<span class="stat-big">{formatCount(snapshot.runCount).full}</span>
						<span class="stat-unit">
							{formatCount(snapshot.countedRuns).full} counted, {formatCount(snapshot.failedRuns).full} failed
						</span>
						<span class="stat-exact">Failed Runs are kept, never dropped.</span>
					</dd>
				</div>
				<div class="stat">
					<dt>Series</dt>
					<dd>
						<span class="stat-big">{formatCount(snapshot.seriesCount).full}</span>
						<span class="stat-unit">
							listed in <a href={links.seriesList}>series.json</a>
						</span>
					</dd>
				</div>
				<div class="stat">
					<dt>AWS prices copied, UTC</dt>
					<dd>
						<span class="stat-big">{pricesFetched.longDate.split(" ")[0]}</span>
						<span class="stat-unit">{pricesFetched.longDate.split(" ").slice(1).join(" ")}</span>
						<span class="stat-exact">
							<time datetime={pricesFetched.iso}>{pricesFetched.full}</time>
							<br />
							One file a day: <a href={links.prices}>{snapshot.priceDate}.json</a>
						</span>
					</dd>
				</div>
			</dl>

			<div class="chain grid">
				<ol class="chain-list">
					<li>
						<span class="chain-step">Run</span>
						<span class="chain-text">
							One benchmark on one freshly booted machine. Kept whole, counted or failed: its binary, its output and the machine's dumps, each stored by its SHA-256.
						</span>
					</li>
					<li>
						<span class="chain-step">Series</span>
						<span class="chain-text">The Runs that share a benchmark, its settings, its build, a machine type and an Availability Zone ID.</span>
					</li>
					<li>
						<span class="chain-step">Method</span>
						<span class="chain-text">
							Versioned and published:{" "}
							{snapshot.methods.map((m, i) => (
								<>
									{i > 0 ? " and " : ""}
									<code>
										{m.name} v{m.version}
									</code>
								</>
							))}
							. It turns a Series' counted Runs into percentiles; its definitions travel with the data, in{" "}
							<a href={links.seriesList}>series.json</a>.
						</span>
					</li>
					<li>
						<span class="chain-step">Figure</span>
						<span class="chain-text">Published exactly as the Method's Derivation holds it, every digit. Where this page rounds a figure, the full one stands beside it.</span>
					</li>
				</ol>
			</div>
		</section>
	);
}

// The worked example, one Series through both reads: the Series the snapshot keeps a file of
// (a cell of the table), its entry in series.json, then the first point of its own file.
const J = (v: unknown) => JSON.stringify(v);
const walkRow = headline.find((row) => row.cells.some((cell) => cell.series.id === seriesFileContents.sample.id))!;
const walkCell = walkRow.cells.find((cell) => cell.series.id === seriesFileContents.sample.id)!;
const walkLead = leadFigure(walkRow.choice, walkCell.series);
const walkShown = show(walkRow, walkLead.p50);
const walkKey = walkRow.choice.lead === "rate" ? "bytes_per_second" : "time_per_repetition_ns";
const walkP = walkCell.series.derivations.series_v1.percentiles[walkKey]!;
const seriesExcerpt = [
	`{ "series": [ …`,
	`  { "id": ${J(walkCell.series.id)},`,
	`    "url": ${J(walkCell.series.url)},`,
	`    "benchmark": ${J(walkCell.series.benchmark)},`,
	`    "instance_type": ${J(walkCell.series.instance_type)},`,
	`    "runs": ${J(walkCell.series.runs)},`,
	`    "derivations": { "series_v1": { "percentiles": {`,
	`      ${J(walkKey)}: { "count": ${J(walkP.count)},`,
	`        "p5": ${J(walkP.p5)},`,
	`        "p50": ${J(walkP.p50)},`,
	`        "p95": ${J(walkP.p95)} } … } } },`,
	`  … ] }`,
].join("\n");
const pt = seriesFileContents.point.example;
const pointExcerpt = [
	`{ "run": ${J(pt.run)},`,
	`  "started_at": ${J(pt.started_at)},`,
	`  "counted": ${J(pt.counted)},`,
	`  "time_per_repetition_ns": ${J(pt.time_per_repetition_ns)},`,
	`  "evidence": ${J(pt.evidence)},`,
	`  "boot_summary": ${J(pt.boot_summary)},`,
	`  … }`,
].join("\n");

function Api() {
	const lines = [
		{ url: links.index, what: "The table of contents: every file, its schema, the newest Run" },
		{ url: links.seriesList, what: `Every Series (${formatCount(snapshot.seriesCount).full}) with its percentiles, and the Methods' definitions` },
		{ url: links.prices, what: `AWS's On-Demand prices, copied ${snapshot.priceDate}` },
	];
	return (
		<section id="api" class="api" aria-labelledby="api-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					03
				</p>
				<h2 id="api-h">For agents, and the developers who run them</h2>
				<p class="sec-lede">
					Static JSON, version 1. An agent reads every Series' figures, follows any figure down to its Runs and their evidence, and prices a machine from the same files. Version 1 only
					ever gains fields.
				</p>
			</div>

			<div class="grid">
				<div class="api-main">
					<ul class="curls">
						{lines.map((line) => (
							<li>
								<span class="curl-what">{line.what}</span>
								<pre class="curl" data-copy={`curl ${line.url}`}>
									<code>
										<span class="prompt" aria-hidden="true">
											${" "}
										</span>
										curl {line.url}
									</code>
								</pre>
							</li>
						))}
					</ul>

					<h3 class="walk-h">From a figure to its evidence, in two reads</h3>
					<p class="walk-lede">
						One figure from the table, followed down:{" "}
						<a href={`#${anchor(walkRow)}`}>
							{walkRow.choice.label.toLowerCase()} on {walkCell.machine.instanceType}
						</a>
						, <span class="walk-fig">{walkShown.full}</span> {walkShown.unit}.
					</p>
					<ol class="walk">
						<li>
							<span class="walk-no">1</span>
							<div>
								<p class="walk-t">
									In <a href={links.seriesList}>series.json</a>, its Series: the percentiles (here in {walkKey === "bytes_per_second" ? "bytes per second" : "nanoseconds"}; p50 is the figure) and the address of the Series' own file.
								</p>
								<pre class="json" role="region" tabindex="0" aria-label="An excerpt of series.json">
									<code>{seriesExcerpt}</code>
								</pre>
							</div>
						</li>
						<li>
							<span class="walk-no">2</span>
							<div>
								<p class="walk-t">
									In <a href={walkCell.series.url}>that file</a>, one point per Run: its figure, and the addresses of its Run file (the evidence) and its boot's summary. This is its first
									Run.
								</p>
								<pre class="json" role="region" tabindex="0" aria-label="An excerpt of the Series file">
									<code>{pointExcerpt}</code>
								</pre>
							</div>
						</li>
					</ol>
				</div>

				<div class="api-side">
					<h3>Schemas</h3>
					<ul class="plain">
						{links.schemas.map((s) => (
							<li>
								<a href={s.url}>{s.name}</a> <span class="mono">{s.describes}</span>
							</li>
						))}
					</ul>
					<h3>Evidence</h3>
					<p>A Run file names its binary, output and dumps by hash; each is a blob at</p>
					<p class="mono">{links.evidenceBlobTemplate}</p>
					<h3>Prices, every day</h3>
					<p>
						One file per day, the newest <a href={links.prices}>{snapshot.priceDate}</a>, at
						<span class="mono mono-line">{links.priceFilePattern.replace("https://api.ledgermath.com/", "")}</span>
					</p>
					<p class="api-docs">
						<a href={links.docs}>Read the API's documentation</a>
					</p>
				</div>
			</div>
		</section>
	);
}

function Machines() {
	return (
		<section id="machines" class="machines" aria-labelledby="machines-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					04
				</p>
				<h2 id="machines-h">The machines</h2>
				<p class="sec-lede">
					Five machine types in {snapshot.region}, Availability Zone ID {[...new Set(machines.flatMap((m) => m.availabilityZoneIds))].join(", ")}, cheapest first. Each price is AWS's
					hourly On-Demand Linux price, read from <a href={links.prices}>the price file of {snapshot.priceDate}</a>, copied from AWS at {pricesFetched.minute} UTC.
				</p>
			</div>

			<ol class="mlist">
				{machines.map((m) => (
					<li class="m grid">
						<h3 class="m-name">{m.instanceType}</h3>
						<p class="m-price">
							<span class="m-dollar">${price(m).full}</span>
							<span class="m-per">an hour</span>
						</p>
						<p class="m-spec">
							{m.vcpu} vCPU · {m.memory} · {m.processor}, {m.clockSpeed} · {m.family}
						</p>
						<div class="m-aws">
							<details class="m-path">
								<summary>Its place in the price file</summary>
								<span class="mono m-ptr">{m.price.path.pointer}</span>
							</details>
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}

function Footer() {
	return (
		<footer class="foot grid">
			<div class="foot-name">LedgerMath</div>
			<p class="foot-cell">
				<a href={links.index}>index.json</a> · <a href={links.seriesList}>series.json</a> · <a href={links.prices}>prices</a> · <a href={links.docs}>documentation</a>
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
				<Evidence />
				<Api />
				<Machines />
			</main>
			<Footer />
		</>
	);
}
