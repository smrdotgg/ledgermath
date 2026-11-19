// Design v3, "Paper": LedgerMath's home page as a one-page data report, a research letter.
// The figures are the page: a title, one line of facts, one sentence of abstract, the way in,
// Table 1 (every digit, a p5–p95 bar per cell, the machines and prices in its head), references.
// Everything else (methods, definitions) is behind a reference. Every figure comes from
// ../../data exactly as the snapshot holds it; nothing is rounded, ranked or computed.
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
	snapshot,
	type DurationUnit,
	type HeadlineRow,
	type Section,
	type Shown,
} from "../../data";

// ---------------------------------------------------------------- figures of one row

type Cell = { p5: Shown; p50: Shown; p95: Shown; n: number; url: string; id: string; machine: string; draw: { p5: number; p50: number; p95: number } };
type Row = { row: HeadlineRow; unit: string; unitLong: string; dir: "up" | "down"; cells: Cell[]; max: number };

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"] as const;
function rateUnit(bytesPerSecond: number) {
	const i = Math.min(4, Math.max(0, Math.floor(Math.log10(Math.abs(bytesPerSecond)) / 3)));
	return BYTE_UNITS[i]!;
}

// One unit per row, so a row reads across: the unit in which the row's smallest median is at least 1.
// Every figure is exact (`full`); no `significant` is asked for anywhere on this page.
const rows: Row[] = headline.map((row) => {
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
		show = (x) => formatRate(x, { unit: u });
		unit = `${u}/s`;
	} else {
		const u: DurationUnit = durationUnit(least);
		show = (x) => formatDuration(x, { unit: u });
		unit = u;
	}
	const cells = figures.map(({ cell, f }) => ({
		p5: show(f.p5),
		p50: show(f.p50),
		p95: show(f.p95),
		n: f.count,
		url: links.seriesFile(cell.series),
		id: cell.series.id,
		machine: cell.machine.instanceType,
		draw: { p5: f.p5, p50: f.p50, p95: f.p95 },
	}));
	return {
		row,
		unit,
		unitLong: per ? `${unit} per ${per.of}` : unit,
		dir: row.choice.lead === "rate" ? "up" : "down",
		// The row's one scale: zero to its largest p95 (the snapshot's own numbers, for drawing only).
		max: Math.max(...cells.map((c) => c.draw.p95)),
		cells,
	};
});

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
// A label, never a sentence: where the two groups that are not the machine itself are measured.
const GROUP_NOTE: Partial<Record<Section, string>> = { Disk: "root volume, EBS gp3", Network: "S3, same Region" };
const bySection = SECTIONS.map((section) => ({ section, rows: rows.filter((r) => r.row.choice.section === section) }));

/** A narrow no-break space: SI's thin gap between groups of three, so a group never stands apart from its run. */
const NNBSP = " ";
/** Digits in groups of three with thin spaces, both sides of the point (SI style). No digit changes. */
const si = (decimal: string) => group(decimal, NNBSP, NNBSP);

/** An exact figure in three parts: its whole part, its point and first three decimals, and every further digit. */
function split(full: string) {
	const g = si(full);
	const dot = g.indexOf(".");
	if (dot < 0) return { int: g, head: "", tail: "" };
	return { int: g.slice(0, dot), head: g.slice(dot, dot + 4), tail: g.slice(dot + 4).replace(/^ /, "") };
}
/** Width in `ch` of a run of digits and thin spaces (generous for the space, so a box never overflows and the points stay in line). */
const chOf = (text: string) => [...text].reduce((w, c) => w + (c === NNBSP ? 0.5 : 1), 0);
const parts = rows.flatMap((r) => r.cells.map((c) => split(c.p50.full)));
/** One width for the whole part and one for the tail across Table 1, so every decimal point lines up down a column. */
const INT_CH = Math.max(...parts.map((p) => chOf(p.int)));
const TAIL_CH = Math.max(...parts.map((p) => chOf(p.tail)));

/** An exact figure, its decimal point in the same place in every cell: full weight to the third decimal, lighter after. */
function Exact(props: { full: string }) {
	const p = split(props.full);
	return (
		<span class="x">
			<span class="x-int" style={`width:${INT_CH}ch`}>
				{p.int}
			</span>
			<span class="x-head">{p.head}</span>
			<span class="x-tail" style={`width:${TAIL_CH}ch`}>
				{p.tail}
			</span>
		</span>
	);
}

/** One cell's figure drawn to its row's scale, from zero: a line to the median, the p5–p95 range over it, and the median's tick. */
function Bar(props: { c: Cell; max: number }) {
	const at = (v: number) => `${((v / props.max) * 100).toFixed(2)}%`;
	const d = props.c.draw;
	return (
		<span class="bar" aria-hidden="true">
			<span class="bar-to" style={`width:${at(d.p50)}`} />
			<span class="bar-range" style={`left:${at(d.p5)};width:${at(d.p95 - d.p5)}`} />
			<span class="bar-tick" style={`left:${at(d.p50)}`} />
		</span>
	);
}

function Arrow(props: { dir: "up" | "down" }) {
	return (
		<span class="dir" title={props.dir === "up" ? "higher is faster" : "lower is faster"}>
			{props.dir === "up" ? "↑" : "↓"}
		</span>
	);
}

// ---------------------------------------------------------------- facts of the snapshot

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const fetched = formatMoment(snapshot.pricesFetchedAt);
const runs = formatCount(snapshot.runCount);
const failed = formatCount(snapshot.failedRuns);
const series1 = snapshot.methods.find((m) => m.key === "series_v1")!;
const schema = (name: string) => links.schemas.find((s) => s.name === name)!;
const priceFileName = links.prices.replace(/^.*\/v1\//, "v1/");
const short = (url: string) => url.replace(/^https:\/\//, "");

// Listing 1: Table 1's first figure, as the Series list holds it, cut to the path that leads to it.
const first = rows[0]!;
const firstCell = first.cells[0]!;
const firstSeries = first.row.cells[0]!.series;
const v1 = firstSeries.derivations.series_v1;
const bps = v1.percentiles.bytes_per_second!;
const j = (x: unknown) => JSON.stringify(x);
const listingMark = `"p50": ${j(bps.p50)}`;
const excerptBefore = [
	"{",
	`  "id": ${j(firstSeries.id)},`,
	`  "benchmark": ${j(firstSeries.benchmark)},`,
	`  "instance_type": ${j(firstSeries.instance_type)},`,
	`  "derivations": { "series_v1": {`,
	`    "method": ${j(v1.method).replace(/,/g, ", ").replace(/:/g, ": ")},`,
	`    "percentiles": { "bytes_per_second": {`,
	`      "count": ${j(bps.count)}, "p5": ${j(bps.p5)},`,
	"      ",
].join("\n");
const excerptAfter = [`, "p95": ${j(bps.p95)}`, "  … } } } }"].join("\n");

/** AWS's processor name without its trailing word "Processor". Instance storage is left out: Table 1 measures the EBS root volume. */
const processor = (name: string) => name.replace(/ Processor$/, "");

// The references: the API's files and the documentation, in the order the page cites them.
const REFS = [
	{ n: 1, file: "v1/index.json", url: links.index, what: "Contents; start here", schema: schema("index").url },
	{ n: 2, file: "v1/series.json", url: links.seriesList, what: "Every Series: figures, Methods", schema: schema("series-list").url },
	{ n: 3, file: "v1/series/<id>.json", url: firstCell.url, what: "One Series: each Run, its evidence", schema: schema("series").url },
	{ n: 4, file: priceFileName, url: links.prices, what: "AWS On-Demand prices", schema: schema("prices").url },
	{ n: 5, file: short(links.docs), url: links.docs, what: "Methods, benchmarks", schema: "" },
] as const;
function Cite(props: { n: number }) {
	return (
		<a class="cite" href={`#ref-${props.n}`} aria-label={`reference ${props.n}`}>
			[{props.n}]
		</a>
	);
}

// ---------------------------------------------------------------- the page

export default function Page() {
	return (
		<>
			<header class="runninghead">
				<div class="rh-inner">
					<a class="wordmark" href="./">
						LedgerMath
					</a>
					<nav class="rh-nav" aria-label="Sections">
						<a href="#s1">Results</a>
						<a href="#refs">API</a>
						<a href={links.docs}>Docs</a>
					</nav>
				</div>
			</header>

			<main id="paper">
				<article>
					<div class="front">
						<h1>
							<span class="h1-name">LedgerMath:</span> {snapshot.benchmarkCount} benchmarks on {snapshot.machineCount} AWS machine types, measured 4&nbsp;times a&nbsp;day
						</h1>
						<p class="affil">
							Amazon EC2 {snapshot.region} · boots 04:10, 10:10, 16:10, 22:10&nbsp;UTC
						</p>
						<dl class="dates">
							<div>
								<dt>First Run</dt>
								<dd>
									<time datetime={oldest.iso} title={oldest.full}>
										{oldest.date} {oldest.minute}
									</time>
								</dd>
							</div>
							<div>
								<dt>Latest Run</dt>
								<dd>
									<a href={links.index} title={newest.full}>
										<time datetime={newest.iso}>
											{newest.date} {newest.minute}
										</time>
									</a>
								</dd>
							</div>
							<div>
								<dt>Prices copied</dt>
								<dd>
									<a href={links.prices} title={fetched.full}>
										<time datetime={snapshot.pricesFetchedAt}>
											{fetched.date} {fetched.minute}
										</time>
									</a>
								</dd>
							</div>
							<div>
								<dt>Runs</dt>
								<dd>
									<a href={links.seriesList}>
										{runs.full}, {failed.full} failed
									</a>
								</dd>
							</div>
						</dl>
					</div>

					<div class="opening">
						<section class="abstract" aria-labelledby="abstract">
							<p>
								<span class="runin" id="abstract" role="heading" aria-level={2}>
									Abstract
								</span>
								Every figure is served as JSON with its Runs, evidence and Method <Cite n={5} />, so an AI agent can choose infrastructure from measured numbers.
							</p>
						</section>

						<aside class="availability" aria-label="The API's index">
							<pre class="code" data-copy={`curl ${links.index}`}>
								<code>
									<span class="prompt">$ </span>curl {links.index}
								</code>
							</pre>
							<span class="copy-slot" />
						</aside>
					</div>

					{/* ---------------------------------------------------- Table 1, with the machines in its head */}
					<section class="sec results" aria-labelledby="s1">
						<h2 id="s1" class="t-title">
							<span class="tlabel">Table 1.</span> Median of counted Runs <Cite n={2} />
						</h2>
						<details class="fold s1-details" id="sA">
							<summary>p5, p95 and Run count</summary>
							<div class="table-wrap s1-wrap" role="region" aria-label="p5, p50, p95 and n per figure" tabindex="0">
								<table class="s1">
									<thead>
										<tr>
											<th scope="col" class="s1-b">
												<span class="vh">Benchmark</span>
											</th>
											{machines.map((m) => (
												<th scope="col" class="s1-m">
													{m.instanceType}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{rows.map((r) => (
											<tr>
												<th scope="row" class="s1-b">
													{r.row.choice.label}
													<span class="s1-unit">{r.unitLong}</span>
												</th>
												{r.cells.map((c) => (
													<td class="s1-c">
														<span class="s1-x">{si(c.p5.full)}</span>
														<a class="s1-x s1-mid" href={c.url}>
															{si(c.p50.full)}
														</a>
														<span class="s1-x">{si(c.p95.full)}</span>
														<span class="s1-n">
															<i>n</i> {c.n}
														</span>
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</details>

						<div class="table-wrap t1-wrap" role="region" aria-label="Table 1" tabindex="0">
							<table class="t1" aria-labelledby="s1">
								<thead>
									<tr>
										<th scope="col" class="c-op stub">
											<span class="key-item key-price">$/h, Linux On-Demand</span>
											<span class="key-item">
												<span class="bar key-bar" aria-hidden="true">
													<span class="bar-to" style="width:62%" />
													<span class="bar-range" style="left:50%;width:24%" />
													<span class="bar-tick" style="left:62%" />
												</span>
												<span>median, p5–p95; each row from 0</span>
											</span>
											<span class="key-item">
												<span class="dir">↑↓</span> higher/lower is faster
											</span>
										</th>
										{machines.map((m) => (
											<th scope="col" class="c-m">
												<span class="m-name">{m.instanceType}</span>
												<a class="m-price" href={links.prices} title={`${m.price.description} · ${m.price.path.pointer}`}>
													${formatUsd(m.price.usdPerHour).full}/h
												</a>
												<span class="m-spec">
													{m.vcpu} vCPU · {m.memory}
												</span>
												<span class="m-proc">{processor(m.processor)}</span>
											</th>
										))}
									</tr>
								</thead>
								{bySection.map((s) => (
									<tbody>
										<tr class="group">
											<th scope="colgroup" colspan={1 + machines.length}>
												{s.section}
												{GROUP_NOTE[s.section] ? <span class="group-note"> · {GROUP_NOTE[s.section]}</span> : ""}
											</th>
										</tr>
										{s.rows.map((r) => (
											<tr id={`t1-${r.row.choice.benchmark}`}>
												<th scope="row" class="c-op">
													<a class="op-label" href={r.row.choice.readme}>
														{r.row.choice.label}
													</a>
													<span class="op-unit">
														{r.unitLong} <Arrow dir={r.dir} />
													</span>
												</th>
												{r.cells.map((c) => (
													<td class="c-fig">
														<span class="c-mlab">{c.machine}</span>
														<a href={c.url} title={`p5 ${si(c.p5.full)} · p95 ${si(c.p95.full)} ${r.unitLong} · n ${c.n} · Series ${c.id}`}>
															<Exact full={c.p50.full} />
														</a>
														<Bar c={c} max={r.max} />
													</td>
												))}
											</tr>
										))}
									</tbody>
								))}
							</table>
						</div>
					</section>

					{/* ---------------------------------------------------- references: the API */}
					<section class="sec refs" aria-labelledby="refs">
						<h2 id="refs">References</h2>
						<ol class="reflist">
							{REFS.map((r) => (
								<li id={`ref-${r.n}`}>
									<span class="ref-n">[{r.n}]</span>
									<a class="ref-file" href={r.url}>
										{r.file}
									</a>
									<span class="ref-what">{r.what}</span>
									{r.schema ? (
										<a class="ref-schema" href={r.schema}>
											schema
										</a>
									) : (
										<span class="ref-schema" />
									)}
								</li>
							))}
						</ol>
						<details class="fold listing">
							<summary>
								<span class="tlabel">Listing 1.</span> Example JSON from [2]
							</summary>
							<pre class="code json" tabindex="0" aria-label="Listing 1">
								<code>
									{excerptBefore}
									<mark>{listingMark}</mark>
									{excerptAfter}
								</code>
							</pre>
						</details>
					</section>
				</article>
			</main>

			<footer class="colophon">
				<p>
					<span class="wordmark-sm">LedgerMath</span> · snapshot of {newest.longDate} · Method series v{series1.version} ·{" "}
					<a href={links.docs}>Docs</a> · <a href="third-party-notices.txt">Font licences</a>
				</p>
			</footer>
		</>
	);
}
