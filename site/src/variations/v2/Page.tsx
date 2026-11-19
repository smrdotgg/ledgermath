// Design v2, "Terminal": the home page as a manual page. Monospace, one accent, figures printed
// in full and aligned on the decimal point. Every figure comes from ../../data as the snapshot
// holds it (see ../README.md); the only arithmetic is a change of unit, done by its helpers.
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
	headlineSeries,
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
const oldest = formatMoment(snapshot.oldestRunStartedAt);
const pricesFetched = formatMoment(snapshot.pricesFetchedAt);
const zones = [...new Set(machines.flatMap((m) => m.availabilityZoneIds))].sort();
const SCHEDULE = ["04:10", "10:10", "16:10", "22:10"];

/** The address without its scheme and host, for the narrow column of FILES. */
const path = (url: string) => new URL(url).pathname;

// ---------------------------------------------------------------- figures

/**
 * One unit per row, so the row's figures share it and align: the unit the smallest figure of the
 * row would take. Where one repetition is a power-of-ten count of something smaller (mutex), the
 * row shows the time of one of those, divided exactly by formatDurationPerUnit.
 */
type Fig = (value: number, significant?: number) => Shown;
function rowFigure(row: HeadlineRow): Fig {
	const c = row.choice;
	const least = Math.min(...row.cells.map((cell) => leadFigure(c, cell.series).p50));
	if (c.lead === "rate") {
		const unit = formatRate(least).unit.replace("/s", "") as ByteUnit;
		return (v, significant) => formatRate(v, { unit, significant });
	}
	if (c.per) {
		const per = c.per;
		const unit: DurationUnit = durationUnit(Number(perUnit(least, per.count)));
		return (v, significant) => formatDurationPerUnit(v, per, { unit, significant });
	}
	const unit: DurationUnit = durationUnit(least);
	return (v, significant) => formatDuration(v, { unit, significant });
}

/**
 * The 5th and 95th percentiles, rounded to as few significant digits (from four) as tell them
 * apart, so a range never prints as "131.3–131.3". Their every digit is a tap away, in the row's
 * EXACT block, and in the figure's title.
 */
function range(fig: Fig, p5: number, p95: number): [Shown, Shown] {
	for (let significant = 4; ; significant++) {
		const lo = fig(p5, significant);
		const hi = fig(p95, significant);
		if (lo.short !== hi.short || (!lo.rounded && !hi.rounded) || significant >= 17) return [lo, hi];
	}
}

/**
 * A figure printed in full, every digit, aligned on its decimal point: the whole part in a box
 * four characters wide, the fraction after it. The first four significant digits are set
 * brighter, the rest dimmer: a typographic emphasis on the exact text, not a rounding.
 */
function Digits(props: { full: string }) {
	const [whole = "", fraction] = props.full.split(".");
	const text = fraction === undefined ? whole : `${whole}.${fraction}`;
	let significant = 0;
	let cut = text.length;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c >= "0" && c <= "9" && (significant > 0 || c !== "0")) significant++;
		if (significant === 4) {
			cut = i + 1;
			break;
		}
	}
	const pad = Math.max(0, 4 - whole.length);
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

const SECTION_ORDER: Section[] = ["Memory", "Compute", "Operating system", "Disk", "Network"];

// ---------------------------------------------------------------- pieces

/** The address with a line-break opportunity after each slash, so a narrow screen breaks it at a slash and not inside a word. */
function breakable(url: string) {
	return url.split(/(?<=\/)/).map((part, i) => [i ? <wbr /> : null, <span class="nb">{part}</span>]);
}

function Command(props: { url: string; note: string }) {
	return (
		<li class="cmd">
			<span class="cmd-note"># {props.note}</span>
			<code>
				<span class="prompt" aria-hidden="true">
					${" "}
				</span>
				<span class="cmd-text">
					<span class="curl">curl -s</span> <a href={props.url}>{breakable(props.url)}</a>
				</span>
			</code>
		</li>
	);
}

function Section(props: { id: string; title: string; children?: unknown }) {
	return (
		<section class="sec" id={props.id} aria-labelledby={`${props.id}-h`}>
			<h2 id={`${props.id}-h`}>{props.title}</h2>
			<div class="body">{props.children as never}</div>
		</section>
	);
}

function Status() {
	const runs = formatCount(snapshot.runCount).full;
	const rows: [string, unknown][] = [
		[
			"newest",
			<time datetime={newest.iso}>
				<span class="hi">
					{newest.date} {newest.second}
				</span>
				<span class="dim">{newest.full.slice(newest.date.length + 1 + newest.second.length, -4)}</span> UTC
			</time>,
		],
		[
			"where",
			<>
				AWS {snapshot.region}, zone {zones.join(", ")}
			</>,
		],
		[
			"runs",
			<>
				<span class="hi">{runs}</span> kept, {formatCount(snapshot.countedRuns).full} counted, {formatCount(snapshot.failedRuns).full} failed
			</>,
		],
		[
			"oldest",
			<time datetime={oldest.iso}>
				{oldest.date} {oldest.second}
				<span class="dim">{oldest.full.slice(oldest.date.length + 1 + oldest.second.length, -4)}</span> UTC
			</time>,
		],
		[
			"series",
			<>
				<span class="hi">{formatCount(snapshot.seriesCount).full}</span>, {formatCount(headlineSeries.length).full} of them in DATA below
			</>,
		],
		[
			"schedule",
			<>
				{SCHEDULE.join(" ")} UTC
			</>,
		],
		[
			"prices",
			<>
				<a href={links.prices}>{snapshot.priceDate}</a>, copied {pricesFetched.second}
				<span class="dim">{pricesFetched.full.slice(pricesFetched.date.length + 1 + pricesFetched.second.length, -4)}</span> UTC
			</>,
		],
		[
			"methods",
			<>
				{snapshot.methods.map((m, i) => (
					<>
						{i ? ", " : ""}
						<a href="#methods">
							{m.name} v{m.version}
						</a>
					</>
				))}

			</>,
		],
		[
			"evidence",
			<>
				every Run's output and machine record, see <a href="#files">FILES</a>
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

const sectionId = (section: Section) => `s-${section.toLowerCase().replace(/ /g, "-")}`;

/** Said once, at the top of a group, where the group's rows share something a reader must know. */
function SectionNote(props: { section: Section }) {
	if (props.section !== "Disk") return null;
	const iops = headline.find((row) => row.choice.benchmark === "disk_read_io_uring")?.choice;
	const seq = headline.find((row) => row.choice.benchmark === "disk_read_sequential")?.choice;
	return (
		<span class="sect-note">
			Every row here reads or writes the root EBS gp3 volume, on all five machines, and not a machine's own disk: the instance store that only
			i4i.2xlarge has is not in these rows. So they describe the volume more than the machine.
			{iops && seq ? (
				<>
					{" "}
					<i>{iops.label}</i> reaches the volume's IOPS limit, and <i>{seq.label}</i> its throughput limit.
				</>
			) : null}
		</span>
	);
}

function DataTable() {
	const cols = machines.length + 1;
	return (
		<div class="scroll" role="region" aria-label="The headline figures: 14 benchmarks on 5 machine types" tabindex="0">
			<table class="data">
				<caption class="sr">
					The median (p50) of each Series' counted Runs, one Series per benchmark and machine type, with its 5th and 95th percentiles and its count of
					Runs. Each figure links to its Series file.
				</caption>
				<colgroup>
					<col class="c-unit" />
					{machines.map(() => (
						<col class="c-fig" />
					))}
				</colgroup>
				<thead>
					<tr>
						<th scope="col" class="corner">
							<span class="hi">p50</span>
							<span class="m-spec">median of</span>
							<span class="m-spec">its Runs</span>
						</th>
						{machines.map((m) => (
							<th scope="col">
								<span class="m-name">{m.instanceType}</span>
								<span class="m-spec">
									{m.vcpu} vCPU · {m.memory}
								</span>
								<span class="m-spec">${formatUsd(m.price.usdPerHour).full}/h</span>
							</th>
						))}
					</tr>
				</thead>
				{SECTION_ORDER.map((section, s) => {
					const rows = headline.filter((row) => row.choice.section === section);
					return rows.map((row, i) => {
						const fig = rowFigure(row);
						const c = row.choice;
						const up = c.lead === "rate";
						const unit = fig(leadFigure(c, row.cells[0]!.series).p50).unit;
						const cells = row.cells.map((cell) => {
							const f = leadFigure(c, cell.series);
							return { cell, f, p50: fig(f.p50), p5: fig(f.p5), p95: fig(f.p95), short: range(fig, f.p5, f.p95) };
						});
						const each = c.per ? ` per ${c.per.of}` : "";
						return (
							<tbody class={i === 0 ? "bench first" : "bench"}>
								{i === 0 ? (
									<tr class="sect">
										<th colspan={cols} scope="rowgroup" id={sectionId(section)}>
											<span class="sect-name">{section}</span>
											<SectionNote section={section} />
										</th>
									</tr>
								) : null}
								{i === 0 && s > 0 ? (
									<tr class="rehead" aria-hidden="true">
										<td />
										{machines.map((m) => (
											<td>{m.instanceType}</td>
										))}
									</tr>
								) : null}
								<tr class="desc">
									<th colspan={cols} scope="rowgroup">
										<span class="b-label">{c.label}</span>
										<span class="b-what">{c.what}</span>
										<div class="b-set">
											<span class="k">one repetition</span> {c.repetition}{" "}
											{c.per ? (
												<>
													<span class="k">shown</span> the time of one {c.per.of}: a repetition's time ÷ {formatCount(c.per.count).full}{" "}
												</>
											) : null}
											<span class="k">setting</span> {c.setting}
										</div>
									</th>
								</tr>
								<tr class="figs">
									<th scope="row" class="unit">
										<span class="sr">{c.label}, median {up ? "rate" : `time${each}`} in </span>
										<span class="u">{unit}</span>
										<span class="dir" aria-hidden="true">
											{up ? "↑" : "↓"}
										</span>
										<span class="sr">{up ? ", higher is better" : ", lower is better"}</span>
										<span class="u2">p5–p95 n</span>
										<details class="more">
											<summary>
												exact<span class="sr">: {c.label}, every digit of p5 and p95, the Series files{c.reason ? ", why this setting" : ""}</span>
											</summary>
										</details>
									</th>
									{cells.map(({ cell, f, p50, p5, p95, short: [lo, hi] }) => (
										<td data-m={cell.machine.instanceType}>
											<a
												href={links.seriesFile(cell.series)}
												title={`${cell.machine.instanceType}: p50 ${p50.full} ${p50.unit}${each}; p5 ${p5.full}, p95 ${p95.full}; ${f.count} counted Runs. As the snapshot holds it: ${p50.source}. Series ${cell.series.id}`}
											>
												<Digits full={p50.full} />
											</a>
											<span class="rng" title={`p5 ${p5.full} ${p5.unit}, p95 ${p95.full} ${p95.unit}`}>
												<span class="sr">p5 to p95: </span>
												{lo.short}–{hi.short}
												<span class="n">
													<span class="sr">, counted Runs: </span>
													<span aria-hidden="true">n=</span>
													{f.count}
												</span>
											</span>
										</td>
									))}
								</tr>
								{(["p5", "p95"] as const).map((k) => (
									<tr class="exact">
										<th scope="row" class="unit">
											<span class="sr">{c.label}, </span>
											{k}
										</th>
										{cells.map((x) => (
											<td data-m={x.cell.machine.instanceType}>
												<Digits full={x[k].full} />
											</td>
										))}
									</tr>
								))}
								<tr class="exact last">
									<th scope="row" class="unit">
										<span class="sr">{c.label}, </span>series
									</th>
									{cells.map((x) => (
										<td data-m={x.cell.machine.instanceType}>
											<a href={links.seriesFile(x.cell.series)} class="sid">
												{x.cell.series.id}.json
											</a>
										</td>
									))}
								</tr>
								{c.reason ? (
									<tr class="exact why">
										<th scope="row" class="unit">
											<span class="sr">{c.label}, </span>why
										</th>
										<td colspan={machines.length}>
											<span class="k">why this setting</span> {c.reason}
										</td>
									</tr>
								) : null}
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
		<div class="scroll" role="region" aria-label="The machine types and their hourly price" tabindex="0">
			<table class="machines">
				<thead>
					<tr>
						<th scope="col">type</th>
						<th scope="col" class="r">
							vcpu
						</th>
						<th scope="col">memory</th>
						<th scope="col">processor</th>
						<th scope="col">clock</th>
						<th scope="col">storage</th>
						<th scope="col">network</th>
						<th scope="col" class="r">
							usd/hour
						</th>
					</tr>
				</thead>
				<tbody>
					{machines.map((m) => {
						const price = formatUsd(m.price.usdPerHour, { per: "hour" });
						return (
							<tr>
								<th scope="row">{m.instanceType}</th>
								<td class="r" data-k="vcpu">
									{m.vcpu}
								</td>
								<td data-k="memory">{m.memory}</td>
								<td data-k="processor">{m.processor}</td>
								<td data-k="clock">{m.clockSpeed}</td>
								<td data-k="storage">{m.storage}</td>
								<td data-k="network">{m.network}</td>
								<td class="r price" data-k="usd/hour" title={`${m.price.description} (as the price file writes it: ${m.price.usdPerHour})`}>
									{price.full}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

const SERIES_DEFS = ["time_per_repetition", "bytes_per_second", "percentiles", "counted"] as const;

function Methods() {
	const series = snapshot.methods.find((m) => m.key === "series_v1");
	const others = snapshot.methods.filter((m) => m.key !== "series_v1");
	return (
		<>
			<p>
				A versioned Method turns a Series' Runs into a Derivation, and its words are published with the data, in{" "}
				<a href={links.seriesList}>{path(links.seriesList)}</a>. The DATA above is Method <b>series</b> v{series?.version}:
			</p>
			<dl class="defs">
				{SERIES_DEFS.map((key) => (
					<div>
						<dt>{key}</dt>
						<dd>{series?.definitions[key]}</dd>
					</div>
				))}
			</dl>
			{others.length ? (
				<p>
					Also published:{" "}
					{others.map((m, i) => (
						<>
							{i ? ", " : ""}
							Method <b>{m.name}</b> v{m.version}
						</>
					))}
					, for the request phases of http_get.
				</p>
			) : null}
		</>
	);
}

// ---------------------------------------------------------------- the page

export default function Page() {
	const title = "LEDGERMATH(5)";
	return (
		<div class="term">
			<header class="manhead">
				<span>{title}</span>
				<span class="mid">LedgerMath Data API</span>
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
								<span class="acc">ledgermath</span> <span class="dash">—</span> measured figures for AWS machines, each with its evidence and its Method
							</h1>
							<p class="lede">
								{formatCount(snapshot.benchmarkCount).full} benchmarks on {formatCount(snapshot.machineCount).full} machine types, run four times a day on
								freshly booted machines, published as static JSON for AI agents and their developers: to choose a machine or estimate a cost
								from measured numbers.
							</p>
						</div>
					</section>

					<Section id="synopsis" title="SYNOPSIS">
						<ul class="cmds">
							<Command url={links.index} note="table of contents: start here" />
							<Command url={links.seriesList} note={`every Series (${formatCount(snapshot.seriesCount).full}) and its percentiles`} />
							<Command url={links.prices} note="AWS On-Demand prices, copied daily" />
						</ul>
						<p class="syn-note">
							Each Series file links every Run's figure and evidence: cite the file behind each number.
						</p>
					</Section>

					<Section id="status" title="STATUS">
						<Status />
					</Section>
				</div>

				<Section id="data" title="DATA">
					<p>
						The median (p50) of each Series' counted Runs, one Series per benchmark and machine type, chosen by a written rule: one thread, static
						build, settings every machine ran. Every digit printed; each figure links to its Series file; <span class="hi">[+] exact</span> opens a row's p5 and
						p95 to the last digit.
					</p>
					<nav class="jump" aria-label="Benchmark groups">
						{SECTION_ORDER.map((section, i) => (
							<span class="nb">
								{i ? (
									<span class="sep" aria-hidden="true">
										·
									</span>
								) : null}
								<a href={`#${sectionId(section)}`}>{section.toLowerCase()}</a>
							</span>
						))}
						<span class="legend">
							<span class="dir">↑</span> higher is better <span class="dir">↓</span> lower is better
						</span>
					</nav>
					<DataTable />
				</Section>

				<Section id="description" title="DESCRIPTION">
					<p>
						LedgerMath boots AWS machines four times a day, at {SCHEDULE.slice(0, -1).join(", ")} and {SCHEDULE.at(-1)} UTC, and runs{" "}
						{formatCount(snapshot.benchmarkCount).full} benchmarks on each freshly booted machine. Every execution is kept as a <b>Run</b>, with its
						evidence: what the benchmark printed, and what was recorded about the machine. A <b>Series</b> is the Runs of one benchmark, setting, build,
						machine type and zone; a published <b>Method</b> derives its figures.
					</p>
					<p>
						{formatCount(snapshot.machineCount).full} machine types in {snapshot.region} are measured. The figures, the evidence and AWS's public
						On-Demand prices, copied daily, are served as static JSON at <a href={links.index}>{API_HOST}</a>.
					</p>
				</Section>

				<Section id="machines" title="MACHINES">
					<p>
						Cheapest first. Hourly On-Demand Linux price in {snapshot.region}, in US dollars, from AWS's price list of{" "}
						<a href={links.prices}>{snapshot.priceDate}</a>. Storage and network are as AWS states them; the instance store of i4i.2xlarge is
						not what DATA's disk rows measure (they use each machine's root EBS gp3 volume).
					</p>
					<Machines />
				</Section>

				<Section id="methods" title="METHODS">
					<Methods />
				</Section>

				<Section id="exit-status" title="EXIT STATUS">
					<p>
						<span class="code0">{formatCount(snapshot.failedRuns).full}</span> Runs failed of {formatCount(snapshot.runCount).full}. A Run that fails is
						kept and shown with its reasons, and left out of every percentile.
					</p>
				</Section>

				<Section id="files" title="FILES">
					<dl class="files">
						<div>
							<dt>
								<a href={links.index}>{path(links.index)}</a>
							</dt>
							<dd>The table of contents: what LedgerMath is, how v1 changes, where everything is.</dd>
						</div>
						<div>
							<dt>
								<a href={links.seriesList}>{path(links.seriesList)}</a>
							</dt>
							<dd>Every Series, {formatCount(snapshot.seriesCount).full}, with its Derivations and the Methods' definitions.</dd>
						</div>
						<div>
							<dt>
								<code>/v1/series/&lt;id&gt;.json</code>
							</dt>
							<dd>One Series: its points, each linking its Run file and boot summary, the evidence. Every figure in DATA links one.</dd>
						</div>
						<div>
							<dt>
								<a href={links.prices}>{path(links.prices)}</a>
							</dt>
							<dd>
								AWS's On-Demand prices for the measured machines, as AWS published them on <span class="nb">{snapshot.priceDate}</span>.
							</dd>
						</div>
					</dl>
					<p class="host">
						All under <span class="hi">https://{API_HOST}</span>. Each kind of file has a JSON schema.
					</p>
				</Section>

				<Section id="see-also" title="SEE ALSO">
					<p class="xref">
						{links.schemas.map((s, i) => (
							<>
								{i ? ", " : ""}
								<span class="nb">
									<a href={s.url} title={`The schema of ${s.describes}`}>
										{s.name}.schema.json
									</a>
									<span class="dim">(5)</span>
								</span>
							</>
						))}
						, <a href={links.docs}>the data API's documentation</a>.
					</p>
				</Section>
			</main>

			<footer class="manfoot">
				<span>LedgerMath v1</span>
				<span class="mid">{newest.date}</span>
				<span>{title}</span>
			</footer>
		</div>
	);
}
