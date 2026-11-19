// Design v7, "Agent conversation": the page opens on a question a developer puts to their
// agent and the agent's answer, every figure in it cited to the API file and field it came
// from. Then the same numbers for the reader: the headline table, the way in, the machines,
// and where the figures come from. Every figure is the data module's, exactly. Full form: one
// table serves desktop and phone, and what each row repeated is said once, in the key.
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
const askedOldest = formatMoment(askedSeries.oldest_run_started_at);
const askedNewest = formatMoment(askedSeries.newest_run_started_at);
const pricePath = links.prices.replace(/^https:\/\/[^/]+\//, "");
const seriesListPath = links.seriesList.replace(/^https:\/\/[^/]+\//, "");

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const pricesFetched = formatMoment(snapshot.pricesFetchedAt);
const BOOTS = ["04:10", "10:10", "16:10", "22:10"];

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

/** The span as text, rounded to four digits, with every digit in its title. */
function Spread(props: { fig: Fig }) {
	const [lo, hi] = spread(props.fig);
	return (
		<span class="spread" title={`5th to 95th percentile: ${lo.full} to ${hi.full} ${lo.unit}`}>
			{lo.short}–{hi.short}
		</span>
	);
}

/** The widest integer part in a row, so its figures' decimal points line up across the row. */
function intWidth(figs: Fig[]): string {
	return `--int: ${Math.max(...figs.map((f) => f.shown.full.split(".")[0]!.length))}ch`;
}

/** A sentence's first word in lower case, unless it is a name or a figure ("SHA-256", "10,000"). */
function lowerFirst(text: string): string {
	return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/**
 * What a row's unit is of, and which way is faster, for the line under its name. Only a divided
 * figure says what it is of: every other row's description already does.
 */
function rowUnit(row: HeadlineRow, unit: string): { unit: string; of: string; better: string } {
	if (row.choice.lead === "rate") return { unit, of: "", better: "higher is faster" };
	if (row.choice.per) return { unit, of: `per ${row.choice.per.of}: one repetition is ${lowerFirst(row.choice.repetition).replace(/\.$/, "")}, divided exactly`, better: "lower is faster" };
	return { unit, of: "", better: "lower is faster" };
}

/** A machine type's family code ("c8a"), the short name a phone's table rows go by. */
const code = (instanceType: string) => instanceType.split(".")[0]!;

/**
 * Where a benchmark's one-sentence description reads as a rate but its figure is a time, the
 * page says what the figure is instead. (Reported for the data module's own words.)
 */
const WHAT: Record<string, string> = {
	disk_read_io_uring: "The time per completed direct 4 KiB read from the root EBS gp3 volume, with 64 kept submitted through io_uring.",
};

/** A few words on a group of rows whose figures come from something the machines share. */
const GROUP_NOTE: Partial<Record<Section, string>> = {
	Disk: "All four rows measure the root EBS gp3 volume each machine booted from, not the machine type's own disks: random reads reach the volume's IOPS limit, the sequential read its throughput limit.",
	Network: "One request to S3 in the same Region: its time runs through AWS's network and S3 as well as the machine.",
};

/** What each Method is for, in a few words drawn from its own definitions. */
const METHOD_WORDS: Record<string, string> = {
	series: "time per repetition, bytes per second, percentiles",
	requests: "each request's phases",
};

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

function cellTitle(fig: Fig, machine: string): string {
	return `${machine}: ${fig.shown.full} ${fig.shown.unit}, the median of ${fig.count} counted Runs (5th percentile ${fig.p5.full}, 95th ${fig.p95.full} ${fig.shown.unit}). As the API holds it: ${fig.shown.source}.`;
}

/**
 * Every digit of a figure, its first four significant digits set heavier so a row scans, the
 * integer part in a box of fixed width so the decimal points line up down a column. Nothing is
 * rounded: the heavy digits are the figure's own leading digits.
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
	const [, host, path] = /^(https:\/\/[^/]+\/)(.*)$/.exec(props.href) ?? ["", "", props.href];
	return (
		<a class="url" href={props.href}>
			<span class="url-host">{host}</span>
			<span class="url-path">{path}</span>
		</a>
	);
}

// ---------------------------------------------------------------- the page

// the key under the table shows a real figure: the first row's, on the first machine
const keyFigure = rowFigures(headline[0]!)[0]!.shown;

export default function Page() {
	return (
		<>
			<header class="masthead">
				<div class="wrap masthead-row">
					<div class="brand">
						<a href="#top" class="wordmark">
							<span class="wordmark-glyph" aria-hidden="true">
								L
							</span>
							LedgerMath
						</a>
					</div>
					<nav aria-label="On this page" class="nav">
						<a href="#numbers">Numbers</a>
						<a href="#api">For agents</a>
						<a href="#machines">Machines</a>
						<a href="#provenance">Provenance</a>
					</nav>
					<p class="fresh">
						<span class="pulse" aria-hidden="true" />
						<span class="fresh-word">Newest Run</span>
						<time datetime={newest.iso} title={newest.full}>
							<span class="fresh-date">{newest.date} </span>
							{newest.minute} UTC
						</time>
					</p>
				</div>
			</header>

			<main id="top">
				<section class="intro wrap" aria-labelledby="title">
					<h1 id="title">
						<span class="h1-name">LedgerMath</span>
						<span class="h1-line">Measured AWS server benchmarks, published for AI agents to read and cite.</span>
					</h1>
					<p class="lede">
						Four times a day it boots {formatCount(snapshot.machineCount).full} AWS machine types in {snapshot.region}, runs {formatCount(snapshot.benchmarkCount).full} benchmarks on each
						freshly booted machine, and keeps every Run with its evidence. The figures, and AWS's hourly prices, are static JSON at <code>api.ledgermath.com</code>.
					</p>
					<ul class="strip" aria-label="What the API holds">
						<li>
							<a href="#numbers">
								<span class="strip-big">
									{formatCount(snapshot.benchmarkCount).full} × {formatCount(snapshot.machineCount).full}
								</span>
								<span class="strip-small">benchmarks × machine types</span>
							</a>
						</li>
						<li>
							<a href="#provenance">
								<span class="strip-big">{formatCount(snapshot.runCount).full}</span>
								<span class="strip-small">Runs kept, with evidence</span>
							</a>
						</li>
						<li>
							<a href="#provenance">
								<span class="strip-big">
									<time datetime={newest.iso} title={newest.full}>
										{newest.minute}
									</time>{" "}
									<span class="strip-unit">UTC</span>
								</span>
								<span class="strip-small">newest Run, {newest.date}</span>
							</a>
						</li>
						<li>
							<a href="#machines">
								<span class="strip-big">
									${formatUsd(machines[0]!.price.usdPerHour).full}–${formatUsd(machines[machines.length - 1]!.price.usdPerHour).full}
								</span>
								<span class="strip-small">an hour On-Demand, <span class="nowrap">{snapshot.priceDate}</span></span>
							</a>
						</li>
						<li class="strip-api" data-copy-block="the index address">
							<span class="strip-label">
								<span class="verb">GET</span> the way in
							</span>
							<a class="strip-url" href={links.index} data-copy>
								<Breakable text={links.index} />
							</a>
						</li>
					</ul>
				</section>

				<section class="exchange" aria-labelledby="exchange-title">
					<div class="wrap">
						<div class="exchange-grid">
							<h2 id="exchange-title" class="kicker">
								<span class="kicker-rule" aria-hidden="true" />
								<span class="kicker-main">An example question, answered from the API</span>
								<span class="kicker-side">Written for this page; every figure read from the API</span>
							</h2>
							<div class="turns">
								<figure class="turn turn-q">
									<figcaption class="who">
										<span class="mark" aria-hidden="true">
											Q
										</span>
										<span>A developer, to their agent</span>
									</figcaption>
									<blockquote class="question">
										<p>
											On a <span class="nowrap">{ASKED_MACHINE}</span> in {askedMachine.region}, how long does one core take to sort 1&nbsp;MiB of 64-bit keys, and what does an
											hour cost?
										</p>
									</blockquote>
								</figure>

								<figure class="turn turn-a">
									<figcaption class="who">
										<span class="mark" aria-hidden="true">
											A
										</span>
										<span>The agent, after reading three files</span>
									</figcaption>
									<blockquote class="answer">
										<p class="answer-lead">
											<strong class="fig">
												{p50.full}&nbsp;{p50.unit}
											</strong>{" "}
											a sort,
											<Cite n={1} />
											<Cite n={2} /> and{" "}
											<strong class="fig">${askedPrice.full}</strong> an hour.
											<Cite n={3} />
										</p>
										<p>
											That is the median of {formatCount(askedFigure.count).full} counted Runs, from {askedOldest.longDate} to {askedNewest.longDate}. The 5th and 95th percentiles are{" "}
											<span class="fig-q">
												{p5.full}&nbsp;{p5.unit}
											</span>{" "}
											and{" "}
											<span class="fig-q">
												{p95.full}&nbsp;{p95.unit}
											</span>
											, and {askedDerivation.failed_runs === 0 ? "no Run failed" : `${formatCount(askedDerivation.failed_runs).full} Runs failed`}.
											<Cite n={1} /> The price is AWS's On-Demand Linux rate there, copied on {formatMoment(`${snapshot.priceDate}T00:00:00Z`).longDate}.
											<Cite n={3} />
										</p>
										<p class="answer-limit">Those are measured figures for one setting. I haven't compared machines or worked out a cost per sort.</p>
									</blockquote>
								</figure>
							</div>

							<details class="trace fold" open>
								<summary class="fold-head">
									<h3 class="trace-title">The files it read, in order</h3>
									<span class="fold-count">3 GETs</span>
								</summary>
								<ol class="reads">
									<li id="read-1">
										<div class="read-head">
											<span class="read-n">1</span>
											<span class="verb">GET</span>
										</div>
										<Url href={links.seriesList} />
										<p class="read-note">
											Every Series, {formatCount(snapshot.seriesCount).full} rows. It kept the one for{" "}
											<code>
												{ASKED_BENCHMARK}, size_bytes {String(askedSeries.params.size_bytes)}, {askedSeries.build}, {ASKED_MACHINE}
											</code>
											: Series <code>{askedSeries.id}</code>.
										</p>
									</li>
									<li id="read-2">
										<div class="read-head">
											<span class="read-n">2</span>
											<span class="verb">GET</span>
										</div>
										<Url href={askedSeries.url} />
										<p class="read-note">
											That Series' own file: its {formatCount(askedSeries.runs).full} Runs, each with its evidence.
										</p>
									</li>
									<li id="read-3">
										<div class="read-head">
											<span class="read-n">3</span>
											<span class="verb">GET</span>
										</div>
										<Url href={links.prices} />
										<p class="read-note">
											AWS's On-Demand prices, copied{" "}
											<time datetime={snapshot.pricesFetchedAt} title={pricesFetched.full}>
												{pricesFetched.date} {pricesFetched.minute} UTC
											</time>

											.
										</p>
									</li>
								</ol>
								<p class="trace-foot">
									Three static files. <a href="#api">Point your agent at the same API</a>.
								</p>
							</details>

							<details class="ledger-wrap fold">
								<summary class="fold-head">
									<h3 class="ledger-title">Every figure in the answer, and where its file holds it</h3>
									<span class="fold-count">5 lines</span>
								</summary>
								<div class="ledger-box">
									<table class="ledger">
										<thead>
											<tr>
												<th scope="col">File</th>
												<th scope="col">Figure</th>
												<th scope="col">Field</th>
												<th scope="col" class="num">
													In the file
												</th>
												<th scope="col" class="num">
													In the answer
												</th>
											</tr>
										</thead>
										<tbody>
											{[
												["Median, one sort", p50, "p50"],
												["5th percentile", p5, "p5"],
												["95th percentile", p95, "p95"],
											].map(([label, shown, key]) => (
												<tr>
													<td>
														<Cite n={1} />
													</td>
													<th scope="row">{label as string}</th>
													<td class="l-field">
														<code>
															…percentiles.time_per_repetition_ns.<b>{key as string}</b>
														</code>
													</td>
													<td class="num l-raw">
														<code>{(shown as Shown).source}</code>
													</td>
													<td class="num">
														<span class="val">{(shown as Shown).full}</span> <span class="unit">{(shown as Shown).unit}</span>
													</td>
												</tr>
											))}
											<tr>
												<td>
													<Cite n={1} />
												</td>
												<th scope="row">Runs counted, failed</th>
												<td class="l-field">
													<code>
														…series_v1.<b>counted_runs</b>, <b>failed_runs</b>
													</code>
												</td>
												<td class="num l-raw">
													<code>
														{askedDerivation.counted_runs}, {askedDerivation.failed_runs}
													</code>
												</td>
												<td class="num">
													<span class="val">
														{formatCount(askedDerivation.counted_runs).full}, {formatCount(askedDerivation.failed_runs).full}
													</span>
												</td>
											</tr>
											<tr>
												<td>
													<Cite n={3} />
												</td>
												<th scope="row">On-Demand, per hour</th>
												<td class="l-field">
													<code title={askedMachine.price.path.pointer}>
														…{askedMachine.price.rateCode}/<b>pricePerUnit/USD</b>
													</code>
												</td>
												<td class="num l-raw">
													<code>"{askedMachine.price.usdPerHour}"</code>
												</td>
												<td class="num">
													<span class="val">${askedPrice.full}</span> <span class="unit">/hour</span>
												</td>
											</tr>
										</tbody>
									</table>
								</div>
								<p class="ledger-note">
									The answer moves the decimal point from nanoseconds to microseconds and drops the price's trailing zeros. Nothing is rounded.
								</p>
							</details>
						</div>
					</div>
				</section>

				<section id="numbers" class="numbers wrap" aria-labelledby="numbers-title">
					<div class="section-head">
						<h2 id="numbers-title">The same numbers, for you</h2>
						<p>Each benchmark at one setting on all five machine types: the median of each Series' counted Runs, every digit as the API holds it. The answer above is marked.</p>
					</div>

					<ul class="key" aria-label="How to read a figure">
						<li>
							<span class="key-fig">
								<Exact full={keyFigure.full} />
							</span>
							<span>
								the median, every digit; the first four heavy
								<span class="key-dir">
									<span class="better up" role="img" aria-label="higher" /> higher or <span class="better down" role="img" aria-label="lower" /> lower is faster
								</span>
							</span>
						</li>
						<li>
							<span class="key-bar bar" aria-hidden="true">
								<span class="bar-p50" style={{ width: "64%" }} />
								<span class="bar-span" style={{ left: "54%", width: "22%" }} />
							</span>
							<span>the median, to the row's scale from zero; in red, its 5th to 95th percentile span, printed beneath</span>
						</li>
						<li>
							<span class="runs-link">n={formatCount(askedFigure.count).full}</span>
							<span>counted Runs: opens the Series' file, every Run with its evidence</span>
						</li>
					</ul>

					<nav class="jump" aria-label="Benchmark groups">
						{SECTIONS.map((section) => (
							<a href={`#group-${section.toLowerCase().replace(/ /g, "-")}`}>{section === "Operating system" ? "OS" : section}</a>
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
									<th scope="col" class="th-bench">
										Benchmark<span class="th-sub">, its unit, what it measures</span>
									</th>
									{machines.map((m) => {
										const price = formatUsd(m.price.usdPerHour, { per: "hour" });
										return (
											<th scope="col" class={m.instanceType === ASKED_MACHINE ? "th-machine is-asked" : "th-machine"}>
												<span class="th-code" aria-hidden="true">
													{code(m.instanceType)}
												</span>
												<span class="th-type">{m.instanceType}</span>
												<span class="th-spec">
													{m.vcpu} vCPU · {m.memory}
												</span>
												<span class="th-price" title={`${price.source}: ${m.price.description}`}>
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
									<tbody id={`group-${section.toLowerCase().replace(/ /g, "-")}`}>
										<tr class="section-row">
											<th scope="colgroup" colspan={machines.length + 1}>
												{section}
											</th>
										</tr>
										{note ? (
											<tr class="group-note">
												<td colspan={machines.length + 1}>
													<p>{note}</p>
												</td>
											</tr>
										) : null}
										{rows.map((row) => {
											const figs = rowFigures(row);
											const max = Math.max(...figs.map((f) => Math.max(f.p5.value, f.p95.value)));
											const u = rowUnit(row, figs[0]!.shown.unit);
											return (
												<tr class="row" style={intWidth(figs)}>
													<th scope="row" class="bench">
														<span class="bench-label">{row.choice.label}</span>
														<span class="bench-unit">
															<span class={row.choice.lead === "rate" ? "better up" : "better down"} role="img" aria-label={u.better} />
															<b>{u.unit}</b>
															{u.of ? ` ${u.of}` : ""}
														</span>
														<span class="bench-what">
															{WHAT[row.choice.benchmark] ?? row.choice.what} <span class="bench-meta">{row.choice.setting}</span>
														</span>
													</th>
													{row.cells.map((cell, i) => {
														const fig = figs[i]!;
														const asked = row === askedRow && cell.machine.instanceType === ASKED_MACHINE;
														const cls = asked ? "fig-cell is-asked" : "fig-cell";
														return (
															<td class={cls} title={cellTitle(fig, cell.machine.instanceType)}>
																<div class="fig-in">
																	<span class="cell-code" aria-hidden="true">
																		{code(cell.machine.instanceType)}
																	</span>
																	<span class="fig-num">
																		<Exact full={fig.shown.full} />
																		<span class="sr"> {fig.shown.unit}</span>
																	</span>
																	<Bar fig={fig} max={max} />
																	<span class="fig-sub">
																		<Spread fig={fig} />
																		<span class="runs">
																			<a
																				class="runs-link"
																				href={links.seriesFile(cell.series)}
																				aria-label={`n=${formatCount(fig.count).full} counted Runs: the Series file for ${cell.machine.instanceType}`}
																			>
																				n={formatCount(fig.count).full}
																			</a>
																			{asked ? <span class="asked-tag"> · the answer</span> : null}
																		</span>
																	</span>
																</div>
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

				<section id="api" class="api" aria-labelledby="api-title">
					<div class="wrap api-grid">
						<div class="api-copy">
							<h2 id="api-title">Point your agent here</h2>
							<p>
								Static JSON: a table of contents, one file listing every Series with its figures, a file for each Series with its Runs and their evidence, and AWS's
								On-Demand prices, copied daily. Each kind of file has a schema; a plain GET reads it.
							</p>
							<div class="api-say-label">Or tell your agent:</div>
							<blockquote class="api-say" data-copy-block="the prompt">
								<p>
									Use the LedgerMath data API at <Breakable text={links.index} />. Answer from the figures in its files, and name the file and field each figure came from.
								</p>
							</blockquote>
						</div>
						<div class="api-code">
							<div class="term">
								<div class="term-bar">
									<span>shell</span>
									<span>plain GET, no key</span>
								</div>
								{[
									[`the table of contents`, links.index, "the index command"],
									[`every Series (${formatCount(snapshot.seriesCount).full})`, links.seriesList, "the Series list command"],
									[`the day's prices`, links.prices, "the prices command"],
								].map(([comment, url, name]) => (
									<div class="cmd" data-copy-block={name}>
										<p class="c"># {comment}</p>
										<pre tabindex="0">
											<code>
												<span class="p">$ </span>
												<span data-copy>
													curl <Breakable text={url!} />
												</span>
											</code>
										</pre>
									</div>
								))}
							</div>
							<ul class="schemas">
								{links.schemas.map((s) => (
									<li>
										<a href={s.url}>
											<code>{s.name}</code>
										</a>{" "}
										<span>{s.describes}</span>
									</li>
								))}
								<li>
									<a href={links.docs}>Documentation</a>
								</li>
							</ul>
						</div>
					</div>
				</section>

				<section id="machines" class="machines wrap" aria-labelledby="machines-title">
					<div class="section-head">
						<h2 id="machines-title">The five machines, and what an hour costs</h2>
						<p>
							AWS's hourly On-Demand price for Linux in {snapshot.region}, from the price file of {snapshot.priceDate}
							<Cite n={3} />. Cheapest first.
						</p>
					</div>
					<ul class="machine-list">
						{machines.map((m) => {
							const price = formatUsd(m.price.usdPerHour, { per: "hour" });
							return (
								<li class={m.instanceType === ASKED_MACHINE ? "machine is-asked" : "machine"}>
									<div class="machine-id">
										<h3 class="machine-type">{m.instanceType}</h3>
										<p class="machine-family">{m.family}</p>
{m.instanceType === ASKED_MACHINE ? <p class="asked-tag">Priced in the answer above</p> : null}
									</div>
									<dl class="machine-specs">
										<div>
											<dt>vCPU</dt>
											<dd>{m.vcpu}</dd>
										</div>
										<div>
											<dt>Memory</dt>
											<dd>{m.memory}</dd>
										</div>
										<div class="wide">
											<dt>Processor</dt>
											<dd>
												{m.processor}, {m.clockSpeed}
											</dd>
										</div>
										<div>
											<dt>Network</dt>
											<dd>{m.network}</dd>
										</div>
										<div>
											<dt>Storage</dt>
											<dd>{m.storage}</dd>
										</div>
									</dl>
									<div class="machine-price">
										<div class="price" title={`${m.price.description} · ${m.price.path.pointer}`}>
											<span class="price-cur">$</span>
											{price.full}
											<span class="price-per">/hour</span>
										</div>
									</div>
								</li>
							);
						})}
					</ul>
				</section>

				<section id="provenance" class="provenance" aria-labelledby="provenance-title">
					<div class="wrap">
						<div class="section-head">
							<h2 id="provenance-title">Where every figure comes from</h2>
							<p>Every figure is a Method's summary of kept Runs, each with what the benchmark printed and what was recorded about the machine.</p>
						</div>

						<div class="day">
							<div class="day-label">Machines boot four times a day, UTC; the benchmarks run after each boot</div>
							<div class="day-line">
								{BOOTS.map((t) => {
									const [h, mm] = t.split(":").map(Number) as [number, number];
									return (
										<span class="boot" style={{ left: `${((h * 60 + mm) / 1440) * 100}%` }}>
											<span class="boot-dot" aria-hidden="true" />
											<span class="boot-time">{t}</span>
										</span>
									);
								})}
								{(() => {
									const [h, mm] = newest.minute.split(":").map(Number) as [number, number];
									return (
										<span class="newest" style={{ left: `${((h * 60 + mm) / 1440) * 100}%` }}>
											<span class="newest-tick" aria-hidden="true" />
											<span class="newest-label">newest Run {newest.second}</span>
										</span>
									);
								})()}
								<span class="hour h0" aria-hidden="true">
									00:00
								</span>
								<span class="hour h24" aria-hidden="true">
									24:00
								</span>
							</div>
						</div>

						<dl class="facts">
							<div>
								<dt>Newest Run</dt>
								<dd>
									<time datetime={newest.iso}>{newest.full}</time>
								</dd>
							</div>
							<div>
								<dt>Oldest Run</dt>
								<dd>
									<time datetime={oldest.iso}>{oldest.full}</time>
								</dd>
							</div>
							<div>
								<dt>Runs</dt>
								<dd>
									<span class="fact-big">{formatCount(snapshot.runCount).full}</span> {formatCount(snapshot.countedRuns).full} counted, {formatCount(snapshot.failedRuns).full}{" "}
									failed
								</dd>
							</div>
							<div>
								<dt>Series</dt>
								<dd>
									<span class="fact-big">{formatCount(snapshot.seriesCount).full}</span> a benchmark, setting, build, machine type and zone each
								</dd>
							</div>
							<div>
								<dt>Prices copied</dt>
								<dd>
									<time datetime={snapshot.pricesFetchedAt}>{pricesFetched.full}</time>
								</dd>
							</div>
						</dl>

						<div class="methods">
							<h3>The Methods</h3>
							<p>
								A versioned Method turns a Series' Runs into its figures. Their definitions are published in <a href={links.seriesList}>{seriesListPath}</a>, beside the
								figures they made.
							</p>
							<ul class="method-list">
								{snapshot.methods.map((m) => (
									<li>
										<a href={links.seriesList}>
											<code>
												{m.name} v{m.version}
											</code>
										</a>
										<span>
											{METHOD_WORDS[m.name] ?? ""} · {formatCount(Object.keys(m.definitions).length).full} definitions
										</span>
									</li>
								))}
							</ul>
							<details class="about">
								<summary class="about-label">The API, in its own words</summary>
								<p>{snapshot.about}</p>
							</details>
						</div>
					</div>
				</section>
			</main>

			<footer class="footer">
				<div class="wrap footer-row">
					<p>
						<strong>LedgerMath</strong>
					</p>
					<ul>
						<li>
							<a href={links.index}>index.json</a>
						</li>
						<li>
							<a href={links.seriesList}>{seriesListPath}</a>
						</li>
						<li>
							<a href={links.prices}>{pricePath}</a>
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

