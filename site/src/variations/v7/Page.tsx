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

/** The unit a whole row is shown in: the one its smallest figure reads at least 1 in, so the row compares at a glance. */
function rowFigures(row: HeadlineRow): { shown: Shown; p5: Shown; p95: Shown; count: number }[] {
	const figures = row.cells.map((cell) => leadFigure(row.choice, cell.series));
	const least = Math.min(...figures.map((f) => f.p50));
	if (row.choice.lead === "rate") {
		const unit = SI_RATE.find(([floor]) => least >= floor)![1];
		return figures.map((f) => ({ shown: formatRate(f.p50, { unit }), p5: formatRate(f.p5, { unit }), p95: formatRate(f.p95, { unit }), count: f.count }));
	}
	const unit = durationUnit(least);
	return figures.map((f) => ({ shown: formatDuration(f.p50, { unit }), p5: formatDuration(f.p5, { unit }), p95: formatDuration(f.p95, { unit }), count: f.count }));
}

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

function cellTitle(fig: { shown: Shown; p5: Shown; p95: Shown; count: number }, machine: string): string {
	return `${machine}: ${fig.shown.full} ${fig.shown.unit}, the median of ${fig.count} counted Runs (5th percentile ${fig.p5.full}, 95th ${fig.p95.full} ${fig.shown.unit}). As the API holds it: ${fig.shown.source}.`;
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
						<a href="#numbers">The numbers</a>
						<a href="#api">For agents</a>
						<a href="#machines">Machines</a>
						<a href="#provenance">Provenance</a>
					</nav>
					<p class="fresh">
						<span class="pulse" aria-hidden="true" />
						<span class="fresh-word">Newest Run</span>
						<time datetime={newest.iso} title={newest.full}>
							{newest.date} {newest.minute} UTC
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

									<div class="ledger-wrap">
										<table class="ledger">
											<caption>Every figure in the answer, as the files hold it</caption>
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
									</div>
								</figure>
							</div>

							<div class="trace">
								<h3 class="trace-title">The files it read, in order</h3>
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
							</div>
						</div>
					</div>
				</section>

				<section id="numbers" class="numbers wrap" aria-labelledby="numbers-title">
					<div class="section-head">
						<h2 id="numbers-title">The same numbers, for you</h2>
						<p>
							Each benchmark at one setting, on all five machine types: the median of each Series' counted Runs, exact. The large figure is rounded to four digits; the small
							line under it is every digit. Each figure links to its Series' file, with the Runs behind it.
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
										Benchmark <span class="th-sub">and what it measures</span>
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
								return (
									<tbody>
										<tr class="section-row">
											<th scope="colgroup" colspan={machines.length + 1}>
												{section}
											</th>
										</tr>
										{rows.map((row) => {
											const figs = rowFigures(row);
											return (
												<tr>
													<th scope="row" class="bench">
														<span class="bench-label">{row.choice.label}</span>
														<span class="bench-what">{row.choice.what}</span>
														<span class="bench-meta">
															{row.choice.lead === "rate" ? "Bytes per second" : `Time of one repetition: ${row.choice.repetition.replace(/\.$/, "").replace(/^One /, "one ")}`}{" "}
															· {row.choice.setting}
														</span>
													</th>
													{row.cells.map((cell, i) => {
														const fig = figs[i]!;
														const asked = row === askedRow && cell.machine.instanceType === ASKED_MACHINE;
														return (
															<td class={asked ? "fig-cell is-asked" : "fig-cell"}>
																<a href={links.seriesFile(cell.series)} title={cellTitle(fig, cell.machine.instanceType)}>
																	<span class="fig-short">
																		{fig.shown.short}
																		<span class="fig-unit">{fig.shown.unit}</span>
																	</span>
																	<span class="fig-full">{fig.shown.full}</span>
																</a>
																{asked ? <span class="asked-tag">cited above</span> : null}
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
						{headline.map((row) => {
							const figs = rowFigures(row);
							return (
								<li class="card">
									<div class="card-section">{row.choice.section}</div>
									<h3 class="card-title">{row.choice.label}</h3>
									<p class="card-what">{row.choice.what}</p>
									<p class="card-meta">
										{row.choice.lead === "rate" ? "Median bytes per second" : `Median time of ${row.choice.repetition.replace(/\.$/, "").replace(/^One /, "one ")}`} ·{" "}
										{row.choice.setting}
									</p>
									<ul class="card-figs">
										{row.cells.map((cell, i) => {
											const fig = figs[i]!;
											const asked = row === askedRow && cell.machine.instanceType === ASKED_MACHINE;
											return (
												<li class={asked ? "is-asked" : undefined}>
													<span class="card-machine">{cell.machine.instanceType}</span>
													<a href={links.seriesFile(cell.series)} class="card-fig" title={cellTitle(fig, cell.machine.instanceType)}>
														<span class="fig-short">
															{fig.shown.short}
															<span class="fig-unit">{fig.shown.unit}</span>
														</span>
														<span class="fig-full">{fig.shown.full}</span>
													</a>
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
							<blockquote class="api-say">
								<p>
									Use the LedgerMath data API at {links.index}. Answer from the figures in its files, and name the file and field each figure came from.
								</p>
							</blockquote>
						</div>
						<div class="api-code">
							<div class="term" data-copy-scope>
								<div class="term-bar">
									<span>shell</span>
								</div>
								<pre tabindex="0">
									<code>
										<span class="c"># the table of contents</span>
										{"\n"}
										<span class="p">$ </span>
										<span data-copy>curl {links.index}</span>
										{"\n\n"}
										<span class="c"># every Series, with its figures ({formatCount(snapshot.seriesCount).full})</span>
										{"\n"}
										<span class="p">$ </span>
										<span data-copy>curl {links.seriesList}</span>
										{"\n\n"}
										<span class="c"># the day's On-Demand prices, {snapshot.region}</span>
										{"\n"}
										<span class="p">$ </span>
										<span data-copy>curl {links.prices}</span>
									</code>
								</pre>
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

