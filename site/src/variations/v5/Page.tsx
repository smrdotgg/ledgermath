// Design v5, "Swiss poster": one grotesque, one strict grid, one accent colour. This form keeps under
// ten words: the name, one exact figure set enormous with what it is above it, and the way in.
// Every figure comes from ../../data exactly as the snapshot holds it (see ../README.md).
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
const oldest = formatMoment(cell.series.oldest_run_started_at);

/** The exact figure cut in two for setting, nothing rounded: four significant digits large, the rest beside them. */
function split(full: string): { head: string; tail: string } {
	const [int = "", frac = ""] = full.split(".");
	const places = Math.max(0, 4 - int.length);
	return { head: frac ? `${int}.${frac.slice(0, places)}` : int, tail: frac.slice(places) };
}
const cut = split(fig.full);

/** Every written value of the figure, for the visitor who hovers. */
const exact = `p50 ${fig.full} ${fig.unit}\np5 ${show(row, lead.p5).full}\np95 ${show(row, lead.p95).full}\n${lead.count} counted Runs, ${oldest.full} to ${newest.full}`;

// ---------------------------------------------------------------- the page

export default function Page() {
	return (
		<>
			<main class="poster">
				<h1 class="name">LedgerMath</h1>
				<p class="kicker">
					<a class="kicker-b" href={row.choice.readme}>
						{row.choice.label}
					</a>
					<span class="sep" aria-hidden="true">
						{" "}
						/{" "}
					</span>
					<span>{cell.machine.instanceType}</span>
					<span class="sep" aria-hidden="true">
						{" "}
						/{" "}
					</span>
					<span class="kicker-m">
						p50 of{" "}
						<a href={links.seriesFile(cell.series)} title={exact}>
							{formatCount(lead.count).full} Runs
						</a>
					</span>
					<span class="sep" aria-hidden="true">
						{" "}
						/{" "}
					</span>
					<time class="kicker-m" datetime={newest.iso} title={`Newest Run started ${newest.full}`}>
						{newest.date}
					</time>
				</p>
				{/* The unit shares one text with the last digits, so it reads, and counts, as part of the figure. */}
				<p class="hero-figure">
					<span class="hero-head">{cut.head}</span>
					<span class="hero-tail">{`${cut.tail}${fig.unit}`}</span>
				</p>
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
