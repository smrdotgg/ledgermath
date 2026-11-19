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

const shortDate = (longDate: string) => longDate.replace(/ \d{4}$/, "").replace(/ (\w{3})\w+$/, " $1");

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
				<span class="mast-label">Boots every day, UTC</span>{" "}
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
				<span class="compare-n">Median rate, {heroShown.unit}. Higher is faster.</span>
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
					LedgerMath boots {formatCount(snapshot.machineCount).full} machine types in AWS's <span class="nowrap">{snapshot.region}</span> Region at 04:10, 10:10, 16:10 and 22:10 UTC, runs{" "}
					{formatCount(snapshot.benchmarkCount).full} benchmarks on each freshly booted machine, and keeps every Run with its evidence.
				</p>
				<p>The figures, the evidence and AWS's On-Demand prices are a static JSON API, made for agents that choose infrastructure from measured numbers.</p>
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
						<dt>From</dt>
						<dd>
							The median (p50) of this Series' {formatCount(heroLead.count).full} counted Runs, {dateRange(heroCell.series)}, by Method series v1.
						</dd>
					</div>
					<div>
						<dt>Source</dt>
						<dd>
							<a href={links.seriesFile(heroCell.series)}>The Series file</a>, with each Run and its evidence. It is the first figure of the table below.
						</dd>
					</div>
				</dl>
			</div>
		</section>
	);
}

function JumpList() {
	return (
		<nav class="jump grid" aria-label="The benchmarks in the table">
			{SECTIONS.map((section) => (
				<div class="jump-sec">
					<p class="jump-h">{section}</p>
					<ul>
						{headline
							.filter((row) => row.choice.section === section)
							.map((row) => (
								<li>
									<a href={`#${anchor(row)}`}>{row.choice.label}</a>
								</li>
							))}
					</ul>
				</div>
			))}
		</nav>
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
					{formatCount(snapshot.benchmarkCount).full} benchmarks × {formatCount(snapshot.machineCount).full} machine types. Each figure is the median (p50) of a Series' counted Runs: the
					rate where the benchmark moves bytes, otherwise the time of one repetition. The large figure is rounded for display; the underlined line beneath it is exact and links to its
					Series file, with every Run.
				</p>
			</div>

			<JumpList />

			<div class="table-box" role="region" aria-label="The figures, 14 benchmarks by 5 machine types">
				<table>
					<caption class="vh">The median of each Series' counted Runs, by benchmark and machine type. Machine types are ordered by hourly price, cheapest first.</caption>
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
									<th scope="rowgroup" colspan={machines.length + 1}>
										<span class="group-name">{section}</span>
										{note ? <span class="group-note">{note}</span> : null}
									</th>
								</tr>
								{headline
									.filter((row) => row.choice.section === section)
									.map((row) => {
										const unit = show(row, leadFigure(row.choice, row.cells[0]!.series).p50).unit;
										const places = rowPlaces(row);
										const better = row.choice.lead === "rate" ? "Higher is faster" : "Lower is faster";
										return (
											<tr class="row" id={anchor(row)}>
												<th scope="row">
													<span class="row-label">{row.choice.label}</span>
													<span class="row-fig">
														{row.choice.lead === "rate" ? `Median rate, ${unit}` : `Median time of one repetition, ${unit}`}
														<span class="row-dir">{better}</span>
													</span>
													<span class="row-what">{row.choice.what}</span>
													<span class="row-set">
														One repetition: {row.choice.repetition.replace(/\.$/, "")}. {row.choice.setting}.
													</span>
												</th>
												{row.cells.map((cell) => {
													const lead = leadFigure(row.choice, cell.series);
													const s = show(row, lead.p50);
													const p5 = show(row, lead.p5);
													const p95 = show(row, lead.p95);
													const isHero = cell.series === heroCell.series;
													const each = row.choice.per ? formatDurationPerUnit(lead.p50, row.choice.per, { unit: "ns" }) : undefined;
													return (
														<td class={isHero ? "hero-cell" : undefined} data-m={cell.machine.instanceType}>
															<span class="v">
																{atPlaces(s.full, places)}
																<span class="u"> {s.unit}</span>
															</span>
															<a class="x" href={links.seriesFile(cell.series)} title={`Series ${cell.series.id}: every Run and its evidence`}>
																<span class="vh">Exact: </span>
																{s.full}
															</a>
															<span class="r" title={spreadTitle(row, lead)}>
																<span>
																	p5 {atPlaces(p5.full, places)} · p95 {atPlaces(p95.full, places)}
																</span>
																<span>
																	{formatCount(lead.count).full}
																	<span class="r-w"> counted</span> Runs
																</span>
															</span>
															{each ? (
																<span class="each" title={`${each.full} ns per ${each.per.of}, exact`}>
																	{each.short} ns per {each.per.of}
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
					Nothing is typed in. Every Run is kept: what the benchmark printed and what was recorded about the machine it booted on. A published, versioned Method turns a Series' Runs
					into its figures, and every figure links to the Runs behind it.
				</p>
			</div>

			<dl class="stats grid">
				<div class="stat">
					<dt>Newest Run</dt>
					<dd>
						<time datetime={newest.iso}>
							<span class="stat-big">{newest.minute}</span>
							<span class="stat-unit">UTC, {shortDate(newest.longDate)}</span>
						</time>
						<span class="stat-exact">{newest.full}</span>
					</dd>
				</div>
				<div class="stat">
					<dt>Oldest Run</dt>
					<dd>
						<time datetime={oldest.iso}>
							<span class="stat-big">{oldest.minute}</span>
							<span class="stat-unit">UTC, {shortDate(oldest.longDate)}</span>
						</time>
						<span class="stat-exact">{oldest.full}</span>
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
						<span class="stat-unit">{formatCount(headline.length * machines.length).full} of them in the table</span>
						<span class="stat-exact">
							Listed in <a href={links.seriesList}>series.json</a>
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
						<span class="chain-text">Exactly as the Method's Derivation holds it. Nothing rounded, nothing computed that the Derivation does not hold.</span>
					</li>
				</ol>
			</div>
		</section>
	);
}

// The worked example: the hero's own entry in series.json, and one point of a Series file.
const J = (v: unknown) => JSON.stringify(v);
const heroP = heroCell.series.derivations.series_v1.percentiles.bytes_per_second!;
const seriesExcerpt = [
	`{ "series": [ …`,
	`  { "id": ${J(heroCell.series.id)},`,
	`    "url": ${J(heroCell.series.url)},`,
	`    "benchmark": ${J(heroCell.series.benchmark)},`,
	`    "instance_type": ${J(heroCell.series.instance_type)},`,
	`    "runs": ${J(heroCell.series.runs)},`,
	`    "derivations": { "series_v1": { "percentiles": {`,
	`      "bytes_per_second": { "count": ${J(heroP.count)},`,
	`        "p5": ${J(heroP.p5)},`,
	`        "p50": ${J(heroP.p50)},`,
	`        "p95": ${J(heroP.p95)} } … } } },`,
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
					Static JSON, version 1, at api.ledgermath.com. An agent reads every Series' figures with the address of its source, follows any figure down to its Runs and their evidence,
					and prices a machine from the same files. Version 1 only ever gains fields.
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
					<ol class="walk">
						<li>
							<span class="walk-no">1</span>
							<div>
								<p class="walk-t">
									In <a href={links.seriesList}>series.json</a>, the Series behind the red figure above: its percentiles, and the address of its own file.
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
									In a Series file, one point per Run: its figure and the addresses of its Run file and its boot's summary. This point is the first Run of{" "}
									<a href={seriesFileContents.sample.url}>
										{seriesFileContents.sample.benchmark} on {seriesFileContents.sample.instanceType}
									</a>
									.
								</p>
								<pre class="json" role="region" tabindex="0" aria-label="An excerpt of a Series file">
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
						<p class="m-aws">
							AWS: “{m.price.description}”, at <span class="mono m-ptr">{m.price.path.pointer}</span>
						</p>
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
				Snapshot of the data API: newest Run{" "}
				<time datetime={newest.iso}>
					{newest.date} {newest.second} UTC
				</time>
				, price file {snapshot.priceDate}.
			</p>
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
