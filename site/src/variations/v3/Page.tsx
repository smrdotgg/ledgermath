// Design v3, "Paper": LedgerMath's home page as a one-page data report, a research letter.
// Form "under-10": at most nine words a visitor reads. The paper keeps its title, its dateline,
// the way in, and Table 1 whole (every digit, a p5–p95 bar per cell, each machine and its hourly
// price over its column). What each row measures waits behind a tap on its number; a machine's
// vCPU, memory and processor behind a tap on its name.
// Every figure comes from ../../data exactly as the snapshot holds it; nothing is rounded, ranked or computed.
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
	type Machine,
	type Section,
	type Shown,
} from "../../data";

// ---------------------------------------------------------------- figures of one row

type Cell = { p5: Shown; p50: Shown; p95: Shown; n: number; url: string; id: string; machine: Machine; draw: { p5: number; p50: number; p95: number } };
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
		machine: cell.machine,
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
const bySection = SECTIONS.map((section) => ({ section, rows: rows.filter((r) => r.row.choice.section === section) }));
/** Each row's number in Table 1, counted down the table across its groups. */
const number = new Map(rows.map((r, i) => [r, i + 1]));

/** A narrow no-break space: SI's thin gap between groups of three, so a group never stands apart from its run. */
const NNBSP = " ";
/** Digits in groups of three with thin spaces, both sides of the point (SI style). No digit changes. */
const si = (decimal: string) => group(decimal, NNBSP, NNBSP);

/** An exact figure in three parts: its whole part (in groups of three), its point and first three decimals, and every
 *  further digit in one run, so the unit that ends it never stands beside a short group of its own. */
function split(full: string) {
	const dot = full.indexOf(".");
	if (dot < 0) return { int: si(full), head: "", tail: "" };
	return { int: si(full.slice(0, dot)), head: full.slice(dot, dot + 4), tail: full.slice(dot + 4) };
}
/** Width in `ch` of a run of digits and thin spaces (generous for the space, so a box never overflows and the points stay in line). */
const chOf = (text: string) => [...text].reduce((w, c) => w + (c === NNBSP ? 0.5 : 1), 0);
const parts = rows.flatMap((r) => r.cells.map((c) => ({ ...split(c.p50.full), unit: r.unit })));
/** One width for the whole part and one for the tail (its unit included) across Table 1, so every decimal point lines up down a column. */
const INT_CH = Math.max(...parts.map((p) => chOf(p.int)));
// A unit's letters are wider than a digit: 1.5ch more, so the longest tail stays inside its box.
const TAIL_CH = Math.max(...parts.map((p) => chOf(p.tail) + p.unit.length)) + 1.5;

/** An exact figure, its decimal point in the same place in every cell: full weight to the third decimal, lighter after,
 *  and its unit set tight against its last digit, part of the figure. */
function Exact(props: { full: string; unit: string }) {
	const p = split(props.full);
	// The unit goes on whichever part ends the figure, in the same text as its last digit.
	if (p.tail) p.tail += props.unit;
	else if (p.head) p.head += props.unit;
	else p.int += props.unit;
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

/** The key's drawing: one bar, as a cell draws it. */
function KeyBar() {
	return (
		<span class="bar key-bar" aria-hidden="true">
			<span class="bar-to" style="width:62%" />
			<span class="bar-range" style="left:50%;width:24%" />
			<span class="bar-tick" style="left:62%" />
		</span>
	);
}

// ---------------------------------------------------------------- facts of the snapshot

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const fetched = formatMoment(snapshot.pricesFetchedAt);
const runs = formatCount(snapshot.runCount);
const price = (m: Machine) => `$${formatUsd(m.price.usdPerHour).full}/h`;

// ---------------------------------------------------------------- the page

export default function Page() {
	return (
		<>
			<main id="paper">
				<article>
					<header class="front">
						<div class="front-title">
							<h1>LedgerMath</h1>
							<p class="dateline">
								<time datetime={oldest.iso} title={`First Run, ${oldest.full}`}>
									{oldest.date} {oldest.minute}
								</time>
								<span class="dash">–</span>
								<a href={links.index} title={`Latest Run, ${newest.full}`}>
									<time datetime={newest.iso}>
										{newest.date} {newest.minute}
									</time>
								</a>
								<span class="sep">·</span>
								<a href={links.seriesList}>{runs.full} Runs</a>
							</p>
						</div>
						<div class="availability" aria-label="The API's index" role="group">
							<pre class="code" data-copy={`curl ${links.index}`}>
								<code>
									<span class="prompt">$ </span>curl {links.index}
								</code>
							</pre>
							<span class="copy-slot" />
						</div>
					</header>

					{/* ---------------------------------------------------- Table 1, nothing but its figures at rest */}
					<section class="results">
						<div class="table-wrap t1-wrap" role="region" aria-label="Table 1" tabindex="0">
							<table class="t1">
								<thead>
									<tr>
										<th scope="col" class="c-op stub">
											<details class="tip tip-key">
												<summary aria-label="Key">
													<KeyBar />
													<span class="dir" aria-hidden="true">
														↑↓
													</span>
												</summary>
												<span class="tip-body">
													<span>
														<KeyBar /> median, p5–p95; one scale per benchmark, from 0
													</span>
													<span>
														<span class="dir">↑</span> higher is faster · <span class="dir">↓</span> lower is faster
													</span>
													<span>
														$/h, Linux On-Demand, {machines[0]!.region} ·{" "}
														<a href={links.prices} title={fetched.full}>
															{fetched.date}
														</a>
													</span>
												</span>
											</details>
										</th>
										{machines.map((m) => (
											<th scope="col" class="c-m">
												<details class="tip">
													<summary title={m.price.description}>
														<span class="m-name">{m.instanceType}</span>
														<span class="m-price">{price(m)}</span>
													</summary>
													<span class="tip-body">
														<span class="m-spec">
															{m.vcpu} vCPU · {m.memory}
														</span>
														<span class="m-proc">{m.processor}</span>
													</span>
												</details>
											</th>
										))}
									</tr>
								</thead>
								{bySection.map((s) => (
									<tbody class="sect">
										{s.rows.map((r) => (
											<tr id={`t1-${r.row.choice.benchmark}`}>
												<th scope="row" class="c-op">
													<details class="tip">
														<summary aria-label={`${number.get(r)} ${r.row.choice.label}`}>
															<span class="rn">{number.get(r)}</span>
															<span class="dir" aria-hidden="true">
																{r.dir === "up" ? "↑" : "↓"}
															</span>
														</summary>
														<span class="tip-body">
															<a class="op-label" href={r.row.choice.readme}>
																{r.row.choice.label}
															</a>
															<span class="op-unit">{r.unitLong}</span>
														</span>
													</details>
												</th>
												{r.cells.map((c) => (
													<td class="c-fig">
														<span class="c-mlab">{price(c.machine)}</span>
														<a href={c.url} title={`${c.machine.instanceType} · ${r.row.choice.label} · p5 ${si(c.p5.full)} · p95 ${si(c.p95.full)} ${r.unitLong} · ${c.n} Runs · Series ${c.id}`}>
															<Exact full={c.p50.full} unit={r.unit} />
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
					<a class="mark" href="third-party-notices.txt" aria-label="Font licences" title="Font licences">
						©
					</a>
				</p>
			</footer>
		</>
	);
}
