// Design v5, "Swiss poster": one grotesque, one strict grid, one accent colour. This form keeps under
// five words: the name, one exact figure set enormous, the machine it was measured on, and the way in.
// What the figure is opens from the figure itself. Every figure comes from ../../data exactly as the
// snapshot holds it (see ../README.md).
import "./page.css";
import { formatCount, formatMoment, formatRate, headline, leadFigure, links, type HeadlineRow, type Shown } from "../../data";

// ---------------------------------------------------------------- the poster's figure

/** A rate in the unit the largest figure of its row takes, so the row's figures read against each other. */
function show(row: HeadlineRow, value: number): Shown {
	const largest = Math.max(...row.cells.map((cell) => leadFigure(row.choice, cell.series).p50));
	return formatRate(value, { unit: formatRate(largest).unit.replace("/s", "") as "GB" });
}

// The table's first cell: read memory sequentially, on the cheapest machine type.
const row = headline[0]!;
const cell = row.cells[0]!;
const lead = leadFigure(row.choice, cell.series);
const fig = show(row, lead.p50);
const newest = formatMoment(cell.series.newest_run_started_at);

/** The exact figure cut in two for setting, nothing rounded: four significant digits large, the rest beside them. */
function split(full: string): { head: string; tail: string } {
	const [int = "", frac = ""] = full.split(".");
	const places = Math.max(0, 4 - int.length);
	return { head: frac ? `${int}.${frac.slice(0, places)}` : int, tail: frac.slice(places) };
}
const cut = split(fig.full);

// ---------------------------------------------------------------- the page

function Figure() {
	return (
		<details class="hero">
			{/* The figure is the summary. The unit shares one text with the last digits, so it reads, and counts, as part of the figure. */}
			<summary class="hero-figure">
				<span class="hero-head">{cut.head}</span>
				<span class="hero-tail">{`${cut.tail}${fig.unit}`}</span>
				<span class="hero-plus" aria-hidden="true" />
			</summary>
			<dl class="hero-open">
				<div>
					<dt>Benchmark</dt>
					<dd>
						<a href={row.choice.readme}>{row.choice.label}</a>
					</dd>
				</div>
				<div>
					<dt>Figure</dt>
					<dd>
						p50 of {formatCount(lead.count).full} counted Runs
						<span class="hero-pct">p5 {`${show(row, lead.p5).full}${fig.unit}`}</span>
						<span class="hero-pct">p95 {`${show(row, lead.p95).full}${fig.unit}`}</span>
					</dd>
				</div>
				<div>
					<dt>Newest Run</dt>
					<dd>
						<time datetime={newest.iso}>
							{newest.date} {newest.minute} UTC
						</time>
					</dd>
				</div>
				<div>
					<dt>Evidence</dt>
					<dd>
						<a href={links.seriesFile(cell.series)}>every Run, with its evidence</a>
					</dd>
				</div>
			</dl>
		</details>
	);
}

export default function Page() {
	return (
		<>
			<main class="poster">
				<h1 class="name">LedgerMath</h1>
				<p class="kicker">
					<span class="kicker-m">{cell.machine.instanceType}</span>
				</p>
				<Figure />
				<div class="cmd" data-copy={`curl ${links.index}`}>
					<code tabindex="0">
						<span class="prompt" aria-hidden="true">
							${" "}
						</span>
						curl <a href={links.index}>{links.index}</a>
					</code>
				</div>
			</main>
			<footer class="foot">
				<a class="foot-lic" href="third-party-notices.txt" aria-label="Third-party notices: the typeface's licence">
					©
				</a>
			</footer>
		</>
	);
}
