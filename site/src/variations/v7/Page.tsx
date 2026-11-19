// Design v7, "Agent conversation": the page opens on a question a developer puts to their
// agent and the agent's answer, every figure in it cited to the API file and field it came
// from. Then the same numbers for the reader: the headline table (its column heads are the
// machines and their prices), the way in, and where the figures come from. Every figure is the
// data module's, exactly. The page says as little as it can: figures, what they are of, and how
// to get them.
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
	series,
	seriesFileContents,
	type Shown,
	snapshot,
} from "../../data";

// ---------------------------------------------------------------- the exchange's facts

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const pricesFetched = formatMoment(snapshot.pricesFetchedAt);
const BOOTS = ["04:10", "10:10", "16:10", "22:10"];
const dayAt = (hhmm: string) => {
	const [h, m] = hhmm.split(":").map(Number) as [number, number];
	return `${((h * 60 + m) / 1440) * 100}%`;
};

/** A moment to the second; its title and datetime keep every digit. */
function When(props: { at: ReturnType<typeof formatMoment> }) {
	const m = props.at;
	return (
		<time datetime={m.iso} title={m.full}>
			{m.date} {m.second} UTC
		</time>
	);
}

// ---------------------------------------------------------------- one unit per table row

const SI_RATE: [number, ByteUnit][] = [
	[1e12, "TB"],
	[1e9, "GB"],
	[1e6, "MB"],
	[1e3, "kB"],
	[0, "B"],
];

type Fig = { shown: Shown; p5: Shown; p95: Shown; count: number };

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

/** A figure's 5th to 95th percentile span, low to high. */
function spread(fig: Fig): [Shown, Shown] {
	return fig.p5.value <= fig.p95.value ? [fig.p5, fig.p95] : [fig.p95, fig.p5];
}

// ---------------------------------------------------------------- the exchange's facts

// The exchange asks about the one Series whose own file the snapshot keeps, so its answer can be
// cited all the way down: the figure in series.json, the Series file, one Run's evidence.
const askedSeries = series.find((row) => row.id === seriesFileContents.sample.id)!;
const askedRow = headline.find((row) => row.cells.some((cell) => cell.series.id === askedSeries.id));
if (!askedRow) throw new Error(`the sample Series ${askedSeries.id} is not a headline figure`);
const ASKED_MACHINE = askedSeries.instance_type;
const askedIndex = askedRow.cells.findIndex((cell) => cell.series.id === askedSeries.id);
const askedFig = rowFigures(askedRow)[askedIndex]!;
const askedPer: { count: number; of: string } =
	askedRow.choice.per ??
	(() => {
		throw new Error("the exchange's answer expects a figure per critical section");
	})();
const askedMachine = machineOf(ASKED_MACHINE);
const askedPrice = formatUsd(askedMachine.price.usdPerHour, { per: "hour" });
const askedDerivation = askedSeries.derivations.series_v1;
const askedOldest = formatMoment(askedSeries.oldest_run_started_at);
const askedNewest = formatMoment(askedSeries.newest_run_started_at);
const askedRun = seriesFileContents.point.example;
const askedRunAt = formatMoment(askedRun.started_at);
const askedSeriesIndex = series.indexOf(askedSeries);
const askedRaw = askedFig.shown.source.replace(/ ns$/, "");

/** The widest integer part in a row, so its figures' decimal points line up down a column. */
function intWidth(figs: Fig[]): string {
	return `--int: ${Math.max(...figs.map((f) => f.shown.full.split(".")[0]!.length))}ch`;
}

/**
 * What stands behind a cell, in its figure's title: its Runs and their dates, its p5 to p95, and
 * its field in the Series list. The figure itself links to the Series' own file, every Run's
 * figure and evidence.
 */
function cellTitle(fig: Fig, series: HeadlineRow["cells"][number]["series"]): string {
	const [lo, hi] = spread(fig);
	const from = formatMoment(series.oldest_run_started_at).date;
	const to = formatMoment(series.newest_run_started_at).date;
	return `Median of ${formatCount(fig.count).full} Runs, ${from} to ${to}\np5–p95 ${lo.full} – ${hi.full} ${fig.shown.unit}\nseries.json: ${fig.shown.source}\nOpen: this Series' Runs and evidence`;
}

/** A few words on a group whose figures come from something the machines share. */
const GROUP_NOTE: Partial<Record<Section, string>> = {
	Disk: "the root EBS gp3 volume",
	Network: "S3, same Region",
};
const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
const sectionId = (s: Section) => `group-${s.toLowerCase().replace(/ /g, "-")}`;

/**
 * Every digit of a figure, its first four significant digits set heavier so a row scans, the
 * integer part in a box of fixed width so the decimal points line up down a column.
 */
function Exact(props: { full: string }) {
	const full = props.full;
	let k = full.length;
	for (let i = 0, sig = 0; i < full.length; i++) {
		const c = full[i]!;
		if (c >= "0" && c <= "9" && (sig > 0 || c !== "0")) sig++;
		if (sig === 4) {
			k = i + 1;
			break;
		}
	}
	const dot = full.includes(".") ? full.indexOf(".") : full.length;
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

/** A figure's median and its 5th to 95th percentile span, drawn to the row's scale from zero. */
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

/** A URL as text that breaks only after a slash, never inside its scheme and host. */
function Breakable(props: { text: string }) {
	const parts = props.text.split(/(?<=[^/:]\/)/);
	return (
		<>
			{parts.map((part, i) => (
				<>
					{part}
					{i < parts.length - 1 ? <wbr /> : null}
				</>
			))}
		</>
	);
}

/**
 * One citation, on one line: the file (a link, its path shown without the host), the field in
 * it (its whole path in the title), and what the answer took from there.
 */
function Source(props: { href: string; field: string; path: string; children: JSX.Element }) {
	const file = props.href.replace(/^https:\/\/[^/]+\//, "");
	return (
		<li class="src">
			<a class="src-file" href={props.href}>
				<Breakable text={file} />
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
			<header class="masthead">
				<div class="wrap masthead-row">
					<a href="#top" class="wordmark">
						<span class="wordmark-glyph" aria-hidden="true">
							L
						</span>
						LedgerMath
					</a>
					<nav aria-label="On this page" class="nav">
						<a href="#numbers">Numbers</a>
						<a href="#api">API</a>
						<a href="#provenance">Provenance</a>
					</nav>
				</div>
			</header>

			<main id="top">
				<section class="hero wrap" aria-labelledby="title">
					<div class="hero-text">
						<h1 id="title">
							<span class="sr-only">LedgerMath: </span>
							<span class="h1-line">Measured AWS server benchmarks, for AI agents to cite.</span>
						</h1>
						<p class="lede">
							{formatCount(snapshot.benchmarkCount).full} benchmarks on {formatCount(snapshot.machineCount).full} freshly booted machine types in {snapshot.region}, four
							times a day. Every Run kept, with its evidence.
						</p>
						<div class="way-in" id="api">
							<div class="way-row" data-copy-block="the index command">
								<span class="way-tag">shell</span>
								<pre tabindex="0">
									<code data-copy>
										curl <Breakable text={links.index} />
									</code>
								</pre>
							</div>
							<div class="way-row" data-copy-block="the agent prompt">
								<span class="way-tag">agent</span>
								<p data-copy>
									Read <Breakable text={links.index} /> and cite each figure's file and field.
								</p>
							</div>
						</div>
						<p class="way-note">
							Static JSON, no key. <a href={links.docs}>Docs</a>
						</p>
					</div>

					<dl class="facts-line">
							<div>
								<dt>Newest Run</dt>
								<dd>
									<a href="#provenance">
										<time datetime={newest.iso} title={newest.full}>
											{newest.date} <span class="nowrap">{newest.minute} UTC</span>
										</time>
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

					<section class="exchange" id="example" aria-labelledby="exchange-title">
						<h2 id="exchange-title" class="sr-only">
							Example
						</h2>
						<div class="turn turn-q">
							<span class="mark" aria-hidden="true">
								Q
							</span>
							<blockquote class="question">
								<p>
									On <span class="nowrap">{ASKED_MACHINE}</span>, how long is one uncontended mutex lock and unlock, and the hourly price?
								</p>
							</blockquote>
						</div>
						<div class="turn turn-a">
							<span class="mark" aria-hidden="true">
								A
							</span>
							<blockquote class="answer">
								<p class="ans">
									<strong class="fig">
										{askedFig.shown.full}&nbsp;{askedFig.shown.unit}
									</strong>{" "}
									<span class="nowrap">per {askedPer.of}</span>
								</p>
								<p class="answer-sub">
									Median of {formatCount(askedFig.count).full} Runs, <time datetime={askedOldest.iso}>{askedOldest.date}</time> to{" "}
									<time datetime={askedNewest.iso}>{askedNewest.date}</time>, {formatCount(askedDerivation.failed_runs).full} failed
								</p>
								<p class="ans">
									<strong class="fig">${askedPrice.full}</strong> per instance-hour
								</p>
							</blockquote>
						</div>
						<ol class="srcs" aria-label="Sources">
							<Source
								href={links.seriesList}
								field={`${askedSeries.id} › p50`}
								path={`/series/${askedSeriesIndex}/derivations/series_v1/percentiles/time_per_repetition_ns/p50`}
							>
								{askedRaw}&nbsp;÷&nbsp;
								<abbr title={`${formatCount(askedPer.count).full} ${askedPer.of}s in one repetition`}>{formatCount(askedPer.count).full}</abbr>
							</Source>
							<Source href={askedSeries.url} field="points[0].evidence" path="/derivations/series_v1/points/0/evidence">
								<a href={askedRun.evidence} title={`Run ${askedRun.run}, ${askedRunAt.full}`}>
									Example Run {askedRunAt.date}
								</a>
							</Source>
							<Source href={links.prices} field="…/pricePerUnit/USD" path={askedMachine.price.path.pointer}>
								"{askedMachine.price.usdPerHour}"
							</Source>
						</ol>
					</section>
				</section>

				<section id="numbers" class="numbers wrap" aria-labelledby="numbers-title">
					<div class="numbers-head">
						<h2 id="numbers-title">
							{formatCount(headline.length).full} benchmarks × {formatCount(machines.length).full} machines
						</h2>
						<ul class="key" aria-label="Key">
							<li>
								<span class="key-bar bar" aria-hidden="true">
									<span class="bar-p50" style={{ width: "100%" }} />
								</span>
								median
							</li>
							<li>
								<span class="key-bar key-band bar" aria-hidden="true">
									<span class="bar-span" style={{ left: "50%", width: "100%" }} />
								</span>
								p5–p95
							</li>
							<li>each benchmark from 0</li>
							<li>
								<span class="dir">↑</span> higher is faster
							</li>
							<li>
								<span class="dir">↓</span> lower is faster
							</li>
						</ul>
					</div>

					<nav class="jump" aria-label="Benchmark groups">
						{SECTIONS.map((section) => (
							<a href={`#${sectionId(section)}`}>{section === "Operating system" ? "OS" : section}</a>
						))}
					</nav>

					<div class="table-box" role="region" aria-label="The headline figures, 14 benchmarks on 5 machine types" tabindex="0">
						<table class="headline">
							<colgroup>
								<col class="col-bench" />
								{machines.map(() => (
									<col class="col-machine" />
								))}
							</colgroup>
							<thead>
								<tr>
									<th scope="col" class="th-corner">
										<a href={links.prices} title={`AWS On-Demand prices, copied ${pricesFetched.full}`}>
											On-Demand, {snapshot.region}
										</a>
									</th>
									{machines.map((m) => {
										const price = formatUsd(m.price.usdPerHour, { per: "hour" });
										return (
											<th scope="col" class="th-machine">
												<span class="th-code">{m.instanceType.split(".")[0]}</span>
												<span class="th-type" title={`${m.processor}, ${m.clockSpeed}`}>
													{m.instanceType}
												</span>
												<span class="th-spec">
													{m.vcpu}&thinsp;vCPU · {m.memory}
												</span>
												<span class="th-price" title={`${m.price.description} · ${m.price.path.pointer}`}>
													${price.full}/h
												</span>
											</th>
										);
									})}
								</tr>
							</thead>
							{SECTIONS.map((section) => {
								const rows = headline.filter((row) => row.choice.section === section);
								const note = GROUP_NOTE[section];
								return (
									<tbody id={sectionId(section)}>
										<tr class="section-row">
											<th scope="colgroup" colspan={machines.length + 1}>
												{section}
												{note ? <span class="section-note"> · {note}</span> : null}
											</th>
										</tr>
										{rows.map((row) => {
											const figs = rowFigures(row);
											const max = Math.max(...figs.map((f) => Math.max(f.p5.value, f.p95.value)));
											const up = row.choice.lead === "rate";
											return (
												<tr class="row" style={intWidth(figs)}>
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
														const asked = row === askedRow && cell.machine.instanceType === ASKED_MACHINE;
														return (
															<td class={asked ? "fig-cell is-asked" : "fig-cell"}>
																<span class="cell-code" aria-hidden="true">
																	{cell.machine.instanceType.split(".")[0]}
																</span>
																{asked ? (
																	<a class="ref" href="#example" aria-label="A, the example answer above" title="The example answer">
																		A
																	</a>
																) : null}
																<span class="cell-fig">
																	<a
																		class="fig-link"
																		href={links.seriesFile(cell.series)}
																		title={cellTitle(fig, cell.series)}
																		aria-label={`${cell.machine.instanceType}: median ${fig.shown.full} ${fig.shown.unit} of ${formatCount(fig.count).full} Runs, its Series file`}
																	>
																		<Exact full={fig.shown.full} />
																	</a>
																</span>
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
				</section>

				<section id="provenance" class="provenance wrap" aria-labelledby="provenance-title">
					<h2 id="provenance-title">Provenance</h2>
					<div class="day">
						<span class="day-label">scheduled boots, UTC</span>
						<div class="day-line">
							{BOOTS.map((t) => (
								<span class="boot" style={{ left: dayAt(t) }}>
									<span class="boot-dot" aria-hidden="true" />
									<span class="boot-time">{t}</span>
								</span>
							))}
							<span class="newest" style={{ left: dayAt(newest.minute) }}>
								<span class="newest-label">
									newest Run{" "}
									<time datetime={newest.iso} title={newest.full}>
										{newest.minute}
									</time>
								</span>
								<span class="newest-tick" aria-hidden="true" />
							</span>
						</div>
					</div>
					<dl class="facts">
						<div>
							<dt>Runs</dt>
							<dd>
								{formatCount(snapshot.runCount).full}
							</dd>
						</div>
						<div>
							<dt>Oldest Run</dt>
							<dd>
								<When at={oldest} />
							</dd>
						</div>
						<div>
							<dt>Failed Runs</dt>
							<dd>{formatCount(snapshot.failedRuns).full}</dd>
						</div>
					</dl>
				</section>
			</main>

			<footer class="footer">
				<div class="wrap footer-row">
					<strong>LedgerMath</strong>
					<ul>
						<li>
							<a href={links.docs}>Docs</a>
						</li>
						<li>
							<a href={links.seriesList} title={snapshot.methods.map((m) => `${m.name} v${m.version}`).join(", ")}>
								Methods
							</a>
						</li>
						<li>
							<a href="third-party-notices.txt">Font notices</a>
						</li>
					</ul>
				</div>
			</footer>
		</>
	);
}
