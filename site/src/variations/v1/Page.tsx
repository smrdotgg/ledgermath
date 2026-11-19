// Design v1, "Ledger": the home page as a book of record. One ruled table is the page: one
// column per machine type, one entry per benchmark, every figure written out to its last digit
// (the first three decimal places in ink, the rest in pencil) and decimal-aligned down its column.
// Under each figure a pencil rule drawn to the row's scale, its p5–p95 in ink. Few words: the
// figures are the page, and everything else is a link. No best, no ranking, no ties.
import "./page.css";
import {
	durationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	headlineSeries,
	leadFigure,
	links,
	machines,
	seriesFileContents,
	snapshot,
	type DurationUnit,
	type HeadlineRow,
	type Section,
	type Shown,
} from "../../data";

// ------------------------------------------------------------------ figures, written out

/** One figure in the unit its row is shown in: every digit, its value for drawing, and where it came from. */
type Entry = { full: string; unit: string; source: string; value: number };
/** A cell: the median, the 5th and 95th percentiles, and the counted Runs behind them. */
type Cell = { p50: Entry; p5: Entry; p95: Entry; count: number };

/** Each row is shown in one unit, so its figures line up on the decimal point. */
function rowCells(row: HeadlineRow): Cell[] {
	const figures = row.cells.map((cell) => leadFigure(row.choice, cell.series));
	const entry = (s: Shown): Entry => ({ full: s.full, unit: s.unit, source: s.source, value: s.value });
	if (row.choice.lead === "rate") {
		// The unit that formatRate would pick for the row's largest figure (a choice of unit, not a statistic).
		const unit = formatRate(Math.max(...figures.map((f) => f.p50))).unit.replace("/s", "") as "GB" | "MB";
		const at = (bps: number) => entry(formatRate(bps, { unit }));
		return figures.map((f) => ({ p50: at(f.p50), p5: at(f.p5), p95: at(f.p95), count: f.count }));
	}
	// Times: per repetition, or, where one repetition is a fixed count of something smaller
	// (mutex: 10,000 critical sections), per one of those, divided exactly by the module.
	const per = row.choice.per;
	const largest = Math.max(...figures.map((f) => f.p50));
	const unit: DurationUnit = per ? (formatDurationPerUnit(largest, per).unit as DurationUnit) : durationUnit(largest);
	const at = (ns: number) => entry(per ? formatDurationPerUnit(ns, per, { unit }) : formatDuration(ns, { unit }));
	return figures.map((f) => ({ p50: at(f.p50), p5: at(f.p5), p95: at(f.p95), count: f.count }));
}

const cells = headline.map(rowCells);
/** The widest whole part of any figure, in digits, so every column's decimal points line up. */
const wholeDigits = Math.max(...cells.flat().map((c) => c.p50.full.split(".")[0]!.length));

/** A figure as a ledger writes it: whole part right-aligned, three places in ink, the rest in pencil, in threes from the point. */
function Written(props: { full: string; inkPlaces?: number }) {
	const [whole = "0", fraction = ""] = props.full.split(".");
	const places = props.inkPlaces ?? 3;
	const ink = fraction.slice(0, places);
	const pencil = fraction.slice(places).match(/\d{1,3}/g) ?? [];
	return (
		<span class="fig">
			<span class="w">{whole}</span>
			<span class="d">{fraction ? `.${ink}` : ""}</span>
			<span class="p">
				{pencil.map((g) => (
					<span>{g}</span>
				))}
			</span>
		</span>
	);
}

/** The pencil rule under a figure: 0 to the median on the row's scale, the 5th to 95th percentile in ink. */
function Rule(props: { x: Cell; scale: number }) {
	const pct = (v: number) => `${((v / props.scale) * 100).toFixed(3)}%`;
	return (
		<span class="bar" aria-hidden="true" style={{ "--to": pct(props.x.p50.value), "--lo": pct(props.x.p5.value), "--hi": pct(props.x.p95.value) }}>
			<span class="bar-len" />
			<span class="bar-rng" />
		</span>
	);
}

/** The rule's scale: the row's largest 95th percentile (a choice of scale for drawing, not a statistic). */
const rowScale = (xs: Cell[]) => Math.max(...xs.map((x) => x.p95.value));

// ------------------------------------------------------------------ the page

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
const ROMAN = ["I", "II", "III", "IV", "V"];
const RUN_TIMES = ["04:10", "10:10", "16:10", "22:10"];
const sectionId = (s: Section) => `s-${s.toLowerCase().replace(/ /g, "-")}`;

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const runs = formatCount(snapshot.runCount).full;
const seriesCount = formatCount(snapshot.seriesCount).full;
const method = snapshot.methods[0]!;
const price = (usd: Parameters<typeof formatUsd>[0]) => `$${formatUsd(usd).full}`;

/** On a phone a machine's line names it by its family, which is unique among the five; the key above the ledger gives the full type. */
const family = (instanceType: string) => instanceType.split(".")[0]!;

/** An address, with a place to break after each slash so it wraps where a reader expects. */
function Url(props: { href: string }) {
	const parts = props.href.split(/(?<=\/)/);
	return (
		<>
			{parts.map((part, i) => (
				<>
					{part}
					{i < parts.length - 1 ? <wbr /> : ""}
				</>
			))}
		</>
	);
}

const API = "https://api.ledgermath.com/";
const rel = (url: string) => url.replace(API, "");
const schemaOf = (name: string) => links.schemas.find((s) => s.name === name)!.url;

/** The API's addresses, one line each: the file, and the schema it follows. */
const ADDRESSES: { label: string; href: string; shown: string; schema?: string }[] = [
	{ label: "Index", href: links.index, shown: rel(links.index), schema: schemaOf("index") },
	{ label: "All Series", href: links.seriesList, shown: rel(links.seriesList), schema: schemaOf("series-list") },
	{ label: "One Series", href: seriesFileContents.sample.url, shown: rel(links.seriesFilePattern), schema: schemaOf("series") },
	{ label: "Prices", href: links.prices, shown: rel(links.priceFilePattern), schema: schemaOf("prices") },
	{ label: "Evidence", href: links.evidenceBlobTemplate, shown: rel(links.evidenceBlobTemplate) },
];

const POINT_SHOWN = ["run", "started_at", "counted", "failure", "time_per_repetition_ns", "evidence", "boot_summary"] as const;
const example = seriesFileContents.point.example;
const sample = seriesFileContents.sample;

export default function Page() {
	let entryNo = 0;
	return (
		<>
			<header class="masthead">
				<div class="title">
					<h1>
						LedgerMath<span class="sub">A book of record for cloud servers</span>
					</h1>
					<p class="claim">
						{formatCount(snapshot.machineCount).full} AWS machine types, benchmarked four times a day. Every figure kept with its evidence and published as
						static JSON for AI agents.
					</p>
					<div class="start">
						<span class="start-h">Point an agent at it</span>
						<div class="cmd">
							<code>
								<span class="prompt" aria-hidden="true">
									${" "}
								</span>
								curl <Url href={links.index} />
							</code>
							<button type="button" class="copy" data-copy={`curl ${links.index}`} aria-label="Copy the command" hidden>
								Copy
							</button>
						</div>
					</div>
				</div>
				<dl class="folio" aria-label="The state of the book">
					<div>
						<dt>Newest Run</dt>
						<dd>
							<time datetime={newest.iso} title={newest.full}>
								{newest.longDate}, {newest.minute} UTC
							</time>
						</dd>
					</div>
					<div>
						<dt>Oldest Run</dt>
						<dd>
							<time datetime={oldest.iso} title={oldest.full}>
								{oldest.longDate}, {oldest.minute} UTC
							</time>
						</dd>
					</div>
					<div>
						<dt>Runs</dt>
						<dd>
							{runs} <span class="aside">in</span> <a href={links.seriesList}>{seriesCount} Series</a>
							<span class="aside">, {formatCount(snapshot.failedRuns).full} failed</span>
						</dd>
					</div>
					<div>
						<dt>Boots</dt>
						<dd>
							{RUN_TIMES.join(" · ")} <span class="aside">UTC</span>
						</dd>
					</div>
					<div>
						<dt>Where</dt>
						<dd>
							{snapshot.region} <span class="aside">· {machines[0]!.availabilityZoneIds.join(", ")}</span>
						</dd>
					</div>
					<div>
						<dt>Method</dt>
						<dd>
							<a href={links.docs}>
								{method.name} v{method.version}
							</a>
							<span class="aside"> · median of counted Runs</span>
						</dd>
					</div>
				</dl>
			</header>

			<main>
				<section class="ledger" aria-labelledby="ledger-h">
					<div class="ledger-head">
						<h2 id="ledger-h">
							The ledger{" "}
							<span class="dim">
								{formatCount(headline.length).full} benchmarks × {formatCount(machines.length).full} machines
							</span>
						</h2>
						<p class="legend">
							<span class="lg-bar" aria-hidden="true">
								<span class="bar-len" />
								<span class="bar-rng" />
							</span>
							<span>
								0 to median, <b>p5–p95</b>
							</span>
							<span class="lg-sep" aria-hidden="true">
								·
							</span>
							<span>a figure opens its Runs</span>
							<span class="lg-sep" aria-hidden="true">
								·
							</span>
							<span>
								{formatCount(headlineSeries.length).full} of {seriesCount} Series, by a <a href={links.docs}>written rule</a>
							</span>
						</p>
					</div>
					<ul class="phone-key" aria-label="The machines, cheapest first">
						{machines.map((m) => (
							<li>
								<span class="pk-it">
									<b>{family(m.instanceType)}</b>
									{m.instanceType.slice(family(m.instanceType).length)}
								</span>
								<span class="pk-p">{price(m.price.usdPerHour)}/h</span>
							</li>
						))}
					</ul>
					<nav class="index-tabs" aria-label="The ledger's accounts">
						<ol>
							{SECTIONS.map((s, i) => (
								<li>
									<a href={`#${sectionId(s)}`} data-sec={sectionId(s)}>
										<span class="roman">{ROMAN[i]}.</span> {s}
									</a>
								</li>
							))}
						</ol>
					</nav>
					<div class="scroll" tabindex="0" role="region" aria-label="The ledger, scrollable" style={{ "--whole": `${wholeDigits}ch` }}>
						<table>
							<thead>
								<tr>
									<th scope="col" class="no">
										<abbr title="Entry number">No.</abbr>
									</th>
									<th scope="col" class="what">
										Benchmark
									</th>
									<th scope="col" class="unit">
										Unit
									</th>
									{machines.map((m) => (
										<th scope="col" class="mach">
											<span class="it">{m.instanceType}</span>
											<span class="spec">
												{m.vcpu} vCPU · {m.memory}
											</span>
											<span class="price" title={m.price.description}>
												{price(m.price.usdPerHour)}
												<span class="per">/h</span>
											</span>
										</th>
									))}
								</tr>
							</thead>
							{SECTIONS.map((section, s) => {
								const rows = headline.map((row, i) => ({ row, i })).filter(({ row }) => row.choice.section === section);
								return (
									<tbody id={sectionId(section)} class="acct">
										<tr class="sec">
											<th scope="colgroup" colspan={3}>
												<span class="roman">{ROMAN[s]}.</span> {section}
											</th>
											{machines.map((m) => (
												<td class="mrep" aria-hidden="true">
													{s > 0 ? (
														<>
															{m.instanceType} <span class="mrep-p">{price(m.price.usdPerHour)}</span>
														</>
													) : (
														""
													)}
												</td>
											))}
										</tr>
										{rows.map(({ row, i }) => {
											entryNo += 1;
											const c = row.choice;
											const xs = cells[i]!;
											const unit = xs[0]!.p50.unit;
											const scale = rowScale(xs);
											const higher = c.lead === "rate";
											return (
												<tr class="entry">
													<td class="no">{String(entryNo).padStart(2, "0")}</td>
													<th scope="row" class="what">
														<a href={c.readme} title={`${c.what} ${c.setting}.`}>
															{c.label}
														</a>
													</th>
													<td class="unit">
														<span class="u">{unit}</span>
														<span class="dir">
															<span class="arrow" aria-hidden="true">
																{higher ? "↑" : "↓"}{" "}
															</span>
															{higher ? "higher" : "lower"} is better
														</span>
													</td>
													{row.cells.map((cell, k) => {
														const x = xs[k]!;
														return (
															<td class="fig-cell">
																<span class="mkey" aria-hidden="true">
																	{family(cell.machine.instanceType)}
																</span>
																<a
																	href={links.seriesFile(cell.series)}
																	title={`${cell.machine.instanceType}: median ${x.p50.full} ${unit}; 5th percentile ${x.p5.full}, 95th ${x.p95.full}; ${x.count} counted Runs. As the Derivation holds it: ${x.p50.source}.`}
																>
																	<Written full={x.p50.full} />
																	<Rule x={x} scale={scale} />
																</a>
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

				<div class="back">
					<section class="api" aria-labelledby="api-h">
						<h2 id="api-h">For agents and developers</h2>
						<p class="api-lede">
							Static JSON at <span class="mono">{API}</span>: every Series, every Run with its evidence, the day's prices, and a schema for each file.
						</p>
						<table class="addr">
							<tbody>
								{ADDRESSES.map((a) => (
									<tr>
										<th scope="row">{a.label}</th>
										<td class="mono">
											<a href={a.href}>
												<Url href={a.shown} />
											</a>
										</td>
										<td class="sch">{a.schema ? <a href={a.schema}>schema</a> : ""}</td>
									</tr>
								))}
								<tr>
									<th scope="row">Docs</th>
									<td class="mono" colspan={2}>
										<a href={links.docs}>{links.docs.replace("https://", "")}</a>
									</td>
								</tr>
							</tbody>
						</table>
						<figure class="point">
							<figcaption>
								One Run of <span class="mono">{sample.benchmark}</span> on <span class="mono">{sample.instanceType}</span>, from{" "}
								<a href={sample.url}>its Series' file</a>
							</figcaption>
							<pre class="json">
								<code>
									{"{\n"}
									{POINT_SHOWN.map((name, i) => {
										const value = example[name];
										const text = JSON.stringify(value);
										const isLink = typeof value === "string" && /^https:\/\//.test(value);
										return (
											<>
												{"  "}
												<span class="jk">"{name}"</span>
												<span class="jp">: </span>
												{isLink ? (
													<a href={value as string}>
														"<Url href={value as string} />"
													</a>
												) : (
													<span class="jv">{text}</span>
												)}
												<span class="jp">{i < POINT_SHOWN.length - 1 ? ",\n" : "\n"}</span>
											</>
										);
									})}
									{"}"}
								</code>
							</pre>
						</figure>
					</section>

					<section class="machines" aria-labelledby="machines-h">
						<h2 id="machines-h">The machines</h2>
						<p class="section-lede">
							AWS On-Demand Linux, per hour, as of{" "}
							<a href={links.prices} class="nowrap">
								{snapshot.priceDate}
							</a>
						</p>
						<table class="mtable">
							<thead>
								<tr>
									<th scope="col">Type</th>
									<th scope="col" class="r">
										vCPU
									</th>
									<th scope="col" class="r">
										Memory
									</th>
									<th scope="col">Processor</th>
									<th scope="col">Network</th>
									<th scope="col" class="price-h">
										USD/h
									</th>
								</tr>
							</thead>
							<tbody>
								{machines.map((m) => (
									<tr>
										<th scope="row" class="mono m-type">
											{m.instanceType}
										</th>
										<td class="r num m-cpu">
											{m.vcpu}
											<span class="ph"> vCPU</span>
										</td>
										<td class="r num m-mem">{m.memory}</td>
										<td class="m-proc">
											{m.processor}
											<span class="clock">{m.clockSpeed}</span>
										</td>
										<td class="m-net">{m.network}</td>
										<td class="r num m-price" title={`${m.price.description}; SKU ${m.price.sku}`}>
											<span class="ph">$</span>
											<Written full={formatUsd(m.price.usdPerHour).full} inkPlaces={10} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
				</div>
			</main>

			<footer class="colophon">
				<p>
					LedgerMath · entries to {newest.longDate}, {newest.second} UTC · Source Serif 4, IBM Plex Mono ·{" "}
					<a href="third-party-notices.txt">Notices</a>
				</p>
			</footer>
		</>
	);
}
