// Design v7, "Agent conversation", spare form: the page opens on a question a developer puts to
// their agent and the agent's answer, every figure in it cited to the API file and field it came
// from (the sources folded). Then the same numbers for the reader, the machines and their prices
// at the head of the table. Every figure is the data module's, exactly. Everything else is a link.
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
	headline,
	type HeadlineRow,
	leadFigure,
	links,
	machineOf,
	machines,
	type Section,
	type Shown,
	snapshot,
} from "../../data";

// ---------------------------------------------------------------- the exchange's facts

const ASKED_BENCHMARK = "sort";
const ASKED_MACHINE = "c8a.2xlarge";

const askedRow = headline.find((row) => row.choice.benchmark === ASKED_BENCHMARK)!;
const askedCell = askedRow.cells.find((cell) => cell.machine.instanceType === ASKED_MACHINE)!;
const askedSeries = askedCell.series;
const askedFigure = leadFigure(askedRow.choice, askedSeries);
const askedMachine = machineOf(ASKED_MACHINE);
const askedUnit: DurationUnit = durationUnit(askedFigure.p50);
const p50 = formatDuration(askedFigure.p50, { unit: askedUnit });
const p5 = formatDuration(askedFigure.p5, { unit: askedUnit });
const p95 = formatDuration(askedFigure.p95, { unit: askedUnit });
const askedPrice = formatUsd(askedMachine.price.usdPerHour, { per: "hour" });
const askedDerivation = askedSeries.derivations.series_v1;

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);

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

/** The widest integer part in a row, so its figures' decimal points line up down a column. */
function intWidth(figs: Fig[]): string {
	return `--int: ${Math.max(...figs.map((f) => f.shown.full.split(".")[0]!.length))}ch`;
}

/** Every written value of a cell, for the visitor who hovers: median, span, Runs, source. */
function cellTitle(fig: Fig, machine: string): string {
	const [lo, hi] = spread(fig);
	return `${machine}: median ${fig.shown.full} ${fig.shown.unit} of ${fig.count} Runs; p5–p95 ${lo.full}–${hi.full} ${fig.shown.unit}. In the file: ${fig.shown.source}.`;
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
	const at = (s: Shown) => `${((s.value / props.max) * 100).toFixed(2)}%`;
	const [lo, hi] = spread(props.fig);
	return (
		<span class="bar" aria-hidden="true">
			<span class="bar-p50" style={{ width: at(props.fig.shown) }} />
			<span class="bar-span" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
		</span>
	);
}

/** A URL as text that breaks only after a slash. */
function Breakable(props: { text: string }) {
	const parts = props.text.split(/(?<=\/)/);
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

function Cite(props: { n: number }) {
	return (
		<a class="cite" href={`#read-${props.n}`} aria-label={`source ${props.n}`}>
			{props.n}
		</a>
	);
}

function Url(props: { href: string }) {
	const [, host, rest] = /^(https:\/\/[^/]+\/)(.*)$/.exec(props.href) ?? ["", "", props.href];
	return (
		<a class="url" href={props.href}>
			<span class="url-host">{host}</span>
			<span class="url-path">
				<Breakable text={rest!} />
			</span>
		</a>
	);
}

/** One line of a source: a field of the file, and its value there, as the file writes it. */
function Field(props: { name: string; raw: string; title?: string }) {
	return (
		<li>
			<code class="f-name" title={props.title}>
				{props.name}
			</code>
			<code class="f-raw">{props.raw}</code>
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
					<p class="fresh">
						<span class="pulse" aria-hidden="true" />
						<a href="#facts">
							<time datetime={newest.iso} title={`Newest Run: ${newest.full}`}>
								<span class="fresh-date">{newest.date} </span>
								{newest.minute} UTC
							</time>
						</a>
					</p>
				</div>
			</header>

			<main id="top">
				<section class="hero wrap" aria-labelledby="title">
					<div class="hero-text">
						<h1 id="title">
							<span class="h1-name sr-only">LedgerMath</span>
							<span class="h1-line">Measured AWS server benchmarks, for AI agents to cite.</span>
						</h1>
						<div class="way-in" data-copy-block="the index command">
							<pre tabindex="0">
								<code>
									<span class="p">$ </span>
									<span data-copy>
										curl <Breakable text={links.index} />
									</span>
								</code>
							</pre>
						</div>
						<p class="way-note">
							No key. <a href={links.docs}>Docs</a>
						</p>
						<dl class="facts-line" id="facts">
							<div>
								<dt>Runs</dt>
								<dd>
									<span title={`Oldest ${oldest.full} · newest ${newest.full}`}>{formatCount(snapshot.runCount).full}</span>
								</dd>
							</div>
							<div>
								<dt>Series</dt>
								<dd>
									<a href={links.seriesList}>{formatCount(snapshot.seriesCount).full}</a>
								</dd>
							</div>
							<div>
								<dt>Prices</dt>
								<dd>
									<a href={links.prices}>{snapshot.priceDate}</a>
								</dd>
							</div>
						</dl>
					</div>

					<section class="exchange" aria-labelledby="exchange-title">
						<h2 id="exchange-title" class="kicker">
							<span>Example</span>
							<span class="kicker-side">every figure read from the API</span>
						</h2>
						<div class="turn turn-q">
							<span class="mark" aria-hidden="true">
								Q
							</span>
							<blockquote class="question">
								<p>
									How long does one core of a <span class="nowrap">{ASKED_MACHINE}</span> take to sort 1&nbsp;MiB of 64-bit keys, and what does an hour cost?
								</p>
							</blockquote>
						</div>
						<div class="turn turn-a">
							<span class="mark" aria-hidden="true">
								A
							</span>
							<blockquote class="answer">
								<p class="answer-lead">
									<span class="ans">
										<strong class="fig">
											{p50.full}&nbsp;{p50.unit}
										</strong>{" "}
										a sort
										<Cite n={1} />
										<Cite n={2} />
									</span>{" "}
									<span class="ans">
										<strong class="fig">${askedPrice.full}</strong> an hour
										<Cite n={3} />
									</span>
								</p>
								<p class="answer-sub">
									Median of {formatCount(askedFigure.count).full} Runs, {formatCount(askedDerivation.failed_runs).full} failed.
								</p>
							</blockquote>
						</div>
						<details class="sources">
							<summary>Sources</summary>
						<ol class="reads" aria-label="The files it read">
							<li id="read-1">
								<span class="read-n">1</span>
								<div>
									<Url href={links.seriesList} />
									<ul class="fields">
										<Field name="…time_per_repetition_ns.p50" raw={p50.source} />
										<Field name="…time_per_repetition_ns.p5" raw={p5.source} />
										<Field name="…time_per_repetition_ns.p95" raw={p95.source} />
										<Field name="…series_v1.counted_runs" raw={String(askedDerivation.counted_runs)} />
									</ul>
								</div>
							</li>
							<li id="read-2">
								<span class="read-n">2</span>
								<div>
									<Url href={askedSeries.url} />
									<ul class="fields">
										<Field name="points[].evidence" raw={`${formatCount(askedSeries.runs).full} Runs`} />
									</ul>
								</div>
							</li>
							<li id="read-3">
								<span class="read-n">3</span>
								<div>
									<Url href={links.prices} />
									<ul class="fields">
										<Field name={`…${askedMachine.price.rateCode}/pricePerUnit/USD`} raw={`"${askedMachine.price.usdPerHour}"`} title={askedMachine.price.path.pointer} />
									</ul>
								</div>
							</li>
						</ol>
						</details>
					</section>
				</section>

				<section id="numbers" class="numbers wrap" aria-labelledby="numbers-title">
					<div class="numbers-head">
						<h2 id="numbers-title">The same numbers</h2>
						<ul class="key" aria-label="How to read the table">
							<li>
								<span class="key-bar bar" aria-hidden="true">
									<span class="bar-p50" style={{ width: "62%" }} />
									<span class="bar-span" style={{ left: "55%", width: "18%" }} />
								</span>
								median · p5–p95
							</li>
							<li>
								<span class="dir">↑</span> higher <span class="dir">↓</span> lower is faster
							</li>
							<li>figure → Series file</li>
						</ul>
					</div>

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
									<td class="th-corner" />
									{machines.map((m) => {
										const price = formatUsd(m.price.usdPerHour, { per: "hour" });
										return (
											<th scope="col" class={m.instanceType === ASKED_MACHINE ? "th-machine is-asked" : "th-machine"} title={`${m.processor}, ${m.clockSpeed}`}>
												<span class="th-code">{m.instanceType.split(".")[0]}</span>
												<span class="th-type">{m.instanceType}</span>
												<span class="th-spec">
													{m.vcpu}&thinsp;vCPU · {m.memory}
												</span>
												<span class="th-price" title={m.price.description}>
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
															<span class="dir" role="img" aria-label={up ? "higher is faster" : "lower is faster"}>
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
																<span class="cell-fig">
																	<a
																		class="fig-link"
																		href={links.seriesFile(cell.series)}
																		title={cellTitle(fig, cell.machine.instanceType)}
																		aria-label={`${cell.machine.instanceType}: ${fig.shown.full} ${fig.shown.unit}, its Series file`}
																	>
																		<Exact full={fig.shown.full} />
																	</a>
																	{asked ? (
																		<span class="cell-cites">
																			<Cite n={1} />
																			<Cite n={2} />
																		</span>
																	) : null}
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

			</main>

			<footer class="footer">
				<div class="wrap footer-row">
					<strong>LedgerMath</strong>
					<ul>
						<li>
							<a href={links.docs}>Docs</a>
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
