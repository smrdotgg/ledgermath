// Design v3, "Paper": LedgerMath's home page set as a data report in a scientific journal.
// Every figure comes from ../../data exactly as the snapshot holds it, and every figure is shown
// with every digit: Table 1 sets the whole part and the first three decimals in full weight and
// the rest in light type, so the table scans without a digit dropped. Table S1 gives the spread.
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

type Cell = { p5: Shown; p50: Shown; p95: Shown; n: number; url: string; id: string; machine: string; price: string; draw: { p5: number; p50: number; p95: number } };
type Row = { row: HeadlineRow; unit: string; unitLong: string; dir: "up" | "down"; cells: Cell[]; per?: string; letter: string; max: number };

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
		price: formatUsd(cell.machine.price.usdPerHour).full,
		draw: { p5: f.p5, p50: f.p50, p95: f.p95 },
	}));
	return {
		row,
		unit,
		unitLong: per ? `${unit} per ${per.of}` : unit,
		dir: row.choice.lead === "rate" ? "up" : "down",
		per: per?.of,
		letter: LETTERS[index]!,
		// The row's one scale: zero to its largest p95 (the snapshot's own numbers, for drawing only).
		max: Math.max(...cells.map((c) => c.draw.p95)),
		cells,
	};
});

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
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
/** Width in `ch` of a run of digits and thin spaces (a word space, generously, is 0.8 of a digit in STIX Two). */
const chOf = (text: string) => [...text].reduce((w, c) => w + (c === " " ? 0.8 : 1), 0);
const parts = rows.flatMap((r) => r.cells.map((c) => split(c.p50.full)));
/** One width for the whole part and one for the tail across Table 1, so every decimal point lines up down a column. */
const INT_CH = Math.max(...parts.map((p) => chOf(p.int)));
const TAIL_CH = Math.max(...parts.map((p) => chOf(p.tail)));

/** An exact figure, its decimal point in the same place in every cell: full weight to the third decimal, light after. */
function Exact(props: { full: string }) {
	const p = split(props.full);
	return (
		<span class="x">
			<span class="x-int" style={`width:${INT_CH}ch`}>
				{p.int}
			</span>
			<span class="x-head">{p.head}</span>
			<span class="x-tail" style={`width:${TAIL_CH}ch`}>
				{p.tail ? ` ${p.tail}` : ""}
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
const firstSeries = first.row.cells[0]!.series;

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
const listing = compact(firstSeries);
// The figure Table 1 shows, marked where it stands in the listing: bytes_per_second's p50.
const v1 = firstSeries.derivations.series_v1;
const bps = v1.percentiles.bytes_per_second!;
const listingMark = `"p50": ${JSON.stringify(bps.p50)}`;
const listingAt = listing.lastIndexOf(listingMark);
if (listingAt < 0) throw new Error("Listing 1 does not hold the figure it marks");
// Its excerpt: the lines that lead from the Series to that figure, every value as the file holds it.
const j = (x: unknown) => JSON.stringify(x);
const excerptBefore = [
	"{",
	`  "id": ${j(firstSeries.id)},`,
	`  "benchmark": ${j(firstSeries.benchmark)},`,
	`  "instance_type": ${j(firstSeries.instance_type)},`,
	"  …",
	`  "derivations": {`,
	`    "series_v1": {`,
	`      "method": ${compact(v1.method)},`,
	`      "counted_runs": ${j(v1.counted_runs)},`,
	"      …",
	`      "percentiles": {`,
	"        …",
	`        "bytes_per_second": {`,
	`          "count": ${j(bps.count)},`,
	`          "p5": ${j(bps.p5)},`,
	"          ",
].join("\n");
const excerptAfter = ["", `          "p95": ${j(bps.p95)}`, "        }", "      }", "    }", "  }", "}"].join("\n");

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

/** A passage that is open everywhere, and folded on a phone by client.ts (open without it). */
function Fold(props: { label: string; children: unknown }) {
	return (
		<details class="fold" open data-fold-on-phone>
			<summary>{props.label}</summary>
			{props.children}
		</details>
	);
}

function Mark(props: { href: string; label: string; children: string }) {
	return (
		<sup class="tn">
			<a href={props.href} aria-label={props.label}>
				{props.children}
			</a>
		</sup>
	);
}

// ---------------------------------------------------------------- the page

export default function Page() {
	const mutex = rows.find((r) => r.per)!;
	const mutexRow = mutex.row.cells[0]!;
	const mutexLead = leadFigure(mutex.row.choice, mutexRow.series);
	const iops = rows.find((r) => r.row.choice.section === "Disk" && r.row.choice.reason?.includes("IOPS"));
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
					<nav class="rh-nav" aria-label="Sections">
						<a href="#s1">Results</a>
						<a href="#s2">Machines</a>
						<a href="#s3">API</a>
						<a href="#s4">Methods</a>
						<a href={links.docs}>Docs</a>
					</nav>
					<span class="rh-date">
						Snapshot of <time datetime={newest.date}>{newest.longDate}</time>
					</span>
				</div>
			</header>

			<main id="paper">
				<article>
					<div class="front">
						<h1>
							<span class="h1-name">LedgerMath:</span> fourteen benchmarks on five AWS machine types, measured four&nbsp;times a&nbsp;day
						</h1>
						<p class="deck">
							Measured numbers for deciding on infrastructure, each with its source: a JSON data API for AI agents and the developers who build them.
						</p>
					</div>

					<div class="front-meta">
						<p class="authors">
							{machines.map((m, i) => (
								<>
									{i > 0 ? <span class="sep"> · </span> : ""}
									<span class="author">{m.instanceType}</span>
								</>
							))}
						</p>
						<p class="affil">
							Amazon EC2, {snapshot.region} (zone ID {zones.join(", ")}) · booted at 04:10, 10:10, 16:10 and 22:10 UTC · each boot runs all {snapshot.benchmarkCount}{" "}
							benchmarks
						</p>
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
							<p>
								<span class="runin" id="abstract" role="heading" aria-level={2}>
									Abstract
								</span>
								LedgerMath boots five AWS machine types in {snapshot.region} four times a day, runs {snapshot.benchmarkCount} benchmarks on each freshly booted machine, keeps
								every Run with its evidence and derives its figures by published Methods. For example, <span class="mono">{firstCell.machine}</span> reads memory
								sequentially at a median of{" "}
								<strong>
									<a href={firstCell.url}>{si(firstCell.p50.full)}&nbsp;GB/s</a>
								</strong>{" "}
								over {firstCell.n} counted Runs (Table 1, row a; Series <span class="mono">{firstCell.id}</span>).
							</p>
						</section>

						<aside class="availability" aria-labelledby="availability">
							<h2 id="availability">Data availability</h2>
							<p>
								<strong>For agents and developers:</strong> every figure here is in a JSON file, with its Method and its Runs <Cite n={REF.index} />. Start at the index:
							</p>
							<pre class="code" data-copy={`curl ${links.index}`}>
								<code>
									<span class="prompt">$ </span>curl <Breakable url={links.index} />
								</code>
							</pre>
							<p class="files">
								<a href={links.seriesList} title={`all ${seriesCount.full} Series and their Methods`}>
									series.json
								</a>{" "}
								· <a href={links.prices} title="AWS's prices, as copied">{priceFileName.replace("v1/", "")}</a> · <a href="#s3">every address, §3</a>
							</p>
						</aside>
					</div>

					{/* ---------------------------------------------------- 1 */}
					<section class="sec results" aria-labelledby="s1">
						<h2 id="s1">
							<span class="num">1</span>Results
						</h2>

						<nav class="jump" aria-label="Benchmarks in Table 1">
							<ul>
								{bySection.map((s) => (
									<li>
										<span class="jump-s">{s.section}</span>
										{s.rows.map((r) => (
											<a href={`#t1-${r.letter}`}>
												<i>{r.letter}</i> {r.row.choice.label}
											</a>
										))}
									</li>
								))}
							</ul>
						</nav>

						<div class="table-wrap wide t1-wrap" role="region" aria-labelledby="t1-cap" tabindex="0">
							<table class="t1">
								<caption id="t1-cap">
									<span class="tlabel">Table 1.</span> The median (p50) of each Series' counted Runs, one Series per cell, chosen by a written rule. <em>Every digit is shown</em>
									, three decimals in full weight. Under each, drawn to one scale per row from zero: a line to the median, the 5th to 95th percentile over it
									(hidden by the median's tick where it is narrower), and <i>n</i>, the count of Runs. Each figure links to its Series file{" "}
									<Cite n={REF.series} />; the spread is in <a href="#sA">Table S1</a>. <Arrow dir="up" /> a rate (1 GB/s is 10<sup>9</sup> B/s), higher is faster;{" "}
									<Arrow dir="down" /> the time of one repetition, lower is faster.
								</caption>
								<thead>
									<tr>
										<th scope="col" class="c-op">
											Benchmark
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
											<th scope="colgroup" colspan={1 + machines.length}>
												{s.section}
												{s.section === "Disk" ? (
													<span class="group-note">
														{" "}
														· the root volume, an EBS gp3 volume of the same kind on every machine type, not storage of the machine's own
														<Mark href="#tn-b" label="table note b">
															b
														</Mark>
													</span>
												) : (
													""
												)}
												{s.section === "Network" ? (
													<span class="group-note">
														{" "}
														· to S3 in the same Region, on a connection already open
														<Mark href="#tn-c" label="table note c">
															c
														</Mark>
													</span>
												) : (
													""
												)}
											</th>
										</tr>
										{s.rows.map((r) => (
											<tr id={`t1-${r.letter}`}>
												<th scope="row" class="c-op">
													<span class="op-label">
														<span class="op-letter">{r.letter}</span>
														{r.row.choice.label}
														{r.per ? (
															<Mark href="#tn-a" label="table note a">
																a
															</Mark>
														) : (
															""
														)}
														<span class="op-unit">
															{r.unitLong} <Arrow dir={r.dir} />
														</span>
													</span>
													<span class="op-what">
														{r.row.choice.per
															? `One ${r.row.choice.per.of}; a repetition is ${r.row.choice.repetition.charAt(0).toLowerCase()}${r.row.choice.repetition.slice(1)}`
															: r.row.choice.repetition}
													</span>
												</th>
												{r.cells.map((c) => (
													<td class="c-fig" data-m={c.machine} data-price={`$${c.price}/h`}>
														<a href={c.url} aria-describedby={`x-${r.letter}-${c.id}`}>
															<Exact full={c.p50.full} />
														</a>
														<span class="foot">
															<Bar c={c} max={r.max} />
															<span class="n">
																<i>n</i>&thinsp;{c.n}
															</span>
														</span>
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
								<span class="tn-mark">a</span> One repetition of mutex is {mutex.row.choice.per!.count.toLocaleString("en-US")} critical sections; row h gives one, by moving the
								decimal point four places. On {mutexRow.machine.instanceType} the median repetition is <span class="nw">{si(formatDuration(mutexLead.p50, { unit: "µs" }).full)} µs</span>, so one
								critical section is <span class="nw">{si(mutex.cells[0]!.p50.full)} ns</span>.
							</li>
							<li id="tn-b">
								<span class="tn-mark">b</span> The four disk benchmarks (rows j–m) measure each machine's root volume, not the storage a machine type has of its own;
								i4i.2xlarge's instance store is measured too, in Series of its own.
								{iops ? (
									<>
										{" "}
										In the headline rule's words, “{iops.row.choice.reason!.split(";")[0]}”; its throughput limit is what row j shows.
									</>
								) : (
									""
								)}
							</li>
							<li id="tn-c">
								<span class="tn-mark">c</span> Each request's phases are summarised separately by Method <span class="sc">requests</span> v{requests1?.version ?? 1}{" "}
								<Cite n={REF.method} />.
							</li>
						</ol>
					</section>

					{/* ---------------------------------------------------- 2 */}
					<section class="sec" aria-labelledby="s2">
						<h2 id="s2">
							<span class="num">2</span>Machines and prices
						</h2>
						<p class="lede">
							The five machine types in order of hourly price, with the On-Demand price for Linux in {snapshot.region} from the price file of{" "}
							{formatMoment(`${snapshot.priceDate}T00:00:00Z`).longDate} <Cite n={REF.prices} />. Each price is printed as the file gives it, and the file words each one the
							same way: “{machines[0]!.price.description}”.
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
											<td class="num-col price" title={m.price.description}>
												{formatUsd(m.price.usdPerHour).full}
											</td>
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
									use, and a source to give for it. Each Series' own file holds each Run's figure and a link to its evidence. The documentation is at{" "}
									<a href={links.docs}>{short(links.docs)}</a> <Cite n={REF.docs} />.
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
								<a href={links.seriesList}>v1/series.json</a> lists it, cut to the path from the Series to the figure (… marks what is left out). The figure is{" "}
								<code>bytes_per_second.p50</code> under Method <span class="sc">series</span> v{series1.version}, in bytes a second: Table 1 moves its decimal point nine
								places.
							</figcaption>
							<pre class="code json excerpt" tabindex="0" aria-label="Listing 1, the excerpt">
								<code>
									{excerptBefore}
									<mark>{listingMark}</mark>,<span class="c">{`  ← ${si(firstCell.p50.full)} GB/s`}</span>
									{excerptAfter}
								</code>
							</pre>
							<details class="whole">
								<summary>The whole entry, every field as series.json holds it</summary>
								<pre class="code json" tabindex="0" aria-label="Listing 1, the whole entry">
									<code>
										{listing.slice(0, listingAt)}
										<mark>{listingMark}</mark>
										{listing.slice(listingAt + listingMark.length)}
									</code>
								</pre>
							</details>
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
									and the {snapshot.benchmarkCount} benchmarks run on it, one Run after another, so each Run starts some time after its boot; every Run records its own start.
									The Runs in this snapshot started between {oldest.longDate} and {newest.longDate}
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
									The API states: “{snapshot.figures.split(":")[0]}.” This page shows every digit of every figure and changes only units, by moving the decimal point
									<Note n={2} />; Table 1 sets the digits after the third decimal lighter, and drops none. On versions: “{snapshot.versioning.split(". ")[0]}.”
								</p>
							</div>
							<div class="sub">
								<h3 id="s44">
									<span class="num">4.4</span>Figures
								</h3>
								<p>
									The figures are Method <span class="sc">series</span> v{series1.version}'s. For each Run it takes the time of one repetition, the median over the Run's
									counted samples (warmup samples left out); where the benchmark observes the bytes one repetition moves, a rate; and across the counted Runs of a Series,
									the 5th, 50th and 95th percentiles of each.
								</p>
								<Fold label="Equations (1)–(3)">
									<p>In symbols, the time of one repetition is</p>
									<div class="eq" role="math" aria-label="t equals the sample's end minus its start, divided by its repetitions">
										<span class="eq-body">
											<i>t</i> = (<i>t</i>
											<sub>end</sub> − <i>t</i>
											<sub>start</sub>) / <i>r</i>
										</span>
										<span class="eq-n">(1)</span>
									</div>
									<p>for a sample of <i>r</i> repetitions, and, where one repetition moves <i>B</i> bytes, a rate in bytes a second of</p>
									<div class="eq" role="math" aria-label="rate equals B times ten to the ninth, divided by t in nanoseconds">
										<span class="eq-body">
											<i>R</i> = <i>B</i> × 10<sup>9</sup> / <i>t</i>
											<sub>ns</sub>
										</span>
										<span class="eq-n">(2)</span>
									</div>
									<p>
										The percentiles are taken by linear interpolation between closest ranks: with the <i>n</i> values sorted, <i>x</i>
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
										<Note n={3} />.
										{requests1 ? (
											<>
												{" "}
												The GET from S3 is also summarised request by request, by Method <span class="sc">requests</span> v{requests1.version} <Cite n={REF.method} />.
											</>
										) : (
											""
										)}
									</p>
								</Fold>
							</div>
						</div>
						<div class="sub counted">
							<h3 id="s45">
								<span class="num">4.5</span>Which Runs count
							</h3>
							<p class="counted-sum">
								A Run counts when its binary exited 0 and its output obeys the events schema and its order rules, with every sample it asked for; any other Run is failed, kept and shown with its reasons, and in
								no percentile. The rule in full:
							</p>
							<Fold label="The rule, word for word">
								<blockquote class="defn">
									<p>“{series1.definitions.counted}”</p>
									<footer>
										Method <span class="sc">series</span> v{series1.version}, definition of <i>counted</i> <Cite n={REF.method} />
									</footer>
								</blockquote>
							</Fold>
						</div>
					</section>

					{/* ---------------------------------------------------- notes, references */}
					<section class="sec notes" aria-labelledby="notes">
						<h2 id="notes">Notes</h2>
						<Fold label="Notes 1–3">
							<ol>
								<li id="fn-1">
									The oldest Run started at {oldest.full}, the newest at {newest.full}; AWS's prices were copied at {fetched.full}. Moments are in UTC, to the nanosecond, as
									each Run records them; the front page gives them to the minute. <a href="#fnref-1" aria-label="back to note 1">↩</a>
								</li>
								<li id="fn-2">
									Nanoseconds to µs or ms and bytes a second to MB/s or GB/s; and, for mutex, one repetition to one of its 10,000 critical sections, by moving the point four
									places. No figure is rounded, averaged or combined across machines. The bars in Table 1 draw each median and its 5th to 95th percentile to one scale per row; machines are listed in
									order of hourly price, which is not a finding about them. <a href="#fnref-2" aria-label="back to note 2">↩</a>
								</li>
								<li id="fn-3">
									So the median rate in Table 1 is not 1 divided by the median time. Method <span class="sc">series</span> v{series1.version}, definition of{" "}
									<i>percentiles</i> <Cite n={REF.method} />. <a href="#fnref-3" aria-label="back to note 3">↩</a>
								</li>
							</ol>
						</Fold>
					</section>

					<section class="sec refs" aria-labelledby="refs">
						<h2 id="refs">References</h2>
						<Fold label="References [1]–[6]">
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
						</Fold>
					</section>

					{/* ---------------------------------------------------- appendix */}
					<section class="sec appendix" aria-labelledby="sA">
						<h2 id="sA">
							<span class="num">A</span>Supplementary data
						</h2>
						<details class="s1-details" open data-fold-on-phone>
							<summary>
								<span class="tlabel">Table S1.</span> The spread of the {rows.length * machines.length} headline Series: their 5th, 50th and 95th percentiles, exactly as the
								snapshot holds them, in the units of Table 1, and the number of counted Runs (<i>n</i>). Digits are grouped in threes; nothing is rounded. The last column
								names each Series' file in the API.
							</summary>
							<div class="table-wrap s1-wrap" role="region" aria-label="Table S1, the spread" tabindex="0">
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
					benchmarks, {snapshot.machineCount} machine types · <a href={links.docs}>Documentation</a> · Set in STIX Two Text and IBM Plex Mono (
					<a href="third-party-notices.txt">licences</a>)
				</p>
			</footer>
		</>
	);
}
