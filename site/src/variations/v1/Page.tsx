// Design v1, "Ledger": the home page as a book of record. One ruled table is the page: one
// column per machine type, one entry per benchmark, every figure written out to its last digit
// (three decimal places in ink, the rest in pencil) and decimal-aligned down its column.
import "./page.css";
import {
	DURATION_UNITS,
	durationUnit,
	formatCount,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	headlineSeries,
	leadFigure,
	links,
	machines,
	plain,
	shift,
	snapshot,
	type DurationUnit,
	type HeadlineRow,
	type Section,
} from "../../data";

// ------------------------------------------------------------------ figures, written out

/** One figure in the unit its row is shown in: every digit, and where they came from. */
type Entry = { full: string; unit: string; source: string };

/** Each row is shown in one unit, so its figures line up on the decimal point. */
function rowEntries(row: HeadlineRow): Entry[] {
	const figures = row.cells.map((cell) => leadFigure(row.choice, cell.series));
	if (row.choice.lead === "rate") {
		// The unit that formatRate would pick for the row's largest figure (a choice of unit, not a statistic).
		const unit = formatRate(Math.max(...figures.map((f) => f.p50))).unit.replace("/s", "") as "GB" | "MB";
		return figures.map((f) => {
			const shown = formatRate(f.p50, { unit });
			return { full: shown.full, unit: shown.unit, source: shown.source };
		});
	}
	// Times: per repetition, or, where one repetition is a fixed count of something smaller
	// (mutex: 10,000 critical sections), per one of those, by moving the decimal point.
	const per = row.choice.per;
	const places = per ? Math.log10(per.count) : 0;
	if (!Number.isInteger(places)) throw new Error(`${row.choice.benchmark}: a repetition of ${per?.count} is not a power of ten`);
	const ns = figures.map((f) => shift(plain(f.p50), -places));
	const unit: DurationUnit = durationUnit(Math.max(...figures.map((f) => f.p50)) / 10 ** places);
	return ns.map((text, i) => ({
		full: shift(text, DURATION_UNITS[unit]),
		unit,
		source: `${plain(figures[i]!.p50)} ns per repetition`,
	}));
}

const entries = headline.map(rowEntries);
/** The widest whole part of any figure, in digits, so every column's decimal points line up. */
const wholeDigits = Math.max(...entries.flat().map((e) => e.full.split(".")[0]!.length));

/** A figure as a ledger writes it: whole part right-aligned, three places in ink, the rest in pencil, in groups of three. */
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

// ------------------------------------------------------------------ the page

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
const ROMAN = ["I", "II", "III", "IV", "V"];
const RUN_TIMES = ["04:10", "10:10", "16:10", "22:10"];

const newest = formatMoment(snapshot.newestRunStartedAt);
const runs = formatCount(snapshot.runCount).full;
const seriesCount = formatCount(snapshot.seriesCount).full;

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

export default function Page() {
	let entryNo = 0;
	return (
		<>
			<header class="masthead">
				<div class="title">
					<h1>
						LedgerMath<span class="sub">A book of record for cloud servers</span>
					</h1>
					<p class="lede">
						Four times a day, LedgerMath boots {formatCount(snapshot.machineCount).full} AWS machine types in {snapshot.region}, runs{" "}
						{formatCount(snapshot.benchmarkCount).full} benchmarks on each and keeps every Run with its evidence. Every figure is exact, with a published
						Method behind it, and the whole book is static JSON, so that AI agents can make infrastructure decisions from measured numbers.
					</p>
				</div>
				<dl class="folio" aria-label="The state of the book">
					<div>
						<dt>Entries to</dt>
						<dd>
							<Moment iso={snapshot.newestRunStartedAt} />
						</dd>
					</div>
					<div>
						<dt>Runs</dt>
						<dd>
							{runs} <span class="aside">in {seriesCount} Series</span>
						</dd>
					</div>
					<div>
						<dt>Runs at</dt>
						<dd>
							{RUN_TIMES.join(" · ")} <span class="aside">UTC</span>
						</dd>
					</div>
					<div>
						<dt>Data API</dt>
						<dd>
							<a href={links.index} class="mono">
								{links.index.replace("https://", "")}
							</a>
							<a href="#api-h" class="jump">
								How agents read it ↓
							</a>
						</dd>
					</div>
				</dl>
			</header>

			<main>
				<section class="ledger" aria-labelledby="ledger-h">
					<div class="ledger-head">
						<h2 id="ledger-h">
							The ledger <span class="dim"><span class="sep">· </span>{formatCount(headline.length).full} benchmarks × {formatCount(machines.length).full} machine types</span>
						</h2>
						<p class="reading">
							Each figure is the <em>median (p50)</em> of one Series' counted Runs, to the last digit its Derivation holds:{" "}
							<span class="ink-key">three places in ink</span>, <span class="p">the rest in pencil</span>. Machines run cheapest first. Each figure links to
							its Series' file: every Run, with its evidence.
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
									<th scope="col" class="note">
										Note
									</th>
								</tr>
							</thead>
							{SECTIONS.map((section, s) => {
								const rows = headline.map((row, i) => ({ row, i })).filter(({ row }) => row.choice.section === section);
								return (
									<tbody>
										<tr class="sec">
											<th scope="colgroup" colspan={9}>
												<span class="roman">{ROMAN[s]}.</span> {section}
											</th>
										</tr>
										{rows.map(({ row, i }) => {
											entryNo += 1;
											const c = row.choice;
											const row_entries = entries[i]!;
											const unit = row_entries[0]!.unit;
											return (
												<tr class="entry">
													<td class="no">{String(entryNo).padStart(2, "0")}</td>
													<th scope="row" class="what">
														<span class="label">{c.label}</span>
														<span class="desc">{c.what}</span>
													</th>
													<td class="unit">{unit}</td>
													{row.cells.map((cell, k) => {
														const e = row_entries[k]!;
														const f = leadFigure(c, cell.series);
														return (
															<td class="fig-cell" data-m={cell.machine.instanceType}>
																<a
																	href={links.seriesFile(cell.series)}
																	title={`${e.full} ${e.unit}: median of ${f.count} counted Runs on ${cell.machine.instanceType}. As the Derivation holds it: ${e.source}.`}
																>
																	<Written full={e.full} />
																	<span class="vh"> {e.unit}</span>
																</a>
															</td>
														);
													})}
													<td class="note">
														<span class="per-rep">
															{c.lead === "rate"
																? "Bytes per second."
																: c.per
																	? `Per ${c.per.of}; one repetition is ${formatCount(c.per.count).full}.`
																	: `Per repetition: ${c.repetition.replace(/\.$/, "").replace(/^One /, "one ")}.`}
														</span>
														<span class="setting">{c.setting}.</span>
													</td>
												</tr>
											);
										})}
									</tbody>
								);
							})}
						</table>
					</div>
					<p class="foot-note">
						Each figure is one of the {formatCount(headlineSeries.length).full} Series chosen for this table by a written rule: settings measured on every
						machine type, the static build, and one thread where a benchmark offers a choice. All {seriesCount} Series, other settings and builds among them, are in{" "}
						<a href={links.seriesList}>series.json</a>.
					</p>
				</section>

				<section class="api" aria-labelledby="api-h">
					<div class="api-text">
						<h2 id="api-h">For agents and developers</h2>
						<p>
							The ledger is static JSON at <span class="mono">api.ledgermath.com</span>. An agent reads one index, then every Series with its percentiles and the
							Method that made them, the day's On-Demand prices, and a JSON schema for each kind of file. Each point in a Series file links the Run and
							its evidence, so any number can be traced to what the machine printed.
						</p>
						<p class="small">Version 1 only ever gains fields: a field, once published, keeps its name, its type and its meaning.</p>
					</div>
					<div class="api-cmds">
						<CopyLine href={links.index} label="fetch the index" />
						<CopyLine href={links.seriesList} label="fetch every Series" />
						<CopyLine href={links.prices} label="fetch the newest prices" />
						<dl class="addr">
							<div>
								<dt>Index</dt>
								<dd>
									<a href={links.index}>
										<Url href={links.index} />
									</a>
								</dd>
							</div>
							<div>
								<dt>Every Series</dt>
								<dd>
									<a href={links.seriesList}>
										<Url href={links.seriesList} />
									</a>
								</dd>
							</div>
							<div>
								<dt>Prices, {snapshot.priceDate}</dt>
								<dd>
									<a href={links.prices}>
										<Url href={links.prices} />
									</a>
								</dd>
							</div>
							{links.schemas.map((s) => (
								<div>
									<dt>
										Schema <span class="aside">{s.describes}</span>
									</dt>
									<dd>
										<a href={s.url}>
										<Url href={s.url} />
									</a>
									</dd>
								</div>
							))}
							<div>
								<dt>Documentation</dt>
								<dd>
									<a href={links.docs}>The data API, described in full</a>
								</dd>
							</div>
						</dl>
					</div>
				</section>

				<div class="back">
					<section class="machines" aria-labelledby="machines-h">
						<h2 id="machines-h">The machines</h2>
						<p class="section-lede">
							Five machine types, all in {snapshot.region} (zone ID {machines[0]!.availabilityZoneIds.join(", ")}), each Run on a freshly booted machine.
							Prices are AWS's public On-Demand Linux rates, copied daily; this copy is dated {snapshot.priceDate}.
						</p>
						<div class="scroll" tabindex="0" role="region" aria-label="The machines, scrollable">
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
											<th scope="row" class="mono">
												{m.instanceType}
											</th>
											<td class="r num">{m.vcpu}</td>
											<td class="r num">{m.memory}</td>
											<td>
												{m.processor}
												<span class="clock">{m.clockSpeed}</span>
											</td>
											<td>{m.network}</td>
											<td class="r num" title={`${m.price.description}; SKU ${m.price.sku}`}>
												<Written full={formatUsd(m.price.usdPerHour).full} inkPlaces={10} />
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
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
									A fresh machine boots at {RUN_TIMES.join(", ")} UTC and runs the benchmarks on it. What the benchmark printed and what was recorded about the
									machine are kept as evidence, addressed by SHA-256.
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
							A Run counts when its binary exited 0 and everything it printed passes the Method's checks. Any other Run is failed: shown, with the reasons,
							and in no percentile.
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
