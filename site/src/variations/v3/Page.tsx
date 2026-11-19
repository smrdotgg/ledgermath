// Design v3, "Paper", spare form: LedgerMath's home page as the front page of a data report and
// nothing else. A title, the machines as authors (each with its size and price), one line of
// dates with their sources, the way in, and Table 1: every digit, a p5–p95 bar per cell. The rest
// is behind a link. Every figure comes from ../../data exactly as the snapshot holds it; nothing is
// rounded, ranked or computed.
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
type Row = { row: HeadlineRow; unit: string; unitLong: string; dir: "up" | "down"; cells: Cell[]; letter: string; max: number };

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"] as const;
function rateUnit(bytesPerSecond: number) {
	const i = Math.min(4, Math.max(0, Math.floor(Math.log10(Math.abs(bytesPerSecond)) / 3)));
	return BYTE_UNITS[i]!;
}

const LETTERS = "abcdefghijklmn";

// One unit per row, so a row reads across: the unit in which the row's smallest median is at least 1.
// Every figure is exact (`full`); no `significant` is asked for anywhere on this page.
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
		letter: LETTERS[index]!,
		// The row's one scale: zero to its largest p95 (the snapshot's own numbers, for drawing only).
		max: Math.max(...cells.map((c) => c.draw.p95)),
		cells,
	};
});

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
// A label, never a sentence: where the two groups that are not the machine itself are measured.
const GROUP_NOTE: Partial<Record<Section, string>> = { Disk: "root volume, EBS gp3", Network: "S3, same Region" };
const bySection = SECTIONS.map((section) => ({ section, rows: rows.filter((r) => r.row.choice.section === section) }));

/** Digits in groups of three with spaces, both sides of the point (SI style). No digit changes. */
const si = (decimal: string) => group(decimal, " ", " ");

/** An exact figure in three parts: its whole part, its point and first three decimals, and every further digit. */
function split(full: string) {
	const g = si(full);
	const dot = g.indexOf(".");
	if (dot < 0) return { int: g, head: "", tail: "" };
	return { int: g.slice(0, dot), head: g.slice(dot, dot + 4), tail: g.slice(dot + 4).replace(/^ /, "") };
}
/** Width in `ch` of a run of digits and spaces (a word space is about 0.8 of a digit in STIX Two). */
const chOf = (text: string) => [...text].reduce((w, c) => w + (c === " " ? 0.8 : 1), 0);
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
const fetched = formatMoment(snapshot.pricesFetchedAt);
const counted = formatCount(snapshot.countedRuns);

/** An address with a place to break after "/v1/", so it wraps where it reads. */
function Breakable(props: { url: string }) {
	const p = props.url.split(/(?<=\/v1\/)/);
	return (
		<>
			{p.map((s, i) => (
				<>
					{i > 0 ? <wbr /> : ""}
					{s}
				</>
			))}
		</>
	);
}

// ---------------------------------------------------------------- the page

export default function Page() {
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
					<nav class="rh-nav" aria-label="Elsewhere">
						<a href={links.index}>API</a>
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
						<ul class="authors" aria-label={`Machines: size and On-Demand price in ${snapshot.region}`}>
							{machines.map((m) => (
								<li class="author">
									<span class="a-name">{m.instanceType}</span>
									<span class="a-aff">
										{m.vcpu} vCPU · {m.memory} ·{" "}
										<a href={links.prices} title={`${m.price.description} · ${m.price.path.pointer}`}>
											${formatUsd(m.price.usdPerHour).full}/h
										</a>
									</span>
								</li>
							))}
						</ul>
						<p class="dates">
							<span>
								Latest Run{" "}
								<a href={links.seriesList} title={newest.full}>
									<time datetime={newest.iso}>
										{newest.date} {newest.minute}
									</time>
								</a>
							</span>
							<span>
								<a href={links.seriesList}>{counted.full}</a> Runs kept
							</span>
							<span>
								AWS prices{" "}
								<a href={links.prices} title={fetched.full}>
									<time datetime={snapshot.pricesFetchedAt}>{fetched.date}</time>
								</a>
							</span>
							<span>{snapshot.region}</span>
						</p>
						<pre class="code" data-copy={`curl ${links.index}`}>
							<code>
								<span class="prompt">$ </span>curl <Breakable url={links.index} />
							</code>
						</pre>
					</div>

					<section class="sec results">
						<div class="table-wrap t1-wrap" role="region" aria-labelledby="t1-cap" tabindex="0">
							<table class="t1">
								<caption>
									<span class="cap">
										<h2 class="cap-text" id="t1-cap">
											<span class="tlabel">Table 1.</span> Median of counted Runs, every digit
										</h2>
										<span class="key" aria-hidden="true">
											<span class="key-item">
												<span class="bar key-bar">
													<span class="bar-to" style="width:62%" />
													<span class="bar-range" style="left:52%;width:22%" />
													<span class="bar-tick" style="left:62%" />
												</span>
												<span class="key-l">median, p5–p95</span>
											</span>
											<span class="key-item">
												<span class="dir">↑</span> higher is faster
											</span>
											<span class="key-item">
												<span class="dir">↓</span> lower is faster
											</span>
										</span>
									</span>
								</caption>
								<thead>
									<tr>
										<th scope="col" class="c-op">
											<span class="vh">Benchmark</span>
										</th>
										{machines.map((m) => (
											<th scope="col" class="c-m">
												<span class="m-name">{m.instanceType}</span>
												<span class="m-price">${formatUsd(m.price.usdPerHour).full}/h</span>
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
											<tr id={`t1-${r.letter}`}>
												<th scope="row" class="c-op">
													<a class="op-label" href={r.row.choice.readme}>
														{r.row.choice.label}
													</a>
													<span class="op-unit">
														{r.unitLong} <Arrow dir={r.dir} />
													</span>
												</th>
												{r.cells.map((c) => (
													<td class="c-fig" data-m={c.machine}>
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
				</article>
			</main>

			<footer class="colophon">
				<p>
					<span class="wordmark-sm">LedgerMath</span> · <a href={links.docs}>Docs</a> · <a href="third-party-notices.txt">Font licences</a>
				</p>
			</footer>
		</>
	);
}
