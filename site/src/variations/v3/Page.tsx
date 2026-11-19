// Design v3, "Paper": LedgerMath's home page set as a data report in a scientific journal.
// Every figure comes from ../../data exactly as the snapshot holds it. Table 1 and Figure 1 round
// to four significant digits for reading and say so; every rounded figure opens to its exact form
// where it stands (Table 1's card, Figure 1's rows), and Table S1 gives every digit.
import "./page.css";
import {
	durationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	group,
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

// ---------------------------------------------------------------- figures of one row

type Cell = { p5: Shown; p50: Shown; p95: Shown; n: number; url: string; id: string; machine: string; draw: { p5: number; p50: number; p95: number } };
type Row = { row: HeadlineRow; unit: string; unitLong: string; dir: "up" | "down"; cells: Cell[]; per?: string; letter: string; frac: number };

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"] as const;
function rateUnit(bytesPerSecond: number) {
	const i = Math.min(4, Math.max(0, Math.floor(Math.log10(Math.abs(bytesPerSecond)) / 3)));
	return BYTE_UNITS[i]!;
}

const LETTERS = "abcdefghijklmn";
/** The part of a decimal text after its point, with the point ("" when there is none). */
const fracOf = (decimal: string) => (decimal.includes(".") ? decimal.slice(decimal.indexOf(".")) : "");

// One unit per row, so a row reads across: the unit in which the row's smallest median is at least 1.
const rows: Row[] = headline.map((row, index) => {
	const figures = row.cells.map((cell) => ({ cell, f: leadFigure(row.choice, cell.series) }));
	const least = Math.min(...figures.map(({ f }) => f.p50));
	const per = row.choice.per;
	let show: (x: number) => Shown;
	let unit: string;
	if (per) {
		// The one division allowed: one repetition of mutex is per.count critical sections, divided exactly.
		show = (x) => formatDurationPerUnit(x, per, { unit: "ns" });
		unit = "ns";
	} else if (row.choice.lead === "rate") {
		const u = rateUnit(least);
		show = (x) => formatRate(x, { unit: u, significant: 4 });
		unit = `${u}/s`;
	} else {
		const u: DurationUnit = durationUnit(least);
		show = (x) => formatDuration(x, { unit: u, significant: 4 });
		unit = u;
	}
	const cells = figures.map(({ cell, f }) => {
		const p5 = show(f.p5);
		const p50 = show(f.p50);
		const p95 = show(f.p95);
		return {
			p5,
			p50,
			p95,
			n: f.count,
			url: links.seriesFile(cell.series),
			id: cell.series.id,
			machine: cell.machine.instanceType,
			draw: { p5: Number(p5.full), p50: Number(p50.full), p95: Number(p95.full) },
		};
	});
	return {
		row,
		unit,
		unitLong: per ? `${unit} per ${per.of}` : unit,
		dir: row.choice.lead === "rate" ? "up" : "down",
		per: per?.of,
		letter: LETTERS[index]!,
		frac: Math.max(...cells.map((c) => fracOf(c.p50.short).length)),
		cells,
	};
});

/** One width for the part after the point in every cell of Table 1, so points line up down each column and across each row. */
const FRAC = Math.max(...rows.map((r) => r.frac));

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
const bySection = SECTIONS.map((section) => ({ section, rows: rows.filter((r) => r.row.choice.section === section) }));

/** Digits in groups of three with thin spaces, both sides of the point (SI style). No digit changes. */
const si = (decimal: string) => group(decimal, " ", " ");
const exact = (s: Shown) => `${s.full} ${s.unit}`;

/** A rounded figure set so that its decimal point falls in the same place in every cell of its row. */
function Aligned(props: { text: string; frac: number }) {
	const f = fracOf(props.text);
	const i = f ? props.text.slice(0, -f.length) : props.text;
	return (
		<>
			<span class="int">{i}</span>
			<span class="frac" style={`width:${props.frac}ch`}>
				{f}
			</span>
		</>
	);
}

function Arrow(props: { dir: "up" | "down" }) {
	return (
		<span class={`dir dir-${props.dir}`} title={props.dir === "up" ? "a rate: higher is faster" : "a time: lower is faster"}>
			{props.dir === "up" ? "↑" : "↓"}
		</span>
	);
}

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

// The example in the abstract: Table 1's first cell, exactly.
const first = rows[0]!;
const firstCell = first.cells[0]!;
const firstExact = formatRate(leadFigure(first.row.choice, first.row.cells[0]!.series).p50, { unit: first.unit.replace("/s", "") as "GB" });

// Listing 1: that cell's Series, as v1/series.json lists it. Small objects on one line.
function compact(value: unknown, indent = ""): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	const array = Array.isArray(value);
	const entries: [string | null, unknown][] = array ? (value as unknown[]).map((x) => [null, x]) : Object.entries(value as object);
	const item = ([k, x]: [string | null, unknown]) => (k === null ? "" : `${JSON.stringify(k)}: `) + compact(x, `${indent}  `);
	const [open, close] = array ? ["[", "]"] : ["{", "}"];
	if (entries.length <= 4 && entries.every(([, x]) => x === null || typeof x !== "object")) return `${open} ${entries.map(item).join(", ")} ${close}`;
	return `${open}\n${entries.map((e) => `${indent}  ${item(e)}`).join(",\n")}\n${indent}${close}`;
}
const listing = compact(first.row.cells[0]!.series);
// The figure Table 1 shows, marked where it stands in the listing: bytes_per_second's p50.
const listingMark = `"p50": ${JSON.stringify(first.row.cells[0]!.series.derivations.series_v1.percentiles.bytes_per_second!.p50)}`;
const listingAt = listing.lastIndexOf(listingMark);
if (listingAt < 0) throw new Error("Listing 1 does not hold the figure it marks");

// The commands of §3, each with its own copy button.
const COMMANDS = [
	{ what: "the table of contents: start here", url: links.index },
	{ what: `every Series, its figures and its Methods (${seriesCount.full} Series)`, url: links.seriesList },
	{ what: `one Series in full: ${firstCell.machine}, ${first.row.choice.label.toLowerCase()}`, url: firstCell.url },
	{ what: `AWS's On-Demand prices, copied ${snapshot.priceDate}`, url: links.prices },
];
/** An address with a place to break after "/v1/" and "/series/", so it wraps where it reads. */
function Breakable(props: { url: string }) {
	const parts = props.url.split(/(?<=\/v1\/|\/series\/|\/prices\/)/);
	return (
		<>
			{parts.map((p, i) => (
				<>
					{i > 0 ? <wbr /> : ""}
					{p}
				</>
			))}
		</>
	);
}

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

function Panel(props: { r: Row }) {
	const top = Math.max(...props.r.cells.map((c) => c.draw.p95));
	const step = niceStep(top / 4);
	const max = Math.ceil(top / step) * step;
	const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
	const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step % 1 === 0 ? 0 : 1));
	const label = (t: number) => (t === 0 ? "0" : t.toFixed(Math.min(decimals, 2)).replace(/\.0+$/, ""));
	const x = (v: number) => (v / max) * 1000;
	const choice = props.r.row.choice;
	const letter = props.r.letter;
	return (
		<figure class="panel" id={`fig1-${letter}`} aria-labelledby={`panel-${letter}`}>
			<figcaption id={`panel-${letter}`}>
				<span class="panel-letter">({letter})</span> {choice.label}
				<span class="panel-unit">
					, {props.r.unitLong} <Arrow dir={props.r.dir} />
				</span>
				<span class="panel-rep">
					<span class="rep-k">Repetition</span> {choice.repetition}
				</span>
			</figcaption>
			<div class="bars">
				{props.r.cells.map((c) => (
					<details class="bar">
						<summary>
							<span class="bar-name">{c.machine}</span>
							<svg class="bar-plot" viewBox="0 0 1000 16" preserveAspectRatio="none" aria-hidden="true">
								{ticks.map((t) => (
									<line class="grid" x1={x(t)} x2={x(t)} y1="0" y2="16" vector-effect="non-scaling-stroke" />
								))}
								<rect class="range" x={x(c.draw.p5)} y="3.5" width={Math.max(0, x(c.draw.p95) - x(c.draw.p5))} height="9" />
								<line class="median" x1={x(c.draw.p50)} x2={x(c.draw.p50)} y1="0.5" y2="15.5" vector-effect="non-scaling-stroke" />
							</svg>
							<span class="bar-figs">
								<span class="lo">{c.p5.short}</span>
								<b>{c.p50.short}</b>
								<span class="hi">{c.p95.short}</span>
								<span class="n">{c.n}</span>
							</span>
						</summary>
						<dl class="bar-exact">
							<div>
								<dt>p5</dt>
								<dd>{si(c.p5.full)}</dd>
							</div>
							<div class="mid">
								<dt>p50</dt>
								<dd>
									{si(c.p50.full)} <span class="u">{props.r.unitLong}</span>
								</dd>
							</div>
							<div>
								<dt>p95</dt>
								<dd>{si(c.p95.full)}</dd>
							</div>
							<div>
								<dt>
									<i>n</i>
								</dt>
								<dd>{c.n} counted Runs</dd>
							</div>
							<div class="sid">
								<dt>Series</dt>
								<dd>
									<a href={c.url}>{c.url.replace(/^https:\/\/[^/]+\//, "")}</a>
								</dd>
							</div>
						</dl>
					</details>
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
						<span class="n">
							<i>n</i>
						</span>
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
						<p class="deck">
							Measured numbers for deciding on infrastructure, each with its source: a JSON data API for AI agents and the developers who build them.
						</p>

						<div class="byline">
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
								<sup>1</sup> Amazon EC2, {snapshot.region} (zone ID {zones.join(", ")}), booted fresh at 04:10, 10:10, 16:10 and 22:10 UTC; each boot runs all{" "}
								{snapshot.benchmarkCount} benchmarks.
							</p>
						</div>

						<dl class="dates">
							<div>
								<dt>First Run</dt>
								<dd>
									<time datetime={oldest.iso} title={oldest.full}>
										{oldest.date} {oldest.minute} UTC
									</time>
								</dd>
							</div>
							<div>
								<dt>Latest Run</dt>
								<dd>
									<time datetime={newest.iso} title={newest.full}>
										{newest.date} {newest.minute} UTC
									</time>
								</dd>
							</div>
							<div>
								<dt>Prices copied</dt>
								<dd>
									<time datetime={snapshot.pricesFetchedAt} title={fetched.full}>
										{fetched.date} {fetched.minute} UTC
									</time>
								</dd>
							</div>
							<div>
								<dt>Runs</dt>
								<dd>
									{counted.full} counted, {failed.full} failed
								</dd>
							</div>
						</dl>
					</div>

					<div class="opening">
						<section class="abstract" aria-labelledby="abstract">
							<h2 id="abstract">Abstract</h2>
							<p>
								LedgerMath boots five AWS machine types in {snapshot.region} four times a day and runs {snapshot.benchmarkCount} small benchmarks on each, freshly booted. Every
								execution is kept as a Run with its evidence, published Methods derive the figures from the counted Runs, and AWS's On-Demand prices are copied daily. This
								snapshot rests on {runs.full} Runs in {seriesCount.full} Series.
							</p>
							<p class="example">
								For example, <span class="mono">{firstCell.machine}</span> reads memory sequentially at a median of{" "}
								<strong>
									<a href={firstCell.url}>{si(firstExact.full)}&nbsp;GB/s</a>
								</strong>{" "}
								over {firstCell.n} counted Runs (Table 1a; Series <span class="mono">{firstCell.id}</span>).
							</p>
						</section>

						<aside class="availability" aria-labelledby="availability">
							<h2 id="availability">Data availability</h2>
							<p>
								<strong>For agents and developers:</strong> every figure here is in a JSON file, with its Method and the Runs behind it <Cite n={REF.index} />.
							</p>
							<p class="code-label">JSON index</p>
							<pre class="code" data-copy={`curl ${links.index}`}>
								<code>
									<span class="prompt">$ </span>curl <Breakable url={links.index} />
								</code>
							</pre>
							<ol class="files">
								<li>
									<a href={links.seriesList}>series.json</a> <span>all {seriesCount.full} Series and their Methods</span>
								</li>
								<li>
									<a href={links.prices}>{priceFileName.replace("v1/", "")}</a> <span>AWS's prices, as copied</span>
								</li>
								<li>
									<a href="#s3">§3</a> <span>every address, and what a file holds</span>
								</li>
							</ol>
						</aside>
					</div>

					{/* ---------------------------------------------------- 1 */}
					<section class="sec results" aria-labelledby="s1">
						<h2 id="s1">
							<span class="num">1</span>Results
						</h2>

						<div class="table-wrap wide t1-wrap" role="region" aria-labelledby="t1-cap" tabindex="0">
							<table class="t1">
								<caption id="t1-cap">
									<span class="tlabel">Table 1.</span> The median (p50) of each Series' counted Runs, one Series per cell, chosen by a written rule (settings measured on every
									machine type, the static build, one thread where there is a choice). <em>Rounded to four significant digits</em>: point at or tab to a figure for every
									digit, its spread and its Runs; follow it to its Series file <Cite n={REF.series} />. <Arrow dir="up" /> a rate (decimal: 1 GB/s is 10<sup>9</sup> B/s),
									higher is faster; <Arrow dir="down" /> the time of one repetition, lower is faster.
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
										{s.rows.map((r) => (
											<tr>
												<th scope="row" class="c-op">
													<span class="op-label">
														<a class="op-letter" href={`#fig1-${r.letter}`} aria-label={`${r.letter}, Figure 1${r.letter}`}>
															{r.letter}
														</a>
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
													<span class="op-what">
														{r.row.choice.per
															? `One ${r.row.choice.per.of}; a repetition is ${r.row.choice.repetition.charAt(0).toLowerCase()}${r.row.choice.repetition.slice(1)}`
															: r.row.choice.repetition}
													</span>
												</th>
												<td class="c-unit">
													{r.unit} <Arrow dir={r.dir} />
												</td>
												{r.cells.map((c) => (
													<td class="c-fig">
														<a href={c.url} aria-describedby={`x-${r.letter}-${c.id}`}>
															<Aligned text={c.p50.short} frac={FRAC} />
														</a>
														<span class="card" id={`x-${r.letter}-${c.id}`}>
															<span class="card-h">
																{c.machine} · {r.row.choice.label}
															</span>
															<span class="card-r">
																<span>p5</span>
																{si(c.p5.full)}
															</span>
															<span class="card-r mid">
																<span>p50</span>
																{si(c.p50.full)}
															</span>
															<span class="card-r">
																<span>p95</span>
																{si(c.p95.full)}
															</span>
															<span class="card-f">
																{r.unitLong} · <i>n</i> = {c.n} counted Runs · Series {c.id}
															</span>
														</span>
													</td>
												))}
											</tr>
										))}
									</tbody>
								))}
							</table>
						</div>
						<ol class="tnotes wide">
							<li id="tn-a">
								<span class="tn-mark">a</span> One repetition of mutex is {mutex.row.choice.per!.count.toLocaleString("en-US")} critical sections; Table 1 and Figure 1h give
								one, by moving the decimal point four places. On {mutexRow.machine.instanceType} the median repetition is {formatDuration(mutexLead.p50, { unit: "µs" }).full} µs, so
								one critical section is {mutex.cells[0]!.p50.full} ns.
							</li>
							<li id="tn-b">
								<span class="tn-mark">b</span> The four disk benchmarks (rows and panels j–m) measure the root volume, an EBS gp3 volume, which is the same kind of volume on every machine type, not
								storage the machine type has of its own. i4i.2xlarge's instance store is measured too, in Series of its own.
							</li>
							<li id="tn-c">
								<span class="tn-mark">c</span> To S3 in the same Region, on a connection already open. Each request's phases are summarised separately by Method requests
								v1 <Cite n={REF.method} />.
							</li>
						</ol>

						<figure class="fig1 wide" aria-labelledby="f1-cap">
							<figcaption id="f1-cap">
								<span class="tlabel">Figure 1.</span> The spread of each headline Series across its counted Runs, one panel per benchmark.{" "}
								<span class="key">
									<svg viewBox="0 0 44 16" aria-hidden="true">
										<rect class="range" x="2" y="3.5" width="40" height="9" />
										<line class="median" x1="26" x2="26" y1="0.5" y2="15.5" />
									</svg>
									a bar runs from the 5th to the 95th percentile; the tick is the median.
								</span>{" "}
								Scales are linear and start at zero, one per panel. Figures are rounded to four significant digits;{" "}
								<span class="tap">select a machine's row to open every digit, its count of Runs and its Series file.</span>
							</figcaption>
							<div class="panels">
								{rows.map((r) => (
									<Panel r={r} />
								))}
							</div>
						</figure>
					</section>

					{/* ---------------------------------------------------- 2 */}
					<section class="sec" aria-labelledby="s2">
						<h2 id="s2">
							<span class="num">2</span>Machines and prices
						</h2>
						<p class="lede">
							The five machine types in order of hourly price, as AWS's price list describes them, with the On-Demand price for Linux in {snapshot.region} from the price file
							of {formatMoment(`${snapshot.priceDate}T00:00:00Z`).longDate} <Cite n={REF.prices} />. Each price is printed as the file gives it, beside AWS's own words.
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

					{/* ---------------------------------------------------- 3 */}
					<section class="sec" aria-labelledby="s3">
						<h2 id="s3">
							<span class="num">3</span>Access for agents and developers
						</h2>
						<div class="access">
							<div class="access-text">
								<p>
									The figures, the evidence behind them and AWS's prices are static JSON files at api.ledgermath.com. An agent that starts at the table of contents finds
									every Series with its figures, the Method and version that derived them, and each file's JSON schema <Cite n={[REF.index, REF.schemas]} />: a number to
									use, and a source to give for it. Each Series' own file holds each Run's figure and a link to its evidence.
								</p>
								<p class="api-words">
									<span class="kw">The API, in its own words</span> “{snapshot.about.split(". ").slice(0, 2).join(". ")}.”
								</p>
							</div>
							<ol class="cmds">
								{COMMANDS.map((c) => (
									<li class="cmd">
										<p class="cmd-what"># {c.what}</p>
										<pre class="code" data-copy={`curl ${c.url}`}>
											<code>
												<span class="prompt">$ </span>curl <Breakable url={c.url} />
											</code>
										</pre>
									</li>
								))}
							</ol>
						</div>

						<figure class="listing">
							<figcaption>
								<span class="tlabel">Listing 1.</span> What an agent reads for Table 1's first figure: Series <span class="mono">{firstCell.id}</span> as{" "}
								<a href={links.seriesList}>v1/series.json</a> lists it, exactly. The figure is <code>bytes_per_second.p50</code> under Method <span class="sc">series</span>{" "}
								v{series1.version} (marked), from <code>count</code> counted Runs; its own file, with each Run and a link to its evidence, is at <code>url</code>.
							</figcaption>
							<pre class="code json">
								<code>
									{listing.slice(0, listingAt)}
									<mark>{listingMark}</mark>
									{listing.slice(listingAt + listingMark.length)}
								</code>
							</pre>
						</figure>

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
											<a href={firstCell.url}>v1/series/&lt;id&gt;.json</a>
										</th>
										<td>One Series in full: each Run's figure and a link to its evidence. Every figure in Table 1 links to its own.</td>
										<td>
											<a href={seriesFileContents.schemaUrl}>series.schema.json</a>
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
									Four times a day, at 04:10, 10:10, 16:10 and 22:10 UTC, a machine of each of the {snapshot.machineCount} types in Table 2 is booted in {snapshot.region},
									and each of the {snapshot.benchmarkCount} benchmarks runs on it while it is freshly booted. The Runs in this snapshot started between {oldest.longDate} and{" "}
									{newest.longDate}
									<Note n={1} />.
								</p>
							</div>
							<div class="sub">
								<h3 id="s42">
									<span class="num">4.2</span>Runs, Series and evidence
								</h3>
								<p>
									Every execution of a benchmark is kept as a Run, with its evidence: what the benchmark printed, and what was recorded about the machine. In the Method's
									words, a Series is “{series1.definitions.series!.replace(/\.$/, "")}”. This snapshot holds {seriesCount.full} Series and {runs.full} Runs: {counted.full}{" "}
									counted, {failed.full} failed. A Run either counts or fails, by the rule in §4.5; a failed Run is kept and shown, with its reasons, and is in no figure{" "}
									<Cite n={REF.method} />.
								</p>
							</div>
							<div class="sub">
								<h3 id="s43">
									<span class="num">4.3</span>Exactness and versions
								</h3>
								<p>
									The API states: “{snapshot.figures.split(":")[0]}.” This page changes units, by moving the decimal point
									<Note n={3} />, and, in Table 1 and Figure 1 only, rounds to four significant digits for reading, which their captions say. Every rounded figure opens to
									its exact form where it stands; Table S1 and the API keep every digit. On versions: “{snapshot.versioning.split(". ")[0]}.”
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

					{/* ---------------------------------------------------- notes, references */}
					<section class="sec notes" aria-labelledby="notes">
						<h2 id="notes">Notes</h2>
						<ol>
							<li id="fn-1">
								The oldest Run started at {oldest.full}, the newest at {newest.full}; AWS's prices were copied at {fetched.full}. Moments are in UTC, to the nanosecond, as
								each Run records them; the front page gives them to the minute. <a href="#fnref-1" aria-label="back to note 1">↩</a>
							</li>
							<li id="fn-2">
								So the median rate in Table 1 is not 1 divided by the median time. Method <span class="sc">series</span> v{series1.version}, definition of{" "}
								<i>percentiles</i> <Cite n={REF.method} />. <a href="#fnref-2" aria-label="back to note 2">↩</a>
							</li>
							<li id="fn-3">
								Nanoseconds to µs or ms, bytes a second to MB/s or GB/s, and one repetition of mutex to one critical section. Nothing on this page is averaged or computed
								from the figures; machines are listed in order of hourly price, which is not a finding about them.{" "}
								<a href="#fnref-3" aria-label="back to note 3">
									↩
								</a>
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
								LedgerMath. <i>The data API: documentation.</i> <a href={links.docs}>{short(links.docs)}</a>
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
								<span class="tlabel">Table S1.</span> Every digit of the {rows.length * machines.length} headline Series: their 5th, 50th and 95th percentiles, exactly
								as the snapshot holds them, in the units of Table 1, and the number of counted Runs (<i>n</i>). Digits are grouped in threes; nothing is rounded. The last
								column names each Series' file in the API.
							</summary>
							<div class="table-wrap s1-wrap" role="region" aria-label="Table S1, every digit" tabindex="0">
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
									{rows.map((r) => (
										<tbody>
											{r.cells.map((c, j) => (
												<tr>
													{j === 0 ? (
														<th scope="rowgroup" rowspan={r.cells.length} class="s1-b">
															<span class="s1-head">
																<span class="s1-letter">{r.letter}</span>
																{r.row.choice.label}
																<span class="s1-unit">{r.unitLong}</span>
															</span>
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
														<a href={c.url}>{c.id}</a>
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
