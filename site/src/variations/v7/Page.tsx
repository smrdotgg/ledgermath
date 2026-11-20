// Design v7, "Agent conversation", form under-05: the page is the exchange and nothing else. A
// question in two words, the agent's answer in two exact figures, each cited by a numbered mark to
// the API file it came from, the dates of the Runs behind it, and the address to start from. Every
// figure is the data module's, exactly; every mark carries its source in its accessible name.
import "./page.css";
import { formatDurationPerUnit, formatMoment, formatUsd, headline, links, machineOf, series, seriesFileContents } from "../../data";

// ---------------------------------------------------------------- the exchange's facts

// The exchange asks about the one Series whose own file the snapshot keeps, so its answer can be
// cited all the way down: the figure in series.json, the Series file, the price file.
const askedSeries = series.find((row) => row.id === seriesFileContents.sample.id)!;
const askedRow =
	headline.find((row) => row.cells.some((cell) => cell.series.id === askedSeries.id)) ??
	(() => {
		throw new Error(`the sample Series ${askedSeries.id} is not a headline figure`);
	})();
const askedPer: { count: number; of: string } =
	askedRow.choice.per ??
	(() => {
		throw new Error("the exchange's answer expects a figure per critical section");
	})();
const ASKED_MACHINE = askedSeries.instance_type;
const askedFigure = askedSeries.derivations.series_v1.percentiles.time_per_repetition_ns!;
const askedTime = formatDurationPerUnit(askedFigure.p50, askedPer);
const askedMachine = machineOf(ASKED_MACHINE);
const askedPrice = formatUsd(askedMachine.price.usdPerHour, { per: "hour" });
const askedOldest = formatMoment(askedSeries.oldest_run_started_at);
const askedNewest = formatMoment(askedSeries.newest_run_started_at);
const askedSeriesIndex = series.indexOf(askedSeries);
const p50Path = `/series/${askedSeriesIndex}/derivations/series_v1/percentiles/time_per_repetition_ns/p50`;

/** A numbered mark that cites one file: its number shown, the file and the field in its name. */
function Cite(props: { n: number; href: string; source: string }) {
	return (
		<sup class="cite-sup">
			<a class="cite" href={props.href} aria-label={`Source ${props.n}: ${props.source}`} title={props.source}>
				{props.n}
			</a>
		</sup>
	);
}

// ---------------------------------------------------------------- the page

export default function Page() {
	return (
		<>
			<main class="page">
				<h1 class="name">
					<span class="glyph" aria-hidden="true">
						L
					</span>
					LedgerMath
				</h1>

				<section class="exchange" aria-labelledby="question">
					<div class="turn turn-q">
						<span class="mark" aria-hidden="true">
							Q
						</span>
						<p class="question" id="question">
							<span class="nowrap">{ASKED_MACHINE}</span> mutex?
						</p>
					</div>
					<div class="turn turn-a">
						<span class="mark" aria-hidden="true">
							A
						</span>
						<div class="answer">
							<p class="ans">
								<strong class="fig" title={`${askedRow.choice.label}: one ${askedPer.of}, median of ${askedFigure.count} Runs (${askedTime.source} per ${askedPer.count} ${askedPer.of}s)`}>
									{`${askedTime.full}${askedTime.unit}`}
								</strong>
								<Cite n={1} href={links.seriesList} source={`v1/series.json, ${askedSeries.id} p50 (${p50Path})`} />
								<Cite n={2} href={askedSeries.url} source={`v1/series/${askedSeries.id}.json: every Run's figure and evidence`} />
							</p>
							<p class="ans">
								<strong class="fig" title={`${askedMachine.price.description}`}>{`$${askedPrice.full}/h`}</strong>
								<Cite n={3} href={links.prices} source={`v1/prices/${askedMachine.price.path.file.split("/").pop()}, ${askedMachine.price.path.pointer}`} />
							</p>
							<p class="when" title={`Runs from ${askedOldest.full} to ${askedNewest.full}`}>
								<time datetime={askedOldest.iso}>{askedOldest.date}</time>
								<span class="dash">–</span>
								<time datetime={askedNewest.iso}>{askedNewest.date}</time>
							</p>
						</div>
					</div>
				</section>

				<div class="way" data-copy-block="the index address">
					<a class="way-url" href={links.index} data-copy={links.index}>
						{links.index.replace(/^https:\/\//, "")}
					</a>
				</div>
			</main>

			<footer class="foot">
				<a class="notice" href="third-party-notices.txt" aria-label="Font notices" title="Font notices">
					©
				</a>
			</footer>
		</>
	);
}
