// Design v9, "Semere's whiteboard": Semere's own layout (a header, a headline with the latest
// rounds beside it, three graphs, the table, a footer) in the style of his site, smr.gg: Geist
// Pixel Circle, black and white with one grey, and dots. Every figure comes from ../../data as
// the snapshot holds it (see ../README.md); the only arithmetic is a change of unit, done by its
// helpers. The rounds in "Latest runs" are the one thing from elsewhere: see ./rounds.ts. The art
// beside the headline, and the flag that chooses between its two pictures: ./art.tsx.
import "./page.css";
import {
	type ByteUnit,
	type DurationUnit,
	durationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	type HeadlineRow,
	headline,
	leadFigure,
	links,
	machines,
	perUnit,
	type Section,
	type SeriesRow,
	type Shown,
	snapshot,
} from "../../data";
import { HeadlineArt } from "./art";
import { ROUNDS } from "./rounds";

// ---------------------------------------------------------------- figures

/**
 * One unit per row, so the row's figures share it: the unit the smallest figure of the row would
 * take. Where one repetition is a power-of-ten count of something smaller (mutex), the row shows
 * the time of one of those, divided exactly by formatDurationPerUnit.
 */
type Fig = (value: number) => Shown;
function rowFigure(row: HeadlineRow): Fig {
	const c = row.choice;
	const least = Math.min(...row.cells.map((cell) => leadFigure(c, cell.series).p50));
	if (c.lead === "rate") {
		const unit = formatRate(least).unit.replace("/s", "") as ByteUnit;
		return (v) => formatRate(v, { unit });
	}
	if (c.per) {
		const per = c.per;
		const unit: DurationUnit = durationUnit(Number(perUnit(least, per.count)));
		return (v) => formatDurationPerUnit(v, per, { unit });
	}
	const unit: DurationUnit = durationUnit(least);
	return (v) => formatDuration(v, { unit });
}

/** The unit a row's figures are in, with what it is a time of where that is not one repetition. */
function rowUnit(row: HeadlineRow, fig: Fig): string {
	const unit = fig(leadFigure(row.choice, row.cells[0]!.series).p50).unit;
	return row.choice.per ? `${unit} per ${row.choice.per.of}` : unit;
}

/** What a figure's `title` says: every digit of the median, the 5th and 95th percentiles, and how many Runs. */
function exact(row: HeadlineRow, series: SeriesRow, fig: Fig): string {
	const f = leadFigure(row.choice, series);
	const unit = fig(f.p50).unit;
	return `Median ${fig(f.p50).full} ${unit}. 5th percentile ${fig(f.p5).full}, 95th ${fig(f.p95).full}. ${formatCount(f.count).full} Runs.`;
}

/** A machine's hourly price, every digit the price file gives. */
const price = (usdPerHour: string) => `$${formatUsd(usdPerHour).full}/h`;

// ---------------------------------------------------------------- the three graphs

/**
 * The three benchmarks drawn above the table: of the sections where the machine types differ
 * (memory, compute, the operating system), one each. A choice of which rows to draw, made when
 * the page was designed; the figures are the table's own.
 */
const GRAPHS = ["memory_read", "hash", "syscall"] as const;

/** Dots in a full bar, and rows of dots in a bar's height. */
const TRACK = 88;
const ROWS = 3;

/** A bar of dots from zero: `share` of the track lit, the rest dim. The figure stands beside it, so the bar is hidden from readers. */
function Bar(props: { share: number }) {
	const lit = Math.min(TRACK, Math.max(1, Math.round(props.share * TRACK)));
	const rows = Array.from({ length: ROWS }, (_, r) => r + 0.5);
	return (
		<svg class="bar" viewBox={`0 0 ${TRACK} ${ROWS}`} aria-hidden="true">
			{lit < TRACK && <path class="off" d={rows.map((y) => `M${lit} ${y}h${TRACK - lit}`).join("")} />}
			<path class="on" d={rows.map((y) => `M0 ${y}h${lit}`).join("")} />
		</svg>
	);
}

function Graph(props: { row: HeadlineRow }) {
	const row = props.row;
	const fig = rowFigure(row);
	const figures = row.cells.map((cell) => leadFigure(row.choice, cell.series).p50);
	const most = Math.max(...figures);
	return (
		<section class="graph">
			<h2>{row.choice.label}</h2>
			<p class="unit">
				{rowUnit(row, fig)} · {row.choice.lead === "rate" ? "more is faster" : "less is faster"}
			</p>
			<ul>
				{row.cells.map((cell, i) => (
					<li>
						<span class="machine">
							{cell.machine.instanceType} <span class="price">{price(cell.machine.price.usdPerHour)}</span>
						</span>
						<a class="figure" href={links.seriesFile(cell.series)} title={exact(row, cell.series, fig)}>
							{fig(figures[i]!).short}
						</a>
						<Bar share={figures[i]! / most} />
					</li>
				))}
			</ul>
		</section>
	);
}

// ---------------------------------------------------------------- the latest rounds

const newest = formatMoment(snapshot.newestRunStartedAt);
if (snapshot.failedRuns !== 0) throw new Error(`the snapshot counts ${snapshot.failedRuns} failed Runs: "Latest runs" says 0 failed, so count each round's failed Runs in rounds.ts first`);
if (ROUNDS[0]!.startedAt > newest.iso) throw new Error("rounds.ts lists a round that started after the snapshot's newest Run");

/** "19 Nov 2026": the long date with its month cut to three letters. */
const shortDate = (longDate: string) => longDate.replace(/^(\d+ [A-Za-z]{3})[a-z]*/, "$1");

// ---------------------------------------------------------------- the table

const SECTIONS: Section[] = [];
for (const row of headline) if (!SECTIONS.includes(row.choice.section)) SECTIONS.push(row.choice.section);

export default function Page() {
	return (
		<>
			<header class="wrap">
				<a class="mark" href="./">
					LedgerMath
				</a>
				<nav aria-label="Site">
					<a href="#numbers">Numbers</a>
					<a href={links.docs}>Docs</a>
					<a href={links.index}>API</a>
				</nav>
			</header>

			<main class="wrap">
				<div class="hero">
					<div class="claim">
						<h1>
							<span class="line">Independent Cloud</span>
							<span class="line">
								Benchmarks
								<HeadlineArt />
							</span>
						</h1>
						<p class="sub">Open-source benchmarks, run on real cloud machines every day.</p>
					</div>

					<section class="latest" aria-labelledby="latest">
						<h2 id="latest">Latest runs</h2>
						<ol>
							{ROUNDS.map((round) => {
								const at = formatMoment(round.startedAt);
								return (
									<li>
										<time datetime={at.iso} title={at.full}>
											{shortDate(at.longDate)}, {at.minute} UTC
										</time>
										<span>
											{formatCount(round.machines).full} machines · {formatCount(round.runs).full} Runs · 0 failed
										</span>
									</li>
								);
							})}
						</ol>
					</section>
				</div>

				<div class="graphs">
					{GRAPHS.map((name) => {
						const row = headline.find((r) => r.choice.benchmark === name);
						if (!row) throw new Error(`no headline row for ${name}`);
						return <Graph row={row} />;
					})}
				</div>

				<section class="numbers" aria-labelledby="numbers">
					<h2 id="numbers">All benchmarks</h2>
					<p class="note">AWS, {snapshot.region}. Each number is a median and links to the Runs behind it.</p>
					<div class="scroll" tabindex="0" role="region" aria-label="The table of benchmarks">
						<table>
							<thead>
								<tr>
									<td />
									{machines.map((m) => (
										<th scope="col" title={`${m.vcpu} vCPU, ${m.memory}, ${m.processor}. ${m.price.description}.`}>
											{m.instanceType}
											<span class="price">{price(m.price.usdPerHour)}</span>
										</th>
									))}
								</tr>
							</thead>
							{SECTIONS.map((section) => (
								<tbody>
									<tr class="section">
										<th scope="rowgroup" colspan={1 + machines.length}>
											<span>{section}</span>
										</th>
									</tr>
									{headline
										.filter((row) => row.choice.section === section)
										.map((row) => {
											const fig = rowFigure(row);
											return (
												<tr>
													<th scope="row" title={`${row.choice.what} ${row.choice.setting}.`}>
														<span class="head">
															<a href={row.choice.readme}>{row.choice.label}</a>
															<span class="unit">{rowUnit(row, fig)}</span>
														</span>
													</th>
													{row.cells.map((cell) => (
														<td>
															<a href={links.seriesFile(cell.series)} title={exact(row, cell.series, fig)}>
																{fig(leadFigure(row.choice, cell.series).p50).short}
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
				</section>
			</main>

			<footer class="wrap">
				<a href={links.docs}>Docs</a>
				<a href={links.index}>API</a>
				<a href={links.prices}>Prices</a>
				<a href="./third-party-notices.txt">Licences</a>
			</footer>
		</>
	);
}
