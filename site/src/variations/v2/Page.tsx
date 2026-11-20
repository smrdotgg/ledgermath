// Design v2, "Terminal": the home page as a manual page. Monospace, one accent, figures printed
// in full and aligned on the decimal point. Every figure comes from ../../data as the snapshot
// holds it (see ../README.md); the only arithmetic is a change of unit, done by its helpers.
// The tiny forms: the same page with almost no words. Units sit tight against their figures (CSS
// spaces them), so the figures carry the page; what a figure is, where no word on the page says
// it, is in a row's tap-open note and in each figure's title.
import "./page.css";
import {
	type ByteUnit,
	type DurationUnit,
	durationUnit,
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

/** What this form shows in words. Each larger form turns one more of these on. */
const FORM = {
	/** The five machine types by name, over their columns. */
	machineNames: false,
	/** The five groups of benchmarks, as section heads. */
	sections: false,
	/** Each benchmark's own name, at its row. */
	benchmarkNames: false,
};

const newest = formatMoment(snapshot.newestRunStartedAt);

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
 * A figure printed in full, every digit, aligned on its decimal point, its unit set tight against
 * it (the space between them is CSS). The first four significant digits are set brighter, the rest
 * dimmer: a typographic emphasis on the exact text, not a rounding.
 */
function Digits(props: { full: string; width: number; unit?: string }) {
	const [whole = "", fraction] = props.full.split(".");
	const text = fraction === undefined ? whole : `${whole}.${fraction}`;
	const pad = Math.max(0, props.width - whole.length);
	if (!props.unit) {
		const cut = leadCut(text);
		return (
			<span class="digits">
				<span class="pad" aria-hidden="true">
					{" ".repeat(pad)}
				</span>
				<span class="lead">{text.slice(0, cut)}</span>
				<span class="tail">{text.slice(cut)}</span>
			</span>
		);
	}
	// The last digit and the unit are one piece of text, so the unit stays part of its figure;
	// the space after the digit is drawn by CSS (.fu::first-letter).
	const body = text.slice(0, -1);
	const cut = Math.min(leadCut(text), body.length);
	return (
		<span class="digits">
			<span class="pad" aria-hidden="true">
				{" ".repeat(pad)}
			</span>
			<span class="lead">{body.slice(0, cut)}</span>
			<span class="tail">{body.slice(cut)}</span>
			<span class={leadCut(text) > body.length ? "fu fu-lead" : "fu"}>
				{text.slice(-1)}
				{props.unit}
			</span>
		</span>
	);
}

/** A count and its unit, "8GiB": the last digit and the unit are one piece of text, spaced by CSS. */
function Amount(props: { text: string }) {
	const number = /^[\d.,]+/.exec(props.text)?.[0] ?? "";
	const unit = props.text.slice(number.length).trim();
	return (
		<span class="nb">
			{number.slice(0, -1)}
			<span class="fu">
				{number.slice(-1)}
				{unit}
			</span>
		</span>
	);
}

/**
 * A figure drawn on the row's one scale, from zero to the row's largest p95: a bar from zero to
 * the p50, a tick at the p50, and the p5 to p95 spread as a whisker. A drawing, not a figure.
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
/** What a group's rows share, where a reader must know it. */
const SECTION_TAG: Partial<Record<Section, string>> = { Disk: "root EBS gp3 volume" };


// ---------------------------------------------------------------- pieces

/** A machine's hourly price, linked to the place in the day's price file it was read from. */
function Price(props: { m: (typeof machines)[number] }) {
	const m = props.m;
	return (
		<a href={m.price.path.file} class="price" title={`${m.instanceType}: ${m.price.description}. Read from ${m.price.path.pointer}`}>
			${formatUsd(m.price.usdPerHour).full}/h
		</a>
	);
}

/** A machine's vCPU and memory, as figures with their units. */
function Spec(props: { m: (typeof machines)[number] }) {
	return (
		<span class="spec" title={`${props.m.instanceType}: ${props.m.vcpu} vCPU, ${props.m.memory}, ${props.m.processor}`}>
			<Amount text={`${props.m.vcpu} vCPU`} /> <Amount text={props.m.memory} />
		</span>
	);
}

/** The key, in the table's corner: each mark of the drawing beside its name, and the switch for the exact lines. */
function Key() {
	return (
		<>
			<span class="key" title="Every figure is a p50. The drawing, on one scale per row from 0: a bar to the p50, a tick at it, a whisker from p5 to p95">
				<span class="key-sw sw-t" aria-hidden="true" /> <span>p50</span> <span class="key-sw sw-r" aria-hidden="true" />{" "}
				<span>p5–p95</span>
			</span>{" "}
			<details class="xt">
				<summary title="Show each figure's exact p5 and p95, and n, the counted Runs">p5 p95 n</summary>
			</details>
		</>
	);
}

/** A row's head: its direction, and a note that opens on a tap to say what the row measures. */
function RowHead(props: { row: HeadlineRow }) {
	const c = props.row.choice;
	const up = c.lead === "rate";
	const tag = SECTION_TAG[c.section];
	return (
		<details class="note">
			<summary title={`${c.label}: open for its name`}>
				<span class="dir" role="img" aria-label={`${c.label}, ${up ? "higher is better" : "lower is better"}`}>
					{up ? "↑" : "↓"}
				</span>
			</summary>
			<span class="note-body">
				<code class="b-id">{c.benchmark}</code>{" "}
				<a href={c.readme} class="b-label">
					{c.label}
				</a>{" "}
				{c.per ? <span class="b-per">per {c.per.of}</span> : null}{" "}
				{tag ? <span class="b-per">{tag}</span> : null}
			</span>
		</details>
	);
}

function DataTable() {
	return (
		<div class="scroll" role="region" aria-label="The headline figures: 14 benchmarks on 5 machine types" tabindex="0">
			<table class="data">
				<colgroup>
					<col class="c-head" />
					{machines.map(() => (
						<col class="c-fig" />
					))}
				</colgroup>
				<thead>
					<tr>
						<th scope="col" class="corner">
							<Key />{" "}
						</th>
						{machines.map((m) => (
							<th scope="col" aria-label={m.instanceType}>
								{FORM.machineNames ? <span class="m-name">{m.instanceType}</span> : null}{" "}
								<span class="m-price">
									<Price m={m} />
								</span>{" "}
								<span class="m-spec">
									<Spec m={m} />
								</span>{" "}
							</th>
						))}
					</tr>
				</thead>
				{SECTION_ORDER.map((section) => {
					const rows = headline.filter((row) => row.choice.section === section);
					return rows.map((row, i) => {
						const fig = rowFigure(row);
						const c = row.choice;
						const cells = row.cells.map((cell) => {
							const f = leadFigure(c, cell.series);
							return { cell, f, p50: fig(f.p50), p5: fig(f.p5), p95: fig(f.p95) };
						});
						const max = Math.max(...cells.map((x) => x.f.p95));
						const whole = (x: Shown) => x.full.split(".")[0]!.length;
						const width = Math.max(...cells.map((x) => whole(x.p50)));
						const exactWidth = Math.max(...cells.flatMap((x) => [whole(x.p5), whole(x.p95)]));
						const countWidth = Math.max(...cells.map((x) => String(x.f.count).length));
						const each = c.per ? ` per ${c.per.of}` : "";
						return (
							<tbody class={i === 0 ? "bench first" : "bench"}>
								<tr class="figs">
									<th scope="row" class="rl">
										<RowHead row={row} />{" "}
									</th>
									{cells.map(({ cell, f, p50, p5, p95 }) => (
										<td>
											{/* Which machine, for the phone, where the columns become lines. */}
											<span class="m-lbl">
												{FORM.machineNames ? (
													cell.machine.instanceType
												) : (
													<span title={cell.machine.instanceType}>${formatUsd(cell.machine.price.usdPerHour).full}/h</span>
												)}
											</span>{" "}
											<a
												href={links.seriesFile(cell.series)}
												class="fig"
												title={`${c.label} on ${cell.machine.instanceType}: p50 ${p50.full} ${p50.unit}${each}; p5 ${p5.full}, p95 ${p95.full}; ${f.count} counted Runs, each with its evidence. Series ${cell.series.id}`}
											>
												<Digits full={p50.full} width={width} unit={p50.unit} />
											</a>{" "}
											<Spread p5={f.p5} p50={f.p50} p95={f.p95} max={max} />{" "}
											<span class="x">
												<span>
													<span class="xk">p5</span> <Digits full={p5.full} width={exactWidth} />
												</span>{" "}
												<span>
													<span class="xk">p95</span> <Digits full={p95.full} width={exactWidth} />
												</span>{" "}
												<span>
													<span class="xk" title="counted Runs">
														n
													</span>{" "}
													<Digits full={String(f.count)} width={countWidth} />
												</span>
											</span>{" "}
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

// ---------------------------------------------------------------- the page

export default function Page() {
	return (
		<div class="term">
			<header class="top">
				<h1 class="name">
					<span class="acc">ledgermath</span>
					<span class="sect-no" aria-hidden="true">
						(5)
					</span>
				</h1>{" "}
				<p class="when">
					<time datetime={newest.iso} title={`The newest Run started ${newest.full}`}>
						<span class="hi">{newest.date}</span>
						<span class="t">T</span>
						<span class="hi">{newest.second}</span>
						<span class="t">Z</span>
					</time>{" "}
					<a href={example.evidence} title={`One Run's evidence: Run ${example.run}, started ${example.started_at}, sha256 ${example.sha256}. ${links.evidenceAbout}`}>
						evidence
					</a>
				</p>
			</header>{" "}
			<main>
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
				</div>{" "}
				<DataTable />
			</main>{" "}
			<footer class="manfoot">
				<a href="third-party-notices.txt" class="lic" aria-label="Third-party notices: the font's licence" title="Third-party notices: the font's licence">
					©
				</a>
			</footer>
		</div>
	);
}
