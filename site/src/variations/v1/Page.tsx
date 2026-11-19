// Design v1, "Ledger", spare form: the home page as a book of record, and almost nothing else.
// One ruled table is the page: one column per machine type, one entry per benchmark, every figure
// written out to its last digit (the first three decimal places in ink, the rest in pencil) and
// decimal-aligned down its column, a pencil rule under each, its p5–p95 in ink. Above it the name,
// one line of what this is, one command, one dateline. Everything else is a link. No best, no ranking.
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

const newest = formatMoment(snapshot.newestRunStartedAt);
const method = snapshot.methods[0]!;
const price = (usd: Parameters<typeof formatUsd>[0]) => `$${formatUsd(usd).full}`;

/** A machine named by its family, which is unique among the five; the column heads give the full type. */
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
						{formatCount(snapshot.machineCount).full} AWS machine types, benchmarked four times a day, every figure kept with its evidence.
					</p>
				</div>
				<div class="start">
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
					<p class="start-links">
						Static JSON for agents · <a href={links.docs}>docs</a>
					</p>
				</div>
			</header>

			<main>
				<p class="dateline">
					<span class="item">
						Entries to{" "}
						<time datetime={newest.iso} title={newest.full}>
							{newest.longDate}, {newest.minute} UTC
						</time>
					</span>
					<span class="sep" aria-hidden="true">
						·
					</span>
					<span class="item">
						{formatCount(snapshot.runCount).full} Runs in <a href={links.seriesList}>{formatCount(snapshot.seriesCount).full} Series</a>
					</span>
					<span class="sep" aria-hidden="true">
						·
					</span>
					<span class="item">
						median of counted Runs, method{" "}
						<a href={links.docs}>
							{method.name} v{method.version}
						</a>
					</span>
					<span class="sep" aria-hidden="true">
						·
					</span>
					<span class="item">
						prices <a href={links.prices}>{snapshot.priceDate}</a>
					</span>
				</p>

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
								median, <b>p5–p95</b>
							</span>
							<span class="lg-sep" aria-hidden="true">
								·
							</span>
							<span>
								<b aria-hidden="true">↑</b> higher, <b aria-hidden="true">↓</b> lower is better
							</span>
						</p>
					</div>
					<ul class="phone-key" aria-label="The machines, On-Demand per hour">
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
									<tbody class="acct">
										<tr class="sec">
											<th scope="colgroup" colspan={3}>
												<span class="roman">{ROMAN[s]}.</span> {section}
											</th>
											{machines.map((m) => (
												<td class="mrep" aria-hidden="true">
													{s > 0 ? family(m.instanceType) : ""}
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
														<span class="arrow" role="img" aria-label={higher ? "higher is better" : "lower is better"} title={higher ? "higher is better" : "lower is better"}>
															{higher ? "↑" : "↓"}
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
			</main>

			<footer class="colophon">
				<p>
					<a href="third-party-notices.txt">Notices</a>
				</p>
			</footer>
		</>
	);
}
