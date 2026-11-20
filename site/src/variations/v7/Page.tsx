// Design v7, "Agent conversation", form under-50: the page opens on a question to an agent and its
// answer, two exact figures each cited by a numbered mark to the file, field and value it came
// from. Then the way in, for a shell and for an agent; when the figures were measured; the asked
// figure's row on all five machines with their prices; and every headline figure, folded until
// opened. Every figure is the data module's, exactly; every mark carries its source in its name.
import "./page.css";
import type { JSX } from "@solidjs/web";
import {
	type ByteUnit,
	durationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	type HeadlineRow,
	leadFigure,
	links,
	machineOf,
	machines,
	type Section,
	type Shown,
	series,
	seriesFileContents,
	snapshot,
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

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const pricesFetched = formatMoment(snapshot.pricesFetchedAt);
const AGENT_PROMPT_TAIL = "and cite each figure's file and field.";

// ---------------------------------------------------------------- one unit per row

const SI_RATE: [number, ByteUnit][] = [
	[1e12, "TB"],
	[1e9, "GB"],
	[1e6, "MB"],
	[1e3, "kB"],
	[0, "B"],
];

type Fig = { shown: Shown; p5: Shown; p95: Shown; count: number };
type Cell = HeadlineRow["cells"][number];

/**
 * The figures of a row, all in one unit: the one its smallest figure reads at least 1 in, so the
 * row compares at a glance. Where one repetition is a power-of-ten count of something smaller
 * (mutex), the figures are of one of those, divided exactly by the data module's helper.
 */
function rowFigures(row: HeadlineRow): Fig[] {
	const figures = row.cells.map((cell) => leadFigure(row.choice, cell.series));
	const least = Math.min(...figures.map((f) => f.p50));
	if (row.choice.lead === "rate") {
		const unit = SI_RATE.find(([floor]) => least >= floor)![1];
		return figures.map((f) => ({ shown: formatRate(f.p50, { unit }), p5: formatRate(f.p5, { unit }), p95: formatRate(f.p95, { unit }), count: f.count }));
	}
	const per = row.choice.per;
	if (per) {
		const unit = durationUnit(formatDurationPerUnit(least, per).value);
		return figures.map((f) => ({
			shown: formatDurationPerUnit(f.p50, per, { unit }),
			p5: formatDurationPerUnit(f.p5, per, { unit }),
			p95: formatDurationPerUnit(f.p95, per, { unit }),
			count: f.count,
		}));
	}
	const unit = durationUnit(least);
	return figures.map((f) => ({ shown: formatDuration(f.p50, { unit }), p5: formatDuration(f.p5, { unit }), p95: formatDuration(f.p95, { unit }), count: f.count }));
}

/** The largest value a row's drawing must hold: its widest p5 or p95. */
const rowMax = (figs: Fig[]) => Math.max(...figs.map((f) => Math.max(f.p5.value, f.p95.value)));

const askedFigs = rowFigures(askedRow);

/** A figure's 5th to 95th percentile span, low to high. */
function spread(fig: Fig): [Shown, Shown] {
	return fig.p5.value <= fig.p95.value ? [fig.p5, fig.p95] : [fig.p95, fig.p5];
}

/** What stands behind a cell, in its figure's title: its Runs and their dates, its p5 to p95, its field in the Series list. */
function cellTitle(fig: Fig, cell: Cell): string {
	const [lo, hi] = spread(fig);
	const from = formatMoment(cell.series.oldest_run_started_at).date;
	const to = formatMoment(cell.series.newest_run_started_at).date;
	return `${cell.machine.instanceType}: median of ${formatCount(fig.count).full} Runs, ${from} to ${to}\np5–p95 ${lo.full} – ${hi.full} ${fig.shown.unit}\nseries.json: ${fig.shown.source}\nOpen: this Series' Runs and evidence`;
}

/** A cell figure's accessible name: its visible text first, then what it is and where it leads. */
function cellName(fig: Fig, cell: Cell, visible: string): string {
	return `${visible} — ${cell.machine.instanceType}, median of ${formatCount(fig.count).full} Runs, ${fig.shown.unit}; its Series file`;
}

/** A figure's median and its 5th to 95th percentile span, drawn to its row's scale from zero. */
function Bar(props: { fig: Fig; max: number }) {
	const pct = (v: number) => `${((v / props.max) * 100).toFixed(2)}%`;
	const [lo, hi] = spread(props.fig);
	return (
		<span class="bar" aria-hidden="true">
			<span class="bar-p50" style={{ width: pct(props.fig.shown.value) }} />
			<span class="bar-span" style={{ left: pct((lo.value + hi.value) / 2), width: `max(6px, ${pct(hi.value - lo.value)})` }} />
		</span>
	);
}

/**
 * Every digit of a figure, its digits down to the row's heavy place set heavier so a row scans,
 * the integer part in a box of fixed width so the decimal points line up down a column.
 */
function Exact(props: { full: string; places: number }) {
	const full = props.full;
	const dot = full.includes(".") ? full.indexOf(".") : full.length;
	const k = Math.min(full.length, props.places > 0 ? dot + 1 + props.places : dot);
	const cut = (from: number, to: number) => [full.slice(from, Math.max(from, Math.min(k, to))), full.slice(Math.max(from, Math.min(k, to)), to)] as const;
	const [intHeavy, intLight] = cut(0, dot);
	const [fracHeavy, fracLight] = cut(dot, full.length);
	return (
		<span class="x">
			<span class="x-int">
				<b>{intHeavy}</b>
				{intLight ? <span class="x-t">{intLight}</span> : null}
			</span>
			<span class="x-frac">
				{fracHeavy ? <b>{fracHeavy}</b> : null}
				{fracLight ? <span class="x-t">{fracLight}</span> : null}
			</span>
		</span>
	);
}

/** How many decimals of a row are set heavier: down to four significant digits of its widest figure. */
function heavyPlaces(figs: Fig[]): number {
	return Math.max(0, 4 - Math.max(...figs.map((f) => f.shown.full.split(".")[0]!.length)));
}

/** The widest integer part in a row, so its figures' decimal points line up down a column. */
function intWidth(figs: Fig[]): string {
	return `--int: ${Math.max(...figs.map((f) => f.shown.full.split(".")[0]!.length))}ch`;
}

/** A few words on a group whose figures come from something the machines share. */
const GROUP_NOTE: Partial<Record<Section, string>> = {
	Disk: "the root EBS gp3 volume",
	Network: "S3, same Region",
};
const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

// ---------------------------------------------------------------- citations

/** A numbered mark that cites one file: its number shown, the file and the field in its name; it leads to its line of the sources. */
function Cite(props: { n: number; source: string }) {
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
								<Cite n={1} source={`v1/series.json, ${askedSeries.id} p50 (${p50Path})`} />
								<Cite n={2} source={`v1/series/${askedSeries.id}.json: every Run's figure and evidence`} />
								<span class="per" title={askedRow.choice.repetition}>
									per {askedPer.of}
								</span>
							</p>
							<p class="ans">
								<strong class="fig" title={askedMachine.price.description}>{`$${askedPrice.full}/h`}</strong>
								<Cite n={3} source={`v1/prices/${snapshot.priceDate}.json, ${askedMachine.price.path.pointer}`} />
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
							{askedTime.source.replace(/ ns$/, "")}&nbsp;÷&nbsp;
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

				<div class="way">
					<div class="way-row" data-copy-block="the index command">
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
					<div class="way-row way-agent" data-copy-block="the prompt for an agent">
						<span class="prompt" aria-hidden="true">
							›
						</span>
						<p class="way-say" data-copy={`Read ${links.index} ${AGENT_PROMPT_TAIL}`}>
							Read <a href={links.index}>{links.index.replace(/^https:\/\//, "")}</a> {AGENT_PROMPT_TAIL}
						</p>
					</div>
				</div>
				<p class="way-note">
					<a href={links.docs}>Docs</a>
				</p>

				<dl class="facts" aria-label="When the figures were measured">
					<div>
						<dt>Newest Run</dt>
						<dd>
							<a href={links.index} title={`index.json: newest_run_started_at, ${newest.full}`}>
								<time datetime={newest.iso}>
									{newest.date} <span class="nowrap">{newest.minute} UTC</span>
								</time>
							</a>
						</dd>
					</div>
					<div>
						<dt>Runs</dt>
						<dd>
							<a href={links.seriesList} title={`series.json: the sum of runs over all ${formatCount(snapshot.seriesCount).full} Series, the oldest from ${oldest.full}`}>
								{formatCount(snapshot.runCount).full}
							</a>
						</dd>
					</div>
					<div>
						<dt>Failed</dt>
						<dd>
							<a href={links.seriesList} title="series.json: the sum of every Series' failed_runs">
								{formatCount(snapshot.failedRuns).full}
							</a>
						</dd>
					</div>
					<div>
						<dt>Prices</dt>
						<dd>
							<a href={links.prices} title={`AWS On-Demand prices, copied ${pricesFetched.full}`}>
								{snapshot.priceDate}
							</a>
						</dd>
					</div>
				</dl>

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
							const fig = askedFigs[i]!;
							const asked = cell.series.id === askedSeries.id;
							const price = formatUsd(cell.machine.price.usdPerHour, { per: "hour" });
							const text = `${fig.shown.full}${fig.shown.unit}`;
							return (
								<li class={asked ? "cell is-asked" : "cell"}>
									<span class="cell-type" title={`${cell.machine.processor}, ${cell.machine.vcpu} vCPU, ${cell.machine.memory}`}>
										{cell.machine.instanceType}
									</span>
									<span class="cell-price" title={cell.machine.price.description}>
										{`$${price.full}/h`}
									</span>
									<a class="cell-fig" href={links.seriesFile(cell.series)} title={cellTitle(fig, cell)} aria-label={cellName(fig, cell, text)}>
										{text}
									</a>
									<Bar fig={fig} max={rowMax(askedFigs)} />
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

				<details class="all">
					<summary>
						<span class="all-title">
							{formatCount(headline.length).full} benchmarks × {formatCount(machines.length).full} machines
						</span>
					</summary>
					<div class="table-box" role="region" aria-label="The headline figures, 14 benchmarks on 5 machine types" tabindex="0">
						<table class="headline">
							<colgroup>
								<col class="col-bench" />
								{machines.map(() => (
									<col />
								))}
							</colgroup>
							<thead>
								<tr>
									<td class="th-corner" />
									{machines.map((m) => (
										<th scope="col" class="th-machine" title={`${m.processor}, ${m.vcpu} vCPU, ${m.memory}`}>
											<span class="th-type">{m.instanceType}</span>
											<span class="th-price" title={m.price.description}>{`$${formatUsd(m.price.usdPerHour, { per: "hour" }).full}/h`}</span>
										</th>
									))}
								</tr>
							</thead>
							{SECTIONS.map((section) => {
								const rows = headline.filter((row) => row.choice.section === section);
								const note = GROUP_NOTE[section];
								return (
									<tbody>
										<tr class="section-row">
											<th scope="colgroup" colspan={machines.length + 1}>
												{section}
												{note ? <span class="section-note"> · {note}</span> : null}
											</th>
										</tr>
										{rows.map((row) => {
											const figs = rowFigures(row);
											const max = rowMax(figs);
											const up = row.choice.lead === "rate";
											const places = heavyPlaces(figs);
											return (
												<tr class="hrow" style={intWidth(figs)}>
													<th scope="row" class="bench">
														<a class="bench-label" href={row.choice.readme} title={row.choice.setting}>
															{row.choice.label}
														</a>
														<span class="bench-unit">
															<span class="dir" role="img" aria-label={up ? "higher is faster" : "lower is faster"} title={up ? "higher is faster" : "lower is faster"}>
																{up ? "↑" : "↓"}
															</span>
															{figs[0]!.shown.unit}
														</span>
													</th>
													{row.cells.map((cell, i) => {
														const fig = figs[i]!;
														return (
															<td class={cell.series.id === askedSeries.id ? "fig-cell is-asked" : "fig-cell"}>
																<span class="cell-code" aria-hidden="true">
																	{cell.machine.instanceType.split(".")[0]}
																</span>
																<a class="fig-link" href={links.seriesFile(cell.series)} title={cellTitle(fig, cell)} aria-label={cellName(fig, cell, fig.shown.full)}>
																	<Exact full={fig.shown.full} places={places} />
																</a>
																<Bar fig={fig} max={max} />
															</td>
														);
													})}
												</tr>
											);
										})}
									</tbody>
								);
							})}
						</table>
					</div>
				</details>
			</main>

			<footer class="foot">
				<a class="notice" href="third-party-notices.txt" aria-label="Font notices" title="Font notices">
					©
				</a>
			</footer>
		</>
	);
}
