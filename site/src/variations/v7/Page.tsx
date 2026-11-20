// Design v7, "Agent conversation", form under-05: the page is the exchange and nothing else. A
// question in two words, the agent's answer in two exact figures, each cited by a numbered mark to
// the API file it came from, the dates of the Runs behind it, and the address to start from. Every
// figure is the data module's, exactly; every mark carries its source in its accessible name.
import "./page.css";
import type { JSX } from "@solidjs/web";
import {
	durationUnit,
	formatCount,
	formatDurationPerUnit,
	formatMoment,
	formatUsd,
	headline,
	leadFigure,
	links,
	machineOf,
	type Shown,
	series,
	seriesFileContents,
} from "../../data";

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
const askedDerivation = askedSeries.derivations.series_v1;
const askedRun = seriesFileContents.point.example;
const askedRunAt = formatMoment(askedRun.started_at);
const p50Path = `/series/${askedSeriesIndex}/derivations/series_v1/percentiles/time_per_repetition_ns/p50`;

// ---------------------------------------------------------------- the asked figure's row, on every machine

type Fig = { shown: Shown; p5: Shown; p95: Shown; count: number };

/** The row's figures, each of one critical section, all in the unit its smallest reads at least 1 in, divided exactly by the data module's helper. */
const rowFigs: Fig[] = (() => {
	const figures = askedRow.cells.map((cell) => leadFigure(askedRow.choice, cell.series));
	const unit = durationUnit(formatDurationPerUnit(Math.min(...figures.map((f) => f.p50)), askedPer).value);
	return figures.map((f) => ({
		shown: formatDurationPerUnit(f.p50, askedPer, { unit }),
		p5: formatDurationPerUnit(f.p5, askedPer, { unit }),
		p95: formatDurationPerUnit(f.p95, askedPer, { unit }),
		count: f.count,
	}));
})();
const rowMax = Math.max(...rowFigs.map((f) => Math.max(f.p5.value, f.p95.value)));

/** A figure's 5th to 95th percentile span, low to high. */
function spread(fig: Fig): [Shown, Shown] {
	return fig.p5.value <= fig.p95.value ? [fig.p5, fig.p95] : [fig.p95, fig.p5];
}

/** What stands behind a cell, in its figure's title: its Runs and their dates, its p5 to p95, its field in the Series list. */
function cellTitle(fig: Fig, cell: (typeof askedRow.cells)[number]): string {
	const [lo, hi] = spread(fig);
	const from = formatMoment(cell.series.oldest_run_started_at).date;
	const to = formatMoment(cell.series.newest_run_started_at).date;
	return `${cell.machine.instanceType}: median of ${formatCount(fig.count).full} Runs, ${from} to ${to}\np5–p95 ${lo.full} – ${hi.full} ${fig.shown.unit}\nseries.json: ${fig.shown.source}\nOpen: this Series' Runs and evidence`;
}

/** A figure's median and its 5th to 95th percentile span, drawn to the row's scale from zero. */
function Bar(props: { fig: Fig }) {
	const pct = (v: number) => `${((v / rowMax) * 100).toFixed(2)}%`;
	const [lo, hi] = spread(props.fig);
	return (
		<span class="bar" aria-hidden="true">
			<span class="bar-p50" style={{ width: pct(props.fig.shown.value) }} />
			<span class="bar-span" style={{ left: pct((lo.value + hi.value) / 2), width: `max(6px, ${pct(hi.value - lo.value)})` }} />
		</span>
	);
}

/** A numbered mark that cites one file: its number shown, the file and the field in its name; it leads to its line of the sources. */
function Cite(props: { n: number; href: string; source: string }) {
	return (
		<sup class="cite-sup">
			<a class="cite" href={`#src-${props.n}`} aria-label={`Source ${props.n}: ${props.source}`} title={props.source}>
				{props.n}
			</a>
		</sup>
	);
}

/**
 * One line of the sources: its number, the file (a link, its path shown without the host), the
 * field in it (its whole path in the title), and what the answer took from there.
 */
function Source(props: { n: number; href: string; field: string; path: string; children: JSX.Element }) {
	return (
		<li class="src" id={`src-${props.n}`}>
			<span class="src-n" aria-hidden="true">
				{props.n}
			</span>
			<a class="src-file" href={props.href}>
				{props.href.replace(/^https:\/\/[^/]+\//, "")}
			</a>
			<code class="src-field" title={props.path}>
				{props.field}
			</code>
			<span class="src-val">{props.children}</span>
		</li>
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
							<span class="nowrap">{ASKED_MACHINE}:</span> mutex, price?
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
								<span class="per" title={askedRow.choice.repetition}>
									per {askedPer.of}
								</span>
							</p>
							<p class="ans">
								<strong class="fig" title={`${askedMachine.price.description}`}>{`$${askedPrice.full}/h`}</strong>
								<Cite n={3} href={links.prices} source={`v1/prices/${askedMachine.price.path.file.split("/").pop()}, ${askedMachine.price.path.pointer}`} />
							</p>
							<p class="when" title={`Runs from ${askedOldest.full} to ${askedNewest.full}`}>
								Median of {formatCount(askedFigure.count).full} Runs,{" "}
								<span class="nowrap">
									<time datetime={askedOldest.iso}>{askedOldest.date}</time>
									<span class="dash">–</span>
									<time datetime={askedNewest.iso}>{askedNewest.date}</time>,
								</span>{" "}
								{formatCount(askedDerivation.failed_runs).full} failed
							</p>
						</div>
					</div>
					<ol class="srcs" aria-label="Sources">
						<Source n={1} href={links.seriesList} field={`${askedSeries.id} › p50`} path={p50Path}>
							{`${askedTime.source.replace(/ ns$/, "")}`}&nbsp;÷&nbsp;
							<a href={askedRow.choice.readme} title={`${formatCount(askedPer.count).full} ${askedPer.of}s in one repetition: the benchmark's Method`}>
								{formatCount(askedPer.count).full}
							</a>
						</Source>
						<Source n={2} href={askedSeries.url} field="points[0].evidence" path="/derivations/series_v1/points/0/evidence">
							<a href={askedRun.evidence} title={`An example Run's evidence: Run ${askedRun.run}, ${askedRunAt.full}`}>
								{askedRunAt.date}
							</a>
						</Source>
						<Source n={3} href={links.prices} field={`${askedMachine.price.path.sku} › … › USD`} path={askedMachine.price.path.pointer}>
							{`"${askedMachine.price.usdPerHour}"`}
						</Source>
					</ol>
				</section>

				<div class="way" data-copy-block="the index command">
					<span class="prompt" aria-hidden="true">
						$
					</span>
					<code class="way-cmd" data-copy={`curl ${links.index}`}>
						curl
						<span class="cont" aria-hidden="true">
							{" \\"}
						</span>{" "}
						<a class="way-url" href={links.index}>
							{links.index}
						</a>
					</code>
				</div>

				<section class="row" aria-labelledby="row-title">
					<div class="row-head">
						<h2 id="row-title" class="row-title">
							<a href={askedRow.choice.readme} title={askedRow.choice.setting}>
								{askedRow.choice.label}
							</a>
						</h2>
						<ul class="key" aria-label="Key">
							<li>
								<span class="key-tick" aria-hidden="true" />
								p50
							</li>
							<li>
								<span class="key-band" aria-hidden="true" />
								p5–p95
							</li>
						</ul>
					</div>
					<ul class="cells">
						{askedRow.cells.map((cell, i) => {
							const fig = rowFigs[i]!;
							const asked = cell.series.id === askedSeries.id;
							const price = formatUsd(cell.machine.price.usdPerHour, { per: "hour" });
							return (
								<li class={asked ? "cell is-asked" : "cell"}>
									<span class="cell-type" title={`${cell.machine.processor}, ${cell.machine.vcpu} vCPU, ${cell.machine.memory}`}>
										{cell.machine.instanceType}
									</span>
									<span class="cell-price" title={cell.machine.price.description}>
										{`$${price.full}/h`}
									</span>
									<a
										class="cell-fig"
										href={links.seriesFile(cell.series)}
										title={cellTitle(fig, cell)}
										aria-label={`${cell.machine.instanceType}: ${fig.shown.full}${fig.shown.unit}, median of ${formatCount(fig.count).full} Runs; its Series file`}
									>
										{`${fig.shown.full}${fig.shown.unit}`}
									</a>
									<Bar fig={fig} />
									{asked ? (
										<a class="ref" href="#question" aria-label="A, the example answer above" title="The example answer">
											A
										</a>
									) : null}
								</li>
							);
						})}
					</ul>
				</section>
			</main>

			<footer class="foot">
				<a class="notice" href="third-party-notices.txt" aria-label="Font notices" title="Font notices">
					©
				</a>
			</footer>
		</>
	);
}
