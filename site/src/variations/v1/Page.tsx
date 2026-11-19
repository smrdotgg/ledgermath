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

/**
 * Margin notes where a row times something every machine type shares (the same kind of volume,
 * the same service) as much as the machine: so that five figures close together read as what
 * they are. Each rests on the row's own words in the data module.
 */
const NB: Record<string, string> = {
	disk_read_sequential:
		"Every machine type reads the same kind of volume, root EBS gp3, and this row reaches its throughput limit: it times the volume as much as the machine.",
	disk_read_random: "One read at a time from the volume, and every machine type has the same kind, root EBS gp3.",
	disk_read_io_uring: "Random 4 KiB reads reach the volume's IOPS limit, on the same kind of volume for every machine type.",
	disk_write: "The time until the volume has the data, and every machine type has the same kind, root EBS gp3.",
	http_get: "A round trip to S3 in the same region: it times S3 and the way to it as much as the machine.",
};

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

/** What one repetition is, and the settings, in the row's own words. */
function memoOf(row: HeadlineRow): { rep: string; setting: string } {
	const c = row.choice;
	const rep =
		c.lead === "rate"
			? "Bytes per second."
			: c.per
				? `Per ${c.per.of}; one repetition is ${formatCount(c.per.count).full}.`
				: `Per repetition: ${c.repetition.replace(/\.$/, "").replace(/^One /, "one ")}.`;
	return { rep, setting: `${c.setting}.` };
}

/** The schema's word for a part of a Series file's point. */
const pointWords = (name: string) => seriesFileContents.point.fields.find((f) => f.name === name)?.what ?? "";
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
						<p class="lede">
							Each boot runs {formatCount(snapshot.benchmarkCount).full} benchmarks on a freshly booted machine in {snapshot.region} and keeps every Run.{" "}
							<span class="more">
								Each figure is the median its published Method derived, to every digit, beside AWS's On-Demand price for the machine.
							</span>
						</p>
						<div class="start">
							<span class="start-h">
								Point an agent at it{" "}
								<a href="#api-h" class="jump">
									How agents read it ↓
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
							{RUN_TIMES.join(" · ")} <span class="aside">UTC; each Run starts after its machine boots</span>
						</dd>
					</div>
					<div class="wide-only">
						<dt>Data API</dt>
						<dd>
							<a href={links.index} class="mono">
								{links.index.replace("https://", "")}
							</a>
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
								This table holds {formatCount(headlineSeries.length).full} of the {seriesCount} Series, chosen by a{" "}
								<a href="#rule">written rule</a>. Machines run cheapest first; each unit says which way is better.
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
									<span class="kn-long">
										<b>The median</b> of the counted Runs, every digit: three places in ink, the rest in pencil, one number, nothing rounded.
									</span>
									<span class="kn-short" aria-hidden="true">
										<b>Median</b>, every digit, nothing rounded
									</span>
								</span>
								<span class="key-s">
									<Rule x={keyCell} scale={rowScale(cells[keyRow]!)} />
								</span>
								<span class="key-n">
									<span class="kn-long">
										<b>A rule</b> from zero to the median, on the row's scale; the dark mark spans the 5th to 95th percentile.
									</span>
									<span class="kn-short" aria-hidden="true">
										<b>Rule</b> from zero; dark: 5th–95th percentile
									</span>
								</span>
								<span class="key-s range">
									{roundPlaces(keyCell.p5.full, 3)}–{roundPlaces(keyCell.p95.full, 3)} · <span class="runs">{keyCell.count} Runs ↗</span>
								</span>
								<span class="key-n">
									<span class="kn-long">
										<b>The 5th to 95th percentile</b>, rounded to three places · <b>the Runs counted</b>, which open the Series' file and every Run's evidence.
									</span>
									<span class="kn-short" aria-hidden="true">
										<b>Range</b>, rounded · <b>Runs</b>, each with its evidence
									</span>
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
												<span class="per"> an hour</span>
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
															{m.instanceType} <span class="mrep-p">${formatUsd(m.price.usdPerHour).full}</span>
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
											const nb = NB[c.benchmark];
											const memo = memoOf(row);
											return (
												<>
													<tr class="entry">
														<td class="no" rowspan={2}>
															{String(entryNo).padStart(2, "0")}
														</td>
														<th scope="row" class="what" rowspan={2}>
															<span class="label">{c.label}</span>
															<span class="desc">{c.what}</span>
														</th>
														<td class="unit" rowspan={2}>
															<span class="u">{unit}</span>
															<span class={`dir ${higher ? "up" : "down"}`}>
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
																		<span class="mk-it">{cell.machine.instanceType}</span>
																		<span class="mk-price">${formatUsd(cell.machine.price.usdPerHour).full}/h</span>
																	</span>
																	<a
																		href={links.seriesFile(cell.series)}
																		title={`${cell.machine.instanceType}: median ${x.p50.full} ${unit}, 5th percentile ${x.p5.full}, 95th ${x.p95.full}, of ${x.count} counted Runs. As the Derivation holds the median: ${x.p50.source}.`}
																	>
																		<Written full={x.p50.full} />
																		<span class="vh"> {unit}</span>
																		<Rule x={x} scale={scale} />
																		<span class="range">
																			<span class="vh">5th to 95th percentile, rounded: </span>
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
													<tr class={nb ? "memo has-nb" : "memo"}>
														<td colspan={5} class="memocell">
															<span class="memo-t">
																<span class="per-rep">{memo.rep}</span> {memo.setting}
															</span>
															{nb ? (
																<span class="nb">
																	<span class="nb-mark">N.B.</span> {nb}
																</span>
															) : (
																""
															)}
														</td>
													</tr>
												</>
											);
										})}
									</tbody>
								);
							})}
						</table>
					</div>
					<p class="foot-note" id="rule">
						<b>The rule.</b> Each figure is one of the {formatCount(headlineSeries.length).full} Series chosen for this table by a written rule: settings
						measured on every machine type, the static build, and one thread where a benchmark offers a choice. All {seriesCount} Series, other settings and
						builds among them, are in <a href={links.seriesList}>series.json</a>. GB/s and MB/s are 10<sup>9</sup> and 10<sup>6</sup> bytes a second. A
						range is rounded to three places; hover a figure, or open its Series' file, for every digit.
					</p>
				</section>

				<section class="api" aria-labelledby="api-h">
					<div class="api-text">
						<h2 id="api-h">For agents and developers</h2>
						<p>
							The ledger is static JSON at <span class="mono">api.ledgermath.com</span>. An agent reads one index, then every Series with its percentiles and the
							Method that made them, the day's On-Demand prices, and a JSON schema for each kind of file. Each Series' own file gives every Run's figure and
							a link to its evidence, so any number can be traced to what the machine printed.
						</p>
						<p class="small">Version 1 only ever gains fields: a field, once published, keeps its name, its type and its meaning.</p>
						<ol class="ways">
							<li>
								<span class="way-h">
									<span class="way-n">1</span> The index
								</span>
								<span class="way-d">What the API holds and where: the Series, the prices, the schemas and the evidence.</span>
								<CopyLine href={links.index} label="fetch the index" />
							</li>
							<li>
								<span class="way-h">
									<span class="way-n">2</span> Every Series
								</span>
								<span class="way-d">All {seriesCount}, each with its percentiles, its Runs counted and its own file's address.</span>
								<CopyLine href={links.seriesList} label="fetch every Series" />
							</li>
							<li>
								<span class="way-h">
									<span class="way-n">3</span> The prices, {snapshot.priceDate}
								</span>
								<span class="way-d">AWS's public On-Demand prices for the five machine types, copied daily.</span>
								<CopyLine href={links.prices} label="fetch the newest prices" />
							</li>
							<li>
								<span class="way-h">
									<span class="way-n">4</span> One Series' own file
								</span>
								<span class="way-d">
									Every Run's figure and a link to its evidence, at <span class="mono">{links.seriesFilePattern.replace("https://", "")}</span>. This one
									holds the Run shown here.
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
								<dt>Documentation</dt>
								<dd class="serif-dd">
									<a href={links.docs}>The data API, described in full</a>
								</dd>
							</div>
						</dl>
					</div>
					<figure class="point">
						<figcaption>
							<span class="cap-h">One Run, as its Series' file gives it</span>
							From step 4: the first of the {sample.points} Runs of <span class="mono">{sample.benchmark}</span> on{" "}
							<span class="mono">{sample.instanceType}</span>, its samples and {seriesFileContents.point.fields.length - POINT_SHOWN.length} other fields left
							out. In the margin, the schema's own words.
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
												<dd class="w">{pointWords(name)}</dd>
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
							Five machine types, all in {snapshot.region} (zone ID {machines[0]!.availabilityZoneIds.join(", ")}), each Run on a freshly booted machine.
							Prices are AWS's public On-Demand Linux rates, copied daily; this copy is dated {snapshot.priceDate}.
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
											<span class="ph per"> an hour</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
						<p class="foot-note">
							AWS's own words, as the price file holds them: “{machines[0]!.price.description}”. Price file:{" "}
							<a href={links.prices}>{links.prices.replace("https://", "")}</a>.
						</p>
					</section>

					<section class="provenance" aria-labelledby="prov-h">
						<h2 id="prov-h">How a figure is kept</h2>
						<ol class="chain">
							<li>
								<span class="step">Run</span>
								<span>
									A fresh machine boots at {RUN_TIMES.join(", ")} UTC and runs the benchmarks on it; each Run starts some time after the boot. What the
									benchmark printed and what was recorded about the machine are kept as evidence, addressed by SHA-256.
								</span>
							</li>
							<li>
								<span class="step">Series</span>
								<span>{snapshot.methods[0]!.definitions.series}</span>
							</li>
							<li>
								<span class="step">Method</span>
								<span>
									A versioned Method turns a Series' Runs into its figures. Method <i>series</i> v1 takes each Run's median time per repetition, then the 5th,
									50th and 95th percentiles across the counted Runs.
								</span>
							</li>
							<li>
								<span class="step">Figure</span>
								<span>The median, as written in the ledger above: nothing rounded, nothing computed that the Derivation does not hold.</span>
							</li>
						</ol>
						<dl class="tally">
							<div>
								<dt>Series</dt>
								<dd class="num">{seriesCount}</dd>
							</div>
							<div>
								<dt>Runs kept</dt>
								<dd class="num">{runs}</dd>
							</div>
							<div>
								<dt>Counted</dt>
								<dd class="num">{formatCount(snapshot.countedRuns).full}</dd>
							</div>
							<div>
								<dt>Failed, kept</dt>
								<dd class="num">{formatCount(snapshot.failedRuns).full}</dd>
							</div>
							<div class="wide">
								<dt>Newest Run</dt>
								<dd>
									<Moment iso={snapshot.newestRunStartedAt} />
								</dd>
							</div>
							<div class="wide">
								<dt>Oldest Run</dt>
								<dd>
									<Moment iso={snapshot.oldestRunStartedAt} />
								</dd>
							</div>
						</dl>
						<p class="quote">
							A Run counts when its binary exited 0 and everything it printed passes the Method's checks. Any other Run is failed: it stays in its Series'
							file, with <span class="mono">counted</span> false and the reason in <span class="mono">failure</span>, and in no percentile.
							{snapshot.failedRuns === 0 ? " In this copy of the book, no Run has failed." : ""}
						</p>
					</section>
				</div>
			</main>

			<footer class="colophon">
				<p>
					LedgerMath · entries to {newest.longDate}, {newest.second} UTC · {runs} Runs · prices of {snapshot.priceDate}
				</p>
				<p>
					Set in Source Serif 4 and IBM Plex Mono · <a href="third-party-notices.txt">Third-party notices</a>
				</p>
			</footer>
		</>
	);
}
