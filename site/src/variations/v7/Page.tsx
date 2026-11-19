// Design v7, "Agent conversation": the page opens on a question a developer puts to their
// agent and the agent's answer, every figure in it cited to the API file and field it came
// from. Then the same numbers for the reader: the headline table, the way in, the machines,
// and where the figures come from. Every figure is the data module's, exactly.
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

/** A sentence's first word in lower case, unless it is a name or a figure ("SHA-256", "10,000"). */
function lowerFirst(text: string): string {
	return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/** What a row's unit is of, and which way is faster, for the line under its name. */
function rowUnit(row: HeadlineRow, unit: string): { unit: string; of: string; better: string } {
	if (row.choice.lead === "rate") return { unit, of: "", better: "higher is faster" };
	if (row.choice.per) return { unit, of: `per ${row.choice.per.of}: one repetition is ${lowerFirst(row.choice.repetition).replace(/\.$/, "")}, divided exactly`, better: "lower is faster" };
	return { unit, of: `per ${lowerFirst(row.choice.repetition).replace(/\.$/, "").replace(/^one /, "")}`, better: "lower is faster" };
}

/**
 * Where a benchmark's one-sentence description reads as a rate but its figure is a time, the
 * page says what the figure is instead. (Reported for the data module's own words.)
 */
const WHAT: Record<string, string> = {
	disk_read_io_uring: "The time per completed direct 4 KiB read from the root EBS gp3 volume, with 64 kept submitted through io_uring.",
};

/** A few words on a group of rows whose figures come from something the machines share. */
const GROUP_NOTE: Partial<Record<Section, string>> = {
	Disk: "All four rows measure the root EBS gp3 volume each machine booted from, not the machine type's own disks. Where the volume's limits set the pace (in the benchmarks' own words, random 4 KiB reads reach the volume's IOPS limit, and the sequential read shows its throughput limit), the five machine types can read alike.",
	Network: "One request to S3 in the same Region. Its time runs through AWS's network and S3 as well as the machine, so the five machine types can read alike.",
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
				{intLight}
			</span>
			<span class="x-frac">
				<b>{fracHeavy}</b>
				{fracLight}
			</span>
		</span>
	);
}

/** A figure's median and its 5th to 95th percentile span, drawn to the row's scale from zero. */
function Bar(props: { fig: Fig; max: number }) {
	const at = (s: Shown) => `${((s.value / props.max) * 100).toFixed(2)}%`;
	return (
		<span class="bar" aria-hidden="true">
			<span class="bar-span" style={{ left: at(props.fig.p5), width: `calc(${at(props.fig.p95)} - ${at(props.fig.p5)})` }} />
			<span class="bar-p50" style={{ width: at(props.fig.shown) }} />
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
						freshly booted machine, and keeps every Run with its evidence. The figures, and AWS's hourly prices, are static JSON at <code>api.ledgermath.com</code>. Here is what
						that lets an agent do:
					</p>
					<ul class="strip" aria-label="What the API holds">
						<li>
							<a href="#numbers">
								<span class="strip-big">
									{formatCount(snapshot.benchmarkCount).full} × {formatCount(snapshot.machineCount).full}
								</span>
								<span class="strip-small">benchmarks × machine types, every digit</span>
							</a>
						</li>
						<li>
							<a href="#provenance">
								<span class="strip-big">{formatCount(snapshot.runCount).full}</span>
								<span class="strip-small">Runs kept, each with its evidence</span>
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
								<span class="strip-small">an hour On-Demand, AWS's prices of <span class="nowrap">{snapshot.priceDate}</span></span>
							</a>
						</li>
						<li class="strip-api">
							<a href="#api">
								<span class="strip-big strip-mono">GET v1/index.json</span>
								<span class="strip-small">the way in, for agents</span>
							</a>
						</li>
					</ul>
				</section>

				<section class="exchange" aria-labelledby="exchange-title">
					<div class="wrap">
						<div class="exchange-grid">
							<h2 id="exchange-title" class="kicker">
								<span class="kicker-rule" aria-hidden="true" />
								One question, answered from the API
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
											Before I size our ingest workers: on a <span class="nowrap">{ASKED_MACHINE}</span> in {askedMachine.region}, how long does one core take to sort 1&nbsp;MiB of
											64-bit keys, and what does the machine cost an hour?
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
										<p>
											On a {ASKED_MACHINE}, one core copies and radix-sorts 1&nbsp;MiB of 64-bit keys in{" "}
											<strong class="fig">
												{p50.full}&nbsp;{p50.unit}
											</strong>
											: the median of {formatCount(askedFigure.count).full} counted Runs, from {askedOldest.longDate} to {askedNewest.longDate}.
											<Cite n={1} />
											<Cite n={2} /> The 5th and 95th percentiles are{" "}
											<strong class="fig">
												{p5.full}&nbsp;{p5.unit}
											</strong>{" "}
											and{" "}
											<strong class="fig">
												{p95.full}&nbsp;{p95.unit}
											</strong>
											, and {askedDerivation.failed_runs === 0 ? "no Run failed" : `${formatCount(askedDerivation.failed_runs).full} Runs failed`}.
											<Cite n={1} />
										</p>
										<p>
											On-Demand, running Linux in {askedMachine.region}, it costs{" "}
											<strong class="fig">${askedPrice.full} an hour</strong>, in AWS's price list as copied on {formatMoment(`${snapshot.priceDate}T00:00:00Z`).longDate}.
											<Cite n={3} />
										</p>
										<p class="answer-limit">
											Those are the measured figures for that one setting. I haven't compared machines or worked out a cost per sort: the figures alone don't make that
											call.
										</p>
									</blockquote>

									<details class="ledger-wrap fold" open>
										<summary class="fold-head">
											<span>Every figure in the answer, as the files hold it</span>
											<span class="fold-count">5 lines</span>
										</summary>
										<table class="ledger">
											<caption class="sr">Every figure in the answer, as the files hold it</caption>
											<thead>
												<tr>
													<th scope="col">Source</th>
													<th scope="col">Figure, and the field it was read from</th>
													<th scope="col" class="num">
														Value
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
														<th scope="row">
<span class="l-label">{label as string}</span>
<code class="l-field">
…percentiles.time_per_repetition_ns.<b>{key as string}</b> = {(shown as Shown).source.replace(/ ns$/, "")}
</code>
</th>
														<td class="num">
															<span class="val">{(shown as Shown).full}</span> <span class="unit">{(shown as Shown).unit}</span>
														</td>
													</tr>
												))}
												<tr>
													<td>
														<Cite n={1} />
													</td>
													<th scope="row">
<span class="l-label">Runs counted, failed</span>
<code class="l-field">
…series_v1.<b>counted_runs</b> = {askedDerivation.counted_runs}, <b>failed_runs</b> = {askedDerivation.failed_runs}
</code>
</th>
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
													<th scope="row">
<span class="l-label">On-Demand, per hour</span>
<code class="l-field">
rate code {askedMachine.price.rateCode}: …<b>pricePerUnit.USD</b> = "{askedMachine.price.usdPerHour}"
</code>
</th>
													<td class="num">
														<span class="val">{askedPrice.full}</span> <span class="unit">USD</span>
													</td>
												</tr>
											</tbody>
										</table>
									</details>
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
											Every Series, one row each: {formatCount(snapshot.seriesCount).full} of them. It kept the row for{" "}
											<code>
												{ASKED_BENCHMARK}, size_bytes {String(askedSeries.params.size_bytes)}, {askedSeries.build}, {ASKED_MACHINE}
											</code>
											: Series <code>{askedSeries.id}</code>, with Method series v{askedDerivation.method.version}'s percentiles.
										</p>
									</li>
									<li id="read-2">
										<div class="read-head">
											<span class="read-n">2</span>
											<span class="verb">GET</span>
										</div>
										<Url href={askedSeries.url} />
										<p class="read-note">
											That Series' own file: its {formatCount(askedSeries.runs).full} Runs, the newest started{" "}
											<time datetime={askedNewest.iso} title={askedNewest.full}>
												{askedNewest.date} {askedNewest.minute} UTC
											</time>
											, each with its evidence.
										</p>
									</li>
									<li id="read-3">
										<div class="read-head">
											<span class="read-n">3</span>
											<span class="verb">GET</span>
										</div>
										<Url href={links.prices} />
										<p class="read-note">
											AWS's On-Demand prices for {snapshot.region}, copied{" "}
											<time datetime={snapshot.pricesFetchedAt} title={pricesFetched.full}>
												{pricesFetched.date} {pricesFetched.minute} UTC
											</time>
											. In AWS's own words: <q>{askedMachine.price.description}</q>, effective {askedMachine.price.effectiveDate.slice(0, 10)}.
										</p>
									</li>
								</ol>
								<p class="trace-foot">
									Three static files. <a href="#api">Point your agent at the same API</a>.
								</p>
							</details>
						</div>
					</div>
				</section>

				<section id="numbers" class="numbers wrap" aria-labelledby="numbers-title">
					<div class="section-head">
						<h2 id="numbers-title">The same numbers, for you</h2>
						<p>
							Each benchmark at one setting, on all five machine types: the median of each Series' counted Runs, every digit as the API holds it. The first four significant
							digits are set heavy so a row scans. Under each figure, its median and its 5th to 95th percentile span, each row drawn to its own scale from zero, and the Runs
							counted. Each figure links to its Series' file, with the Runs behind it.
						</p>
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
									<th scope="col" class="th-bench">
										Benchmark<span class="th-sub">, its unit, and which way is faster</span>
									</th>
									{machines.map((m) => {
										const price = formatUsd(m.price.usdPerHour, { per: "hour" });
										return (
											<th scope="col" class={m.instanceType === ASKED_MACHINE ? "th-machine is-asked" : "th-machine"}>
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
									<tbody>
										<tr class="section-row">
											<th scope="colgroup">{section}</th>
											{machines.map((m) => (
												<td aria-hidden="true" class={m.instanceType === ASKED_MACHINE ? "section-machine is-asked" : "section-machine"}>
													{m.instanceType}
												</td>
											))}
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
											const max = Math.max(...figs.map((f) => f.p95.value));
											const u = rowUnit(row, figs[0]!.shown.unit);
											return (
												<tr>
													<th scope="row" class="bench">
														<span class="bench-label">{row.choice.label}</span>
														<span class="bench-what">{WHAT[row.choice.benchmark] ?? row.choice.what}</span>
														<span class="bench-unit">
															<span class={row.choice.lead === "rate" ? "better up" : "better down"}>{u.better}</span>
															<b>{u.unit}</b>
															{u.of ? ` ${u.of}` : ""}
														</span>
														<span class="bench-meta">{row.choice.setting}</span>
													</th>
													{row.cells.map((cell, i) => {
														const fig = figs[i]!;
														const asked = row === askedRow && cell.machine.instanceType === ASKED_MACHINE;
														return (
															<td class={asked ? "fig-cell is-asked" : "fig-cell"}>
																<a href={links.seriesFile(cell.series)} title={cellTitle(fig, cell.machine.instanceType)}>
																	<Exact full={fig.shown.full} />
																	<span class="sr"> {fig.shown.unit}</span>
																</a>
																<Bar fig={fig} max={max} />
																<span class="runs">
																	{formatCount(fig.count).full} Runs{asked ? <span class="asked-tag"> · cited above</span> : null}
																</span>
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

					<ol class="cards" aria-label="The headline figures, one benchmark at a time">
						{headline.map((row, n) => {
							const figs = rowFigures(row);
							const max = Math.max(...figs.map((f) => f.p95.value));
							const u = rowUnit(row, figs[0]!.shown.unit);
							const first = headline.findIndex((r) => r.choice.section === row.choice.section) === n;
							const note = first ? GROUP_NOTE[row.choice.section] : undefined;
							return (
								<li class={first ? "card card-first" : "card"}>
									{first ? <div class="card-section">{row.choice.section}</div> : null}
									{note ? <p class="card-note">{note}</p> : null}
									<h3 class="card-title">{row.choice.label}</h3>
									<p class="card-what">{WHAT[row.choice.benchmark] ?? row.choice.what}</p>
									<p class="bench-unit">
										<span class={row.choice.lead === "rate" ? "better up" : "better down"}>{u.better}</span>
										<b>{u.unit}</b>
										{u.of ? ` ${u.of}` : ""}
									</p>
									<p class="card-meta">{row.choice.setting}</p>
									<ul class="card-figs">
										{row.cells.map((cell, i) => {
											const fig = figs[i]!;
											const asked = row === askedRow && cell.machine.instanceType === ASKED_MACHINE;
											return (
												<li class={asked ? "is-asked" : undefined}>
													<span class="card-line">
														<span class="card-machine">
															{cell.machine.instanceType}
															{asked ? <span class="asked-tag"> · cited</span> : null}
														</span>
														<a href={links.seriesFile(cell.series)} class="card-fig" title={cellTitle(fig, cell.machine.instanceType)}>
															<Exact full={fig.shown.full} />
															<span class="sr"> {fig.shown.unit}</span>
														</a>
													</span>
													<span class="card-bar">
														<Bar fig={fig} max={max} />
														<span class="runs">{formatCount(fig.count).full} Runs</span>
													</span>
												</li>
											);
										})}
									</ul>
								</li>
							);
						})}
					</ol>
				</section>

				<section id="api" class="api" aria-labelledby="api-title">
					<div class="wrap api-grid">
						<div class="api-copy">
							<h2 id="api-title">Point your agent here</h2>
							<p>
								The data API is static JSON: a table of contents, one file listing every Series with its figures, a file for each Series with its Runs and their evidence,
								and AWS's On-Demand prices, copied daily. Each kind of file has a JSON schema. An agent can read it with nothing more than an HTTP GET, and cite the file and
								field behind every number it gives you.
							</p>
							<div class="api-say-label">Or tell your agent, in so many words:</div>
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
									[`every Series, with its figures (${formatCount(snapshot.seriesCount).full})`, links.seriesList, "the Series list command"],
									[`the day's On-Demand prices, ${snapshot.region}`, links.prices, "the prices command"],
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
										<span>schema of {s.describes}</span>
									</li>
								))}
								<li>
									<a href={links.docs}>The API's documentation</a>
								</li>
							</ul>
						</div>
					</div>
				</section>

				<section id="machines" class="machines wrap" aria-labelledby="machines-title">
					<div class="section-head">
						<h2 id="machines-title">The five machines, and what an hour costs</h2>
						<p>
							AWS's hourly On-Demand price for each, running Linux in {snapshot.region}, from the price file of {snapshot.priceDate}
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
										<div class="price">
											<span class="price-cur">$</span>
											{price.full}
											<span class="price-per">/hour</span>
										</div>
										<p class="price-words">
											<q>{m.price.description}</q>
										</p>
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
							<p>
								Every figure is a Method's summary of Runs that were kept, each with what the benchmark printed and what
								was recorded about the machine.
							</p>
						</div>

						<div class="day">
							<div class="day-label">Machines boot, every day, UTC</div>
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
											<span class="newest-label">
												Newest Run started {newest.second}
											</span>
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
									<span class="fact-big">{formatCount(snapshot.seriesCount).full}</span> one benchmark, setting, build, machine type and zone each
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
							<div class="method-list">
								{snapshot.methods.map((m) => (
									<details>
										<summary>
											<code>
												{m.name} v{m.version}
											</code>
											<span>{Object.keys(m.definitions).length} definitions</span>
										</summary>
										<dl class="defs">
											{Object.entries(m.definitions).map(([term, words]) => (
												<div>
													<dt>
														<code>{term}</code>
													</dt>
													<dd>{words}</dd>
												</div>
											))}
										</dl>
									</details>
								))}
							</div>
							<p class="about">
								<span class="about-label">The API, in its own words</span> {snapshot.about}
							</p>
						</div>
					</div>
				</section>
			</main>

			<footer class="footer">
				<div class="wrap footer-row">
					<p>
						<strong>LedgerMath</strong> · figures as of the newest Run, {newest.longDate} · prices of {snapshot.priceDate}
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

