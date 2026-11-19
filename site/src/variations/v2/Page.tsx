// Design v2, "Terminal": the home page as a manual page. Monospace, one accent, figures printed
// in full and aligned on the decimal point. Every figure comes from ../../data as the snapshot
// holds it (see ../README.md); the only arithmetic is a change of unit, done by its helpers.
// The spare form: the name, the command, one line of status, the figures. Everything else is a
// link.
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
	type Shown,
	snapshot,
} from "../../data";

const API_HOST = new URL(links.index).host;
const newest = formatMoment(snapshot.newestRunStartedAt);
const zones = [...new Set(machines.flatMap((m) => m.availabilityZoneIds))].sort();
const SCHEDULE = ["04:10", "10:10", "16:10", "22:10"];

/** The address without its scheme and host. */
const path = (url: string) => decodeURI(new URL(url).pathname);

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
 * A figure's p5 to p95, drawn: a rule from zero to the row's largest p95, the same for every cell
 * of the row, with the range as a bar and the median as a tick. A drawing, not a figure; the
 * written values are in the row's exact lines and the figure's title.
 */
function Spread(props: { p5: number; p50: number; p95: number; max: number }) {
	const at = (v: number) => `${((v / props.max) * 100).toFixed(3)}%`;
	return (
		<span class="spread" aria-hidden="true">
			<span class="sp-b" style={{ width: at(props.p50) }} />
			<span class="sp-r" style={{ left: at(props.p5), width: at(props.p95 - props.p5) }} />
			<span class="sp-m" style={{ left: at(props.p50) }} />
		</span>
	);
}

const SECTION_ORDER: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];
const sectionId = (section: Section) => `s-${section.toLowerCase().replace(/ /g, "-")}`;
/** What a group's rows share, in two or three words, where a reader must know it. */
const SECTION_TAG: Partial<Record<Section, string>> = { Disk: "root EBS gp3 volume" };

// ---------------------------------------------------------------- pieces

/** The address with a line-break opportunity after each slash. */
function breakable(url: string) {
	return url.split(/(?<=\/)/).map((part, i) => [i ? <wbr /> : null, <span class="nb">{part}</span>]);
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

/** A moment to the second, its fraction dimmer, and UTC: one unbreakable piece. */
function Moment(props: { m: ReturnType<typeof formatMoment> }) {
	const m = props.m;
	const fraction = m.full.slice(m.date.length + 1 + m.second.length, -4);
	return (
		<time datetime={m.iso} class="nb">
			<span class="hi">
				{m.date} {m.second}
			</span>
			<span class="frac">{fraction}</span> UTC
		</time>
	);
}

/** Freshness and provenance: one line of facts, each a key and a value. */
function Status() {
	const rows: [string, unknown][] = [
		["newest", <Moment m={newest} />],
		[
			"runs",
			<>
				<span class="hi">{formatCount(snapshot.runCount).full}</span>, {formatCount(snapshot.failedRuns).full} failed
			</>,
		],
		["at", <span class="nb">{SCHEDULE.join(" ")} UTC</span>],
		[
			"in",
			<span class="nb">
				{snapshot.region} {zones.join(" ")}
			</span>,
		],
		["prices", <a href={links.prices}>{snapshot.priceDate}</a>],
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

function DataTable() {
	const cols = machines.length + 1;
	return (
		<div class="scroll" role="region" aria-label="The headline figures: 14 benchmarks on 5 machine types" tabindex="0">
			<table class="data">
				<caption class="sr">Median of counted Runs</caption>
				<colgroup>
					<col class="c-unit" />
					{machines.map(() => (
						<col class="c-fig" />
					))}
				</colgroup>
				<thead>
					<tr>
						<th scope="col" class="corner">
							p50
						</th>
						{machines.map((m) => (
							<th scope="col">
								<span class="m-name">{m.instanceType}</span>
								<span class="m-spec">
									{m.vcpu} vCPU {m.memory}
								</span>
								<span class="m-spec">${formatUsd(m.price.usdPerHour).full}/h</span>
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
						const width = Math.max(...cells.flatMap((x) => [whole(x.p50), whole(x.p5), whole(x.p95)]));
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
										<span class="u">
											{unit}
											{each}{" "}
											<span class="dir" role="img" aria-label={up ? "higher is better" : "lower is better"}>
												{up ? "↑" : "↓"}
											</span>
										</span>
									</th>
									{cells.map(({ cell, f, p50, p5, p95 }) => (
										<td data-m={cell.machine.instanceType}>
											<a
												href={links.seriesFile(cell.series)}
												class="fig"
												title={`${cell.machine.instanceType}: p50 ${p50.full} ${p50.unit}${each}; p5 ${p5.full}, p95 ${p95.full}; ${f.count} counted Runs. Series ${cell.series.id}`}
											>
												<Digits full={p50.full} width={width} />
											</a>
											<Spread p5={f.p5} p50={f.p50} p95={f.p95} max={max} />
										</td>
									))}
								</tr>
								{(["p5", "p95", "n"] as const).map((k) => (
									<tr class={`exact x-${k}`}>
										<th scope="row" class="rl" aria-label={k === "n" ? "counted Runs" : k}>
											{k}
										</th>
										{cells.map((x) => (
											<td data-m={x.cell.machine.instanceType}>
												{k === "n" ? (
													<Digits full={String(x.f.count)} width={countWidth} />
												) : (
													<Digits full={x[k].full} width={width} />
												)}
											</td>
										))}
									</tr>
								))}
							</tbody>
						);
					});
				})}
			</table>
		</div>
	);
}

// ---------------------------------------------------------------- the page

export default function Page() {
	const title = "LEDGERMATH(5)";
	return (
		<div class="term">
			<header class="manhead">
				<span>{title}</span>
				<span>{title}</span>
			</header>

			<main>
				<div class="hero">
					<section class="sec name" aria-labelledby="name-h">
						<p class="label" aria-hidden="true">
							NAME
						</p>
						<div class="body">
							<h1 id="name-h">
								<span class="acc">ledgermath</span> <span class="dash">—</span> measured AWS machine figures, as JSON for agents, each with its evidence
							</h1>
						</div>
					</section>

					<Section id="synopsis" title="SYNOPSIS">
						<div class="cmd">
							<code>
								<span class="prompt" aria-hidden="true">
									${" "}
								</span>
								<span class="cmd-text">
									<span class="curl">curl -s</span> <a href={links.index}>{breakable(links.index)}</a>
								</span>
							</code>
						</div>
					</Section>
				</div>

				<Section id="status" title="STATUS">
					<Status />
				</Section>

				<Section id="data" title="DATA">
					<div class="key">
						<span class="nb">
							<span class="dir">↑</span> higher is better
						</span>
						<span class="nb">
							<span class="dir">↓</span> lower
						</span>
						<span class="nb">
							<span class="key-sp" aria-hidden="true">
								<span class="sp-b" />
								<span class="sp-r" />
								<span class="sp-m" />
							</span>{" "}
							p50, p5–p95, from 0
						</span>
						<details class="xt">
							<summary>exact p5, p95, counted runs</summary>
						</details>
					</div>
					<DataTable />
				</Section>

				<div class="foot">
				<Section id="see-also" title="SEE ALSO">
					<p class="xref">
						{links.schemas.map((s) => (
							<>
							<span class="nb">
								<a href={s.url} title={`The schema of ${s.describes}`}>
									{s.name}
								</a>
								<span class="dim">(5)</span>
							</span>,{" "}
							</>
						))}
						<a href={links.docs}>docs</a>
					</p>
				</Section>
				</div>
			</main>

			<footer class="manfoot">
				<span>LedgerMath v1</span>
				<span>{newest.date}</span>
				<span>{title}</span>
			</footer>
		</div>
	);
}
