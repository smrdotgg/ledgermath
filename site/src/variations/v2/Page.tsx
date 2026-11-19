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
	roundPlaces,
	seriesFileContents,
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

/** How many places after the point the bold part of a figure shows. */
function leadPlaces(full: string): number {
	const point = full.indexOf(".");
	if (point < 0) return 0;
	return Math.max(0, leadCut(full) - point - 1);
}

/**
 * One rule for a row's p5–p95 ranges: each is printed to the places its own median's bold part
 * shows, so the range reads at the precision of the bold digits above it, trailing zeros kept.
 * Where that would print a range as "131.3–131.3", the whole row takes one more place, and again,
 * until every range in it reads as two numbers. Every digit is in the row's [+] block and in the
 * figure's title.
 */
function ranges(cells: { p50: Shown; p5: Shown; p95: Shown }[]): [string, string][] {
	for (let extra = 0; ; extra++) {
		const out = cells.map(({ p50, p5, p95 }): [string, string] => {
			const places = leadPlaces(p50.full) + extra;
			return [roundPlaces(p5.full, places), roundPlaces(p95.full, places)];
		});
		const clash = out.some(([lo, hi], i) => lo === hi && cells[i]!.p5.full !== cells[i]!.p95.full);
		if (!clash || extra >= 17) return out;
	}
}

/**
 * Which figure of a row is best (the highest rate, or the lowest time), and which others have a
 * p5–p95 that overlaps the best's: a mark for reading the row, not a figure. No number is made.
 */
function marks(up: boolean, cells: { f: { p5: number; p50: number; p95: number } }[]): ("best" | "near" | "")[] {
	const p50s = cells.map((x) => x.f.p50);
	const top = up ? Math.max(...p50s) : Math.min(...p50s);
	const best = cells.filter((x) => x.f.p50 === top);
	return cells.map((x) => {
		if (x.f.p50 === top) return "best";
		return best.some((b) => x.f.p5 <= b.f.p95 && b.f.p5 <= x.f.p95) ? "near" : "";
	});
}

/**
 * A figure printed in full, every digit, aligned on its decimal point: the whole part in a box
 * as wide as the row's widest, the fraction after it. The first four significant digits are set
 * brighter, the rest dimmer: a typographic emphasis on the exact text, not a rounding.
 */
function Digits(props: { full: string; width?: number }) {
	const [whole = "", fraction] = props.full.split(".");
	const text = fraction === undefined ? whole : `${whole}.${fraction}`;
	const cut = leadCut(text);
	const pad = Math.max(0, (props.width ?? 4) - whole.length);
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

function Section(props: { id: string; title: string; sub?: string; children?: unknown }) {
	return (
		<section class="sec" id={props.id} aria-labelledby={`${props.id}-h`}>
			<h2 id={`${props.id}-h`}>
				{props.title}
				{props.sub ? <span class="h2-sub">{props.sub}</span> : null}
			</h2>
			<div class="body">{props.children as never}</div>
		</section>
	);
}

/** A moment to the second, its fraction dimmer, and UTC: one unbreakable piece. */
function Moment(props: { m: ReturnType<typeof formatMoment>; hi?: boolean }) {
	const m = props.m;
	const fraction = m.full.slice(m.date.length + 1 + m.second.length, -4);
	return (
		<time datetime={m.iso} class="nb">
			<span class={props.hi ? "hi" : undefined}>
				{m.date} {m.second}
			</span>
			<span class="frac">{fraction}</span> UTC
		</time>
	);
}

/** In reading order for one column: when, then how much, then where and how. A wide screen sets it in three columns of three. */
function Status() {
	const runs = formatCount(snapshot.runCount).full;
	const rows: [string, unknown][] = [
		["newest", <Moment m={newest} hi />],
		["oldest", <Moment m={oldest} />],
		["schedule", <>{SCHEDULE.join(" ")} UTC, daily</>],
		[
			"runs",
			<>
				<span class="nb">
					<span class="hi">{runs}</span> kept,
				</span>{" "}
				<span class="nb">{formatCount(snapshot.countedRuns).full} counted,</span> <span class="nb">{formatCount(snapshot.failedRuns).full} failed</span>
			</>,
		],
		[
			"series",
			<>
				<span class="hi">{formatCount(snapshot.seriesCount).full}</span>, {formatCount(headlineSeries.length).full} of them in DATA
			</>,
		],
		[
			"prices",
			<>
				<a href={links.prices}>{snapshot.priceDate}</a>, copied <span class="nb">{pricesFetched.second}<span class="frac">{pricesFetched.full.slice(pricesFetched.date.length + 1 + pricesFetched.second.length, -4)}</span> UTC</span>
			</>,
		],
		[
			"where",
			<>
				AWS {snapshot.region}, zone {zones.join(", ")}
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
				each Run's output and machine, <a href="#files">FILES</a>
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

const MARK_WORDS = { best: "the best median in this row", near: "its p5–p95 overlaps the best median's", "": "" } as const;

/** A machine's column head: its name, size and hourly price. Said once at the top, and again at each group. */
function MachineHead(props: { m: (typeof machines)[number] }) {
	return (
		<>
			<span class="m-name">{props.m.instanceType}</span>
			<span class="m-spec">
				{props.m.vcpu} vCPU · {props.m.memory}
			</span>
			<span class="m-spec">${formatUsd(props.m.price.usdPerHour).full}/h</span>
		</>
	);
}

function DataTable() {
	const cols = machines.length + 1;
	return (
		<div class="scroll" role="region" aria-label="The headline figures: 14 benchmarks on 5 machine types" tabindex="0">
			<table class="data">
				<caption class="sr">
					The median (p50) of each Series' counted Runs, one Series per benchmark and machine type, with its 5th and 95th percentiles and its count of
					Runs. Each figure links to its Series file. A star marks the best median of a row; an approximately-equal sign marks a median whose p5 to p95
					overlaps the best one's.
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
								<MachineHead m={m} />
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
							return { cell, f, p50: fig(f.p50), p5: fig(f.p5), p95: fig(f.p95) };
						});
						const shortRanges = ranges(cells);
						const rowMarks = marks(up, cells);
						const whole = (x: Shown) => x.full.split(".")[0]!.length;
						const width = Math.max(...cells.map((x) => whole(x.p50)));
						const exactWidth = Math.max(...cells.flatMap((x) => [whole(x.p5), whole(x.p95)]));
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
											<td>
												<MachineHead m={m} />
											</td>
										))}
									</tr>
								) : null}
								<tr class="desc">
									<th colspan={cols} scope="rowgroup">
										<span class="b-label">{c.label}</span>
										<span class="b-what">{c.what}</span>
										{c.per ? (
											<span class="b-shown">
												<span class="k">shown</span> the time of one {c.per.of}: a repetition's time ÷ {formatCount(c.per.count).full}
											</span>
										) : null}
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
												exact<span class="sr">: {c.label}, every digit of p5 and p95, the Series files, one repetition and the setting</span>
												<span class="sum-more" aria-hidden="true">
													, setting
												</span>
											</summary>
										</details>
									</th>
									{cells.map(({ cell, f, p50, p5, p95 }, k) => {
										const mark = rowMarks[k]!;
										const [lo, hi] = shortRanges[k]!;
										return (
											<td data-m={cell.machine.instanceType} class={mark ? `m-${mark}` : undefined}>
												<span class="fig">
													<span class="mk" aria-hidden="true">
														{mark === "best" ? "*" : mark === "near" ? "≈" : " "}
													</span>
													<a
														href={links.seriesFile(cell.series)}
														title={`${cell.machine.instanceType}: p50 ${p50.full} ${p50.unit}${each}; p5 ${p5.full}, p95 ${p95.full}; ${f.count} counted Runs.${mark ? ` ${MARK_WORDS[mark][0]!.toUpperCase()}${MARK_WORDS[mark].slice(1)}.` : ""} As the snapshot holds it: ${p50.source}. Series ${cell.series.id}`}
													>
														<Digits full={p50.full} width={width} />
													</a>
													{mark ? <span class="sr">, {MARK_WORDS[mark]}</span> : null}
												</span>
												<span class="rng" title={`p5 ${p5.full} ${p5.unit}, p95 ${p95.full} ${p95.unit}`}>
													<span class="sr">p5 to p95: </span>
													{lo}–{hi}
													<span class="n">
														<span class="sr">, counted Runs: </span>
														<span aria-hidden="true">n=</span>
														{f.count}
													</span>
												</span>
											</td>
										);
									})}
								</tr>
								{(["p5", "p95"] as const).map((k) => (
									<tr class="exact">
										<th scope="row" class="unit">
											<span class="sr">{c.label}, </span>
											{k}
										</th>
										{cells.map((x) => (
											<td data-m={x.cell.machine.instanceType}>
												<Digits full={x[k].full} width={exactWidth} />
											</td>
										))}
									</tr>
								))}
								<tr class="exact sids">
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
								<tr class="exact about">
									<th scope="row" class="unit">
										<span class="sr">{c.label}, </span>about
									</th>
									<td colspan={machines.length}>
										<span class="ab">
											<span class="k">one repetition</span> {c.repetition}
										</span>
										<span class="ab">
											<span class="k">setting</span> {c.setting}
										</span>
										{c.reason ? (
											<span class="ab">
												<span class="k">why this setting</span> {c.reason}
											</span>
										) : null}
										<span class="ab">
											<span class="k">how it is run</span> <a href={c.readme}>{c.readme.replace(/^https:\/\//, "")}</a>
										</span>
									</td>
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

/** One real point of a Series file, the fields a reader most needs in the file's own order, the rest named on one line. */
function ExamplePoint() {
	const point = seriesFileContents.point.example as unknown as Record<string, unknown>;
	const keep = new Set<string>(seriesFileContents.point.key);
	const names = Object.keys(point);
	const shown = names.filter((n) => keep.has(n));
	const left = names
		.filter((n) => !keep.has(n))
		.map((n) => (Array.isArray(point[n]) ? `${n} (${(point[n] as unknown[]).length})` : n));
	const per = headline.find((row) => row.choice.benchmark === seriesFileContents.sample.benchmark)?.choice.per;
	return (
		<>
			<pre class="json">
				<code>
					<span class="jl0">{"{"}</span>
					{shown.map((n) => {
						const value = JSON.stringify(point[n]);
						const kind = typeof point[n] === "string" ? "j-s" : point[n] === null ? "j-n" : "j-v";
						return (
							<span class="jl">
								<span class="j-k">"{n}"</span>: <span class={kind}>{value}</span>,
							</span>
						);
					})}
					<span class="jl j-c">… also {left.join(", ")}</span>
					<span class="jl0">{"}"}</span>
				</code>
			</pre>
			{per ? (
				<span class="json-note">
					A point's figure is one repetition's time in nanoseconds. One repetition of {seriesFileContents.sample.benchmark} is{" "}
					{formatCount(per.count).full} {per.of}s, so DATA shows the time of one: this one ÷ {formatCount(per.count).full}.
				</span>
			) : null}
		</>
	);
}

const SERIES_DEFS = ["time_per_repetition", "bytes_per_second", "percentiles"] as const;

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
				<div>
					<dt>counted</dt>
					<dd>
						In short: a Run counts when its benchmark exited 0, every line it printed is a well-formed event, and its events came in the required order
						with as many samples as it asked for. Any other Run is failed: kept, shown with its reasons, and in no percentile. The full rule is in{" "}
						<a href={links.seriesList}>{path(links.seriesList)}</a>.
					</dd>
				</div>
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
				<span class="mid">LedgerMath Manual</span>
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
							<p class="glance">
								<span class="nb">
									newest Run <Moment m={newest} />
								</span>
								<span class="gl-2">
									{formatCount(snapshot.runCount).full} Runs kept, {formatCount(snapshot.failedRuns).full} failed, in {snapshot.region}
								</span>
							</p>
							<nav class="goto" aria-label="On this page">
								<a href="#data">the figures</a>
								<span aria-hidden="true"> · </span>
								<a href="#synopsis">the API</a>
								<span aria-hidden="true"> · </span>
								<a href="#status">status</a>
								<span aria-hidden="true"> · </span>
								<a href="#machines">machines</a>
							</nav>
						</div>
					</section>

					<Section id="synopsis" title="SYNOPSIS">
						<ul class="cmds">
							<Command url={links.index} note="table of contents: start here" />
							<Command url={links.seriesList} note={`every Series (${formatCount(snapshot.seriesCount).full}): percentiles, file`} />
							<Command url={links.prices} note="AWS On-Demand prices, a new file daily" />
						</ul>
						<p class="syn-note">
							Each Series file links every Run's figure and its evidence: cite it.
						</p>
					</Section>

					<Section id="status" title="STATUS">
						<Status />
					</Section>
				</div>

				<Section id="data" title="DATA" sub={`${formatCount(snapshot.benchmarkCount).full} benchmarks × ${formatCount(snapshot.machineCount).full} machine types`}>
					<p>
						The median (p50) of each Series' counted Runs, chosen by a written rule: one thread, static build, settings every machine ran. Each
						median is printed in full and links to its Series file; the p5–p95 under it is shortened; <span class="hi">[+] exact</span> gives it in
						full.
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
							<span class="nb">
								<span class="dir">↑</span> higher is better
							</span>{" "}
							<span class="nb">
								<span class="dir">↓</span> lower is better
							</span>{" "}
							<span class="nb">
								<span class="lg-mk">*</span> the row's best median
							</span>{" "}
							<span class="nb">
								<span class="lg-mk near">≈</span> range overlaps it
							</span>
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
							<dd>
								One Series: each Run's figure and a link to its evidence. Every figure in DATA links one. One point, one Run, as the file of Series{" "}
								<a href={seriesFileContents.sample.url}>{seriesFileContents.sample.id}</a> holds it ({seriesFileContents.sample.benchmark} on{" "}
								{seriesFileContents.sample.instanceType}), abridged:
								<ExamplePoint />
							</dd>
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
