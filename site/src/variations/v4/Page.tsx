// Design v4, "Departure board", form under-05: the board with almost no words. The name, the
// clock (the newest Run and the four daily rounds as split-flap tiles), the API's address, then
// the whole board: fourteen numbered rows, five columns headed by their hourly price, every figure
// exact with its unit set tight against it. A row's number and a column's price open on a tap to
// say what they are; every figure links to its Series, each Run with its evidence.
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
	snapshot,
} from "../../data";

const ROUNDS = ["04:10", "10:10", "16:10", "22:10"] as const;

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

/** The brand's mark: three bars, like a board's columns. */
function Mark() {
	return (
		<span class="brand-mark" aria-hidden="true">
			<i />
			<i />
			<i />
		</span>
	);
}

/** A curl command; the address, one unbroken piece of text, is a link. */
function Curl(props: { href: string }) {
	return (
		<>
			{"curl "}
			<a class="u-path" href={props.href}>
				{props.href}
			</a>
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
	if (dot < 0) return { head: grouped, headMore: [] as string[], tail: [] as string[] };
	const frac = grouped.slice(dot + 1).split(" ");
	const keep = places / 3;
	return { head: `${grouped.slice(0, dot + 1)}${frac[0]}`, headMore: frac.slice(1, keep), tail: frac.slice(keep) };
}

/** The whole part of a cut figure (before the point), the part the row aligns on. */
const whole = (head: string) => (head.includes(".") ? head.slice(0, head.indexOf(".")) : head);

/**
 * One exact figure as one unbroken run of digits, its unit set tight against its last digit (in the
 * same text, so it reads and copies as one figure): the head bold, every further digit lighter, the
 * groups of three set apart by a sliver of margin. The whole part is right-aligned in a box as wide
 * as the row's widest, so the row's five decimal points stand at one place.
 */
function Figure(props: { head: string; headMore: string[]; tail: string[]; wholeWidth: number; unit: string }) {
	// Every piece of the figure in order; the unit joins the text of the last one (one text node,
	// so it is never set apart from its digits).
	const w = whole(props.head);
	const pieces: { text: string; kind: string }[] = [
		{ text: w, kind: "w" },
		{ text: props.head.slice(w.length), kind: "rest" },
		...props.headMore.map((text) => ({ text, kind: "more" })),
		...props.tail.map((text) => ({ text, kind: "tail" })),
	].filter((p) => p.text !== "");
	pieces[pieces.length - 1]!.text += props.unit;
	const of = (kind: string) => pieces.filter((p) => p.kind === kind);
	return (
		<span class="fig-v">
			<span class="fig-h">
				<span class="fig-w" style={{ "--w": props.wholeWidth }}>
					{of("w")[0]!.text}
				</span>
				{of("rest").map((p) => (
					<span>{p.text}</span>
				))}
				{of("more").map((p) => (
					<span class="g">{p.text}</span>
				))}
			</span>
			{of("tail").length > 0 && (
				<span class="fig-t">
					{of("tail").map((p) => (
						<span class="g">{p.text}</span>
					))}
				</span>
			)}
		</span>
	);
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
		const heads = fulls.map((full) => {
			const c = cut(full, places);
			return c.head + c.headMore.join("");
		});
		if (!heads.some((h, i) => heads.some((k, j) => j > i && h === k && fulls[i] !== fulls[j]))) break;
	}
	return {
		unit: fmt(largest.p50).unit,
		wholeWidth: Math.max(...fulls.map((full) => whole(cut(full, places).head).length)),
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

/** A machine's price tag, "$0.096/h": the figure that heads its column and names its line on the phone. */
const tag = (usdPerHour: string) => `$${formatUsd(usdPerHour, { per: "hour" }).full}/h`;

export default function Page() {
	const newest = formatMoment(snapshot.newestRunStartedAt);
	const oldest = formatMoment(snapshot.oldestRunStartedAt);
	const runs = formatCount(snapshot.runCount).full;
	const sections = sectionsInOrder();
	let rowNumber = 0;
	// The round the newest Run belongs to: the last scheduled time at or before it.
	const roundOfNewest = ROUNDS.reduce((acc, t, i) => (minutes(t) <= minutes(newest.minute) ? i : acc), ROUNDS.length - 1);
	const index = links.index;

	return (
		<>
			<main id="top">
				{/* ------------------------------------------------ the name, the way in, the clock */}
				<section class="head" aria-labelledby="title">
					<div class="head-in">
						<div class="head-id">
							<h1 id="title" class="name">
								<Mark />
								<span class="name-t">LedgerMath</span>
							</h1>
							<div class="cmd" data-copy-wrap>
								<code data-copy={`curl ${index}`}>
									<Curl href={index} />
								</code>
							</div>
						</div>

						<div class="panel">
							<p class="clock">
								<span class="p-label">Newest Run</span>
								<time datetime={newest.iso} title={`Newest Run: ${newest.full}`} class="clock-time">
									<Flaps text={newest.minute} />
									<span class="sr">{newest.minute}</span>
									<span class="clock-utc">UTC</span>
								</time>
								<span class="clock-date">
									<span>{newest.date}</span>
									<span>{snapshot.region}</span>
								</span>
							</p>

							{/* the schedule; the round the newest Run belongs to is lit */}
							<ol class="round-list" aria-label="Daily rounds, UTC">
								{ROUNDS.map((t, i) => (
									<li class={i === roundOfNewest ? "round on" : "round"} aria-current={i === roundOfNewest ? "true" : undefined}>
										{t}
									</li>
								))}
							</ol>

							<p class="tally">
								<span>
									<span class="tally-l">Runs</span> <b title={`${runs} Runs since ${oldest.full}`}>{runs}</b>
								</span>
							</p>
						</div>
					</div>
				</section>

				{/* ------------------------------------------------ the board */}
				<section class="board-sec" id="board" aria-label="The board">
					<div class="key" aria-hidden="true">
						<span class="key-strip">
							<span class="key-end key-0">0</span>
							<i class="strip-span" style={{ left: "30%", width: "44%" }} />
							<i class="strip-post" style={{ left: "50%" }} />
							<span class="key-l" style={{ left: "30%" }}>
								p5
							</span>
							<span class="key-l key-l-mid" style={{ left: "50%" }}>
								p50
							</span>
							<span class="key-l" style={{ left: "74%" }}>
								p95
							</span>
						</span>
					</div>

					<table class="board" aria-label="Fourteen benchmarks on five AWS machine types, median of every Run">
						<thead>
							<tr>
								<td class="corner" />
								{machines.map((m) => (
									<th scope="col" class="col-m">
										<span class="col-m-name">{m.instanceType}</span>
										<a class="col-m-price" href={links.prices} title={`${m.price.description}, AWS price list of ${snapshot.priceDate}`}>
											{tag(m.price.usdPerHour)}
										</a>
										{/* the price list's own facts, each set tight against its unit */}
										<span class="col-m-spec">
											<span>{`${m.vcpu}vCPU`}</span>
											<span>{m.memory.replace(/\s+/g, "")}</span>
										</span>
									</th>
								))}
							</tr>
						</thead>
						{sections.map((g) => {
							const prepared = g.rows.map(prepareRow);
							return (
								<tbody class={SECTION_CLASS[g.section]}>
									<tr class="sec-row">
										<th scope="rowgroup" colspan={machines.length + 1} class="sec-what">
											{g.section}
										</th>
									</tr>
									{g.rows.map((row, r) => {
										rowNumber += 1;
										const n = String(rowNumber).padStart(2, "0");
										const c = row.choice;
										const p = prepared[r]!;
										const up = c.lead === "rate";
										return (
											<tr class="row">
												<th scope="row" class="what">
													<details class="tap">
														<summary class="badge" title={c.label}>
															{n}
															<b class="dir" aria-label={up ? "higher is faster" : "lower is faster"}>
																{up ? "↑" : "↓"}
															</b>
														</summary>
														<span class="tap-body">
															<a class="what-label" href={c.readme}>
																{c.label}
															</a>
														</span>
													</details>
												</th>
												{p.cells.map(({ cell, f, p50, p5, p95, head, headMore, tail, at }) => {
													const t = formatMoment(cell.series.newest_run_started_at);
													const m = cell.machine.instanceType;
													return (
														<td class="fig">
															<a
																href={links.seriesFile(cell.series)}
																title={`${c.label} · ${m}: median ${p50.full} ${p50.unit} · p5 ${p5.full} · p95 ${p95.full} · ${f.count} Runs, newest ${t.full}`}
															>
																{/* the column's price tag again: shown only on the phone, where the columns become lines */}
																<span class="fig-m" aria-hidden="true">
																	{tag(cell.machine.price.usdPerHour)}
																</span>
																<Figure head={head} headMore={headMore} tail={tail} wholeWidth={p.wholeWidth} unit={p.unit} />
																<Strip from={at(f.p5)} to={at(f.p95)} at={at(f.p50)} />
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
			</main>

			<footer class="foot">
				<div class="foot-in">
					<span class="foot-brand" aria-hidden="true">
						<Mark />
					</span>
					<span class="foot-links">
						<a class="foot-mark" href="third-party-notices.txt" aria-label="Font licences" title="Font licences">
							<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
								<path d="M3 13 7 3h2l4 10h-2l-1-2.6H6L5 13H3Zm3.6-4.4h2.8L8 4.9 6.6 8.6Z" fill="currentColor" />
							</svg>
						</a>
					</span>
				</div>
			</footer>
		</>
	);
}
