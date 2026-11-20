// Experiment dt-receipt: the home page as a shop's till receipt, printed in Datatype (whose
// letters are IBM Plex Mono's, a receipt printer's own). The machines are the price list, the
// benchmarks are the line items, each item's barcode is a Datatype bar chart of its five figures
// drawn from zero, and tapping a barcode "scans" it: every digit. The total is not computed,
// because the data holds none.
import "./page.css";
import {
	type ByteUnit,
	durationUnit,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	type HeadlineRow,
	headline,
	leadFigure,
	links,
	machines,
	type Section,
	type Shown,
	snapshot,
} from "../../data";
import { seriesFileSample } from "../../data/snapshot";

/**
 * Groups of values as Datatype bar charts on one scale from zero: the largest value of all the
 * groups becomes 100, every other in proportion, so the groups compare.
 */
function fromZero(groups: number[][]): string[] {
	const max = Math.max(...groups.flat());
	return groups.map((g) => `{b:${g.map((v) => Math.round((v / max) * 100)).join(",")}}`);
}
const bars = (values: number[]) => fromZero([values])[0]!;
/** "c8i.2xlarge" to "c8i": the name with its size left out, for the digits under a barcode. */
const family = (instanceType: string) => instanceType.split(".")[0]!;

type Item = {
	row: HeadlineRow;
	unit: string;
	cells: { instanceType: string; url: string; runs: number; p5: Shown; p50: Shown; p95: Shown }[];
	charts: string[];
};

/** One line item: the five p50s in one unit (the unit of the largest), and its barcode. */
function item(row: HeadlineRow): Item {
	const leads = row.cells.map((c) => leadFigure(row.choice, c.series));
	const max = Math.max(...leads.map((l) => l.p50));
	let unit: string;
	let show: (n: number) => Shown;
	if (row.choice.lead === "rate") {
		const u = formatRate(max).unit.replace("/s", "") as ByteUnit;
		unit = `${u}/s`;
		show = (n) => formatRate(n, { unit: u });
	} else if (row.choice.per) {
		const per = row.choice.per;
		const u = formatDurationPerUnit(max, per).unit as ReturnType<typeof durationUnit>;
		unit = `${u} per ${per.of}`;
		show = (n) => formatDurationPerUnit(n, per, { unit: u });
	} else {
		const u = durationUnit(max);
		unit = u;
		show = (n) => formatDuration(n, { unit: u });
	}
	return {
		row,
		unit,
		cells: row.cells.map((c, i) => ({
			instanceType: c.machine.instanceType,
			url: c.series.url,
			runs: c.series.runs,
			p5: show(leads[i]!.p5),
			p50: show(leads[i]!.p50),
			p95: show(leads[i]!.p95),
		})),
		charts: fromZero(leads.map((l) => [l.p5, l.p50, l.p95])),
	};
}

const items = headline.map(item);
const sections = [...new Set(headline.map((r) => r.choice.section))] as Section[];
const newest = formatMoment(snapshot.newestRunStartedAt);
const newestTime = newest.full.split(" ")[1]!;
const zones = [...new Set(machines.flatMap((m) => m.availabilityZoneIds))].sort();
const prices = machines.map((m) => ({ m, usd: formatUsd(m.price.usdPerHour) }));

// The receipt's own barcode: the newest 20 Runs of the Series whose file the snapshot keeps as a sample.
const sample = seriesFileSample;
const samplePer = headline.find((r) => r.choice.benchmark === sample.benchmark)?.choice.per;
const runs = sample.derivations.series_v1.points.slice(-20).map((p) => ({
	at: formatMoment(p.started_at),
	ns: p.time_per_repetition_ns!,
	shown: samplePer ? formatDurationPerUnit(p.time_per_repetition_ns!, samplePer, { unit: "ns" }) : formatDuration(p.time_per_repetition_ns!),
	evidence: p.evidence,
}));

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** A figure as a price: the short form on the paper, every digit in its title. */
function Fig(props: { s: Shown }) {
	return (
		<span class="fig" title={`${props.s.full} ${props.s.unit}`}>
			{props.s.short}
		</span>
	);
}

/** A Datatype chart, hidden from assistive technology, with a short text alternative. */
function Code(props: { chart: string; label: string; class?: string }) {
	return (
		<span class={`code ${props.class ?? ""}`} role="img" aria-label={props.label}>
			<span class="dt" aria-hidden="true">
				{props.chart}
			</span>
		</span>
	);
}

/** A barcode: one Datatype chart per machine, all on one scale, the machine's family printed under it like a barcode's digits. */
function Barcode(props: { charts: string[]; names: string[]; label: string; class?: string }) {
	return (
		<span class={`barcode ${props.class ?? ""}`} role="img" aria-label={props.label}>
			{props.charts.map((chart, i) => (
				<span class="slot" aria-hidden="true">
					<span class="dt">{chart}</span>
					<span class="digits">{family(props.names[i]!)}</span>
				</span>
			))}
		</span>
	);
}

/** The words under a barcode: "scan" while it is folded, "scanned" once it is open. */
function Hint(props: { keys: string }) {
	return (
		<span class="hint" aria-hidden="true">
			{props.keys}
			<span class="shut">scan</span>
			<span class="opened">scanned</span>
		</span>
	);
}

function LineItem(props: { it: Item }) {
	const c = props.it.row.choice;
	const id = `i-${c.benchmark}`;
	return (
		<article class="item" aria-labelledby={id}>
			<div class="ihead">
				<h3 id={id}>
					<a href={c.readme}>{c.label}</a>
				</h3>
				<span class="unit">{props.it.unit}</span>
			</div>
			<ul class="lines">
				{props.it.cells.map((cell) => (
					<li>
						<span class="m">{cell.instanceType}</span>
						<span class="lead" aria-hidden="true" />
						<Fig s={cell.p50} />
					</li>
				))}
			</ul>
			<details class="scan">
				<summary>
					<Barcode
						charts={props.it.charts}
						names={props.it.cells.map((cell) => cell.instanceType)}
						label="Barcode: for each machine in the order above, three bars, its p5, p50 and p95, all from zero on one scale. Scan for every digit."
					/>
					<Hint keys="p5 p50 p95 · " />
				</summary>
				<div class="scanned">
					<p class="setting">
						{props.it.unit} · {c.setting}
					</p>
					{props.it.cells.map((cell) => (
						<dl>
							<dt>
								{cell.instanceType} · <a href={cell.url}>{formatCount(cell.runs).full} Runs</a>
							</dt>
							<dd>
								<span>p5</span> {cell.p5.full}
							</dd>
							<dd class="p50">
								<span>p50</span> {cell.p50.full}
							</dd>
							<dd>
								<span>p95</span> {cell.p95.full}
							</dd>
						</dl>
					))}
				</div>
			</details>
		</article>
	);
}

const oldest = formatMoment(snapshot.oldestRunStartedAt);

export default function Page() {
	return (
		<div class="counter">
			<div class="till">
			<div class="printer" aria-hidden="true">
				<span class="led" />
				<span class="slot" />
			</div>
			<div class="paper">
				<header class="top">
					<h1 class="store">LedgerMath</h1>
					<p class="tag">AWS servers, benchmarked</p>
					<p class="web">
						<a href={links.index}>api.ledgermath.com</a>
						<span class="copyable" data-copy={links.index} />
					</p>
					<p class="small">
						{snapshot.region} · {zones.join(" ")}
					</p>
					<p class="small">open 04:10 · 10:10 · 16:10 · 22:10 UTC</p>
				</header>

				<main>
					<section class="sale" aria-labelledby="h-sale">
						<h2 id="h-sale" class="vh">
							This sale
						</h2>
						<p class="rule" aria-hidden="true" />
						<dl class="kv">
							<div>
								<dt>Date</dt>
								<dd>{newest.date}</dd>
							</div>
							<div>
								<dt>Time</dt>
								<dd title={newest.full}>{newestTime}</dd>
							</div>
							<div class="note">
								<dt>of the newest Run</dt>
								<dd>UTC, to the ns</dd>
							</div>
							<div>
								<dt>Runs kept</dt>
								<dd>{formatCount(snapshot.runCount).full}</dd>
							</div>
							<div>
								<dt>Series</dt>
								<dd>
									<a href={links.seriesList}>{formatCount(snapshot.seriesCount).full}</a>
								</dd>
							</div>
						</dl>
						<p class="rule" aria-hidden="true" />
					</section>

					<section class="dept" aria-labelledby="h-prices">
						<h2 id="h-prices">Price list</h2>
						<p class="sub">
							On-Demand Linux, per hour, <a href={links.prices}>{snapshot.priceDate}</a>
						</p>
						<ul class="prices">
							{prices.map(({ m, usd }) => (
								<li>
									<div class="pline">
										<span class="m">{m.instanceType}</span>
										<span class="lead" aria-hidden="true" />
										<span class="qty">1 hr @</span>
										<span class="fig" title={m.price.description}>
											${usd.full}
										</span>
									</div>
									<p class="spec">
										{m.vcpu} vCPU · {m.memory} · {m.processor}
									</p>
								</li>
							))}
						</ul>
						<details class="scan">
							<summary>
								<Barcode
									class="single"
									charts={fromZero(machines.map((m) => [Number(m.price.usdPerHour)]))}
									names={machines.map((m) => m.instanceType)}
									label="Barcode: the five hourly prices above as bars, in the same order, from zero. Scan for every digit."
								/>
								<Hint keys="" />
							</summary>
							<div class="scanned">
								{machines.map((m) => (
									<dl>
										<dt>{m.instanceType}</dt>
										<dd class="p50">
											{m.price.path.field} {m.price.usdPerHour}
										</dd>
										<dd>{m.price.description}</dd>
									</dl>
								))}
							</div>
						</details>
					</section>

					<p class="legend">every figure: p50 of every Run</p>

					{sections.map((section) => (
						<section class="dept" aria-labelledby={`h-${slug(section)}`}>
							<h2 id={`h-${slug(section)}`}>{section}</h2>
							{items
								.filter((it) => it.row.choice.section === section)
								.map((it) => (
									<LineItem it={it} />
								))}
						</section>
					))}

					<section class="totals" aria-labelledby="h-total">
						<p class="rule double" aria-hidden="true" />
						<dl class="kv big">
							<div>
								<dt>Subtotal</dt>
								<dd class="blank">--.--</dd>
							</div>
							<div>
								<dt>Tax</dt>
								<dd class="blank">--.--</dd>
							</div>
						</dl>
						<h2 id="h-total" class="total">
							<span>Total</span>
							<span class="nc">not computed</span>
						</h2>
						<p class="why">A total is a computed figure. The data holds none.</p>
						<p class="rule double" aria-hidden="true" />
						<dl class="kv">
							<div>
								<dt>Paid in</dt>
								<dd>{formatCount(snapshot.runCount).full} Runs</dd>
							</div>
							<div class="note">
								<dt>counted</dt>
								<dd>{formatCount(snapshot.countedRuns).full}</dd>
							</div>
							<div class="note">
								<dt>failed, kept</dt>
								<dd>{formatCount(snapshot.failedRuns).full}</dd>
							</div>
						</dl>
						<p class="rule" aria-hidden="true" />
						<h2 class="policy">Returns</h2>
						<p class="why">Every figure links its Runs. Every Run, its evidence. Keep your receipt; we keep ours.</p>
					</section>
				</main>

				<footer class="bottom">
					<p class="thanks">
						<span>Thank you</span>
						<span>come again</span>
					</p>
					<p class="small">04:10 · 10:10 · 16:10 · 22:10 UTC</p>
					<div class="loyalty">
						<p class="offer">Loyalty offer: for agents</p>
						<p class="small">every figure as JSON, each with its source</p>
						<p class="url">
							<code data-copy={links.index}>{links.index}</code>
						</p>
					</div>
					<details class="scan receipt-code">
						<summary>
							<Code
								class="big"
								chart={bars(runs.map((r) => r.ns))}
								label={`Barcode: the newest ${runs.length} Runs of ${sample.benchmark} on ${sample.instance_type} as bars, from zero. Scan for every digit.`}
							/>
							<span class="num">{sample.id}</span>
						</summary>
						<div class="scanned">
							<p class="setting">
								<a href={sample.url}>
									{sample.benchmark} · {sample.instance_type}
								</a>
								, newest {runs.length} Runs, {samplePer ? `ns per ${samplePer.of}` : ""}
							</p>
							<ol class="runs">
								{runs.map((r) => (
									<li>
										<a href={r.evidence}>{r.at.date.slice(5)} {r.at.minute}</a> {r.shown.full}
									</li>
								))}
							</ol>
						</div>
					</details>
					<p class="small">
						<a href={links.docs}>docs</a> · <a href="third-party-notices.txt">font</a>
					</p>
				</footer>
			</div>
			</div>

			<aside class="spike" aria-labelledby="h-spike">
				<h2 id="h-spike">Old receipts</h2>
				<ol>
					{links.priceFiles.map((file) => (
						<li>
							<a href={file.url}>
								<span>prices</span> <span>{file.date}</span>
							</a>
						</li>
					))}
				</ol>
			</aside>

			<div class="card" aria-hidden="true">
				<p class="card-brand">LedgerMath</p>
				<p class="card-kind">loyalty card · for agents</p>
				<p class="card-chip" />
				<p class="card-num">api.ledgermath.com</p>
				<p class="card-row">
					<span>/v1/index.json</span>
					<span>runs since {oldest.date}</span>
				</p>
			</div>
		</div>
	);
}
