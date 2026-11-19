// Design v4, "Departure board": the home page as a station board. One line of what it is, the
// clock (the newest Run, the four daily rounds, the day's price file), then the board itself:
// fourteen rows, five machine types, every figure exact, its p5 to p95 drawn like a platform
// strip. Few words: the board reads itself, and everything longer is a link away.
// Rendered once at build time; client.ts only adds copy buttons.
import "./page.css";
import {
	type ByteUnit,
	type DurationUnit,
	type HeadlineRow,
	type Section,
	type Shown,
	formatCount,
	formatDuration,
	formatDurationPerUnit,
	formatMoment,
	formatRate,
	formatUsd,
	group,
	headline,
	leadFigure,
	links,
	machines,
	seriesFileContents,
	snapshot,
} from "../../data";

const ROUNDS = ["04:10", "10:10", "16:10", "22:10"] as const;

const SECTION_CODE: Record<Section, string> = {
	Memory: "MEM",
	Compute: "CPU",
	"Operating system": "OS",
	Disk: "DSK",
	Network: "NET",
};
const SECTION_CLASS: Record<Section, string> = {
	Memory: "s-mem",
	Compute: "s-cpu",
	"Operating system": "s-os",
	Disk: "s-dsk",
	Network: "s-net",
};

const minutes = (hhmm: string) => {
	const [h, m] = hhmm.split(":").map(Number);
	return h! * 60 + m!;
};

/**
 * A curl command whose only break is between the host and the path, so a narrow screen puts
 * "v1/…" on a line of its own instead of breaking inside it. The text copies exactly.
 */
function Curl(props: { href: string }) {
	const cut = props.href.indexOf("/", "https://".length) + 1;
	return (
		<>
			<span class="u-host">curl {props.href.slice(0, cut)}</span>
			<span class="u-path">{props.href.slice(cut)}</span>
		</>
	);
}

/** Split-flap tiles for a short text such as "17:07". */
function Flaps(props: { text: string }) {
	return (
		<span class="flaps" aria-hidden="true">
			{[...props.text].map((ch) =>
				ch === ":" ? (
					<span class="flap-colon">:</span>
				) : (
					<span class="flap">
						<span>{ch}</span>
					</span>
				),
			)}
		</span>
	);
}

function sectionsInOrder() {
	const out: { section: Section; rows: HeadlineRow[] }[] = [];
	for (const row of headline) {
		const last = out[out.length - 1];
		if (last && last.section === row.choice.section) last.rows.push(row);
		else out.push({ section: row.choice.section, rows: [row] });
	}
	return out;
}

/**
 * An exact figure cut in two for setting, not rounded: the whole part and the first groups of
 * three decimals (the head, set large), and every remaining digit (the tail, set small in the
 * same run). Read together they are the figure, digit for digit.
 */
function cut(full: string, places: number) {
	const grouped = group(full, ",", " ");
	const dot = grouped.indexOf(".");
	if (dot < 0) return { head: grouped, tail: "" };
	const frac = grouped.slice(dot + 1).split(" ");
	const keep = places / 3;
	return { head: `${grouped.slice(0, dot + 1)}${frac.slice(0, keep).join(" ")}`, tail: frac.slice(keep).join(" ") };
}

/**
 * One board row, prepared for printing: one unit for the whole row (the one its largest figure
 * reads in, so no cell switches unit; for the mutex, the time of one critical section), and a head
 * long enough to tell the row's five figures apart. The strip is drawn on a scale from zero to the
 * row's largest 95th percentile: a drawing, not a statistic.
 */
function prepareRow(row: HeadlineRow) {
	const c = row.choice;
	const figs = row.cells.map((cell) => leadFigure(c, cell.series));
	const largest = figs.reduce((a, b) => (b.p50 > a.p50 ? b : a));
	const scaleEnd = Math.max(...figs.map((f) => f.p95));
	let fmt: (n: number) => Shown;
	if (c.lead === "rate") {
		const unit = formatRate(largest.p50).unit.replace("/s", "") as ByteUnit;
		fmt = (n) => formatRate(n, { unit });
	} else if (c.per) {
		const per = c.per;
		const unit = formatDurationPerUnit(largest.p50, per).unit as DurationUnit;
		fmt = (n) => formatDurationPerUnit(n, per, { unit });
	} else {
		const unit = formatDuration(largest.p50).unit as DurationUnit;
		fmt = (n) => formatDuration(n, { unit });
	}
	const fulls = figs.map((f) => fmt(f.p50).full);
	let places = 3;
	for (; places < 12; places += 3) {
		const heads = fulls.map((full) => cut(full, places).head);
		if (!heads.some((h, i) => heads.some((k, j) => j > i && h === k && fulls[i] !== fulls[j]))) break;
	}
	return {
		unit: fmt(largest.p50).unit,
		cells: row.cells.map((cell, i) => {
			const f = figs[i]!;
			return { cell, f, p50: fmt(f.p50), p5: fmt(f.p5), p95: fmt(f.p95), ...cut(fulls[i]!, places), at: (n: number) => (n / scaleEnd) * 100 };
		}),
	};
}

/** The strip: a track from zero to the row's largest p95, the p5 to p95 span, and the median as a post. */
function Strip(props: { from: number; to: number; at: number }) {
	return (
		<span class="strip" aria-hidden="true">
			<i class="strip-span" style={{ left: `${props.from}%`, width: `${Math.max(props.to - props.from, 0.6)}%` }} />
			<i class="strip-post" style={{ left: `${props.at}%` }} />
		</span>
	);
}

export default function Page() {
	const newest = formatMoment(snapshot.newestRunStartedAt);
	const oldest = formatMoment(snapshot.oldestRunStartedAt);
	const fetched = formatMoment(snapshot.pricesFetchedAt);
	const runs = formatCount(snapshot.runCount).full;
	const seriesCount = formatCount(snapshot.seriesCount).full;
	const failed = formatCount(snapshot.failedRuns).full;
	const benchmarksN = formatCount(snapshot.benchmarkCount).full;
	const machinesN = formatCount(snapshot.machineCount).full;
	const seriesV1 = snapshot.methods.find((m) => m.key === "series_v1")!;
	const requestsV1 = snapshot.methods.find((m) => m.key === "requests_v1");
	const sections = sectionsInOrder();
	let rowNumber = 0;
	const roundOfNewest = ROUNDS.reduce((acc, t, i) => (t <= newest.minute ? i : acc), ROUNDS.length - 1);
	// How far into its six-hour slot the newest Run started: where the marker sits in the lit round.
	const intoRound = (((minutes(newest.minute) - minutes(ROUNDS[roundOfNewest]!) + 1440) % 1440) / 360) * 100;

	// The sample Series file the snapshot keeps: which board row and machine it is.
	const sample = seriesFileContents.sample;
	const point = seriesFileContents.point.example;
	const sampleRowIndex = headline.findIndex((r) => r.cells.some((cell) => cell.series.id === sample.id));
	const sampleRow = headline[sampleRowIndex];
	const sampleCode = sampleRow ? `${SECTION_CODE[sampleRow.choice.section]} ${String(sampleRowIndex + 1).padStart(2, "0")}` : "";
	const samplePrepared = sampleRow ? prepareRow(sampleRow).cells.find((p) => p.cell.series.id === sample.id) : undefined;
	const pointTime = sampleRow?.choice.per ? formatDurationPerUnit(point.time_per_repetition_ns!, sampleRow.choice.per, { unit: samplePrepared?.p50.unit as DurationUnit }) : formatDuration(point.time_per_repetition_ns!);
	const J = (v: unknown) => JSON.stringify(v);

	const api = [
		{ note: "index", href: links.index, schema: links.schema.index },
		{ note: `all ${seriesCount} Series`, href: links.seriesList, schema: links.schema.seriesList },
		{ note: `${sampleCode} · ${sample.instanceType}`, href: sample.url, schema: links.schema.series },
		{ note: `prices · ${snapshot.priceDate}`, href: links.prices, schema: links.schema.prices },
	];

	return (
		<>
			<a class="skip" href="#board">
				Skip to the board
			</a>
			<header class="band">
				<div class="band-in">
					<a class="brand" href="#top" aria-label="LedgerMath, top of the page">
						<span class="brand-mark" aria-hidden="true">
							<i />
							<i />
							<i />
						</span>
						<span class="brand-name">LedgerMath</span>
					</a>
					<nav aria-label="Site">
						<a href="#board">Board</a>
						<a href="#api">API</a>
						<a href={links.docs}>Docs</a>
					</nav>
				</div>
			</header>

			<main id="top">
				{/* ------------------------------------------------ what this is, then the clock */}
				<section class="head" aria-labelledby="title">
					<div class="head-in">
						<div class="head-id">
							<h1 id="title">
								<span class="h1-a">Fresh AWS machines,</span> <span class="h1-hi">measured four times a day.</span>
							</h1>
							<p class="lede">
								{benchmarksN} benchmarks on {machinesN} freshly booted machine types. Every Run kept with its evidence; every figure in JSON, for AI agents
								to cite.
							</p>
							<div class="cmd" data-copy-wrap>
								<code data-copy>
									<Curl href={links.index} />
								</code>
							</div>
						</div>

						<div class="panel">
							<p class="clock">
								<span class="p-label" id="clock-label">
									Newest Run
								</span>
								<time datetime={newest.iso} title={newest.full} class="clock-time">
									<Flaps text={newest.minute} />
									<span class="sr">{newest.minute}</span>
									<span class="clock-utc">UTC</span>
								</time>
								<span class="clock-date">
									<span class="dot" aria-hidden="true" />
									{newest.date}
								</span>
							</p>

							<div class="rounds">
								<span class="p-label" id="rounds-label">
									Rounds
								</span>
								<ol class="round-list" aria-labelledby="rounds-label">
									{ROUNDS.map((t, i) => (
										<li class={i === roundOfNewest ? "round on" : "round"}>
											{t}
											{i === roundOfNewest && (
												<span class="round-now" aria-hidden="true">
													<i style={{ width: `${intoRound}%` }} />
												</span>
											)}
										</li>
									))}
								</ol>
							</div>

							<dl class="tally">
								<div>
									<dt>Runs</dt>
									<dd>{runs}</dd>
								</div>
								<div>
									<dt>Failed</dt>
									<dd>{failed}</dd>
								</div>
								<div>
									<dt>Region</dt>
									<dd>{snapshot.region}</dd>
								</div>
								<div>
									<dt>Since</dt>
									<dd title={oldest.full}>{oldest.date}</dd>
								</div>
							</dl>

							<p class="panel-prices">
								<span class="p-label">Prices</span>
								<a href={links.prices} title={`AWS On-Demand, copied ${fetched.full}`}>
									AWS On-Demand · {snapshot.priceDate}
								</a>
							</p>
						</div>
					</div>
				</section>

				{/* ------------------------------------------------ the board */}
				<section class="board-sec" id="board" aria-labelledby="board-title">
					<div class="sec-head">
						<h2 id="board-title">The board</h2>
						<div class="key">
							<span class="key-strip" aria-hidden="true">
								<span class="key-end key-0">0</span>
								<i class="strip-span" style={{ left: "36%", width: "36%" }} />
								<i class="strip-post" style={{ left: "52%" }} />
								<span class="key-l" style={{ left: "36%" }}>
									p5
								</span>
								<span class="key-l" style={{ left: "52%" }}>
									median
								</span>
								<span class="key-l" style={{ left: "72%" }}>
									p95
								</span>
								<span class="key-end key-max">row max</span>
							</span>
							<span class="key-marks">
								<span class="key-mark">
									<b>n</b> = Runs
								</span>
								<span class="key-mark">
									<b>↑↓</b> faster
								</span>
								<a class="key-mark" href={links.seriesList}>
									Method series v{seriesV1.version}
								</a>
							</span>
						</div>
					</div>

					<table class="board" aria-labelledby="board-title">
						<thead>
							<tr>
								<th scope="col" class="corner">
									Benchmark
								</th>
								{machines.map((m) => {
									const price = formatUsd(m.price.usdPerHour, { per: "hour" });
									return (
										<th scope="col" class="col-m">
											<span class="col-m-name">{m.instanceType}</span>
											<span class="col-m-price" title={`${m.price.description}: ${price.source}`}>
												${price.full}
												<small>/h</small>
											</span>
											<span class="col-m-spec">
												<span>{m.vcpu} vCPU</span> <span>{m.memory}</span>
											</span>
										</th>
									);
								})}
							</tr>
						</thead>
						{sections.map((g) => {
							const prepared = g.rows.map(prepareRow);
							// A machine's Run count, said once in the band when every row of the section shares it.
							const bandN = machines.map((_, j) => {
								const counts = prepared.map((p) => p.cells[j]!.f.count);
								return counts.every((n) => n === counts[0]) ? counts[0] : undefined;
							});
							return (
								<tbody class={SECTION_CLASS[g.section]} id={`b-${SECTION_CLASS[g.section]}`}>
									<tr class="sec-row">
										<th scope="rowgroup" class="sec-what">
											<span class="badge">{SECTION_CODE[g.section]}</span>
											<span class="sec-name">{g.section}</span>
											{g.section === "Disk" && <span class="sec-note">root EBS gp3 volume on all five</span>}
										</th>
										{machines.map((m, j) => (
											<td class="sec-m">
												<span class="sec-m-name">{m.instanceType}</span>{" "}
												{bandN[j] !== undefined && <span class="sec-m-n">n={formatCount(bandN[j]!).full}</span>}
											</td>
										))}
									</tr>
									{g.rows.map((row, r) => {
										rowNumber += 1;
										const n = String(rowNumber).padStart(2, "0");
										const c = row.choice;
										const p = prepared[r]!;
										const up = c.lead === "rate";
										const unitTitle = `${up ? "Higher" : "Lower"} is faster${c.per ? `; per ${c.per.of} (one repetition is ${formatCount(c.per.count).full})` : ""}`;
										return (
											<tr class="row">
												<th scope="row" class="what">
													<span class="what-meta">
														<span class="badge">
															{SECTION_CODE[c.section]} {n}
														</span>
														<span class="what-unit" title={unitTitle}>
															{p.unit} <b class={up ? "up" : "down"}>{up ? "↑" : "↓"}</b>
														</span>
													</span>
													<a class="what-label" href={c.readme} title={`${c.what} ${c.setting}.`}>
														{c.label}
													</a>
												</th>
												{p.cells.map(({ cell, f, p50, p5, p95, head, tail, at }, j) => {
													const t = formatMoment(cell.series.newest_run_started_at);
													const m = cell.machine.instanceType;
													return (
														<td class="fig">
															<a
																href={links.seriesFile(cell.series)}
																title={`${m}: median ${p50.full} ${p50.unit} · p5 ${p5.full} · p95 ${p95.full} · ${formatCount(f.count).full} Runs, newest ${t.full}`}
															>
																<span class="fig-v">
																	<span class="fig-h">{head}</span> <span class="fig-t">{tail}</span>
																</span>
																<Strip from={at(f.p5)} to={at(f.p95)} at={at(f.p50)} />
																{bandN[j] === undefined && <span class="fig-n">n={formatCount(f.count).full}</span>}
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
				</section>

				{/* ------------------------------------------------ the way in */}
				<section class="api-sec" id="api" aria-labelledby="api-title">
					<div class="sec-head">
						<h2 id="api-title">For agents</h2>
					</div>

					<div class="api-grid">
						<ol class="term">
							{api.map((a) => (
								<li data-copy-wrap>
									<span class="term-c">
										# {a.note}
										<a href={a.schema}>schema</a>
									</span>
									<code data-copy>
										<Curl href={a.href} />
									</code>
								</li>
							))}
							<li>
								<span class="term-c"># evidence</span>
								<code class="term-tpl">{links.evidenceBlobTemplate}</code>
							</li>
						</ol>

						<div class="api-side">
							<details class="fold">
								<summary>One Run, in its Series file</summary>
								<p class="fold-l">
									<code>v1/series/{sample.id}.json</code> · excerpt, samples omitted
								</p>
								<pre class="resp">
									<code>
										<span class="j-k">"benchmark"</span>: <span class="j-s">{J(sample.benchmark)}</span>,{"\n"}
										<span class="j-k">"instance_type"</span>: <span class="j-s">{J(sample.instanceType)}</span>,{"\n"}
										<span class="j-k">"run"</span>: <span class="j-s">{J(point.run)}</span>,{"\n"}
										<span class="j-k">"started_at"</span>: <span class="j-s">{J(point.started_at)}</span>,{"\n"}
										<span class="j-k">"counted"</span>: <span class="j-n">{J(point.counted)}</span>,{"\n"}
										<span class="j-k">"time_per_repetition_ns"</span>: <mark class="j-n">{J(point.time_per_repetition_ns)}</mark>,{"\n"}
										<span class="j-k">"evidence"</span>: <a href={point.evidence}>{J(point.evidence)}</a>
									</code>
								</pre>
								{samplePrepared && (
									<p class="fold-l">
										This Run{sampleRow?.choice.per ? ` ÷ ${formatCount(sampleRow.choice.per.count).full}` : ""}: {group(pointTime.full, ",", " ")} {pointTime.unit}. Its
										cell on the board ({sampleCode}, {sample.instanceType}): {group(samplePrepared.p50.full, ",", " ")} {samplePrepared.p50.unit}.
									</p>
								)}
							</details>

							<details class="fold">
								<summary>Where each price is read</summary>
								<dl class="ptr">
									{machines.map((m) => (
										<div>
											<dt>{m.instanceType}</dt>
											<dd>
												<code>{m.price.path.pointer}</code>
											</dd>
										</div>
									))}
								</dl>
							</details>

							<p class="api-docs">
								<a href={links.docs}>API documentation →</a>
							</p>
						</div>
					</div>
				</section>
			</main>

			<footer class="foot">
				<div class="foot-in">
					<span class="foot-brand">
						<span class="brand-mark" aria-hidden="true">
							<i />
							<i />
							<i />
						</span>
						LedgerMath
					</span>
					<span class="foot-asof">
						As of <time datetime={newest.iso}>{newest.full}</time>
					</span>
					<span class="foot-links">
						<a href={links.seriesList}>
							Methods: series v{seriesV1.version}
							{requestsV1 ? `, requests v${requestsV1.version}` : ""}
						</a>
						<a href={links.prices}>prices</a>
						<a href={links.docs}>docs</a>
						<a href="third-party-notices.txt">Font licences</a>
					</span>
				</div>
			</footer>
		</>
	);
}
