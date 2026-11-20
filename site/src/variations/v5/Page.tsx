// Design v5, "Swiss poster": one grotesque, one strict grid, one accent colour. This form keeps under
// twenty words: the name and the way in, one exact figure set enormous with what it is above it, and
// the same benchmark on all five machine types, with what each is and costs an hour.
// Every figure comes from ../../data exactly as the snapshot holds it (see ../README.md).
import "./page.css";
import { formatCount, formatMoment, formatRate, formatUsd, headline, leadFigure, links, snapshot, type HeadlineRow, type Shown } from "../../data";

// ---------------------------------------------------------------- figures

/** A rate in the unit the largest figure of its row takes, so the row's figures read against each other. */
function show(row: HeadlineRow, value: number): Shown {
	const largest = Math.max(...row.cells.map((cell) => leadFigure(row.choice, cell.series).p50));
	return formatRate(value, { unit: formatRate(largest).unit.replace("/s", "") as "GB" });
}

/** The exact figure cut in two for setting, nothing rounded: four significant digits, then the rest. */
function split(full: string): { head: string; tail: string } {
	const [int = "", frac = ""] = full.split(".");
	const places = Math.max(0, 4 - int.length);
	return { head: frac ? `${int}.${frac.slice(0, places)}` : int, tail: frac.slice(places) };
}

type Cell = HeadlineRow["cells"][number];

/** Every written value of a cell, for the visitor who hovers. */
function exact(row: HeadlineRow, cell: Cell): string {
	const lead = leadFigure(row.choice, cell.series);
	const s = (v: number) => show(row, v).full;
	const unit = show(row, lead.p50).unit;
	const from = formatMoment(cell.series.oldest_run_started_at);
	const to = formatMoment(cell.series.newest_run_started_at);
	return `${cell.machine.instanceType}, ${unit}\np50 ${s(lead.p50)}\np5 ${s(lead.p5)}\np95 ${s(lead.p95)}\n${lead.count} counted Runs, ${from.full} to ${to.full}`;
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

/** The same benchmark on all five machine types, cheapest first: what each is, its hourly price, its figure on one zero-based scale. */
function Machines() {
	const max = Math.max(...row.cells.map((cell) => leadFigure(row.choice, cell.series).p50));
	return (
		<table class="mach">
			<thead>
				<tr>
					<th scope="col" class="mach-type">
						{snapshot.region}
					</th>
					<th scope="col" class="num">
						vCPU
					</th>
					<td />

					<th scope="col" class="num">
						<a href={links.prices} title={`AWS On-Demand prices, fetched ${pricesFetched.full}`}>
							On-Demand
						</a>
					</th>
					<th scope="col" class="mach-fig">
						p50
					</th>
				</tr>
			</thead>
			<tbody>
				{row.cells.map((cell) => {
					const lead = leadFigure(row.choice, cell.series);
					const f = split(show(row, lead.p50).full);
					const m = cell.machine;
					const usd = formatUsd(m.price.usdPerHour, { per: "hour" });
					return (
						<tr class={cell === hero ? "is-hero" : undefined}>
							<th scope="row" class="mach-type" title={m.processor}>
								{m.instanceType}
							</th>
							<td class="num">{m.vcpu}</td>
							<td class="num">{m.memory.replace(" ", "")}</td>
							<td class="num" title={`$${usd.full} an hour: ${m.price.path.pointer}`}>
								{`$${usd.full}/h`}
							</td>
							<td class="mach-fig">
								<span class="figline">
									<span class="bar" aria-hidden="true">
										<span style={{ width: pct(lead.p50, max) }} />
									</span>
									<a class="fig" href={links.seriesFile(cell.series)} title={exact(row, cell)}>
										<span class="fh">{f.head}</span>
										<span class="ft">{`${f.tail}${show(row, lead.p50).unit}`}</span>
									</a>
								</span>
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
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
				<Machines />
			</main>
			<footer class="foot">
				<a class="foot-lic" href="third-party-notices.txt" aria-label="Third-party notices: the typeface's licence">
					©
				</a>
			</footer>
		</>
	);
}
