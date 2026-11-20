// Design v7, form "dt-bulletin": the statistical bulletin of the Permanent Directorate of
// Machine Arithmetic, an imaginary and very grave institution that reports LedgerMath's
// figures with the solemnity of an interest-rate decision. A crest, a release number, an
// embargo (the newest Run's start, to the nanosecond), numbered paragraphs that say almost
// nothing, and tables with a chart in every row, drawn by the Datatype font from the data
// module's figures. Every figure is the module's, exactly; every chart is scaled in code here.
import "./page.css";
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
	machines,
	type Section,
	seriesFileContents,
	type Shown,
	snapshot,
} from "../../data";
import { seriesFileSample } from "../../data/snapshot";

// ---------------------------------------------------------------- the facts of the release

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const runs = formatCount(snapshot.runCount);
const failed = formatCount(snapshot.failedRuns);
const BOOTS = ["04:10", "10:10", "16:10", "22:10"];

// ---------------------------------------------------------------- scaling for the font

/** Whole numbers 0–100 for the font, from zero: the largest becomes 100, the rest in proportion. */
function fromZero(values: number[]): number[] {
	const max = Math.max(...values);
	return values.map((v) => (max > 0 ? Math.round((v / max) * 100) : 0));
}

/** Whole numbers 0–100 stretched between the lowest and the highest: a zoomed drawing, and labelled so. */
function zoomed(values: number[]): number[] {
	const min = Math.min(...values);
	const max = Math.max(...values);
	return values.map((v) => (max > min ? Math.round(((v - min) / (max - min)) * 100) : 50));
}

const bars = (values: number[]) => `{b:${values.join(",")}}`;
const line = (values: number[]) => `{l:${values.join(",")}}`;
const pie = (value: number) => `{p:${value}}`;

/** A chart drawn by the font: a picture to a screen reader, with a short text alternative. */
function Chart(props: { text: string; label: string; class?: string }) {
	return (
		<span class={`chart ${props.class ?? ""}`} role="img" aria-label={props.label}>
			<span aria-hidden="true">{props.text}</span>
		</span>
	);
}

/** A figure in its short form, the full one in its title (and in Annex A). */
function Fig(props: { shown: Shown }) {
	return (
		<span class="fig" title={`${props.shown.full} ${props.shown.unit}`}>
			{props.shown.short}
		</span>
	);
}

// ---------------------------------------------------------------- Table 1: one unit per row

const SI_RATE: [number, ByteUnit][] = [
	[1e12, "TB"],
	[1e9, "GB"],
	[1e6, "MB"],
	[1e3, "kB"],
	[0, "B"],
];

type Cell = { p50: Shown; p5: Shown; p95: Shown; raw: number };

/** A row's five figures in one unit (the one its smallest reads at least 1 in). Mutex is per critical section, divided by the module's helper. */
function rowCells(row: HeadlineRow): { cells: Cell[]; unit: string } {
	const figures = row.cells.map((cell) => leadFigure(row.choice, cell.series));
	const least = Math.min(...figures.map((f) => f.p50));
	let cells: Cell[];
	if (row.choice.lead === "rate") {
		const unit = SI_RATE.find(([floor]) => least >= floor)![1];
		cells = figures.map((f) => ({ p50: formatRate(f.p50, { unit }), p5: formatRate(f.p5, { unit }), p95: formatRate(f.p95, { unit }), raw: f.p50 }));
	} else if (row.choice.per) {
		const per = row.choice.per;
		const unit = durationUnit(formatDurationPerUnit(least, per).value);
		cells = figures.map((f) => ({ p50: formatDurationPerUnit(f.p50, per, { unit }), p5: formatDurationPerUnit(f.p5, per, { unit }), p95: formatDurationPerUnit(f.p95, per, { unit }), raw: f.p50 }));
	} else {
		const unit = durationUnit(least);
		cells = figures.map((f) => ({ p50: formatDuration(f.p50, { unit }), p5: formatDuration(f.p5, { unit }), p95: formatDuration(f.p95, { unit }), raw: f.p50 }));
	}
	return { cells, unit: cells[0]!.p50.unit };
}

const table1 = headline.map((row, i) => {
	const { cells, unit } = rowCells(row);
	return { n: i + 1, row, cells, unit, chart: bars(fromZero(cells.map((c) => c.raw))) };
});

const sections: Section[] = [...new Set(headline.map((row) => row.choice.section))];

// ---------------------------------------------------------------- Figure 2: the longest-watched indicator

const per = headline.find((row) => row.choice.benchmark === seriesFileContents.sample.benchmark)?.choice.per;
const watched = seriesFileSample.derivations.series_v1.points.filter((p) => p.counted && p.time_per_repetition_ns !== null).slice(-20);
const watchedNs = watched.map((p) => p.time_per_repetition_ns!);
const asShown = (ns: number) => (per ? formatDurationPerUnit(ns, per, { unit: "ns" }) : formatDuration(ns));
const watchedLow = asShown(Math.min(...watchedNs));
const watchedHigh = asShown(Math.max(...watchedNs));
const watchedFirst = formatMoment(watched[0]!.started_at);
const watchedLast = formatMoment(watched.at(-1)!.started_at);

// ---------------------------------------------------------------- Table 3: rates

const prices = machines.map((m) => formatUsd(m.price.usdPerHour, { per: "hour" }));
const priceBars = fromZero(prices.map((p) => p.value));

// ---------------------------------------------------------------- the page

export default function Page() {
	return (
		<div class="sheet">
			<header class="mast">
				<div class="mast-top">
					<span class="brand">LedgerMath</span>
					<span class="class-mark">Classification: Public. Thoroughly.</span>
				</div>

				<div class="crest-row">
					<div class="seal" role="img" aria-label="The crest: the five hourly prices as bars, to scale">
						<svg viewBox="0 0 200 200" aria-hidden="true" class="seal-ring">
							<defs>
								<path id="arc-top" d="M 36 138 A 74 74 0 1 1 164 138" />
								<path id="arc-bottom" d="M 18 100 A 82 82 0 0 0 182 100" />
							</defs>
							<circle cx="100" cy="100" r="96" />
							<circle cx="100" cy="100" r="90" class="thin" />
							<circle cx="100" cy="100" r="58" class="thin" />
							<text>
								<textPath href="#arc-top" startOffset="50%" text-anchor="middle">
									DIRECTORATE OF MACHINE ARITHMETIC
								</textPath>
							</text>
							<text>
								<textPath href="#arc-bottom" startOffset="50%" text-anchor="middle">
									★ NIHIL NISI MENSUM ★
								</textPath>
							</text>
						</svg>
						<span class="seal-bars chart" aria-hidden="true">
							{bars(priceBars)}
						</span>
					</div>

					<div class="mast-words">
						<p class="issuer">The Permanent Directorate of Machine Arithmetic</p>
						<h1>
							Statistical Bulletin
							<span class="release">
								Release No. {runs.full}
								<a href="#n1" class="fn" aria-label="note 1">
									1
								</a>
							</span>
						</h1>
						<dl class="embargo">
							<div>
								<dt>Embargoed until</dt>
								<dd title={newest.full}>
									{newest.second}
									<span class="nanos">{newest.iso.slice(19, -1)}</span> UTC, {newest.longDate}
									<a href="#n2" class="fn" aria-label="note 2">
										2
									</a>
								</dd>
							</div>
							<div>
								<dt>Period</dt>
								<dd title={`${oldest.full} to ${newest.full}`}>
									{oldest.longDate} to {newest.longDate}
								</dd>
							</div>
						</dl>
					</div>
					<p class="stamp">
						Embargo
						<br />
						lifted
					</p>
				</div>
			</header>

			<main>
				<section class="decision" aria-labelledby="decision-h">
					<p class="kicker">Decision</p>
					<h2 id="decision-h">The machines have been measured.</h2>
					<p class="dek">No further action is contemplated.</p>

					<ul class="headline-figs">
						<li>
							<strong>{snapshot.benchmarkCount}</strong> benchmarks
						</li>
						<li>
							<strong>{snapshot.machineCount}</strong> AWS machine types, <span class="nowrap">{snapshot.region}</span>
						</li>
						<li>
							<strong>{runs.full}</strong> Runs, every one kept
						</li>
						<li class="nil">
							<Chart text={pie(0)} label={`An empty pie: ${failed.full} failed Runs`} class="pie" />
							<span>
								<strong>{failed.full}</strong> failed
							</span>
						</li>
					</ul>

					<div class="access" data-copy-block="the API address">
						<p class="access-label">Means of access, for agents and other competent persons</p>
						<code data-copy>{links.index}</code>
					</div>
				</section>

				<section class="paras" aria-labelledby="paras-h">
					<h2 id="paras-h" class="sr">Statement</h2>
					<ol>
						<li>
							The Directorate boots five AWS machine types four times daily, at {BOOTS.slice(0, 3).join(", ")} and {BOOTS[3]} UTC, and runs {snapshot.benchmarkCount} benchmarks on each,
							freshly booted.
						</li>
						<li>Every Run is kept, with its evidence. Figures are derived by published Methods.</li>
						<li>
							Of {runs.full} Runs, {failed.full} failed. The Directorate has no comment.
						</li>
						<li>The Directorate expresses no view as to which machine is preferable. It holds no views. It holds figures.</li>
						<li>
							Prices are AWS's public On-Demand rates. The Directorate notes them. It does not set them.
						</li>
					</ol>
				</section>

				<section class="table-sec" aria-labelledby="t1-h">
					<h2 id="t1-h">
						<span class="tno">Table 1</span> Selected indicators
					</h2>
					<p class="tsub">Median of counted Runs. Bars drawn from zero, one per machine, in column order.</p>
					<div class="scroll" tabindex="0" role="region" aria-label="Table 1, scrolls sideways">
						<table class="t1">
							<thead>
								<tr>
									<th scope="col" class="num">
										No.
									</th>
									<th scope="col">Indicator</th>
									<th scope="col">Chart</th>
									{machines.map((m) => (
										<th scope="col" class="mcol">
											{m.instanceType}
										</th>
									))}
									<th scope="col">Unit</th>
								</tr>
							</thead>
							{sections.map((section) => (
								<tbody>
									<tr class="sec-row">
										<th scope="colgroup" colspan={4 + machines.length}>
											{section}
										</th>
									</tr>
									{table1
										.filter((t) => t.row.choice.section === section)
										.map((t) => (
											<tr>
												<td class="num">{t.n}</td>
												<th scope="row" class="ind">
													{t.row.choice.label}
												</th>
												<td class="chart-cell">
													<Chart text={t.chart} label={`Five bars from zero, ${t.unit}`} />
												</td>
												{t.cells.map((c) => (
													<td class="val">
														<Fig shown={c.p50} />
													</td>
												))}
												<td class="unit">{t.unit}</td>
											</tr>
										))}
								</tbody>
							))}
						</table>
					</div>
					<p class="tnote">
						Row 8 is per critical section. The Directorate draws attention to rows 10 to 13 and declines to elaborate.
					</p>
				</section>

				<section class="fig2" aria-labelledby="f2-h">
					<h2 id="f2-h">
						<span class="tno">Figure 2</span> The Directorate's most closely watched indicator
					</h2>
					<p class="tsub">
						Lock and unlock a mutex, {seriesFileContents.sample.instanceType}, per critical section: the last {watched.length} Runs, {watchedFirst.date} to {watchedLast.date}.
					</p>
					<div class="twin">
						<figure>
							<Chart text={line(fromZero(watchedNs))} label={`Line of ${watched.length} Runs drawn from zero: nearly flat`} class="spark" />
							<figcaption>
								<strong>2a.</strong> To scale, from zero.
							</figcaption>
						</figure>
						<figure class="zoom">
							<span class="zoom-tag">Zoomed</span>
							<span class="axis hi" title={`${watchedHigh.full} ${watchedHigh.unit}`}>
								{watchedHigh.short} {watchedHigh.unit}
							</span>
							<Chart text={line(zoomed(watchedNs))} label={`The same ${watched.length} Runs, zoomed from lowest to highest`} class="spark" />
							<span class="axis lo" title={`${watchedLow.full} ${watchedLow.unit}`}>
								{watchedLow.short} {watchedLow.unit}
							</span>
							<figcaption>
								<strong>2b.</strong> The same, zoomed, for readers who require excitement.
							</figcaption>
						</figure>
					</div>
				</section>

				<section class="table-sec" aria-labelledby="t3-h">
					<h2 id="t3-h">
						<span class="tno">Table 3</span> Rates
					</h2>
					<p class="tsub">On-Demand, Linux, {snapshot.region}, per hour, {snapshot.priceDate}. Bars from zero.</p>
					<div class="scroll" tabindex="0" role="region" aria-label="Table 3, scrolls sideways">
						<table class="t3">
							<thead>
								<tr>
									<th scope="col">Machine</th>
									<th scope="col">vCPU</th>
									<th scope="col">Memory</th>
									<th scope="col">Chart</th>
									<th scope="col" class="val">
										USD/hour
									</th>
								</tr>
							</thead>
							<tbody>
								{machines.map((m, i) => (
									<tr>
										<th scope="row">
											<span class="mono">{m.instanceType}</span>
											<span class="proc">{m.processor}</span>
										</th>
										<td class="mono">{m.vcpu}</td>
										<td class="mono">{m.memory}</td>
										<td class="chart-cell">
											<Chart text={bars([priceBars[i]!])} label="One bar, from zero" class="one" />
										</td>
										<td class="val">
											<span class="fig" title={m.price.description}>
												{prices[i]!.full}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p class="tnote">Unchanged by the Directorate, which was not consulted.</p>
				</section>

				<section class="annex" aria-labelledby="annex-h">
					<h2 id="annex-h" class="sr">Annexes</h2>
					<details>
						<summary>Annex A. Every digit the Directorate possesses</summary>
						<p class="tsub">Table 1 again, in full: 5th, 50th and 95th percentiles of counted Runs.</p>
						<div class="scroll" tabindex="0" role="region" aria-label="Annex A, scrolls sideways">
							<table class="ta">
								<thead>
									<tr>
										<th scope="col">No.</th>
										<th scope="col">Machine</th>
										<th scope="col">p5</th>
										<th scope="col">p50</th>
										<th scope="col">p95</th>
										<th scope="col">Unit</th>
									</tr>
								</thead>
								<tbody>
									{table1.flatMap((t) =>
										t.cells.map((c, j) => (
											<tr class={j === 0 ? "first" : ""}>
												<td class="num">{j === 0 ? t.n : ""}</td>
												<th scope="row" class="mono">
													{machines[j]!.instanceType}
												</th>
												<td class="mono">{c.p5.full}</td>
												<td class="mono strong">{c.p50.full}</td>
												<td class="mono">{c.p95.full}</td>
												<td class="unit">{t.unit}</td>
											</tr>
										)),
									)}
								</tbody>
							</table>
						</div>
					</details>
					<details>
						<summary>Annex B. Figure 2, as numbers</summary>
						<ol class="runs">
							{watched.map((p) => {
								const s = asShown(p.time_per_repetition_ns!);
								return (
									<li>
										<span class="mono">{formatMoment(p.started_at).full}</span> <span class="mono strong">{s.full}</span> {s.unit}
									</li>
								);
							})}
						</ol>
					</details>
				</section>
			</main>

			<footer class="foot">
				<div class="signed">
					<span class="for">For the Directorate</span>
					<Chart text={line(zoomed(watchedNs))} label="A signature: Figure 2b again, zoomed" class="sig" />
					<span class="sig-note">Signature: Figure 2b, zoomed.</span>
				</div>
				<ol class="notes">
					<li id="n1">Numbered after the Runs it reports. The Directorate does not invent numbers, including its own.</li>
					<li id="n2">The start of the newest Run. The Directorate saw no reason to round it.</li>
					<li>The crest is the five hourly prices, cheapest first, to scale. Nothing more dignified was available.</li>
				</ol>
				<p class="colophon">
					Issued for <strong>LedgerMath</strong>: measured AWS benchmarks, every figure with its source, as JSON at <a href={links.index}>api.ledgermath.com</a>.{" "}
					<a href={links.docs}>Documentation</a>. Charts set in Datatype (<a href="third-party-notices.txt">notices</a>). Next release within six hours, without ceremony.
				</p>
			</footer>
		</div>
	);
}
