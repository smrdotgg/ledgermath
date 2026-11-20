// Design v5, "Swiss poster": one grotesque, one strict grid, one accent colour. This form keeps under
// fifty words: the name and the way in, one exact figure set enormous with what it is above it, and
// the table as a typographic object: eleven of the fourteen benchmarks on all five machine types,
// each machine with what it is and costs an hour; the other three a tap away.
// Every figure comes from ../../data exactly as the snapshot holds it (see ../README.md).
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
	type Shown,
} from "../../data";

// ---------------------------------------------------------------- figures

/** A figure in the unit the largest figure of its row takes, so the row's five figures read against each other. */
function show(row: HeadlineRow, value: number): Shown {
	const largest = Math.max(...row.cells.map((cell) => leadFigure(row.choice, cell.series).p50));
	if (row.choice.lead === "rate") return formatRate(value, { unit: formatRate(largest).unit.replace("/s", "") as "GB" });
	// Where a repetition is many units of work (the mutex), the time of one, divided exactly by the module.
	if (row.choice.per) return formatDurationPerUnit(value, row.choice.per, { unit: formatDurationPerUnit(largest, row.choice.per).unit as DurationUnit });
	return formatDuration(value, { unit: durationUnit(largest) });
}

/** The exact figure cut in two for setting, nothing rounded: four significant digits, then the rest. */
function split(full: string): { head: string; tail: string } {
	const [int = "", frac = ""] = full.split(".");
	const sig = int.replace(/^0+/, "").length;
	const places = sig > 0 ? Math.max(0, 4 - sig) : frac.search(/[1-9]/) + 4;
	return { head: frac ? `${int}.${frac.slice(0, places)}`.replace(/\.$/, "") : int, tail: frac ? (places === 0 ? `.${frac}` : frac.slice(places)) : "" };
}

type Cell = HeadlineRow["cells"][number];

/** Every written value of a cell, for the visitor who hovers. */
function exact(row: HeadlineRow, cell: Cell): string {
	const lead = leadFigure(row.choice, cell.series);
	const s = (v: number) => show(row, v).full;
	const unit = show(row, lead.p50).unit;
	const from = formatMoment(cell.series.oldest_run_started_at);
	const to = formatMoment(cell.series.newest_run_started_at);
	return `${row.choice.label}, ${cell.machine.instanceType}, ${unit}\np50 ${s(lead.p50)}\np5 ${s(lead.p5)}\np95 ${s(lead.p95)}\n${lead.count} counted Runs, ${from.full} to ${to.full}`;
}

const pct = (v: number, max: number) => `${((v / max) * 100).toFixed(3)}%`;

// The poster's figure: the table's first cell, read memory sequentially on the cheapest machine type.
const row = headline[0]!;
const hero = row.cells[0]!;
const heroLead = leadFigure(row.choice, hero.series);
const heroFig = show(row, heroLead.p50);
const heroCut = split(heroFig.full);
const newest = formatMoment(hero.series.newest_run_started_at);
const pricesFetched = formatMoment(snapshot.pricesFetchedAt);

/**
 * The rows this form shows at once: eleven of the fourteen, in the headline's order, every section
 * held. The three whose names take the most words wait behind the table's "+3".
 */
const FOLDED = ["memory_read_random", "mutex", "tcp_echo"];
const rows = headline.filter((r) => !FOLDED.includes(r.choice.benchmark));
const folded = headline.filter((r) => FOLDED.includes(r.choice.benchmark));

/**
 * A label with the space between a figure and its unit closed, so "8 KiB" reads, and counts, as one
 * figure; each figure held unbroken ("64-bit" never splits at its hyphen).
 */
function Label(props: { text: string }) {
	const pieces = props.text.replace(/(\d) (KiB|MiB|GiB)\b/g, "$1$2").split(" ");
	return (
		<>
			{pieces.map((piece, i) => (
				<>
					{i > 0 ? " " : ""}
					{/\d/.test(piece) ? <span class="nw">{piece}</span> : piece}
				</>
			))}
		</>
	);
}

// ---------------------------------------------------------------- parts

function Command() {
	return (
		<div class="way">
			<p class="way-k">JSON API</p>
			<div class="cmd" data-copy={`curl ${links.index}`}>
				<code tabindex="0">
					<span class="prompt" aria-hidden="true">
						${" "}
					</span>
					curl <a href={links.index}>{links.index}</a>
				</code>
			</div>
		</div>
	);
}

function Kicker() {
	return (
		<p class="kicker">
			<a class="kicker-b" href={row.choice.readme}>
				{row.choice.label}
			</a>
			<span class="sep" aria-hidden="true">
				{" "}
				/{" "}
			</span>
			<span>{hero.machine.instanceType}</span>
			<span class="sep" aria-hidden="true">
				{" "}
				/{" "}
			</span>
			<span class="kicker-m">
				p50 of{" "}
				<a href={links.seriesFile(hero.series)} title={exact(row, hero)}>
					{formatCount(heroLead.count).full} Runs
				</a>
			</span>
			<span class="sep" aria-hidden="true">
				{" "}
				/{" "}
			</span>
			<time class="kicker-m" datetime={newest.iso} title={`Newest Run started ${newest.full}`}>
				{newest.date}
			</time>
		</p>
	);
}

/** The table: benchmarks down, the five machine types across, cheapest first; every figure exact, on its row's zero-based bar. */
function Figures() {
	return (
		<div class="table-box" role="region" aria-label="p50 figures by benchmark and machine type" tabindex="0">
			<table class="figs">
				<thead>
					<tr>
						<th scope="col" class="corner">
							<span class="corner-r">{snapshot.region}</span>
							<a href={links.prices} title={`AWS On-Demand prices, fetched ${pricesFetched.full}`}>
								On-Demand
							</a>
						</th>
						{machines.map((m) => (
							<th scope="col" class="mach" title={m.processor}>
								<span class="mach-name">{m.instanceType}</span>
								<span class="mach-spec">
									{`${m.vcpu}vCPU`} {m.memory.replace(" ", "")}
								</span>
								<span class="mach-price" title={m.price.path.pointer}>{`$${formatUsd(m.price.usdPerHour, { per: "hour" }).full}/h`}</span>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((r, i) => (
						<Row row={r} first={i > 0 && rows[i - 1]!.choice.section !== r.choice.section} />
					))}
				</tbody>
			</table>
		</div>
	);
}

/** One benchmark across the five machine types; a heavier rule where a new section begins. */
function Row(props: { row: HeadlineRow; first?: boolean }) {
	const r = props.row;
	const max = Math.max(...r.cells.map((cell) => leadFigure(r.choice, cell.series).p50));
	return (
		<tr class={props.first ? "sec" : undefined}>
			<th scope="row" class="lab">
				<a href={r.choice.readme}>
					<Label text={r.choice.label} />
				</a>
				<span class="dir" title={r.choice.lead === "rate" ? "Higher is faster" : "Lower is faster"}>
					{r.choice.lead === "rate" ? "↑" : "↓"}
				</span>
				{r.choice.per && <span class="lab-per">per {r.choice.per.of}</span>}
			</th>
			{r.cells.map((cell) => {
				const lead = leadFigure(r.choice, cell.series);
				const s = show(r, lead.p50);
				const f = split(s.full);
				return (
					<td class={cell === hero ? "is-hero" : undefined}>
						<a class="fig" href={links.seriesFile(cell.series)} title={exact(r, cell)}>
							<span class="fh">{f.head}</span>
							<span class="ft">{`${f.tail}${s.unit}`}</span>
						</a>
						<span class="bar" aria-hidden="true">
							<span style={{ width: pct(lead.p50, max) }} />
						</span>
					</td>
				);
			})}
		</tr>
	);
}

/** The three rows whose names take the most words, a tap away: the same columns, the machine types named again. */
function More() {
	return (
		<details class="more">
			<summary aria-label={`${folded.length} more benchmarks`}>
				<span class="more-mark" aria-hidden="true" />
				{`+${folded.length}`}
			</summary>
			<div class="table-box" role="region" aria-label="The other benchmarks" tabindex="0">
				<table class="figs">
					<thead>
						<tr>
							<td class="corner" />
							{machines.map((m) => (
								<th scope="col" class="mach">
									<span class="mach-name mach-name-s">{m.instanceType}</span>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{folded.map((r) => (
							<Row row={r} />
						))}
					</tbody>
				</table>
			</div>
		</details>
	);
}

export default function Page() {
	return (
		<>
			<main class="poster">
				<h1 class="name">LedgerMath</h1>
				<Command />
				<Kicker />
				{/* The unit shares one text with the last digits, so it reads, and counts, as part of the figure. */}
				<p class="hero-figure">
					<span class="hero-head">{heroCut.head}</span>
					<span class="hero-tail">{`${heroCut.tail}${heroFig.unit}`}</span>
				</p>
				<div class="figures">
					<Figures />
					<More />
				</div>
			</main>
			<footer class="foot">
				<a class="foot-lic" href="third-party-notices.txt" aria-label="Third-party notices: the typeface's licence">
					©
				</a>
			</footer>
		</>
	);
}
