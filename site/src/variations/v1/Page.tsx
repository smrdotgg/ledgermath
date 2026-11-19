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
/** One real Run, as a Series file holds it: its evidence and its boot's summary, to show what "kept with its evidence" means. */
const sampleRun = seriesFileContents.point.example;

/** The tally beside each figure: the counted Runs behind it, in pencil, inside the figure's link to its Series. */
function Tally(props: { count: number }) {
	return (
		<span class="n">
			<i>n</i>
			{props.count}
		</span>
	);
}

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
						{formatCount(snapshot.machineCount).full} AWS machine types, benchmarked four times a day. Every Run kept with its evidence, published as static
						JSON for AI agents.
					</p>
					<div class="start">
						<span class="start-h">Point an agent at it</span>
						<div class="cmd">
							<code tabindex="0">curl {links.index}</code>
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
						<dt>Runs</dt>
						<dd>
							<span title={`Since ${oldest.full}; boots at ${RUN_TIMES.join(", ")} UTC`}>{runs}</span> <span class="aside">in</span>{" "}
							<a href={links.seriesList}>{seriesCount} Series</a>
							<span class="aside">, {formatCount(snapshot.failedRuns).full} failed</span>
						</dd>
					</div>
					<div>
						<dt>Evidence</dt>
						<dd>
							<a href={sampleRun.evidence ?? links.evidenceBlobTemplate} title={`Run ${sampleRun.run}: its binary, streams and dumps by sha256`}>
								Run file
							</a>
							<span class="aside"> · </span>
							<a href={sampleRun.boot_summary ?? links.evidenceBlobTemplate}>boot summary</a>
						</dd>
					</div>
					<div>
						<dt>Prices</dt>
						<dd>
							AWS On-Demand{" "}
							<span class="aside">
								· copied{" "}
								<a href={links.prices} class="nowrap">
									{snapshot.priceDate}
								</a>
							</span>
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
							<span class="lg-item">
								<span class="lg-rule" aria-hidden="true">
									<span class="lg-len" />
									<span class="lg-rng" />
								</span>
								p5–p95 · scale per row
							</span>
							<span class="lg-item">
								<span class="n" aria-hidden="true">
									<i>n</i>
								</span>
								counted Runs · links to its Series
							</span>
						</p>
					</div>
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
											<span class="it" title={`${m.processor}, ${m.clockSpeed}; network ${m.network}`}>
												{m.instanceType}
											</span>
											<span class="spec">
												{m.vcpu} vCPU · {m.memory}
											</span>
											<a class="price" href={links.prices} title={`${m.price.description}; SKU ${m.price.sku}; at ${m.price.path.pointer}`}>
												{price(m.price.usdPerHour)}
												<span class="per">/h</span>
											</a>
										</th>
									))}
								</tr>
							</thead>
							{SECTIONS.map((section, s) => {
								const rows = headline.map((row, i) => ({ row, i })).filter(({ row }) => row.choice.section === section);
								return (
									<tbody id={sectionId(section)} class="acct">
										<tr class="sec">
											<th scope="colgroup" colspan={3 + machines.length}>
												<span class="roman">{ROMAN[s]}.</span> {section}
											</th>
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
														<span class="u">{unit}</span>{" "}
														<span class="arrow" role="img" aria-label={`${higher ? "higher" : "lower"} is better`} title={`${higher ? "Higher" : "Lower"} is better`}>
															{higher ? "↑" : "↓"}
														</span>
													</td>
													{row.cells.map((cell, k) => {
														const x = xs[k]!;
														return (
															<td class="fig-cell">
																<span class="mkey" aria-hidden="true">
																	{cell.machine.instanceType}
																</span>
																<a
																	href={links.seriesFile(cell.series)}
																	title={`${cell.machine.instanceType}: median of ${x.count} counted Runs ${x.p50.full} ${unit}; 5th percentile ${x.p5.full}, 95th ${x.p95.full}. As the Derivation holds it: ${x.p50.source}.`}
																>
																	<Written full={x.p50.full} />
																	<span class="line">
																		<Rule x={x} scale={scale} />
																		<Tally count={x.count} />
																	</span>
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
							Static JSON at <span class="mono">{API}</span>, a schema for each file.
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
					</section>
				</div>
			</main>

			<footer class="colophon">
				<p>
					LedgerMath · entries to {newest.longDate}, {newest.second} UTC · <a href="third-party-notices.txt">Notices</a>
				</p>
			</footer>
		</>
	);
}
