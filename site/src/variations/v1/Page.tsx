// Design v1, "Ledger": the home page as a book of record. One ruled table is the page: one
// column per machine type, one entry per benchmark, every figure written out to its last digit
// (the first three decimal places in ink, the rest in pencil) and decimal-aligned down its column.
// Under each figure a pencil rule drawn to the row's scale, the p5–p95 range and the Runs behind
// it. The page draws no conclusion from the figures: no best, no ranking, no ties.
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
	roundPlaces,
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

/** A moment, every digit: date and time in ink, the fraction of a second in pencil. */
function Moment(props: { iso: string }) {
	const m = formatMoment(props.iso);
	const fraction = /\.(\d+)Z$/.exec(props.iso)?.[1] ?? "";
	return (
		<time datetime={m.iso} title={m.full}>
			{m.date} {m.second}
			<span class="p">.{fraction}</span> UTC
		</time>
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
const runs = formatCount(snapshot.runCount).full;
const seriesCount = formatCount(snapshot.seriesCount).full;

/** On a phone a machine's line names it by its family, which is unique among the five; the key above the ledger gives the full type. */
const family = (instanceType: string) => instanceType.split(".")[0]!;

/** An address, with a place to break after each slash so it wraps where a reader expects. */
function Url(props: { href: string }) {
	const scheme = /^[a-z]+:\/\//.exec(props.href)?.[0] ?? "";
	const parts = props.href.slice(scheme.length).split(/(?<=\/)/);
	return (
		<>
			{scheme}
			{parts.map((part, i) => (
				<>
					{part}
					{i < parts.length - 1 ? <wbr /> : ""}
				</>
			))}
		</>
	);
}

/** A command on one line (it scrolls inside its box where it is too long), and a button that copies it. */
function CopyLine(props: { href: string; label: string }) {
	return (
		<div class="cmd">
			<code>
				<span class="prompt" aria-hidden="true">
					${" "}
				</span>
				curl <Url href={props.href} />
			</code>
			<button type="button" class="copy" data-copy={`curl ${props.href}`} aria-label={`Copy: ${props.label}`} hidden>
				Copy
			</button>
		</div>
	);
}

/** Where a figure is per something smaller than a repetition (mutex: one critical section), what, in the row's own words. */
const perNote = (row: HeadlineRow) => (row.choice.per ? `Per ${row.choice.per.of}; one repetition is ${formatCount(row.choice.per.count).full}.` : "");

const POINT_SHOWN = ["run", "started_at", "counted", "failure", "time_per_repetition_ns", "evidence", "boot_summary"] as const;
const example = seriesFileContents.point.example;
const sample = seriesFileContents.sample;
const exampleJson = JSON.stringify(Object.fromEntries(POINT_SHOWN.map((name) => [name, example[name]])), null, 2);

/** The entry the reading key is drawn from: the first row's first figure, as the ledger holds it. */
const keyRow = 0;
const keyCol = 0;
const keyCell = cells[keyRow]![keyCol]!;
const keyMachine = headline[keyRow]!.cells[keyCol]!.machine;

export default function Page() {
	let entryNo = 0;
	return (
		<>
			<header class="masthead">
				<div class="title">
					<h1>
						LedgerMath<span class="sub">A book of record for cloud servers</span>
					</h1>
					<div class="lede-col">
						<p class="claim">
							{formatCount(snapshot.machineCount).full} AWS machine types, benchmarked four times a day. Every figure kept with its evidence and published as
							static JSON for AI agents.
						</p>
						<p class="lede">Each figure is the median a published Method derived, to every digit, beside the machine's On-Demand price.</p>
						<div class="start">
							<span class="start-h">
								Point an agent at it{" "}
								<a href="#api-h" class="jump">
									The API ↓
								</a>
							</span>
							<CopyLine href={links.index} label="fetch the index" />
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
							{runs}{" "}
							<span class="aside">
								in {seriesCount} Series,{" "}
								{snapshot.failedRuns === 0 ? "none failed" : `${formatCount(snapshot.failedRuns).full} failed`}
							</span>
						</dd>
					</div>
					<div class="wide-only">
						<dt>Boots at</dt>
						<dd>
							{RUN_TIMES.join(" · ")} <span class="aside">UTC</span>
						</dd>
					</div>
					<div class="wide-only">
						<dt>Prices</dt>
						<dd>
							<a href={links.prices}>{snapshot.priceDate}</a>
						</dd>
					</div>
				</dl>
			</header>

			<main>
				<section class="ledger" aria-labelledby="ledger-h">
					<div class="ledger-head">
						<div class="lh-title">
							<h2 id="ledger-h">
								The ledger{" "}
								<span class="dim">
									<span class="sep">· </span>
									{formatCount(headline.length).full} benchmarks × {formatCount(machines.length).full} machine types
								</span>
							</h2>
							<p class="lh-scope">
								{formatCount(headlineSeries.length).full} of the {seriesCount} Series, chosen by a <a href="#rule">written rule</a>.{" "}
								<span class="nowrap">
									<b>↑</b> higher,
								</span>{" "}
								<span class="nowrap">
									<b>↓</b> lower is better.
								</span>
							</p>
						</div>
						<figure class="key" aria-labelledby="key-h">
							<figcaption id="key-h" class="key-h">
								How to read an entry: <span class="mono">{keyMachine.instanceType}</span>
								<span class="key-row">, {headline[keyRow]!.choice.label.toLowerCase()}</span>
							</figcaption>
							<div class="key-grid">
								<span class="key-s key-fig">
									<Written full={keyCell.p50.full} />
									<span class="key-u"> {keyCell.p50.unit}</span>
								</span>
								<span class="key-n">
									<b>The median</b> of the counted Runs, every digit.
								</span>
								<span class="key-s">
									<Rule x={keyCell} scale={rowScale(cells[keyRow]!)} />
								</span>
								<span class="key-n">
									<b>A rule</b> from zero to the median; dark: the 5th to 95th percentile.
								</span>
								<span class="key-s range">
									{roundPlaces(keyCell.p5.full, 3)}–{roundPlaces(keyCell.p95.full, 3)} · <span class="runs">{keyCell.count} Runs ↗</span>
								</span>
								<span class="key-n">
									<b>That range</b>, rounded · <b>the Runs</b>, each with its evidence.
								</span>
							</div>
						</figure>
					</div>
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
												${formatUsd(m.price.usdPerHour).full}
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
															{family(m.instanceType)} <span class="mrep-p">${formatUsd(m.price.usdPerHour).full}</span>
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
											const note = perNote(row);
											const span = note ? 2 : 1;
											return (
												<>
													<tr class="entry">
														<td class="no" rowspan={span}>
															{String(entryNo).padStart(2, "0")}
														</td>
														<th scope="row" class="what" rowspan={span} title={`${c.setting}.`}>
															<span class="label">{c.label}</span>
															<span class="desc">{c.what}</span>
														</th>
														<td class="unit" rowspan={span}>
															<span class="u">{unit}</span>
															<span
																class={`dir ${higher ? "up" : "down"}`}
																role="img"
																aria-label={higher ? "higher is better" : "lower is better"}
																title={higher ? "higher is better" : "lower is better"}
															>
																<span class="arrow">{higher ? "↑" : "↓"}</span>
															</span>
														</td>
														{row.cells.map((cell, k) => {
															const x = xs[k]!;
															return (
																<td class="fig-cell">
																	<span class="mkey" aria-hidden="true">
																		<span class="mk-it">{family(cell.machine.instanceType)}</span>
																		<span class="mk-price">${formatUsd(cell.machine.price.usdPerHour).full}/h</span>
																	</span>
																	<a
																		href={links.seriesFile(cell.series)}
																		title={`${cell.machine.instanceType}: median ${x.p50.full} ${unit}, 5th percentile ${x.p5.full}, 95th ${x.p95.full}, of ${x.count} counted Runs. As the Derivation holds the median: ${x.p50.source}.`}
																	>
																		<Written full={x.p50.full} />
																		<Rule x={x} scale={scale} />
																		<span class="range">
																			{roundPlaces(x.p5.full, 3)}–{roundPlaces(x.p95.full, 3)}
																			<span class="dot" aria-hidden="true">
																				{" "}
																				·{" "}
																			</span>
																			<span class="runs">
																				{x.count} Runs<span aria-hidden="true"> ↗</span>
																			</span>
																		</span>
																	</a>
																</td>
															);
														})}
													</tr>
													{note ? (
														<tr class="memo">
															<td colspan={5} class="memocell">
																<span class="memo-t">
																	<span class="per-rep">{note}</span>
																</span>
															</td>
														</tr>
													) : (
														""
													)}
												</>
											);
										})}
									</tbody>
								);
							})}
						</table>
					</div>
					<p class="foot-note" id="rule">
						<b>The rule.</b> Settings measured on every machine type, the static build, and one thread where a benchmark offers a choice; every Series is in{" "}
						<a href={links.seriesList}>series.json</a>. GB/s and MB/s are 10<sup>9</sup> and 10<sup>6</sup> bytes a second.
					</p>
				</section>

				<section class="api" aria-labelledby="api-h">
					<div class="api-text">
						<h2 id="api-h">For agents and developers</h2>
						<p>
							Static JSON at <span class="mono">api.ledgermath.com</span>, a schema for each kind of file. Any number traces to what the machine printed.
						</p>
						<ol class="ways">
							<li>
								<span class="way-h">
									<span class="way-n">1</span> The index
								</span>
								<CopyLine href={links.index} label="fetch the index" />
							</li>
							<li>
								<span class="way-h">
									<span class="way-n">2</span> Every Series
								</span>
								<CopyLine href={links.seriesList} label="fetch every Series" />
							</li>
							<li>
								<span class="way-h">
									<span class="way-n">3</span> The prices, {snapshot.priceDate}
								</span>
								<CopyLine href={links.prices} label="fetch the newest prices" />
							</li>
							<li>
								<span class="way-h">
									<span class="way-n">4</span> One Series' own file
								</span>
								<CopyLine href={sample.url} label="fetch one Series' file" />
							</li>
						</ol>
						<dl class="addr">
							<div>
								<dt>Schemas</dt>
								<dd>
									{links.schemas.map((s, i) => (
										<>
											<a href={s.url} title={s.url}>
												{s.describes}
											</a>
											{i < links.schemas.length - 1 ? <span class="sep-dot"> · </span> : ""}
										</>
									))}
								</dd>
							</div>
							<div>
								<dt>Evidence</dt>
								<dd class="mono-dd">
									<Url href={links.evidenceBlobTemplate} />
								</dd>
							</div>
							<div>
								<dt>Docs</dt>
								<dd class="serif-dd">
									<a href={links.docs}>The data API in full</a>
								</dd>
							</div>
						</dl>
					</div>
					<figure class="point">
						<figcaption>
							<span class="cap-h">One Run, from step 4</span>
							<span class="mono">{sample.benchmark}</span> on <span class="mono">{sample.instanceType}</span>, abridged.
						</figcaption>
						<div class="json">
							<div class="json-bar">
								<span class="json-t">JSON</span>
								<button type="button" class="copy" data-copy={exampleJson} aria-label="Copy: the Run as JSON" hidden>
									Copy
								</button>
							</div>
							<div class="json-body">
								<div class="brace" aria-hidden="true">
									{"{"}
								</div>
								<dl>
									{POINT_SHOWN.map((name, i) => {
										const value = example[name];
										const text = JSON.stringify(value);
										const isLink = typeof value === "string" && /^https:\/\//.test(value);
										return (
											<div class="jline">
												<dt>{name}</dt>
												<dd class="v">
													{isLink ? (
														<a href={value as string}>
															<Url href={text} />
														</a>
													) : (
														text
													)}
													{i < POINT_SHOWN.length - 1 ? <span class="comma">,</span> : ""}
												</dd>
											</div>
										);
									})}
								</dl>
								<div class="brace" aria-hidden="true">
									{"}"}
								</div>
							</div>
						</div>
					</figure>
				</section>

				<div class="back">
					<section class="machines" aria-labelledby="machines-h">
						<h2 id="machines-h">The machines</h2>
						<p class="section-lede">
							All in {snapshot.region} (zone ID {machines[0]!.availabilityZoneIds.join(", ")}). AWS's On-Demand Linux rates of{" "}
							<a href={links.prices}>{snapshot.priceDate}</a>.
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
										USD an hour
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
											<span class="ph per">/h</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>

					<section class="provenance" aria-labelledby="prov-h">
						<h2 id="prov-h">How a figure is kept</h2>
						<ol class="chain">
							<li>
								<span class="step">Run</span>
								<span>
									A fresh machine boots and runs the benchmarks; their output is kept as evidence, addressed by SHA-256.
								</span>
							</li>
							<li>
								<span class="step">Series</span>
								<span>{snapshot.methods[0]!.definitions.series}</span>
							</li>
							<li>
								<span class="step">Method</span>
								<span>
									Method <i>series</i> v1 takes each Run's median time per repetition, then the 5th, 50th and 95th percentiles across the counted Runs.
								</span>
							</li>
						</ol>
						<dl class="tally">
							<div>
								<dt>Series</dt>
								<dd class="num">{seriesCount}</dd>
							</div>
							<div>
								<dt>Runs</dt>
								<dd class="num">{runs}</dd>
							</div>
							<div>
								<dt>Counted</dt>
								<dd class="num">{formatCount(snapshot.countedRuns).full}</dd>
							</div>
							<div>
								<dt>Failed</dt>
								<dd class="num">{formatCount(snapshot.failedRuns).full}</dd>
							</div>
							<div class="wide">
								<dt>Oldest Run</dt>
								<dd>
									<Moment iso={snapshot.oldestRunStartedAt} />
								</dd>
							</div>
						</dl>
						<p class="quote">
							A Run counts when its binary exited 0 and its output passes the Method's checks; a failed Run stays in its file, in no percentile.
						</p>
					</section>
				</div>
			</main>

			<footer class="colophon">
				<p>
					<a href="third-party-notices.txt">Notices</a>
				</p>
			</footer>
		</>
	);
}
