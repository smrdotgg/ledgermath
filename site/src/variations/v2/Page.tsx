// Design v2, "Terminal": the home page as a manual page. Monospace, one accent, figures printed
// in full and aligned on the decimal point. Every figure comes from ../../data as the snapshot
// holds it (see ../README.md); the only arithmetic is a change of unit, done by its helpers.
// Round 3: the page says as little as a man page can. The figures carry it; everything else is
// a link.
import "./page.css";
import {
	type ByteUnit,
	type DurationUnit,
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
	perUnit,
	type Section,
	seriesFileContents,
	type Shown,
	snapshot,
} from "../../data";

const API_HOST = new URL(links.index).host;
const newest = formatMoment(snapshot.newestRunStartedAt);
const zones = [...new Set(machines.flatMap((m) => m.availabilityZoneIds))].sort();
const SCHEDULE = ["04:10", "10:10", "16:10", "22:10"];

/** The address without its scheme and host. */
const path = (url: string) => decodeURI(new URL(url).pathname);

/** One real Run file, the first point of the sample Series: the evidence a figure stands on. */
const example = seriesFileContents.point.example;

// ---------------------------------------------------------------- figures

/**
 * One unit per row, so the row's figures share it and align: the unit the smallest figure of the
 * row would take. Where one repetition is a power-of-ten count of something smaller (mutex), the
 * row shows the time of one of those, divided exactly by formatDurationPerUnit.
 */
type Fig = (value: number) => Shown;
function rowFigure(row: HeadlineRow): Fig {
	const c = row.choice;
	const least = Math.min(...row.cells.map((cell) => leadFigure(c, cell.series).p50));
	if (c.lead === "rate") {
		const unit = formatRate(least).unit.replace("/s", "") as ByteUnit;
		return (v) => formatRate(v, { unit });
	}
	if (c.per) {
		const per = c.per;
		const unit: DurationUnit = durationUnit(Number(perUnit(least, per.count)));
		return (v) => formatDurationPerUnit(v, per, { unit });
	}
	const unit: DurationUnit = durationUnit(least);
	return (v) => formatDuration(v, { unit });
}

/** Where the bold part of a figure ends: after its first four significant digits. */
function leadCut(text: string): number {
	let significant = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c >= "0" && c <= "9" && (significant > 0 || c !== "0")) significant++;
		if (significant === 4) return i + 1;
	}
	return text.length;
}

/**
 * A figure printed in full, every digit, aligned on its decimal point: the whole part padded to
 * the row's widest, the fraction after it. The first four significant digits are set brighter,
 * the rest dimmer: a typographic emphasis on the exact text, not a rounding.
 */
function Digits(props: { full: string; width: number }) {
	const [whole = "", fraction] = props.full.split(".");
	const text = fraction === undefined ? whole : `${whole}.${fraction}`;
	const cut = leadCut(text);
	const pad = Math.max(0, props.width - whole.length);
	return (
		<span class="digits">
			<span class="pad" aria-hidden="true">
				{" ".repeat(pad)}
			</span>
			<span class="lead">{text.slice(0, cut)}</span>
			<span class="tail">{text.slice(cut)}</span>
		</span>
	);
}

/**
 * A figure drawn on the row's one scale, from zero to the row's largest p95: a bar from zero to
 * the p50, so lengths compare as the figures do, and the p5 to p95 band laid on its end. A
 * drawing, not a figure; the written values are in the cell's exact lines and the figure's title.
 */
function Spread(props: { p5: number; p50: number; p95: number; max: number }) {
	const at = (v: number) => `${((v / props.max) * 100).toFixed(3)}%`;
	return (
		<span class="spread" aria-hidden="true">
			<span class="sp-b" style={{ width: at(props.p50) }} />
			<span class="sp-r" style={{ left: at(props.p5), width: at(props.p95 - props.p5) }} />
			<span class="sp-t" style={{ left: at(props.p50) }} />
		</span>
	);
}

const SECTION_ORDER: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
const sectionId = (section: Section) => `s-${section.toLowerCase().replace(/ /g, "-")}`;
/** What a group's rows share, in two or three words, where a reader must know it. */
const SECTION_TAG: Partial<Record<Section, string>> = { Disk: "root EBS gp3 volume" };

// ---------------------------------------------------------------- pieces

/**
 * A processor's name short enough for one line: without the vendor, "Platinum", "Scalable" and a
 * trailing "Processor", and without the code name where a model number is left. AWS's whole name
 * is in the title.
 */
function cpu(name: string): string {
	let s = name
		.replace(/\s+Processor$/i, "")
		.replace(/^(Intel|AMD)\s+/, "")
		.replace(/\b(Platinum|Scalable)\s+/g, "");
	if (/\d/.test(s.replace(/\(.*\)/, ""))) s = s.replace(/\s*\(.*\)$/, "");
	return s.replace(/[()]/g, "");
}

/** A machine's hourly price, linked to the place in the day's price file it was read from. */
function Price(props: { m: (typeof machines)[number]; unit?: string }) {
	const m = props.m;
	return (
		<a href={m.price.path.file} class="price" title={`${m.price.description}. Read from ${m.price.path.pointer} (as the file writes it: ${m.price.usdPerHour})`}>
			${formatUsd(m.price.usdPerHour).full}
			{props.unit ?? ""}
		</a>
	);
}

function Section(props: { id: string; title: string; sub?: unknown; children?: unknown }) {
	return (
		<section class="sec" id={props.id} aria-labelledby={`${props.id}-h`}>
			<h2 id={`${props.id}-h`}>
				{props.title}
				{props.sub ? <span class="h2-sub">{props.sub as never}</span> : null}
			</h2>
			<div class="body">{props.children as never}</div>
		</section>
	);
}

/** A moment to the second, and UTC: one unbreakable piece. Its full form is in the title. */
function Moment(props: { m: ReturnType<typeof formatMoment>; bright?: boolean }) {
	const m = props.m;
	return (
		<time datetime={m.iso} class="nb" title={m.full}>
			<span class={props.bright ? "hi" : undefined}>
				{m.date} {m.second}
			</span>{" "}
			UTC
		</time>
	);
}

/** Freshness and provenance: four facts, each a key and a value, in aligned columns. */
function Status() {
	const oldest = formatMoment(snapshot.oldestRunStartedAt);
	const rows: [string, unknown][] = [
		["latest Run", <Moment m={newest} bright />],
		["schedule", <span class="nb">{SCHEDULE.join(" ")} UTC</span>],
		[
			"Runs kept",
			<a
				href={links.seriesList}
				class="runs"
				title={`${formatCount(snapshot.seriesCount).full} Series: every setting of every benchmark; the table shows one setting each`}
			>
				<span class="nb">
					<span class="hi">{formatCount(snapshot.runCount).full}</span> since{" "}
					<time datetime={oldest.iso} title={oldest.full}>
						{oldest.date}
					</time>
				</span>
				<span class="sep">, </span>
				<span class="nb">{formatCount(snapshot.failedRuns).full} failed</span>
			</a>,
		],
		[
			"prices",
			<a href={links.prices} class="nb">
				On-Demand {snapshot.priceDate}
			</a>,
		],
		[
			"sample Run",
			<span class="nb ev">
				<span class="xk">sha256</span>{" "}
				<a href={example.evidence} title={`Run ${example.run}, started ${example.started_at}: its file, sha256 ${example.sha256}, the hash its Series cites`}>
					{example.sha256.slice(0, 16)}…
				</a>
			</span>,
		],
		[
			"derived by",
			<>
				{snapshot.methods.map((m, i) => (
					<>
						{i ? <span class="sep"> · </span> : ""}
						<a href={links.seriesList} class="nb" title={`Method ${m.name} v${m.version}: its definitions are in series.json`}>
							{m.name} v{m.version}
						</a>
					</>
				))}
			</>,
		],
	];
	return (
		<dl class="kv">
			{rows.map(([k, v]) => (
				<div>
					<dt>{k}</dt>
					<dd>{v as never}</dd>
				</div>
			))}
		</dl>
	);
}

/**
 * The table's key, in its corner: the drawing, each part labelled where it is. The p50 label, over
 * the tick, is also the qualifier of every bold figure. Then the switch for the exact lines.
 */
function Key() {
	return (
		<>
			<span class="key" title="Every figure is a p50. The drawing, on one scale per row from 0: a bar to the p50, a tick at it, a whisker from p5 to p95">
				<span class="key-sw sw-t" aria-hidden="true" />
				p50
				<span class="key-sw sw-r" aria-hidden="true" />
				p5–p95
			</span>
			<details class="xt">
				<summary title="Show each figure's exact p5 and p95, and n, the Runs it counts">ranges, Runs</summary>
			</details>
		</>
	);
}

function DataTable() {
	const cols = machines.length + 1;
	return (
		<div class="scroll" role="region" aria-label="The headline figures: 14 benchmarks on 5 machine types" tabindex="0">
			<table class="data">
				<colgroup>
					<col class="c-unit" />
					{machines.map(() => (
						<col class="c-fig" />
					))}
				</colgroup>
				<thead>
					<tr>
						<th scope="col" class="corner">
							<Key />
						</th>
						{machines.map((m) => (
							<th scope="col">
								<span class="m-name">{m.instanceType}</span>
								<span class="m-spec">
									{m.vcpu} vCPU {m.memory}
								</span>
								<span class="m-cpu" title={m.processor}>
									{cpu(m.processor)}
								</span>
								<span class="m-price">
									<Price m={m} unit="/h" />
								</span>
							</th>
						))}
					</tr>
				</thead>
				{SECTION_ORDER.map((section) => {
					const rows = headline.filter((row) => row.choice.section === section);
					return rows.map((row, i) => {
						const fig = rowFigure(row);
						const c = row.choice;
						const up = c.lead === "rate";
						const unit = fig(leadFigure(c, row.cells[0]!.series).p50).unit;
						const cells = row.cells.map((cell) => {
							const f = leadFigure(c, cell.series);
							return { cell, f, p50: fig(f.p50), p5: fig(f.p5), p95: fig(f.p95) };
						});
						const max = Math.max(...cells.map((x) => x.f.p95));
						const whole = (x: Shown) => x.full.split(".")[0]!.length;
						// The p50s align among themselves, the exact lines among themselves.
						const width = Math.max(...cells.map((x) => whole(x.p50)));
						const exactWidth = Math.max(...cells.flatMap((x) => [whole(x.p5), whole(x.p95)]));
						const countWidth = Math.max(...cells.map((x) => String(x.f.count).length));
						const each = c.per ? ` per ${c.per.of}` : "";
						const tag = SECTION_TAG[section];
						return (
							<tbody class={i === 0 ? "bench first" : "bench"}>
								{i === 0 ? (
									<tr class="sect">
										<th colspan={cols} scope="rowgroup" id={sectionId(section)}>
											<span class="sect-name">{section}</span>
											{tag ? <span class="sect-tag">{tag}</span> : null}
										</th>
									</tr>
								) : null}
								<tr class="figs">
									<th scope="row" class="rl">
										<a href={c.readme} class="b-label" title={c.what}>
											{c.label}
										</a>
										<span class="u" title={`${c.lead === "rate" ? "Bytes per second" : "Time of one repetition"}. One repetition: ${c.repetition}`}>
											{unit}
											{each}{" "}
											<span class="dir" role="img" aria-label={up ? "higher is better" : "lower is better"}>
												{up ? "↑" : "↓"}
											</span>
										</span>
									</th>
									{cells.map(({ cell, f, p50, p5, p95 }) => (
										<td>
											{/* The machine's name, for the phone, where the columns become lines. */}
											<span class="m-lbl">{cell.machine.instanceType}</span>
											<a
												href={links.seriesFile(cell.series)}
												class="fig"
												title={`${cell.machine.instanceType}: p50 ${p50.full} ${p50.unit}${each}; p5 ${p5.full}, p95 ${p95.full}; ${f.count} counted Runs. Series ${cell.series.id}`}
											>
												<Digits full={p50.full} width={width} />
											</a>
											<Spread p5={f.p5} p50={f.p50} p95={f.p95} max={max} />
											<span class="x">
												<span>
													<span class="xk">p5</span>
													<Digits full={p5.full} width={exactWidth} />
												</span>
												<span>
													<span class="xk">p95</span>
													<Digits full={p95.full} width={exactWidth} />
												</span>
												<span>
													<span class="xk" title="counted Runs">
														n
													</span>
													<a href={links.seriesFile(cell.series)} class="n" title={`The ${f.count} counted Runs, each with its evidence: Series ${cell.series.id}`}>
														<Digits full={String(f.count)} width={countWidth} />
													</a>
												</span>
											</span>
										</td>
									))}
								</tr>
							</tbody>
						);
					});
				})}
			</table>
		</div>
	);
}

function Machines() {
	return (
		<ul class="machines" aria-labelledby="machines-h">
			{machines.map((m) => (
				<li title={m.processor}>
					<span class="mc-name">{m.instanceType}</span>
					<span class="mc-spec">
						{m.vcpu} vCPU {m.memory}
					</span>
					<span class="mc-price">
						<Price m={m} unit="/h" />
					</span>
				</li>
			))}
		</ul>
	);
}

// ---------------------------------------------------------------- the page

export default function Page() {
	const title = "LEDGERMATH(5)";
	/** One real Run file stands behind the word "evidence": a Run, its binary, streams and dumps by sha256. */
	const evidence = (
		<>
			each Run, with{" "}
			<a href={example.evidence} title={links.evidenceAbout}>
				evidence
			</a>
		</>
	);
	const files: [string, string, unknown, string][] = [
		[links.index, path(links.index), "every address", links.schema.index],
		[links.seriesList, path(links.seriesList), "every Series", links.schema.seriesList],
		[links.seriesFile(headline[0]!.cells[0]!.series), path(links.seriesFilePattern), evidence, links.schema.series],
		[links.prices, path(links.priceFilePattern), "AWS prices, daily", links.schema.prices],
	];
	return (
		<div class="term">
			<header class="manhead">
				<span>{title}</span>
				<span>
					{snapshot.region} {zones.join(" ")}
				</span>
			</header>

			<main>
				<div class="hero">
					<section class="sec name" aria-labelledby="name-h">
						<h1 id="name-h">
							<span class="acc">ledgermath</span> <span class="dash">—</span> AWS machine benchmarks as JSON for agents, every figure with its evidence
						</h1>
					</section>

					<Section id="synopsis" title="SYNOPSIS">
						<div class="cmd">
							<code>
								<span class="prompt" aria-hidden="true">
									${" "}
								</span>
								<span class="cmd-text">
									<span class="curl">curl</span>{" "}
									<a href={links.index} class="nb">
										{links.index}
									</a>
								</span>
							</code>
						</div>
					</Section>

					<Section id="status" title="STATUS">
						<Status />
					</Section>
				</div>

				{/* On a wide screen the table's head holds every machine fact, so this list is for the
				    phone, open: the price is half of any estimate. */}
				<Section id="machines" title="MACHINES">
					<Machines />
				</Section>

				<Section
					id="data"
					title="DATA"
					sub={
						<nav class="jump" aria-label="Benchmark groups">
							{SECTION_ORDER.map((section) => (
								<a href={`#${sectionId(section)}`}>{section.toLowerCase()}</a>
							))}
						</nav>
					}
				>
					<DataTable />
				</Section>

				<Section id="files" title="FILES" sub={<span class="nb">https://{API_HOST}</span>}>
					<table class="files">
						<tbody>
							{files.map(([href, shown, what, schema]) => (
								<tr>
									<th scope="row">
										<a href={href} class="nb">
											{shown}
										</a>
									</th>
									<td>{what as never}</td>
									<td class="schema">
										<a href={schema}>schema</a>
									</td>
								</tr>
							))}
							<tr>
								<th scope="row">
									<a href={links.docs} class="nb">
										{links.docs}
									</a>
								</th>
								<td>documentation</td>
								<td />
							</tr>
						</tbody>
					</table>
				</Section>
			</main>

			<footer class="manfoot">
				<a href="third-party-notices.txt">licences</a>
				<span>{title}</span>
			</footer>
		</div>
	);
}
