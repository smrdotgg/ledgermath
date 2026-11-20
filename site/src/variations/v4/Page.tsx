// Experiment "dt-cards": the five machine types as collectible trading cards, the kind swapped
// in a playground. A booster pack on top (it holds the whole set, every time), five card fronts
// (portrait, name plate, price as the card's cost, six stats with bars, a flavour line), their
// backs (all fourteen headline figures, p5 · p50 · p95), and three bonus cards. Every chart is
// drawn by the Datatype font from figures in src/data, scaled here in code: a chart that compares
// machines starts at zero, the largest of the five being 100. No card is rarer than another.
// Rendered once at build time; client.ts only adds a copy button.
import "./page.css";
import {
	type DurationUnit,
	type HeadlineRow,
	type Machine,
	type Section,
	type Shown,
	formatCount,
	formatDuration,
	formatMoment,
	formatRate,
	formatUsd,
	headline,
	leadFigure,
	links,
	machines,
	seriesFileContents,
	snapshot,
} from "../../data";
import sample from "../../../data/snapshot/v1/series/c2d748916b19.json";

// ---------------------------------------------------------------- scaling, in code, from the data

/** A whole number from 0 to 100: `value` against `max`, from zero. */
const pct = (value: number, max: number) => Math.max(0, Math.min(100, Math.round((100 * value) / max)));

/** The lead p50 of a headline row on each of the five machines, in the order of `machines`. */
const p50s = (row: HeadlineRow) => row.cells.map((cell) => leadFigure(row.choice, cell.series).p50);

/**
 * A horizontal meter of 20 cells drawn as one Datatype bar chart: `value` against `max`, from
 * zero. Full cells are bars of 100; the cell where the value ends is a bar as tall as the part
 * of it that is filled; the rest are 0. So the drawn length keeps the proportion to 1/2000.
 */
function meterChart(value: number, max: number): string {
	const cells = 20;
	const exact = (cells * value) / max;
	const full = Math.floor(exact);
	const bars = Array.from({ length: cells }, (_, k) => (k < full ? 100 : k === full ? Math.round((exact - full) * 100) : 0));
	return `{b:${bars.join(",")}}`;
}

// ---------------------------------------------------------------- what the cards show

const SECTIONS: { section: Section; short: string }[] = [
	{ section: "Memory", short: "MEM" },
	{ section: "Compute", short: "CPU" },
	{ section: "Operating system", short: "OS" },
	{ section: "Disk", short: "DISK" },
	{ section: "Network", short: "NET" },
];

/** The six stats on a card's front, with the row's own label shortened by leaving words out. */
const FRONT: { benchmark: string; label: string }[] = [
	{ benchmark: "memory_read", label: "Read memory" },
	{ benchmark: "hash", label: "Hash 64 bytes" },
	{ benchmark: "sort", label: "Sort 1 MiB" },
	{ benchmark: "syscall", label: "System call" },
	{ benchmark: "disk_read_random", label: "Read 8 KiB from disk" },
	{ benchmark: "http_get", label: "GET 4 KiB from S3" },
];

/** Short labels for the backs' tables: each the row's own label with words left out. */
const BACK_LABEL: Record<string, string> = {
	memory_read: "Read memory",
	memory_read_random: "Read memory random",
	memory_write: "Write memory",
	compressed_memory_read: "Unpack 8-bit ints",
	hash: "Hash 64 bytes",
	sort: "Sort 1 MiB",
	syscall: "System call",
	mutex: "Mutex ×10,000",
	tcp_echo: "Echo 32 KiB TCP",
	disk_read_sequential: "Read file",
	disk_read_random: "Read 8 KiB disk",
	disk_read_io_uring: "4 KiB reads, 64 deep",
	disk_write: "Write 8 KiB durably",
	http_get: "GET 4 KiB S3",
};

const ACCENT = ["a1", "a2", "a3", "a4", "a5"] as const;

/** Flavour lines: the data's own words where they quote it. */
function flavour(m: Machine): string {
	switch (m.instanceType) {
		case "m5.large":
			return `${m.family}. Its purpose: general.`;
		case "c8i.2xlarge":
			return "Granite Rapids. Neither granite nor rapids.";
		case "c8a.2xlarge":
			return `“${m.clockSpeed}.” AWS wrote the “up to”. We wrote the rest down.`;
		case "i4i.2xlarge":
			return `Brought its own ${m.storage}. The headline rows read the root volume.`;
		case "c6i.8xlarge":
			return `${m.vcpu} vCPUs. The headline picks one thread wherever it can.`;
		default:
			return `${m.vcpu} vCPUs. ${m.memory}.`;
	}
}

const rowOf = (benchmark: string) => {
	const row = headline.find((r) => r.choice.benchmark === benchmark);
	if (!row) throw new Error(`no headline row ${benchmark}`);
	return row;
};

/** The lead figure of a cell, formatted: 4 significant digits shown, every digit in `title`. */
function lead(row: HeadlineRow, i: number, which: "p5" | "p50" | "p95" = "p50", unit?: string): Shown {
	const f = leadFigure(row.choice, row.cells[i]!.series);
	return f.kind === "rate" ? formatRate(f[which], unit ? { unit: unit as "GB" } : {}) : formatDuration(f[which], unit ? { unit: unit as DurationUnit } : {});
}

/** One unit per back-table row, so its five machines and three percentiles read in one unit. */
function rowUnit(row: HeadlineRow): string {
	const smallest = Math.min(...row.cells.map((cell) => leadFigure(row.choice, cell.series).p5));
	if (row.choice.lead === "rate") return formatRate(smallest).unit.replace("/s", "");
	return formatDuration(smallest).unit;
}

const tip = (s: Shown) => `${s.full} ${s.unit} (${s.source})`;

const cardNo = (i: number) => `${String(i + 1).padStart(3, "0")}/${String(machines.length).padStart(3, "0")}`;
const slug = (m: Machine) => m.instanceType.replace(/\W/g, "");

const newest = formatMoment(snapshot.newestRunStartedAt);
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const ROUNDS = ["04:10", "10:10", "16:10", "22:10"];
const runsOn = (m: Machine) => m.series.reduce((total, row) => total + row.runs, 0);

// ---------------------------------------------------------------- the sparkline on the JSON card

const samplePoints = (sample as unknown as { derivations: { series_v1: { points: { started_at: string; time_per_repetition_ns: number }[] } } }).derivations.series_v1.points.slice(-20);
const sampleNs = samplePoints.map((p) => p.time_per_repetition_ns);
const sampleLo = Math.min(...sampleNs);
const sampleHi = Math.max(...sampleNs);
const sparkChart = `{l:${sampleNs.map((ns) => Math.round((100 * (ns - sampleLo)) / (sampleHi - sampleLo))).join(",")}}`;

// ---------------------------------------------------------------- pieces

/** One section's bars of a portrait: each row's p50 on machine `i` against the largest of the five (at least 3, so a bar shows). */
const skyChart = (i: number, section: Section) =>
	`{b:${headline
		.filter((row) => row.choice.section === section)
		.map((row) => {
			const values = p50s(row);
			return Math.max(pct(values[i]!, Math.max(...values)), 3);
		})
		.join(",")}}`;

function Portrait(props: { i: number; m: Machine }) {
	return (
		<div class="art" role="img" aria-label={`Portrait of ${props.m.instanceType}: its 14 headline figures as bars, each against the largest of the five machines on that row. The exact figures are on its back.`}>
			<span class="sun" aria-hidden="true" />
			<span class="sky" aria-hidden="true">
				{SECTIONS.map((s) => (
					<span class="grp">
						<span class="dt">{skyChart(props.i, s.section)}</span>
						<span class="grp-name">{s.short}</span>
					</span>
				))}
			</span>
		</div>
	);
}

/** The pack's window: the five portraits, fanned, peeking out. Decoration; the cards below carry the words. */
function Fan() {
	return (
		<div class="fan" aria-hidden="true">
			{machines.map((m, i) => (
				<div class={`mini ${ACCENT[i]}`}>
					<span class="mini-name">{m.instanceType}</span>
					<span class="mini-sky">
						{SECTIONS.map((s) => (
							<span class="dt">{skyChart(i, s.section)}</span>
						))}
					</span>
				</div>
			))}
		</div>
	);
}

function Front(props: { i: number; m: Machine }) {
	const m = props.m;
	const price = formatUsd(m.price.usdPerHour);
	return (
		<article class={`card front ${ACCENT[props.i]}`} aria-labelledby={`f-${slug(m)}`}>
			<div class="frame">
				<header class="plate">
					<h3 id={`f-${slug(m)}`}>{m.instanceType}</h3>
					<p class="cost" title={`${m.price.description} (On-Demand, ${m.region}, price file of ${snapshot.priceDate})`}>
						<span class="cost-n">${price.full}</span>
						<span class="cost-u">/hr</span>
					</p>
				</header>
				<Portrait i={props.i} m={m} />
				<p class="typeline">
					<span>{m.family}</span>
					<span class="nw">
						{m.vcpu} vCPU · {m.memory}
					</span>
				</p>
				<dl class="stats">
					{FRONT.map((f) => {
						const row = rowOf(f.benchmark);
						const values = p50s(row);
						const shown = lead(row, props.i);
						return (
							<div class="stat">
								<dt>{f.label}</dt>
								<dd>
									<span class="fig" title={tip(shown)}>
										{shown.short}
										<small> {shown.unit}</small>
									</span>
									<span class="meter dt" aria-hidden="true">
										{meterChart(values[props.i]!, Math.max(...values))}
									</span>
								</dd>
							</div>
						);
					})}
				</dl>
				<p class="flavour">{flavour(m)}</p>
				<footer class="foot">
					<span>{cardNo(props.i)}</span>
					<span class="rarity">
						<span aria-hidden="true">●</span> Common
					</span>
					<span>Illus. by its own figures</span>
				</footer>
			</div>
		</article>
	);
}

function Back(props: { i: number; m: Machine }) {
	const m = props.m;
	return (
		<article class={`card back ${ACCENT[props.i]}`} aria-labelledby={`b-${slug(m)}`}>
			<div class="frame">
				<header class="back-head">
					<h3 id={`b-${slug(m)}`}>{m.instanceType}</h3>
					<span class="back-no">{cardNo(props.i)}</span>
				</header>
				<p class="bio">
					{m.processor} · {m.clockSpeed} · {m.storage} · {m.network} · {m.region} {m.availabilityZoneIds.join(", ")}
				</p>
				<table class="career">
					<caption>Median (p50), with p5 and p95</caption>
					<thead>
						<tr>
							<th scope="col">Stat</th>
							<th scope="col">p5</th>
							<th scope="col">p50</th>
							<th scope="col">p95</th>
						</tr>
					</thead>
					<tbody>
						{headline.map((row) => {
							const unit = rowUnit(row);
							const cell = row.cells[props.i]!;
							const sec = SECTIONS.find((s) => s.section === row.choice.section)!.short.toLowerCase();
							return (
								<tr class={`sec-${sec}`}>
									<th scope="row">
										<a href={links.seriesFile(cell.series)} title={`${row.choice.label}: ${row.choice.setting}. Its Series file, every Run.`}>
											{BACK_LABEL[row.choice.benchmark] ?? row.choice.label}
										</a>
										<span class="u">{row.choice.lead === "rate" ? `${unit}/s` : unit}</span>
									</th>
									{(["p5", "p50", "p95"] as const).map((p) => {
										const s = lead(row, props.i, p, unit);
										return (
											<td class={p === "p50" ? "mid" : undefined} title={tip(s)}>
												{s.short}
											</td>
										);
									})}
								</tr>
							);
						})}
					</tbody>
				</table>
				<p class="aws">
					<span>AWS:</span> “{m.price.description}”
				</p>
				<footer class="foot">
					<span>{formatCount(runsOn(m)).full} Runs on this type</span>
					<span class="rarity">
						<span aria-hidden="true">●</span> Common
					</span>
				</footer>
			</div>
		</article>
	);
}

// ---------------------------------------------------------------- the page

export default function Page() {
	const cmd = `curl ${links.index}`;
	return (
		<>
			<header class="pack-wrap">
				<div class="pack">
					<div class="crimp" aria-hidden="true" />
					<div class="pack-body">
						<p class="pack-kicker">Booster · Set 1 · {snapshot.region}</p>
						<h1>
							<span class="h1-main">LedgerMath</span>
							<span class="h1-sub">Machine Cards</span>
						</h1>
						<p class="pack-line">
							{snapshot.machineCount} AWS machines. {snapshot.benchmarkCount} stats each. <strong>Every stat measured.</strong>
						</p>
						<Fan />
						<p class="burst" aria-hidden="true">
							<span>
								All {snapshot.machineCount}
								<br />
								foil.
								<br />
								None rare.
							</span>
						</p>
						<ul class="contents" aria-label="Contents">
							<li>
								<b>{formatCount(snapshot.runCount).full}</b> Runs
							</li>
							<li>
								<b>{formatCount(snapshot.seriesCount).full}</b> Series
							</li>
							<li>
								<b>{snapshot.machineCount}</b> of {snapshot.machineCount} cards
							</li>
						</ul>
						<p class="printing">
							Printed fresh at{" "}
							{ROUNDS.map((r, k) => (
								<>
									<time>{r}</time>
									{k < ROUNDS.length - 1 ? " · " : ""}
								</>
							))}{" "}
							UTC. Newest Run{" "}
							<time datetime={newest.iso} title={newest.full}>
								{newest.date} {newest.minute} UTC
							</time>
							.
						</p>
					</div>
					<div class="tear" aria-hidden="true">
						<span>✂ tear here</span>
					</div>
					<div class="pack-api">
						<p class="api-lead">
							Or open it as JSON at <strong>api.ledgermath.com</strong>
						</p>
						<div class="copy-wrap" data-copy-wrap>
							<code data-copy>{cmd}</code>
						</div>
					</div>
					<div class="crimp" aria-hidden="true" />
				</div>
			</header>

			<main>
				<section class="set" aria-labelledby="h-set">
					<div class="sec-head">
						<h2 id="h-set">The set</h2>
						<p>Collect all five. You just did.</p>
					</div>
					<div class="row">
						{machines.map((m, i) => (
							<Front i={i} m={m} />
						))}
					</div>
				</section>

				<section class="set backs" aria-labelledby="h-backs">
					<div class="sec-head">
						<h2 id="h-backs">Flip them over</h2>
						<p>
							All {snapshot.benchmarkCount} headline stats. {oldest.date} to {newest.date}.
						</p>
					</div>
					<div class="row">
						{machines.map((m, i) => (
							<Back i={i} m={m} />
						))}
					</div>
				</section>

				<section class="set bonus" aria-labelledby="h-bonus">
					<div class="sec-head">
						<h2 id="h-bonus">Also in the pack</h2>
					</div>
					<div class="row row-3">
						<article class="card extra a0" aria-labelledby="x-check">
							<div class="frame">
								<h3 id="x-check" class="extra-title">
									Checklist
								</h3>
								<ul class="checklist">
									{machines.map((m, i) => (
										<li>
											<span class="box" aria-hidden="true">
												✓
											</span>
											<span class="cl-no">{cardNo(i).slice(0, 3)}</span> {m.instanceType}
										</li>
									))}
								</ul>
								<p class="pie-line">
									<span class="dt pie" aria-hidden="true">
										{`{p:${pct(machines.length, machines.length)}}`}
									</span>
									<span>
										Set complete.
										<br />
										It came that way.
									</span>
								</p>
								<footer class="foot">
									<span>000/{String(machines.length).padStart(3, "0")}</span>
									<span class="rarity">
										<span aria-hidden="true">●</span> Common
									</span>
								</footer>
							</div>
						</article>

						<article class="card extra a0" aria-labelledby="x-rules">
							<div class="frame">
								<h3 id="x-rules" class="extra-title">
									How to play
								</h3>
								<ol class="rules">
									<li>Collect all five.</li>
									<li>Compare.</li>
									<li>Nobody wins.</li>
								</ol>
								<div class="legend">
									<span class="meter dt" aria-hidden="true">
										{meterChart(1, 1)}
									</span>
									<p>A full bar is the largest of the five on that row. Bigger, not better: for a time, longer is slower.</p>
								</div>
								<footer class="foot">
									<span>RULES</span>
									<span class="rarity">
										<span aria-hidden="true">●</span> Common
									</span>
								</footer>
							</div>
						</article>

						<article class="card extra a0" aria-labelledby="x-json">
							<div class="frame">
								<h3 id="x-json" class="extra-title">
									Every card is a file
								</h3>
								<ul class="files">
									<li>
										<a href={links.index}>v1/index.json</a>
									</li>
									<li>
										<a href={links.seriesList}>v1/series.json</a>
									</li>
									<li>
										<a href={links.prices}>v1/prices/{snapshot.priceDate}.json</a>
									</li>
								</ul>
								<figure class="spark">
									<div class="spark-box" role="img" aria-label={`Sparkline, zoomed: the time of one repetition of mutex on ${seriesFileContents.sample.instanceType} in its last ${samplePoints.length} Runs.`}>
										<span class="zoom">Zoomed</span>
										<span class="dt" aria-hidden="true">
											{sparkChart}
										</span>
									</div>
									<figcaption>
										<a href={seriesFileContents.sample.url}>mutex on {seriesFileContents.sample.instanceType}</a>, its last {samplePoints.length} Runs, one by one, each with its evidence.
									</figcaption>
									<details>
										<summary>The {samplePoints.length} figures</summary>
										<ol class="spark-list">
											{samplePoints.map((p) => {
												const s = formatDuration(p.time_per_repetition_ns);
												return (
													<li title={tip(s)}>
														<time datetime={p.started_at}>{formatMoment(p.started_at).date} {formatMoment(p.started_at).minute}</time> {s.short} {s.unit}
													</li>
												);
											})}
										</ol>
									</details>
								</figure>
								<footer class="foot">
									<span>JSON</span>
									<span class="rarity">
										<span aria-hidden="true">●</span> Common
									</span>
								</footer>
							</div>
						</article>
					</div>
				</section>
			</main>

			<footer class="site-foot">
				<p>
					<a href={links.docs}>Docs</a> · <a href={links.index}>API index</a> · Prices: AWS On-Demand, {snapshot.region}, {snapshot.priceDate} ·{" "}
					<a href="third-party-notices.txt">Font: Datatype (OFL)</a>
				</p>
			</footer>
		</>
	);
}
