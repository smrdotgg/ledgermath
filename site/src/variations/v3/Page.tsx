// Design v3, "Paper": LedgerMath's home page set as a data report in a scientific journal.
// Every figure comes from ../../data exactly as the snapshot holds it; a rounded figure always
// has its exact form beside it (a title, Table S1).
import "./page.css";
import {
	durationUnit,
	formatCount,
	formatDuration,
	formatMoment,
	formatRate,
	formatUsd,
	group,
	headline,
	leadFigure,
	links,
	machines,
	plain,
	roundSignificant,
	shift,
	snapshot,
	type DurationUnit,
	type HeadlineRow,
	type Section,
	type Shown,
} from "../../data";

// ---------------------------------------------------------------- figures of one row

type Cell = { p5: Shown; p50: Shown; p95: Shown; n: number; url: string; machine: string; draw: { p5: number; p50: number; p95: number } };
type Row = { row: HeadlineRow; unit: string; cells: Cell[]; per?: string };

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"] as const;
function rateUnit(bytesPerSecond: number) {
	const i = Math.min(4, Math.max(0, Math.floor(Math.log10(Math.abs(bytesPerSecond)) / 3)));
	return BYTE_UNITS[i]!;
}

/** One time in nanoseconds, divided by the benchmark's fixed count by moving the decimal point (10,000 → four places). */
function perOne(nanoseconds: number, count: number): Shown {
	const places = Math.log10(count);
	if (!Number.isInteger(places)) throw new Error(`a count of ${count} is not a power of ten`);
	const text = plain(nanoseconds);
	const full = shift(text, -places);
	const short = roundSignificant(full, 4);
	return { full, short, unit: "ns", rounded: short !== full, source: `${text} ns per ${count}`, value: nanoseconds / count };
}

// One unit per row, so a row reads across: the unit in which the row's smallest median is at least 1.
const rows: Row[] = headline.map((row) => {
	const figures = row.cells.map((cell) => ({ cell, f: leadFigure(row.choice, cell.series) }));
	const least = Math.min(...figures.map(({ f }) => f.p50));
	const per = row.choice.per;
	let show: (x: number) => Shown;
	let unit: string;
	if (per) {
		show = (x) => perOne(x, per.count);
		unit = "ns";
	} else if (row.choice.lead === "rate") {
		const u = rateUnit(least);
		show = (x) => formatRate(x, { unit: u });
		unit = `${u}/s`;
	} else {
		const u: DurationUnit = durationUnit(least);
		show = (x) => formatDuration(x, { unit: u });
		unit = u;
	}
	return {
		row,
		unit,
		per: per?.of,
		cells: figures.map(({ cell, f }) => ({
			p5: show(f.p5),
			p50: show(f.p50),
			p95: show(f.p95),
			n: f.count,
			url: links.seriesFile(cell.series),
			machine: cell.machine.instanceType,
			draw: { p5: Number(show(f.p5).full), p50: Number(show(f.p50).full), p95: Number(show(f.p95).full) },
		})),
	};
});

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
const bySection = SECTIONS.map((section) => ({ section, rows: rows.filter((r) => r.row.choice.section === section) }));
const LETTERS = "abcdefghijklmn";

/** Digits in groups of three with thin spaces, both sides of the point (SI style). No digit changes. */
const si = (decimal: string) => group(decimal, " ", " ");
const exact = (s: Shown) => `${s.full} ${s.unit}`;

// ---------------------------------------------------------------- facts of the snapshot

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const fetched = formatMoment(snapshot.pricesFetchedAt);
const runs = formatCount(snapshot.runCount);
const counted = formatCount(snapshot.countedRuns);
const failed = formatCount(snapshot.failedRuns);
const seriesCount = formatCount(snapshot.seriesCount);
const zones = [...new Set(machines.flatMap((m) => m.availabilityZoneIds))];
const series1 = snapshot.methods.find((m) => m.key === "series_v1")!;
const requests1 = snapshot.methods.find((m) => m.key === "requests_v1");
const schema = (name: string) => links.schemas.find((s) => s.name === name)!;
const priceFileName = links.prices.replace(/^.*\/v1\//, "v1/");
const short = (url: string) => url.replace(/^https:\/\//, "");

// The references, numbered in the order the text first cites them.
const REF = { index: 1, series: 2, prices: 3, method: 4, schemas: 5, docs: 6 } as const;
function Cite(props: { n: number | number[] }) {
	const ns = Array.isArray(props.n) ? props.n : [props.n];
	return (
		<span class="cite">
			[
			{ns.map((n, i) => (
				<>
					{i > 0 ? "," : ""}
					<a href={`#ref-${n}`} aria-label={`reference ${n}`}>
						{n}
					</a>
				</>
			))}
			]
		</span>
	);
}
function Note(props: { n: number }) {
	return (
		<sup class="fn" id={`fnref-${props.n}`}>
			<a href={`#fn-${props.n}`} aria-label={`note ${props.n}`}>
				{props.n}
			</a>
		</sup>
	);
}

// ---------------------------------------------------------------- Figure 1: one panel

function niceStep(raw: number) {
	const p = 10 ** Math.floor(Math.log10(raw));
	const m = raw / p;
	return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

function Panel(props: { r: Row; letter: string }) {
	const top = Math.max(...props.r.cells.map((c) => c.draw.p95));
	const step = niceStep(top / 4);
	const max = Math.ceil(top / step) * step;
	const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
	const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step % 1 === 0 ? 0 : 1));
	const label = (t: number) => (t === 0 ? "0" : t.toFixed(Math.min(decimals, 2)).replace(/\.0+$/, ""));
	const x = (v: number) => (v / max) * 1000;
	const choice = props.r.row.choice;
	return (
		<figure class="panel" aria-labelledby={`panel-${props.letter}`}>
			<figcaption id={`panel-${props.letter}`}>
				<span class="panel-letter">({props.letter})</span> {choice.label}
				<span class="panel-unit">
					, {props.r.unit}
					{props.r.per ? ` per ${props.r.per}` : ""}
				</span>
				<span class="panel-rep">{choice.repetition}</span>
			</figcaption>
			<div class="bars">
				{props.r.cells.map((c) => (
					<div class="bar" title={`${c.machine}: p5 ${exact(c.p5)}, p50 ${exact(c.p50)}, p95 ${exact(c.p95)}, ${c.n} counted Runs`}>
						<span class="bar-name">{c.machine}</span>
						<svg class="bar-plot" viewBox="0 0 1000 16" preserveAspectRatio="none" aria-hidden="true">
							{ticks.map((t) => (
								<line class="grid" x1={x(t)} x2={x(t)} y1="0" y2="16" vector-effect="non-scaling-stroke" />
							))}
							<rect class="range" x={x(c.draw.p5)} y="4" width={Math.max(0, x(c.draw.p95) - x(c.draw.p5))} height="8" />
							<line class="median" x1={x(c.draw.p50)} x2={x(c.draw.p50)} y1="1" y2="15" vector-effect="non-scaling-stroke" />
						</svg>
						<span class="bar-figs">
							<span class="lo">{c.p5.short}</span>
							<b>{c.p50.short}</b>
							<span class="hi">{c.p95.short}</span>
						</span>
					</div>
				))}
				<div class="axis" aria-hidden="true">
					<span class="bar-name" />
					<span class="axis-ticks">
						{ticks.map((t) => (
							<span style={`left:${(t / max) * 100}%`}>{label(t)}</span>
						))}
					</span>
					<span class="bar-figs axis-key">
						<span class="lo">p5</span>
						<b>p50</b>
						<span class="hi">p95</span>
					</span>
				</div>
			</div>
		</figure>
	);
}

// ---------------------------------------------------------------- the page

export default function Page() {
	const mutex = rows.find((r) => r.per)!;
	const mutexRow = mutex.row.cells[0]!;
	const mutexLead = leadFigure(mutex.row.choice, mutexRow.series);
	return (
		<>
			<p class="stamp" aria-hidden="true">
				api.ledgermath.com/v1&ensp;[{snapshot.region}]&ensp;{newest.longDate}
			</p>
			<header class="runninghead">
				<div class="rh-inner">
					<a class="wordmark" href="./">
						LedgerMath
					</a>
					<span class="rh-kind">Data report · data API v1</span>
					<span class="rh-date">
						Snapshot of <time datetime={newest.date}>{newest.longDate}</time>
					</span>
				</div>
			</header>

			<main id="paper">
				<article>
					<div class="front">
						<p class="kicker">Data report · cloud server benchmarks</p>
						<h1>
							<span class="h1-name">LedgerMath:</span> fourteen benchmarks on five AWS machine types, measured four&nbsp;times a&nbsp;day
						</h1>

						<div class="byline">
							<p class="by">Measured by five freshly booted machines</p>
							<p class="authors">
								{machines.map((m, i) => (
									<>
										{i > 0 ? <span class="sep"> · </span> : ""}
										<span class="author">
											{m.instanceType}
											<sup>1</sup>
										</span>
									</>
								))}
							</p>
							<p class="affil">
								<sup>1</sup> Amazon EC2, {snapshot.region} (Availability Zone ID {zones.join(", ")}). Booted at 04:10, 10:10, 16:10 and 22:10 UTC; each boot runs all{" "}
								{snapshot.benchmarkCount} benchmarks.
							</p>
							<p class="affil">
								<span aria-hidden="true">✉ </span>Correspondence: <a href={links.index}>{short(links.index)}</a>
							</p>
						</div>

						<dl class="dates">
							<div>
								<dt>First Run</dt>
								<dd>
									<time datetime={oldest.iso}>{oldest.full}</time>
								</dd>
							</div>
							<div>
								<dt>Latest Run</dt>
								<dd>
									<time datetime={newest.iso}>{newest.full}</time>
								</dd>
							</div>
							<div>
								<dt>Prices copied</dt>
								<dd>
									<time datetime={snapshot.pricesFetchedAt}>{fetched.full}</time>
								</dd>
							</div>
						</dl>
					</div>

					<div class="opening">
						<section class="abstract" aria-labelledby="abstract">
							<h2 id="abstract">Abstract</h2>
							<p>
								LedgerMath boots machines on AWS four times a day and runs {snapshot.benchmarkCount} small benchmarks on each one, freshly booted: reading and writing memory,
								hashing, sorting, system calls, locks, loopback TCP, disk reads and writes, and a GET from S3. Every execution is kept as a Run, with its evidence: what the
								benchmark printed and what was recorded about the machine. Published, versioned Methods turn the Runs into the figures below. Five machine types in AWS's{" "}
								{snapshot.region} Region are measured; their hourly On-Demand prices are copied from AWS every day. As of this snapshot, the figures rest on{" "}
								<strong>{runs.full} Runs</strong> in <strong>{seriesCount.full} Series</strong>: {counted.full} counted, {failed.full} failed. All of it is published as a
								static JSON data API, made so that an AI agent can decide on infrastructure from measured numbers and give a source for each <Cite n={REF.index} />.
							</p>
							<p class="keywords">
								<span class="kw">Keywords</span> cloud servers · Amazon EC2 · memory bandwidth · system call latency · disk latency · On-Demand prices · data API for agents
							</p>
						</section>

						<aside class="availability" aria-labelledby="availability">
							<h2 id="availability">Data availability</h2>
							<p>
								<strong>For agents and developers:</strong> every figure in this report is in a JSON file, with the Method that derived it and the Runs behind it.
							</p>
							<pre class="code" data-copy={`curl ${links.index}`}>
								<code>
									<span class="prompt">$ </span>curl \{"\n"}
									{"    "}
									{links.index}
								</code>
							</pre>
							<ol class="files">
								<li>
									<a href={links.index}>index.json</a> <span>the table of contents</span>
								</li>
								<li>
									<a href={links.seriesList}>series.json</a> <span>all {seriesCount.full} Series and their Methods</span>
								</li>
								<li>
									<a href={links.prices}>{priceFileName.replace("v1/", "")}</a> <span>AWS's prices, as copied</span>
								</li>
							</ol>
							<p class="fresh">
								<span class="dot" aria-hidden="true" />
								Latest Run <time datetime={newest.iso}>{newest.date}, {newest.minute} UTC</time>
							</p>
						</aside>
					</div>

					{/* ---------------------------------------------------- 1 */}
					<section class="sec" aria-labelledby="s1">
						<h2 id="s1">
							<span class="num">1</span>Introduction
						</h2>
						<div class="cols">
							<p>
								An estimate of what a piece of infrastructure will do, and cost, is a chain of small numbers: how fast a core reads memory, how long a system call takes, how
								long the disk takes to accept a write, what an hour of the machine costs. Each number is only as good as the measurement behind it, and a reader, person or
								agent, should be able to see that measurement.
							</p>
							<p>LedgerMath keeps the measurement. It does three things:</p>
							<ol class="contrib">
								<li>
									<em>It measures on a schedule.</em> Machines are booted fresh four times a day, at 04:10, 10:10, 16:10 and 22:10 UTC, and run the same{" "}
									{snapshot.benchmarkCount} benchmarks (§4.1).
								</li>
								<li>
									<em>It keeps every Run.</em> A Run is kept with its evidence, whether it counted or failed; a failed Run is shown with its reasons and is in no figure
									(§4.2, §4.5).
								</li>
								<li>
									<em>It derives by published Methods.</em> A figure is what a named, versioned Method computes from the counted Runs of one Series, and the Method's
									definitions are published beside the figures <Cite n={[REF.series, REF.method]} /> (§4.4).
								</li>
							</ol>
							<p>
								The result is a data API <Cite n={REF.index} />, in which each figure carries its source. This report reads one snapshot of it: Table 1 and Figure 1 give
								the headline figure of each benchmark on each machine type, Table 2 the machines and their prices, §5 the way in for agents, and Table S1 every digit.
							</p>
						</div>
					</section>

					{/* ---------------------------------------------------- 2 */}
					<section class="sec" aria-labelledby="s2">
						<h2 id="s2">
							<span class="num">2</span>Results
						</h2>
						<p class="lede">
							Table 1 gives, for each of the {snapshot.benchmarkCount} benchmarks on each of the {snapshot.machineCount} machine types, the median of the Series' counted Runs.
							One Series stands for each cell, chosen by a written rule: settings measured on every machine type, the static build, one thread where there is a choice.
							Figure 1 draws the same Series from their 5th to their 95th percentile.
						</p>

						<div class="table-wrap wide" role="region" aria-labelledby="t1-cap" tabindex="0">
							<table class="t1">
								<caption id="t1-cap">
									<span class="tlabel">Table 1.</span> Headline figures: the median (p50) of each Series' counted Runs. Rates are in decimal units (1 GB/s is 10
									<sup>9</sup> bytes a second); times are of one repetition, as described under each benchmark. Figures are given to four significant digits; each links
									to its Series file <Cite n={REF.series} />, and Table S1 gives every digit.
								</caption>
								<thead>
									<tr>
										<th scope="col" class="c-op">
											Benchmark
										</th>
										<th scope="col" class="c-unit">
											Unit
										</th>
										{machines.map((m) => (
											<th scope="col" class="c-m">
												<span class="m-name">{m.instanceType}</span>
												<span class="m-spec">
													{m.vcpu} vCPU · {m.memory}
												</span>
												<span class="m-price" title={m.price.description}>
													${formatUsd(m.price.usdPerHour).full}/h
												</span>
											</th>
										))}
									</tr>
								</thead>
								{bySection.map((s) => (
									<tbody>
										<tr class="group">
											<th scope="colgroup" colspan={2 + machines.length}>
												{s.section}
											</th>
										</tr>
										{s.rows.map((r) => {
											const letter = LETTERS[rows.indexOf(r)]!;
											return (
												<tr>
													<th scope="row" class="c-op">
														<span class="op-label">
															{r.row.choice.label}
															{r.per ? (
																<sup class="tn">
																	<a href="#tn-a" aria-label="table note a">
																		a
																	</a>
																</sup>
															) : (
																""
															)}
															{r.row.choice.section === "Disk" ? (
																<sup class="tn">
																	<a href="#tn-b" aria-label="table note b">
																		b
																	</a>
																</sup>
															) : (
																""
															)}
															{r.row.choice.section === "Network" ? (
																<sup class="tn">
																	<a href="#tn-c" aria-label="table note c">
																		c
																	</a>
																</sup>
															) : (
																""
															)}
														</span>
														<span class="op-what">{r.row.choice.what}</span>
														<span class="op-panel">Fig. 1{letter}</span>
													</th>
													<td class="c-unit">{r.per ? `ns per ${r.per}` : r.unit}</td>
													{r.cells.map((c) => (
														<td class="c-fig" data-m={c.machine}>
															<a href={c.url} title={`${c.machine}: median ${exact(c.p50)} (exact), ${c.n} counted Runs. Series file.`}>
																{c.p50.short}
															</a>
														</td>
													))}
												</tr>
											);
										})}
									</tbody>
								))}
							</table>
						</div>
						<ol class="tnotes wide">
							<li id="tn-a">
								<span class="tn-mark">a</span> One repetition of mutex is {mutex.row.choice.per!.count.toLocaleString("en-US")} critical sections; the table gives one,
								by moving the decimal point four places. On {mutexRow.machine.instanceType} the median repetition is {formatDuration(mutexLead.p50, { unit: "µs" }).full} µs,
								so one critical section is {mutex.cells[0]!.p50.full} ns.
							</li>
							<li id="tn-b">
								<span class="tn-mark">b</span> On the root volume, an EBS gp3 volume, which every machine type has; i4i.2xlarge's instance store is measured too, in Series
								of its own.
							</li>
							<li id="tn-c">
								<span class="tn-mark">c</span> To S3 in the same Region, on a connection already open. Each request's phases are summarised separately by Method requests
								v1 <Cite n={REF.method} />.
							</li>
						</ol>

						<figure class="fig1 wide" aria-labelledby="f1-cap">
							<div class="panels">
								{rows.map((r, i) => (
									<Panel r={r} letter={LETTERS[i]!} />
								))}
							</div>
							<figcaption id="f1-cap">
								<span class="tlabel">Figure 1.</span> The spread of each headline Series across its counted Runs. Each bar runs from the 5th to the 95th percentile and the
								tick marks the median; the three are printed on the right, to four significant digits (on a narrow screen, the median only; every digit is in Table S1). Scales are linear and start at zero, one
								per panel, so a bar's length and position are to exact scale within its panel. A very short bar is a Series whose Runs agreed closely. Percentiles are by
								linear interpolation between closest ranks, Eq. (3).
							</figcaption>
						</figure>
					</section>

					{/* ---------------------------------------------------- 3 */}
					<section class="sec" aria-labelledby="s3">
						<h2 id="s3">
							<span class="num">3</span>Machines and prices
						</h2>
						<p class="lede">
							The five machine types, cheapest first, as AWS's price list describes them, with the hourly On-Demand price for Linux in {snapshot.region} from the price file
							of {formatMoment(`${snapshot.priceDate}T00:00:00Z`).longDate} <Cite n={REF.prices} />. Each price is printed as the file gives it, with AWS's own description
							in the last column.
						</p>
						<div class="table-wrap wide" role="region" aria-labelledby="t2-cap" tabindex="0">
							<table class="t2">
								<caption id="t2-cap">
									<span class="tlabel">Table 2.</span> The machines measured, and what an hour of each costs On-Demand.
								</caption>
								<thead>
									<tr>
										<th scope="col">Machine type</th>
										<th scope="col" class="num-col">
											vCPU
										</th>
										<th scope="col">Memory</th>
										<th scope="col">Processor</th>
										<th scope="col">Network</th>
										<th scope="col">Storage</th>
										<th scope="col" class="num-col">
											USD per hour
										</th>
										<th scope="col">AWS's description</th>
									</tr>
								</thead>
								<tbody>
									{machines.map((m) => (
										<tr>
											<th scope="row">{m.instanceType}</th>
											<td class="num-col" data-label="vCPU">
												{m.vcpu}
											</td>
											<td data-label="Memory">{m.memory}</td>
											<td class="proc">
												{m.processor}
												<span class="clock">{m.clockSpeed}</span>
											</td>
											<td data-label="Network">{m.network}</td>
											<td data-label="Storage">{m.storage}</td>
											<td class="num-col price" title={`${m.price.usdPerHour} USD per hour, as the price file writes it`}>
												{formatUsd(m.price.usdPerHour).full}
											</td>
											<td class="desc">{m.price.description}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>

					{/* ---------------------------------------------------- 4 */}
					<section class="sec" aria-labelledby="s4">
						<h2 id="s4">
							<span class="num">4</span>Methods
						</h2>
						<div class="cols methods">
							<div class="sub">
								<h3 id="s41">
									<span class="num">4.1</span>Schedule and machines
								</h3>
								<p>
									Four times a day, at 04:10, 10:10, 16:10 and 22:10 UTC, a machine of each of the {snapshot.machineCount} types in Table 2 is booted in{" "}
									{snapshot.region}, and each of the {snapshot.benchmarkCount} benchmarks runs on it while it is freshly booted. The Runs in this snapshot started between{" "}
									{oldest.longDate} and {newest.longDate}
									<Note n={1} />.
								</p>
							</div>
							<div class="sub">
								<h3 id="s42">
									<span class="num">4.2</span>Runs, Series and evidence
								</h3>
								<p>
									Every execution of a benchmark is kept as a Run, with its evidence: what the benchmark printed, and what was recorded about the machine. In the Method's
									words, a Series is “{series1.definitions.series!.replace(/\.$/, "")}”. This snapshot holds {seriesCount.full} Series and {runs.full} Runs. A Run either
									counts or fails, by the rule in §4.5; a failed Run is kept and shown, with its reasons, and is in no figure <Cite n={REF.method} />.
								</p>
							</div>
							<div class="sub">
								<h3 id="s43">
									<span class="num">4.3</span>Exactness and versions
								</h3>
								<p>
									The API states: “{snapshot.figures.split(":")[0]}.” This page changes only units, by moving the decimal point
									<Note n={3} />. On versions: “{snapshot.versioning.split(". ")[0]}.”
								</p>
							</div>
							<div class="sub">
								<h3 id="s44">
									<span class="num">4.4</span>Figures
								</h3>
								<p>
									The figures are Method <span class="sc">series</span> v{series1.version}'s. For each Run it takes the time of one repetition: the median, over the Run's
									counted samples (warmup samples left out), of
								</p>
								<div class="eq" role="math" aria-label="t equals the sample's end minus its start, divided by its repetitions">
									<span class="eq-body">
										<i>t</i> = (<i>t</i>
										<sub>end</sub> − <i>t</i>
										<sub>start</sub>) / <i>r</i>
									</span>
									<span class="eq-n">(1)</span>
								</div>
								<p>
									for a sample of <i>r</i> repetitions; and where the benchmark observes the bytes one repetition moves, <i>B</i>, a rate in bytes a second of
								</p>
								<div class="eq" role="math" aria-label="rate equals B times ten to the ninth, divided by t in nanoseconds">
									<span class="eq-body">
										<i>R</i> = <i>B</i> × 10<sup>9</sup> / <i>t</i>
										<sub>ns</sub>
									</span>
									<span class="eq-n">(2)</span>
								</div>
								<p>
									Across the counted Runs of a Series it takes the 5th, 50th and 95th percentiles by linear interpolation between closest ranks: with the <i>n</i> values
									sorted, <i>x</i>
									<sub>0</sub> ≤ … ≤ <i>x</i>
									<sub>
										<i>n</i>−1
									</sub>
									,
								</p>
								<div class="eq" role="math" aria-label="h equals n minus 1 times p over 100; the percentile is x at floor h plus the fraction of h times the next difference">
									<span class="eq-body">
										<span class="eq-line">
											<i>h</i> = (<i>n</i> − 1) <i>p</i> / 100,
										</span>{" "}
										<span class="eq-line">
											<i>Q</i>(<i>p</i>) = <i>x</i>
											<sub>⌊h⌋</sub> + (<i>h</i> − ⌊<i>h</i>⌋)(<i>x</i>
											<sub>⌊h⌋+1</sub> − <i>x</i>
											<sub>⌊h⌋</sub>)
										</span>
									</span>
									<span class="eq-n">(3)</span>
								</div>
								<p>
									Each number's percentiles are taken over that number's own values, so the percentiles of a rate are not those of the time inverted
									<Note n={2} />.
									{requests1 ? (
										<>
											{" "}
											The GET from S3 is also summarised request by request, by Method <span class="sc">requests</span> v{requests1.version} <Cite n={REF.method} />.
										</>
									) : (
										""
									)}
								</p>
							</div>
						</div>
						<div class="sub counted">
							<h3 id="s45">
								<span class="num">4.5</span>Which Runs count
							</h3>
							<blockquote class="defn">
								<p>“{series1.definitions.counted}”</p>
								<footer>
									Method <span class="sc">series</span> v{series1.version}, definition of <i>counted</i> <Cite n={REF.method} />
								</footer>
							</blockquote>
						</div>
					</section>

					{/* ---------------------------------------------------- 5 */}
					<section class="sec" aria-labelledby="s5">
						<h2 id="s5">
							<span class="num">5</span>Access for agents and developers
						</h2>
						<div class="access">
							<div class="access-text">
								<p>
									The figures, the evidence behind them and AWS's prices are static JSON files at api.ledgermath.com. An agent that starts at the table of contents finds
									every Series with its figures, the Method and version that derived them, and each file's JSON schema <Cite n={[REF.index, REF.schemas]} />: a number to
									use, and a source to give for it.
								</p>
								<p class="api-words">
									<span class="kw">The API, in its own words</span> “{snapshot.about.split(". ").slice(0, 2).join(". ")}.”
								</p>
							</div>
							<div class="access-code">
								<pre class="code" data-copy={[links.index, links.seriesList, rows[0]!.cells[0]!.url, links.prices].map((u) => `curl ${u}`).join("\n")}>
									<code>
										<span class="c"># the table of contents</span>
										{"\n"}
										<span class="prompt">$ </span>curl {links.index}
										{"\n\n"}
										<span class="c"># every Series, its figures and its Methods</span>
										{"\n"}
										<span class="prompt">$ </span>curl {links.seriesList}
										{"\n\n"}
										<span class="c"># one Series: m5.large, Read memory sequentially</span>
										{"\n"}
										<span class="prompt">$ </span>curl {rows[0]!.cells[0]!.url}
										{"\n\n"}
										<span class="c"># AWS's On-Demand prices, copied {snapshot.priceDate}</span>
										{"\n"}
										<span class="prompt">$ </span>curl {links.prices}
									</code>
								</pre>
							</div>
						</div>
						<div class="table-wrap wide" role="region" aria-labelledby="t3-cap" tabindex="0">
							<table class="t3">
								<caption id="t3-cap">
									<span class="tlabel">Table 3.</span> The files of the data API, version 1. Each kind of file has a JSON schema; version 1 only ever gains fields{" "}
									<Cite n={[REF.index, REF.schemas]} />.
								</caption>
								<thead>
									<tr>
										<th scope="col">File</th>
										<th scope="col">What an agent finds there</th>
										<th scope="col">Schema</th>
									</tr>
								</thead>
								<tbody>
									<tr>
										<th scope="row">
											<a href={links.index}>v1/index.json</a>
										</th>
										<td>The table of contents: what LedgerMath is, how versions work, the newest Run, and the address of every other file.</td>
										<td>
											<a href={schema("index").url}>index.schema.json</a>
										</td>
									</tr>
									<tr>
										<th scope="row">
											<a href={links.seriesList}>v1/series.json</a>
										</th>
										<td>
											All {seriesCount.full} Series, each with its benchmark, settings, machine type and zone, its counts of Runs, and the figures of Method{" "}
											<span class="sc">series</span> v{series1.version}; the Methods' definitions.
										</td>
										<td>
											<a href={schema("series-list").url}>series-list.schema.json</a>
										</td>
									</tr>
									<tr>
										<th scope="row">
											<a href={rows[0]!.cells[0]!.url}>v1/series/&lt;id&gt;.json</a>
										</th>
										<td>One Series in full: every figure in Table 1 links to its own.</td>
										<td>
											<a href={schema("series").url}>series.schema.json</a>
										</td>
									</tr>
									<tr>
										<th scope="row">
											<a href={links.prices}>v1/prices/&lt;date&gt;.json</a>
										</th>
										<td>AWS's public On-Demand prices for the machine types measured, copied once a day; the newest is of {snapshot.priceDate}.</td>
										<td>
											<a href={schema("prices").url}>prices.schema.json</a>
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</section>

					{/* ---------------------------------------------------- notes, references */}
					<section class="sec notes" aria-labelledby="notes">
						<h2 id="notes">Notes</h2>
						<ol>
							<li id="fn-1">
								The oldest Run started at {oldest.full}, the newest at {newest.full}. Moments are in UTC, to the nanosecond, as each Run records them.{" "}
								<a href="#fnref-1" aria-label="back to note 1">
									↩
								</a>
							</li>
							<li id="fn-2">
								So the median rate in Table 1 is not 1 divided by the median time. Method <span class="sc">series</span> v{series1.version}, definition of{" "}
								<i>percentiles</i> <Cite n={REF.method} />. <a href="#fnref-2" aria-label="back to note 2">↩</a>
							</li>
							<li id="fn-3">
								Nanoseconds to µs or ms, bytes a second to MB/s or GB/s, and one repetition of mutex to one critical section. Nothing on this page is averaged, ranked or
								computed from the figures. <a href="#fnref-3" aria-label="back to note 3">↩</a>
							</li>
						</ol>
					</section>

					<section class="sec refs" aria-labelledby="refs">
						<h2 id="refs">References</h2>
						<ol>
							<li id="ref-1">
								LedgerMath. <i>Data API v1: table of contents.</i> <a href={links.index}>{short(links.index)}</a>
							</li>
							<li id="ref-2">
								LedgerMath. <i>Every Series, with its figures ({seriesCount.full} Series).</i> <a href={links.seriesList}>{short(links.seriesList)}</a>
							</li>
							<li id="ref-3">
								Amazon Web Services. <i>On-Demand prices, {snapshot.region}</i>, copied {fetched.full}. <a href={links.prices}>{short(links.prices)}</a>
							</li>
							<li id="ref-4">
								LedgerMath. <i>Methods {snapshot.methods.map((m) => `${m.name} v${m.version}`).join(" and ")}: definitions.</i> In series.json, under <code>methods</code>.{" "}
								<a href={links.seriesList}>{short(links.seriesList)}</a>
							</li>
							<li id="ref-5">
								LedgerMath. <i>JSON schemas</i>:{" "}
								{links.schemas.map((s, i) => (
									<>
										{i > 0 ? ", " : ""}
										<a href={s.url}>{s.name}</a> ({s.describes})
									</>
								))}
								.
							</li>
							<li id="ref-6">
								LedgerMath. <i>The data API: documentation.</i> <a href={links.docs}>Read the documentation</a>
							</li>
						</ol>
					</section>

					{/* ---------------------------------------------------- appendix */}
					<section class="sec appendix" aria-labelledby="sA">
						<h2 id="sA">
							<span class="num">A</span>Supplementary data
						</h2>
						<details class="s1-details" open data-fold-on-phone>
							<summary>
								<span class="tlabel">Table S1.</span> Every digit of the {rows.length * machines.length} headline Series: their 5th, 50th and 95th percentiles,
								exactly as the snapshot holds them, in the units of Table 1, and the number of counted Runs (<i>n</i>). Digits are grouped in threes; nothing is rounded.
								The last column names each Series' file in the API.
							</summary>
							<div class="table-wrap" role="region" aria-label="Table S1, every digit" tabindex="0">
								<table class="s1">
									<thead>
										<tr>
											<th scope="col" class="s1-b">
												Benchmark
											</th>
											<th scope="col" class="s1-m">
												Machine
											</th>
											<th scope="col" class="s1-x">
												p5
											</th>
											<th scope="col" class="s1-x s1-mid">
												p50
											</th>
											<th scope="col" class="s1-x">
												p95
											</th>
											<th scope="col" class="s1-n">
												<i>n</i>
											</th>
											<th scope="col" class="s1-id">
												Series
											</th>
										</tr>
									</thead>
									{rows.map((r, i) => (
										<tbody>
											{r.cells.map((c, j) => (
												<tr>
													{j === 0 ? (
														<th scope="rowgroup" rowspan={r.cells.length} class="s1-b">
															<span class="s1-letter">{LETTERS[i]}</span>
															{r.row.choice.label}
															<span class="s1-unit">{r.per ? `ns per ${r.per}` : r.unit}</span>
														</th>
													) : (
														""
													)}
													<td class="s1-m">{c.machine}</td>
													<td class="s1-x">{si(c.p5.full)}</td>
													<td class="s1-x s1-mid">{si(c.p50.full)}</td>
													<td class="s1-x">{si(c.p95.full)}</td>
													<td class="s1-n">{c.n}</td>
													<td class="s1-id">
														<a href={c.url}>{c.url.replace(/^.*\/series\//, "").replace(/\.json$/, "")}</a>
													</td>
												</tr>
											))}
										</tbody>
									))}
								</table>
							</div>
						</details>
					</section>
				</article>
			</main>

			<footer class="colophon">
				<p>
					<span class="wordmark-sm">LedgerMath</span> · Data report, snapshot of {newest.longDate} · {runs.full} Runs, {seriesCount.full} Series, {snapshot.benchmarkCount}{" "}
					benchmarks, {snapshot.machineCount} machine types · Set in STIX Two Text and IBM Plex Mono (<a href="third-party-notices.txt">licences</a>)
				</p>
			</footer>
		</>
	);
}
