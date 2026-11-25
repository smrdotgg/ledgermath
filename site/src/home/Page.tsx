// The home page: design v9, "Semere's whiteboard", as the maintainer chose it from the
// home-page variations (issue #64): a header, a headline with the latest rounds beside it,
// three graphs, the table, a footer, in the style of smr.gg (Geist Pixel Circle, black and
// white with one grey, and dots). Every figure comes from ../data, from the tree the site is
// built from; the only arithmetic is a change of unit, done by its helpers. The art beside the
// headline: ./art.tsx. The header and footer are shared with the other pages: ../chrome.tsx.
//
// What the tree may lack, the page leaves out rather than fill: without recent_rounds there is
// no "Latest runs"; a cell whose Series is missing shows a dash.
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
	type HeadlineCell,
	type HeadlineRow,
	type LeadFigure,
	perUnit,
	type Section,
	type Shown,
	type SiteData,
} from "../data";
import { Footer, Header } from "../chrome";
import { HeadlineArt } from "./art";

// ---------------------------------------------------------------- figures

/**
 * One unit per row, so the row's figures share it: the unit the smallest figure of the row would
 * take. Where one repetition is a power-of-ten count of something smaller (mutex), the row shows
 * the time of one of those, divided exactly by formatDurationPerUnit. Null when no cell of the row
 * has a figure.
 */
type Fig = (value: number) => Shown;
function rowFigure(row: HeadlineRow): Fig | null {
	const c = row.choice;
	const figures = row.cells.flatMap((cell) => (cell.figure ? [cell.figure.p50] : []));
	if (figures.length === 0) return null;
	const least = Math.min(...figures);
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
	const first = row.cells.find((cell) => cell.figure)!.figure!;
	const unit = fig(first.p50).unit;
	return row.choice.per ? `${unit} per ${row.choice.per.of}` : unit;
}

/** What a figure's `title` says: every digit of the median, the 5th and 95th percentiles, and how many Runs. */
function exact(f: LeadFigure, fig: Fig): string {
	const unit = fig(f.p50).unit;
	return `Median ${fig(f.p50).full} ${unit}. 5th percentile ${fig(f.p5).full}, 95th ${fig(f.p95).full}. ${formatCount(f.count).full} Runs.`;
}

/** What a cell without a figure says, beside its dash. */
function absent(cell: HeadlineCell): string {
	return cell.series ? "No figure: the data give this Series none yet." : `No figure: the data have no Series for this on ${cell.machine.instanceType}.`;
}

/** A cell without a figure: a dash, with why in its title. */
const Dash = (props: { cell: HeadlineCell }) => <span title={absent(props.cell)}>—</span>;

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

function Graph(props: { row: HeadlineRow; data: SiteData }) {
	const row = props.row;
	const fig = rowFigure(row);
	const most = Math.max(0, ...row.cells.flatMap((cell) => (cell.figure ? [cell.figure.p50] : [])));
	return (
		<section class="graph">
			<h2>{row.choice.label}</h2>
			<p class="unit">
				{fig ? `${rowUnit(row, fig)} · ` : ""}
				{row.choice.lead === "rate" ? "more is faster" : "less is faster"}
			</p>
			<ul>
				{row.cells.map((cell) => (
					<li>
						<span class="machine">
							{cell.machine.instanceType} <span class="price">{price(cell.machine.price.usdPerHour)}</span>
						</span>
						{cell.figure && cell.series && fig ? (
							<>
								<a class="figure" href={props.data.links.seriesFile(cell.series)} title={exact(cell.figure, fig)}>
									{fig(cell.figure.p50).short}
								</a>
								<Bar share={most > 0 ? cell.figure.p50 / most : 0} />
							</>
						) : (
							<Dash cell={cell} />
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

// ---------------------------------------------------------------- the latest rounds

/** How many rounds "Latest runs" lists, newest first. */
const ROUNDS_SHOWN = 3;

/** "19 Nov 2026": the long date with its month cut to three letters. */
const shortDate = (longDate: string) => longDate.replace(/^(\d+ [A-Za-z]{3})[a-z]*/, "$1");

function Latest(props: { data: SiteData }) {
	return (
		<section class="latest" aria-labelledby="latest">
			<h2 id="latest">Latest runs</h2>
			<ol>
				{(props.data.rounds ?? []).slice(0, ROUNDS_SHOWN).map((round) => {
					const at = formatMoment(round.startedAt);
					return (
						<li>
							<time datetime={at.iso} title={at.full}>
								{shortDate(at.longDate)}, {at.minute} UTC
							</time>
							<span>
								{formatCount(round.boots).full} machines · {formatCount(round.runs).full} Runs · {formatCount(round.failedRuns).full} failed
							</span>
						</li>
					);
				})}
			</ol>
		</section>
	);
}

// ---------------------------------------------------------------- the page

export default function HomePage(props: { data: SiteData }) {
	const data = props.data;
	const { headline, machines, links } = data;
	const sections: Section[] = [];
	for (const row of headline) if (!sections.includes(row.choice.section)) sections.push(row.choice.section);

	return (
		<>
			<Header links={links} />

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

					{data.rounds && <Latest data={data} />}
				</div>

				<div class="graphs">
					{GRAPHS.map((name) => {
						const row = headline.find((r) => r.choice.benchmark === name);
						if (!row) throw new Error(`no headline row for ${name}`);
						return <Graph row={row} data={data} />;
					})}
				</div>

				<section class="numbers" aria-labelledby="numbers">
					<h2 id="numbers">All benchmarks</h2>
					<p class="note">AWS, {data.region}. Each number is a median and links to the Runs behind it.</p>
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
							{sections.map((section) => (
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
															<span class="unit">{fig ? rowUnit(row, fig) : ""}</span>
														</span>
													</th>
													{row.cells.map((cell) => (
														<td>
															{cell.figure && cell.series && fig ? (
																<a href={links.seriesFile(cell.series)} title={exact(cell.figure, fig)}>
																	{fig(cell.figure.p50).short}
																</a>
															) : (
																<Dash cell={cell} />
															)}
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

			<Footer links={links} />
		</>
	);
}
