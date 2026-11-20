// Design v1, "Ledger", in its tiny forms: the home page as a book of record with almost no words. The figures
// are the page: one column per machine type, one entry per benchmark, every figure written out to its last
// digit (three places in ink, the rest in pencil) with its unit set against it. Under each figure a pencil
// rule drawn from zero on one scale per row. What a row or a column is opens on a tap (a closed <details>),
// so nothing a visitor can see is left unnamed. FORM sets the budget of visible words; each larger form adds
// the next most useful words. No best, no ranking, no ties.
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

/** The form's budget: visible words that are not figures stay under it. */
const FORM = 5 as 5 | 10 | 20 | 30 | 50;
const has = (budget: 10 | 20 | 30 | 50) => FORM >= budget;

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
/** The widest whole part of a row's figures, in digits: one benchmark's figures line up on the point. */
const wholeDigits = (xs: Cell[]) => Math.max(...xs.map((c) => c.p50.full.split(".")[0]!.length));

/**
 * A figure as a ledger writes it: whole part right-aligned, three places in ink, the rest in pencil in threes,
 * and its unit set tight against the last digits, in one piece of text, as a figure and its unit are one thing.
 */
function Written(props: { full: string; unit: string }) {
	const [whole = "0", fraction = ""] = props.full.split(".");
	const ink = fraction.slice(0, 3);
	const pencil = fraction.slice(3).match(/\d{1,3}/g) ?? [];
	const last = pencil.pop();
	return (
		<span class="fig">
			<span class="w">{whole}</span>
			<span class="d">{fraction ? `.${ink}` : ""}</span>
			<span class="p">
				{pencil.map((g) => (
					<span>{g}</span>
				))}
				<span class="tail">{`${last ?? ""}${props.unit}`}</span>
			</span>
		</span>
	);
}

/** The pencil rule under a figure, drawn from zero: a zero tick, a line to the median, p5–p95 in ink, the median a red notch. */
function Rule(props: { x: Cell; hi: number }) {
	const pct = (v: number) => `${(props.hi > 0 ? (v / props.hi) * 100 : 0).toFixed(3)}%`;
	return (
		<span class="bar" aria-hidden="true" style={{ "--to": pct(props.x.p50.value), "--lo": pct(props.x.p5.value), "--hi": pct(props.x.p95.value) }}>
			<span class="bar-zero" />
			<span class="bar-len" />
			<span class="bar-rng" />
			<span class="bar-mid" />
		</span>
	);
}

/** The rule's scale runs from zero to the row's highest 95th percentile (a choice of scale for drawing, not a statistic). */
const rowTop = (xs: Cell[]) => Math.max(...xs.map((x) => x.p95.value));

/** Each machine's usual count of counted Runs, written once in its column head; a cell names its count only where it differs. */
const usualCount = machines.map((_, k) => {
	const tally = new Map<number, number>();
	for (const xs of cells) tally.set(xs[k]!.count, (tally.get(xs[k]!.count) ?? 0) + 1);
	return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
});

// ------------------------------------------------------------------ the page

const SECTIONS: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
const newest = formatMoment(snapshot.newestRunStartedAt);
const price = (usd: Parameters<typeof formatUsd>[0]) => `$${formatUsd(usd).full}`;
const sampleRun = seriesFileContents.point.example;
const two = (i: number) => String(i + 1).padStart(2, "0");

/** A size such as "8 GiB" or "2 vCPU", the unit set tight against its number, one piece of text. */
function Tight(props: { n: string; unit: string }) {
	return <span class="tight">{`${props.n}${props.unit}`}</span>;
}

/** The tally: counted Runs behind a figure, in pencil. */
function Tally(props: { count: number }) {
	return (
		<span class="n">
			<i>n</i>
			{props.count}
		</span>
	);
}

/** Two sheets, the copy mark. */
function CopyMark() {
	return (
		<svg class="copy-mark" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<rect x="5.5" y="5.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" />
			<path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" fill="none" stroke="currentColor" />
		</svg>
	);
}

function MachineHead(props: { k: number }) {
	const m = machines[props.k]!;
	const [mem = "", memUnit = ""] = m.memory.split(" ");
	const spec = (
		<span class="spec">
			<Tight n={m.vcpu} unit="vCPU" /> · <Tight n={mem} unit={memUnit} />
		</span>
	);
	const priceLine = (
		<span class="mrow">
			<span class="price" title={`${m.price.description}; SKU ${m.price.sku}`}>
				{price(m.price.usdPerHour)}
				<span class="per">/h</span>
			</span>
			<span title={`${usualCount[props.k]} counted Runs behind each figure in this column, unless its cell says otherwise`}>
				<Tally count={usualCount[props.k]!} />
			</span>
		</span>
	);
	if (has(10)) {
		return (
			<th scope="col" class="mach">
				<span class="it" title={`${m.processor}, ${m.clockSpeed}; network ${m.network}`}>
					{m.instanceType}
				</span>
				{spec}
				{priceLine}
			</th>
		);
	}
	// Below ten words the column is its price and size; its name opens on a tap.
	return (
		<th scope="col" class="mach" aria-label={m.instanceType}>
			<details class="note">
				<summary>
					{priceLine}
					{spec}
				</summary>
				<span class="pop">
					<a class="it" href={links.prices} title={`${m.processor}, ${m.clockSpeed}`}>
						{m.instanceType}
					</a>
				</span>
			</details>
		</th>
	);
}

export default function Page() {
	return (
		<>
			<header class="masthead">
				<h1>LedgerMath</h1>
				<div class="start">
					<div class="cmd">
						<code tabindex="0">{`curl ${links.index}`}</code>
						<button type="button" class="copy" data-copy={`curl ${links.index}`} aria-label="Copy the command" title="Copy the command" hidden>
							<CopyMark />
						</button>
					</div>
					<p class="folio">
						<time datetime={newest.iso} title={newest.full}>
							<span class="date">{newest.date}</span> <span class="clock">{newest.minute}</span>
						</time>
						<span class="sep" aria-hidden="true">
							·
						</span>
						<a href={sampleRun.evidence ?? links.evidenceBlobTemplate} title={`Run ${sampleRun.run}: its binary, streams and dumps by sha256`}>
							evidence
						</a>
					</p>
				</div>
			</header>

			<main>
				<section class="ledger" aria-label="The ledger: 14 benchmarks on 5 machine types">
					<div class="scroll" tabindex="0" role="region" aria-label="The ledger, scrollable">
						<table>
							<thead id="machines">
								<tr>
									<th scope="col" class="what">
										<details class="note legend">
											<summary aria-label="How to read a figure" title="How to read a figure">
												<span class="lg-rule lg-zero" aria-hidden="true">
													<span class="lg-len" />
													<span class="lg-rng" />
													<span class="lg-mid" />
												</span>
											</summary>
											<span class="pop">
												<span class="lg-item">median, p5–p95</span>
												<span class="lg-item">rule from 0, per row</span>
												<span class="lg-item">
													<i class="nn">n</i> counted Runs
												</span>
											</span>
										</details>
									</th>
									{machines.map((_, k) => (
										<MachineHead k={k} />
									))}
								</tr>
							</thead>
							{SECTIONS.map((section) => {
								const rows = headline.map((row, i) => ({ row, i })).filter(({ row }) => row.choice.section === section);
								return (
									<tbody class="acct">
										{rows.map(({ row, i }) => {
											const c = row.choice;
											const xs = cells[i]!;
											const top = rowTop(xs);
											const higher = c.lead === "rate";
											const tallied = xs.some((x, k) => x.count !== usualCount[k]);
											return (
												<tr class="entry" style={{ "--whole": `${wholeDigits(xs)}ch` }}>
													<th scope="row" class="what" aria-label={c.label}>
														<details class="note">
															<summary>
																<span class="no">{two(i)}</span>
																<span class="arrow" role="img" aria-label={`${higher ? "higher" : "lower"} is better`} title={`${higher ? "Higher" : "Lower"} is better`}>
																	{higher ? "↑" : "↓"}
																</span>
															</summary>
															<span class="pop">
																<a href={c.readme} title={`${c.what} ${c.setting}.`}>
																	{c.label}
																</a>
															</span>
														</details>
													</th>
													{row.cells.map((cell, k) => {
														const x = xs[k]!;
														return (
															<td class="fig-cell">
																<span class="mkey" aria-hidden="true">
																	{price(cell.machine.price.usdPerHour)}
																	<span class="per">/h</span>
																</span>
																<a
																	href={links.seriesFile(cell.series)}
																	title={`${c.label}, ${cell.machine.instanceType}: median of ${x.count} counted Runs ${x.p50.full} ${x.p50.unit}; 5th percentile ${x.p5.full}, 95th ${x.p95.full}. As the Derivation holds it: ${x.p50.source}.`}
																>
																	<Written full={x.p50.full} unit={x.p50.unit} />
																	<span class="line">
																		<Rule x={x} hi={top} />
																		{x.count !== usualCount[k] ? <Tally count={x.count} /> : tallied ? <span class="n" /> : ""}
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
			</main>

			<footer class="colophon">
				<a href="third-party-notices.txt" class="mark" aria-label="Third-party notices" title="Third-party notices">
					©
				</a>
			</footer>
		</>
	);
}
