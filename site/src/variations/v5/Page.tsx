// Design v5, "Swiss poster": one grotesque, one strict grid, one accent colour.
// Every figure comes from ../../data exactly as the snapshot holds it (see ../README.md).
import "./page.css";
import {
	durationUnit,
	formatCount,
	formatDuration,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	leadFigure,
	links,
	machines,
	snapshot,
	type DurationUnit,
	type HeadlineRow,
	type Section,
	type SeriesRow,
	type Shown,
} from "../../data";

// ---------------------------------------------------------------- figures

type Lead = ReturnType<typeof leadFigure>;

/**
 * One unit for a whole row, so its five figures read against each other: the unit the
 * largest of them would take on its own. Only the unit is chosen here; nothing is shown
 * that the snapshot does not hold.
 */
function rowUnit(row: HeadlineRow): { kind: "rate"; unit: "B" | "kB" | "MB" | "GB" | "TB" } | { kind: "time"; unit: DurationUnit } {
	const leads = row.cells.map((cell) => leadFigure(row.choice, cell.series));
	const largest = leads.reduce((a, b) => (b.p50 > a.p50 ? b : a));
	if (row.choice.lead === "rate") return { kind: "rate", unit: formatRate(largest.p50).unit.replace("/s", "") as "GB" };
	return { kind: "time", unit: durationUnit(largest.p50) };
}

function show(row: HeadlineRow, value: number): Shown {
	const u = rowUnit(row);
	return u.kind === "rate" ? formatRate(value, { unit: u.unit }) : formatDuration(value, { unit: u.unit });
}

/** The exact figure cut in two for setting: its first four significant digits, and every digit after them. Nothing is dropped. */
function cut(full: string): [string, string] {
	let significant = 0;
	let started = false;
	for (let i = 0; i < full.length; i++) {
		const ch = full[i]!;
		if (ch >= "0" && ch <= "9") {
			if (ch !== "0") started = true;
			if (started) significant++;
			if (significant === 4) return [full.slice(0, i + 1), full.slice(i + 1)];
		}
	}
	return [full, ""];
}

function spread(row: HeadlineRow, lead: Lead): string {
	const p5 = show(row, lead.p5);
	const p50 = show(row, lead.p50);
	const p95 = show(row, lead.p95);
	return `p50 ${p50.full} ${p50.unit} · p5 ${p5.full} · p95 ${p95.full} ${p95.unit} · ${lead.count} counted Runs`;
}

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

// The poster's figure: the table's first cell, read memory sequentially on the first machine type.
const heroRow = headline[0]!;
const heroCell = heroRow.cells[0]!;
const heroLead = leadFigure(heroRow.choice, heroCell.series);
const heroShown = show(heroRow, heroLead.p50);
const [heroHead, heroTail] = cut(heroShown.full);

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const pricesFetched = formatMoment(snapshot.pricesFetchedAt);

function price(m: (typeof machines)[number]): Shown {
	return formatUsd(m.price.usdPerHour, { per: "hour" });
}

function dateRange(row: SeriesRow): string {
	const a = formatMoment(row.oldest_run_started_at);
	const b = formatMoment(row.newest_run_started_at);
	return `${a.longDate.replace(/ \d{4}$/, "")} to ${b.longDate}`;
}

// ---------------------------------------------------------------- parts

function Masthead() {
	return (
		<header class="mast grid">
			<div class="mast-name">
				<a href="#top">LedgerMath</a>
			</div>
			<p class="mast-cell">
				<span class="mast-label">Newest Run</span>{" "}
				<br />
				<time datetime={newest.iso} title={newest.full}>
					{newest.longDate}, {newest.minute} UTC
				</time>
			</p>
			<p class="mast-cell">
				<span class="mast-label">Four Runs a day, UTC</span>{" "}
				<br />
				04:10 10:10 16:10 22:10
			</p>
			<nav class="mast-nav" aria-label="On this page">
				<a href="#figures">Figures</a>
				<a href="#evidence">Evidence</a>
				<a href="#api">API</a>
				<a href="#machines">Machines</a>
			</nav>
		</header>
	);
}

function Poster() {
	return (
		<section class="poster grid" aria-labelledby="top">
			<h1 id="top" class="headline">
				AWS machines, measured four times a&nbsp;day.
			</h1>
			<div class="intro">
				<p>
					LedgerMath boots {formatCount(snapshot.machineCount).full} machine types in AWS's <span class="nowrap">{snapshot.region}</span> Region at 04:10, 10:10, 16:10 and 22:10 UTC, runs{" "}
					{formatCount(snapshot.benchmarkCount).full} benchmarks on each freshly booted machine, and keeps every Run with its evidence.
				</p>
				<p>The figures, the evidence and AWS's On-Demand prices are a static JSON API, made for agents that choose infrastructure from measured numbers.</p>
				<p class="intro-curl">
					<code>
						<span class="intro-cmd">curl</span> <span class="intro-url">{links.index}</span>
					</code>
				</p>
			</div>

			<div class="hero" role="group" aria-label="One figure from the table">
				<p class="hero-figure">
					<span class="hero-head">{heroHead}</span>
					<span class="hero-rest">
						<span class="hero-tail">{heroTail}</span>
						<span class="hero-unit">{heroShown.unit}</span>
					</span>
				</p>
				<dl class="hero-facts grid-inner">
					<div>
						<dt>What</dt>
						<dd>
							<strong>{heroRow.choice.label}.</strong> {heroRow.choice.what}
						</dd>
					</div>
					<div>
						<dt>Where</dt>
						<dd>
							{heroCell.machine.instanceType}, {heroCell.machine.vcpu} vCPU, {heroCell.machine.memory}, {heroCell.machine.processor}. {heroRow.choice.setting}.
						</dd>
					</div>
					<div>
						<dt>From</dt>
						<dd>
							The median (p50) of {formatCount(heroLead.count).full} counted Runs, {dateRange(heroCell.series)}, by Method series v1. Every digit as the snapshot holds it.
						</dd>
					</div>
					<div>
						<dt>Source</dt>
						<dd>
							<a href={links.seriesFile(heroCell.series)}>The Series file</a>, with each Run and its evidence. The first figure of the table below.
						</dd>
					</div>
				</dl>
			</div>
		</section>
	);
}

function FigureTable() {
	return (
		<section id="figures" class="figures" aria-labelledby="figures-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					01
				</p>
				<h2 id="figures-h">The figures</h2>
				<p class="sec-lede">
					{formatCount(snapshot.benchmarkCount).full} benchmarks × {formatCount(snapshot.machineCount).full} machine types. Each figure is the median (p50) of a Series' counted Runs: the
					rate where the benchmark moves bytes, otherwise the time of one repetition. The large figure is cut at four digits; every digit stands beneath it. Each one links to its Series
					file.
				</p>
			</div>

			<div class="table-box" role="region" aria-label="The figures, 14 benchmarks by 5 machine types" tabindex="0">
				<table>
					<caption class="vh">The median of each Series' counted Runs, by benchmark and machine type. Machine types are ordered by hourly price, cheapest first.</caption>
					<thead>
						<tr>
							<th scope="col" class="corner">
								<span>Benchmark</span>
								<span class="corner-note">Machine types, cheapest first</span>
							</th>
							{machines.map((m) => (
								<th scope="col" class="mach">
									<span class="mach-name">{m.instanceType}</span>
									<span class="mach-spec">
										{m.vcpu} vCPU · {m.memory}
									</span>
									<span class="mach-price">${price(m).full} an hour</span>
								</th>
							))}
						</tr>
					</thead>
					{SECTIONS.map((section) => (
						<tbody>
							<tr class="group">
								<th scope="rowgroup" colspan={machines.length + 1}>
									{section}
								</th>
							</tr>
							{headline
								.filter((row) => row.choice.section === section)
								.map((row) => {
									const unit = show(row, leadFigure(row.choice, row.cells[0]!.series).p50).unit;
									return (
										<tr class="row">
											<th scope="row">
												<span class="row-label">{row.choice.label}</span>
												<span class="row-what">{row.choice.what}</span>
												<span class="row-set">
													{row.choice.lead === "rate" ? `Median rate, ${unit}` : `Median time of one repetition, ${unit}`}. One repetition: {row.choice.repetition.replace(/\.$/, "")}.{" "}
													{row.choice.setting}.
												</span>
											</th>
											{row.cells.map((cell) => {
												const lead = leadFigure(row.choice, cell.series);
												const s = show(row, lead.p50);
												const isHero = cell.series === heroCell.series;
												return (
													<td class={isHero ? "hero-cell" : undefined} data-m={cell.machine.instanceType}>
														<a href={links.seriesFile(cell.series)} title={spread(row, lead)}>
															<span class="v">
																{s.short}
																<span class="u"> {s.unit}</span>
															</span>
															<span class="x">
																<span class="vh">Exact: </span>
																{s.full}
															</span>
														</a>
													</td>
												);
											})}
										</tr>
									);
								})}
						</tbody>
					))}
				</table>
			</div>
		</section>
	);
}

function Evidence() {
	return (
		<section id="evidence" class="evidence" aria-labelledby="evidence-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					02
				</p>
				<h2 id="evidence-h">Where every figure comes from</h2>
				<p class="sec-lede">
					Nothing is typed in. Every Run is kept: what the benchmark printed and what was recorded about the machine it booted on. A published, versioned Method turns a Series' Runs
					into its figures, and every figure links to the Runs behind it.
				</p>
			</div>

			<dl class="stats grid">
				<div class="stat stat-wide">
					<dt>Newest Run</dt>
					<dd>
						<time datetime={newest.iso}>
							<span class="stat-big">{newest.minute}</span>
							<span class="stat-unit">UTC, {newest.longDate}</span>
						</time>
						<span class="stat-exact">{newest.full}</span>
					</dd>
				</div>
				<div class="stat stat-runs">
					<dt>Runs</dt>
					<dd>
						<span class="stat-big">{formatCount(snapshot.runCount).full}</span>
						<span class="stat-exact">
							{formatCount(snapshot.countedRuns).full} counted, {formatCount(snapshot.failedRuns).full} failed
						</span>
					</dd>
				</div>
				<div class="stat">
					<dt>Series</dt>
					<dd>
						<span class="stat-big">{formatCount(snapshot.seriesCount).full}</span>
						<span class="stat-exact">
							{formatCount(headline.length * machines.length).full} of them in the table above
						</span>
					</dd>
				</div>
				<div class="stat">
					<dt>Oldest Run</dt>
					<dd>
						<time datetime={oldest.iso}>
							<span class="stat-mid">{oldest.longDate.replace(/ \d{4}$/, "")}</span>
						</time>
						<span class="stat-exact">{oldest.full}</span>
					</dd>
				</div>
				<div class="stat">
					<dt>Prices copied from AWS</dt>
					<dd>
						<time datetime={pricesFetched.iso}>
							<span class="stat-mid">{pricesFetched.longDate.replace(/ \d{4}$/, "")}</span>
						</time>
						<span class="stat-exact">{pricesFetched.full}</span>
					</dd>
				</div>
			</dl>

			<div class="chain grid">
				<ol class="chain-list">
					<li>
						<span class="chain-step">Run</span>
						<span class="chain-text">
							One benchmark on one freshly booted machine. Kept whole, counted or failed: its binary, its output and the machine's dumps, each stored by its SHA-256.
						</span>
					</li>
					<li>
						<span class="chain-step">Series</span>
						<span class="chain-text">The Runs that share a benchmark, its settings, its build, a machine type and an Availability Zone ID.</span>
					</li>
					<li>
						<span class="chain-step">Method</span>
						<span class="chain-text">
							Versioned and published:{" "}
							{snapshot.methods.map((m, i) => (
								<>
									{i > 0 ? " and " : ""}
									<code>
										{m.name} v{m.version}
									</code>
								</>
							))}
							. It turns a Series' counted Runs into percentiles; its definitions travel with the data, in{" "}
							<a href={links.seriesList}>series.json</a>.
						</span>
					</li>
					<li>
						<span class="chain-step">Figure</span>
						<span class="chain-text">Exactly as the Method's Derivation holds it. Nothing rounded, nothing computed that the Derivation does not hold.</span>
					</li>
				</ol>
			</div>
		</section>
	);
}

function Api() {
	const lines = [
		{ url: links.index, what: "The table of contents: every file, its schema, the newest Run" },
		{ url: links.seriesList, what: `Every Series (${formatCount(snapshot.seriesCount).full}) with its percentiles, and the Methods' definitions` },
		{ url: links.prices, what: `AWS's On-Demand prices, copied ${snapshot.priceDate}` },
	];
	return (
		<section id="api" class="api" aria-labelledby="api-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					03
				</p>
				<h2 id="api-h">For agents, and the developers who run them</h2>
				<p class="sec-lede">
					Static JSON, version 1, at api.ledgermath.com. An agent reads every Series' figures with the address of its source, follows any figure down to its Runs and their evidence,
					and prices a machine from the same files. Version 1 only ever gains fields.
				</p>
			</div>

			<div class="grid">
				<ul class="curls">
					{lines.map((line) => (
						<li>
							<span class="curl-what">{line.what}</span>
							<pre class="curl">
								<code>
									<span class="prompt" aria-hidden="true">
										${" "}
									</span>
									curl {line.url}
								</code>
							</pre>
						</li>
					))}
				</ul>

				<div class="api-side">
					<h3>Schemas</h3>
					<ul class="plain">
						{links.schemas.map((s) => (
							<li>
								<a href={s.url}>{s.name}</a> <span class="muted">{s.describes}</span>
							</li>
						))}
					</ul>
					<h3>Evidence</h3>
					<p>Each point of a Series file links its Run file and its boot's summary. A Run file names its binary, output and dumps by hash; each is a blob under the same address.</p>
					<p>
						<a href={links.docs}>Read the API's documentation</a>
					</p>
				</div>
			</div>
		</section>
	);
}

function Machines() {
	return (
		<section id="machines" class="machines" aria-labelledby="machines-h">
			<div class="sec-head grid">
				<p class="sec-no" aria-hidden="true">
					04
				</p>
				<h2 id="machines-h">The machines</h2>
				<p class="sec-lede">
					Five machine types in {snapshot.region}, Availability Zone ID {[...new Set(machines.flatMap((m) => m.availabilityZoneIds))].join(", ")}, cheapest first. Each price is AWS's
					hourly On-Demand Linux price from the price file of {snapshot.priceDate}, copied from AWS at {pricesFetched.minute} UTC.
				</p>
			</div>

			<ol class="mlist">
				{machines.map((m) => (
					<li class="m grid">
						<h3 class="m-name">{m.instanceType}</h3>
						<p class="m-price">
							<span class="m-dollar">${price(m).full}</span>
							<span class="m-per">an hour</span>
						</p>
						<dl class="m-spec">
							<div>
								<dt>vCPU</dt>
								<dd>{m.vcpu}</dd>
							</div>
							<div>
								<dt>Memory</dt>
								<dd>{m.memory}</dd>
							</div>
							<div>
								<dt>Processor</dt>
								<dd>
									{m.processor}, {m.clockSpeed}
								</dd>
							</div>
							<div>
								<dt>Family</dt>
								<dd>{m.family}</dd>
							</div>
						</dl>
						<p class="m-aws">
							AWS: “{m.price.description}”
						</p>
					</li>
				))}
			</ol>
		</section>
	);
}

function Footer() {
	return (
		<footer class="foot grid">
			<div class="foot-name">LedgerMath</div>
			<p class="foot-cell">
				Snapshot of the data API: newest Run{" "}
				<time datetime={newest.iso}>
					{newest.date} {newest.second} UTC
				</time>
				, price file {snapshot.priceDate}.
			</p>
			<p class="foot-cell">
				<a href={links.index}>index.json</a> · <a href={links.seriesList}>series.json</a> · <a href={links.prices}>prices</a> · <a href={links.docs}>documentation</a>
			</p>
		</footer>
	);
}

export default function Page() {
	return (
		<>
			<Masthead />
			<main>
				<Poster />
				<FigureTable />
				<Evidence />
				<Api />
				<Machines />
			</main>
			<Footer />
		</>
	);
}
