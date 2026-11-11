/**
 * Builds the page: one static HTML file from a file of Derivations.
 *
 *     bun scripts/build-page.ts DERIVATIONS OUT.html [--requests REQUESTS_DERIVATIONS] [--run-url-base URL]
 *
 * One chart per Series, every point a link to its Run file in the Runs
 * repository (or under --run-url-base). With --requests, Method requests v1's
 * Derivations add a part after every Series (scripts/lib/request-page.ts),
 * and a link to it after the list of Series; version 1's part is the same
 * bytes with or without it. It opens from disk with no network: no script, no
 * stylesheet, font or image from anywhere; the charts are SVG drawn here. The
 * same Derivations give the same bytes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import type { DerivationsFile as RequestsDerivationsFile } from "../methods/requests/v1/output";
import type { DerivationsFile, Group, Point, SectionEffect, SeriesDerivation, Stat } from "../methods/v1/output";
import {
	bytesPerSecondUnit,
	type ChartMedian,
	type ChartPoint,
	esc,
	nanosecondUnit,
	renderChart,
	swatch,
	type Unit,
	withUnit,
} from "./lib/chart";
import { renderRequestsPart } from "./lib/request-page";
import { RUNS_REPOSITORY_BLOB_URL } from "./lib/runs-repository";

export interface PageOptions {
	/** Prefixed to a Run's path to link to it. */
	runUrlBase: string;
	/** Method requests v1's Derivations, for the part after every Series. */
	requests?: RequestsDerivationsFile;
}

interface Metric {
	name: string;
	value: (point: Point) => number | null;
	stat: (percentiles: Group["percentiles"]) => Stat | null;
	unit: Unit;
}

const time = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
const short = (value: string | number | null): string => {
	if (value === null) return "absent";
	const text = String(value);
	const hash = /^(sha256:|canonical-json-sha256:)([0-9a-f]{64})$/.exec(text);
	return hash ? `${hash[1]}${(hash[2] as string).slice(0, 12)}…` : text;
};

export function seriesLabel(series: SeriesDerivation["series"]): string {
	const params = Object.entries(series.params)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(" ");
	return [series.benchmark, params, series.build, series.instance_type ?? "no instance type", series.availability_zone_id ?? "no zone ID"]
		.filter((part) => part !== "")
		.join(" · ");
}

/** Bytes per second when every counted Run has it, otherwise time per repetition. */
function metrics(derivation: SeriesDerivation): { primary: Metric; secondary: Metric | null } {
	const counted = derivation.points.filter((point) => point.counted);
	const time: Metric = {
		name: "time per repetition",
		value: (point) => point.time_per_repetition_ns,
		stat: (percentiles) => percentiles.time_per_repetition_ns,
		unit: nanosecondUnit(Math.max(0, ...counted.map((point) => point.time_per_repetition_ns ?? 0))),
	};
	if (counted.length > 0 && counted.every((point) => point.bytes_per_second !== null)) {
		const bytes: Metric = {
			name: "bytes per second",
			value: (point) => point.bytes_per_second,
			stat: (percentiles) => percentiles.bytes_per_second,
			unit: bytesPerSecondUnit(Math.max(...counted.map((point) => point.bytes_per_second as number))),
		};
		return { primary: bytes, secondary: time };
	}
	return { primary: time, secondary: null };
}

function statCells(stat: Stat | null, metric: Metric): string {
	if (stat === null) return `<td class="n">0</td><td colspan="3" class="none">no counted Run</td>`;
	const cell = (value: number): string => `<td class="v" title="${esc(String(value))}">${esc(withUnit(value, metric.unit))}</td>`;
	return `<td class="n">${stat.count}</td>${cell(stat.p5)}${cell(stat.p50)}${cell(stat.p95)}`;
}

function statsTable(derivation: SeriesDerivation, primary: Metric, secondary: Metric | null): string {
	const rows: string[] = [];
	const failed = (runs: readonly string[]): number =>
		derivation.points.filter((point) => !point.counted && runs.includes(point.run)).length;
	const row = (label: string, percentiles: Group["percentiles"], runs: readonly string[]): string => {
		const second = secondary === null ? "" : statCells(secondary.stat(percentiles), secondary).replace(/^<td class="n">\d+<\/td>/, "");
		return `<tr><th scope="row">${label}</th><td class="n">${failed(runs)}</td>${statCells(primary.stat(percentiles), primary)}${second}</tr>`;
	};
	rows.push(row("All groups", derivation.percentiles, derivation.points.map((point) => point.run)));
	if (derivation.groups.length > 1) {
		derivation.groups.forEach((group, index) => {
			rows.push(row(`${swatch(index)} Group ${esc(group.id)}`, group.percentiles, group.runs));
		});
	}
	const head2 =
		secondary === null ? "" : `<th colspan="3">${esc(secondary.name)}</th>`;
	const sub2 = secondary === null ? "" : "<th>5th</th><th>50th</th><th>95th</th>";
	return [
		'<table class="stats">',
		`<thead><tr><th rowspan="2"></th><th rowspan="2">Failed Runs</th><th rowspan="2">Counted Runs</th><th colspan="3">${esc(primary.name)}, percentiles across Runs</th>${head2}</tr>`,
		`<tr><th>5th</th><th>50th</th><th>95th</th>${sub2}</tr></thead>`,
		`<tbody>${rows.join("")}</tbody>`,
		"</table>",
	].join("\n");
}

function pointTitle(point: Point, primary: Metric, secondary: Metric | null): string {
	const lines = [`Run ${point.run}`, time(Date.parse(point.started_at)), `group ${point.group}, boot ${point.boot}`];
	if (!point.counted) lines.push(`FAILED: ${point.failure ?? ""}`);
	else {
		const p = primary.value(point);
		if (p !== null) lines.push(`${primary.name}: ${withUnit(p, primary.unit)} (${p})`);
		const s = secondary?.value(point) ?? null;
		if (secondary !== null && s !== null) lines.push(`${secondary.name}: ${withUnit(s, secondary.unit)} (${s})`);
		lines.push(`median of ${point.samples.length} counted samples`);
	}
	return lines.join("\n");
}

function chart(derivation: SeriesDerivation, primary: Metric, secondary: Metric | null, options: PageOptions): string {
	const groupIndex = new Map(derivation.groups.map((group, index) => [group.id, index]));
	const points: ChartPoint[] = derivation.points.map((point) => ({
		x: Date.parse(point.started_at),
		y: point.counted ? primary.value(point) : null,
		group: groupIndex.get(point.group) ?? 0,
		href: options.runUrlBase + point.path,
		title: pointTitle(point, primary, secondary),
	}));
	const medians: ChartMedian[] = derivation.groups.flatMap((group, index) => {
		const stat = primary.stat(group.percentiles);
		const counted = derivation.points.filter((point) => point.group === group.id && point.counted);
		if (stat === null || counted.length === 0) return [];
		return [
			{
				group: index,
				x0: Date.parse((counted[0] as Point).started_at),
				x1: Date.parse((counted.at(-1) as Point).started_at),
				y: stat.p50,
				title: `group ${group.id}: 50th percentile ${withUnit(stat.p50, primary.unit)} over ${stat.count} Runs`,
			},
		];
	});
	return renderChart({ points, medians, unit: primary.unit, label: `${primary.name} of each Run of ${seriesLabel(derivation.series)}` });
}

function legend(derivation: SeriesDerivation): string {
	const items = derivation.groups.map((group, index) => {
		const counted = derivation.points.filter((point) => point.group === group.id && point.counted).length;
		return `<li>${swatch(index)} group ${esc(group.id)}: ${group.runs.length} Run${group.runs.length === 1 ? "" : "s"}, ${counted} counted</li>`;
	});
	items.push('<li><span class="cross">×</span> failed Run, in no percentile</li>');
	items.push('<li><span class="dash">- -</span> a group\'s 50th percentile</li>');
	return `<ul class="legend">${items.join("")}</ul>`;
}

function groupFacts(derivation: SeriesDerivation, file: DerivationsFile): string {
	const first = derivation.groups[0];
	if (first === undefined) return "";
	const header = derivation.groups.map((group, index) => `<th>${swatch(index)} ${esc(group.id)}</th>`).join("");
	const rows = file.split_on.map(({ fact, what }) => {
		const cells = derivation.groups.map((group) => {
			const value = group.facts[fact] ?? null;
			const differs = value !== (first.facts[fact] ?? null);
			return `<td title="${esc(String(value))}"${differs ? ' class="differs"' : ""}>${esc(short(value))}</td>`;
		});
		return `<tr><th scope="row" title="${esc(what)}">${esc(fact)}</th>${cells.join("")}</tr>`;
	});
	const summary =
		derivation.groups.length === 1
			? "One group: every Run was made with the same split facts"
			: `${derivation.groups.length} groups: what each was made with (a value unlike group ${first.id}'s is marked)`;
	return `<details><summary>${esc(summary)}</summary><table class="facts"><thead><tr><th>fact</th>${header}</tr></thead><tbody>${rows.join("")}</tbody></table></details>`;
}

function failedList(derivation: SeriesDerivation, options: PageOptions): string {
	const failed = derivation.points.filter((point) => !point.counted);
	if (failed.length === 0) return "";
	const items = failed.map(
		(point) =>
			`<li><a href="${esc(options.runUrlBase + point.path)}">${esc(time(Date.parse(point.started_at)))}</a>, group ${esc(point.group)}: ${esc(point.failure ?? "")}</li>`,
	);
	return `<h3>Failed Runs (${failed.length})</h3><ul class="failed">${items.join("")}</ul>`;
}

/** How a changed section is marked in "what differed". */
const EFFECT: Record<SectionEffect, string> = {
	splits: "splits",
	"left out": "only in what is left out of the split",
	"not split on": "not split on",
};

function differedList(derivation: SeriesDerivation): string {
	const pairs = derivation.differed;
	if (pairs.length === 0) return "<h3>What differed</h3><p>One Run: nothing to compare yet.</p>";
	const startedAt = new Map(derivation.points.map((point) => [point.run, point.started_at]));
	const facts = new Map<string, number>();
	const sections = new Map<string, number>();
	for (const pair of pairs) {
		for (const fact of pair.facts) facts.set(fact, (facts.get(fact) ?? 0) + 1);
		for (const { section, effect } of pair.sections) {
			const label = `${section} (${EFFECT[effect]})`;
			sections.set(label, (sections.get(label) ?? 0) + 1);
		}
	}
	const counts = (map: Map<string, number>): string =>
		map.size === 0
			? "none"
			: [...map]
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([name, n]) => `${esc(name)} in ${n}`)
					.join(", ");
	const items = pairs.map((pair) => {
		const parts: string[] = [];
		if (pair.facts.length) parts.push(`split facts: <b>${pair.facts.map(esc).join(", ")}</b>`);
		const named = pair.sections.map(({ section, keys, effect }) => {
			const changed = keys === null || keys.length === 0 ? "" : `: ${keys.map(esc).join(", ")}`;
			const name = effect === "splits" ? `<b>${esc(section)}</b>` : esc(section);
			return `${name} (${EFFECT[effect]}${changed})`;
		});
		parts.push(`sections: ${named.length ? named.join("; ") : "none"}`);
		const from = startedAt.get(pair.from) ?? "";
		const to = startedAt.get(pair.to) ?? "";
		return `<li>${esc(time(Date.parse(from)))} → ${esc(time(Date.parse(to)))}: ${parts.join(". ")}</li>`;
	});
	return [
		"<h3>What differed</h3>",
		`<p>${pairs.length} pair${pairs.length === 1 ? "" : "s"} of consecutive Runs. Split facts that changed: ${counts(facts)}. Before-dump sections whose hash changed: ${counts(sections)}.</p>`,
		`<details><summary>Every pair</summary><ol class="pairs">${items.join("")}</ol></details>`,
	].join("\n");
}

function runsTable(derivation: SeriesDerivation, primary: Metric, secondary: Metric | null, options: PageOptions): string {
	const rows = derivation.points.map((point) => {
		const p = point.counted ? primary.value(point) : null;
		const s = point.counted && secondary !== null ? secondary.value(point) : null;
		const value = (v: number | null, metric: Metric | null): string =>
			metric === null ? "" : v === null ? '<td class="none">—</td>' : `<td class="v" title="${esc(String(v))}">${esc(withUnit(v, metric.unit))}</td>`;
		return [
			"<tr>",
			`<td><a href="${esc(options.runUrlBase + point.path)}">${esc(time(Date.parse(point.started_at)))}</a></td>`,
			`<td>${esc(point.group)}</td>`,
			`<td>${point.counted ? "counted" : "failed"}</td>`,
			value(p, primary),
			value(s, secondary),
			`<td class="n">${point.samples.length}</td>`,
			`<td><code>${esc(point.boot.slice(0, 8))}</code></td>`,
			"</tr>",
		].join("");
	});
	const head2 = secondary === null ? "" : `<th>${esc(secondary.name)}</th>`;
	return `<details><summary>Every Run (${derivation.points.length})</summary><table class="runs"><thead><tr><th>started</th><th>group</th><th></th><th>${esc(primary.name)}</th>${head2}<th>counted samples</th><th>boot</th></tr></thead><tbody>${rows.join("")}</tbody></table></details>`;
}

function seriesSection(derivation: SeriesDerivation, file: DerivationsFile, options: PageOptions): string {
	const { primary, secondary } = metrics(derivation);
	return [
		`<section class="series" id="s-${esc(derivation.series.id)}">`,
		`<h2>${esc(seriesLabel(derivation.series))}</h2>`,
		statsTable(derivation, primary, secondary),
		chart(derivation, primary, secondary, options),
		legend(derivation),
		groupFacts(derivation, file),
		failedList(derivation, options),
		differedList(derivation),
		runsTable(derivation, primary, secondary, options),
		"</section>",
	].join("\n");
}

function evidenceTable(file: DerivationsFile): string {
	const rows = file.sections.map(
		(s) =>
			`<tr><th scope="row">${esc(s.section)}</th><td class="n">${s.changed_within_run} of ${s.runs}</td><td class="n">${s.changed_within_boot} of ${s.boot_pairs}</td><td class="n">${s.changed_between_runs} of ${s.series_pairs}</td><td>${s.split_on === null ? "no" : `yes (${esc(s.split_on)})`}</td></tr>`,
	);
	return [
		'<table class="evidence">',
		"<thead><tr><th>dump section</th><th>changed within a Run (before against after)</th><th>changed between consecutive Runs of one boot</th><th>changed between consecutive Runs of one Series</th><th>split on</th></tr></thead>",
		`<tbody>${rows.join("")}</tbody>`,
		"</table>",
	].join("\n");
}

const STYLE = `
body { font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0 auto; max-width: 980px; padding: 0 16px 48px; }
h1 { font-size: 1.6em; margin: 24px 0 4px; }
h2 { font-size: 1.15em; margin: 0 0 8px; }
h3 { font-size: 1em; margin: 14px 0 4px; }
section.series { border-top: 2px solid #333; padding-top: 14px; margin-top: 28px; }
table { border-collapse: collapse; margin: 6px 0 10px; font-size: 0.92em; }
th, td { border: 1px solid #ccc; padding: 3px 7px; text-align: left; vertical-align: top; }
thead th { background: #f4f4f4; }
td.n, td.v { text-align: right; font-variant-numeric: tabular-nums; }
td.none { color: #777; }
td.differs { font-weight: bold; background: #fff4d6; }
code { font-size: 0.95em; }
.axis { font-size: 11px; fill: #333; }
svg.chart { max-width: 100%; height: auto; display: block; }
svg.swatch { vertical-align: -2px; }
ul.legend { list-style: none; padding: 0; margin: 4px 0 8px; display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 0.92em; }
.cross { color: #B00020; font-weight: bold; }
.dash { color: #555; letter-spacing: -1px; }
details { margin: 6px 0; }
summary { cursor: pointer; }
nav ol { columns: 2; font-size: 0.92em; }
.meta { color: #333; }
`;

/** The one line version 1's part gains with requests: a link to their part. */
function requestsLink(requests: RequestsDerivationsFile): string {
	const n = requests.derivations.length;
	return `<p class="meta"><a href="#requests">Per request: ${n} Series of requests (Method ${esc(requests.method.name)} v${requests.method.version})</a>, after every Series below: percentiles of each phase across requests, and their distributions.</p>`;
}

export function renderPage(file: DerivationsFile, options: PageOptions): string {
	if (file.schema !== "ledgermath.derivations/1" || file.method.name !== "series" || file.method.version !== 1) {
		throw new Error(`this page knows Method series version 1, not ${JSON.stringify(file.method)}`);
	}
	const runs = file.derivations.flatMap((derivation) => derivation.points);
	const newest = runs.reduce<string | null>((max, point) => (max === null || point.started_at > max ? point.started_at : max), null);
	const counted = runs.filter((point) => point.counted).length;
	const toc = file.derivations.map(
		(derivation) => `<li><a href="#s-${esc(derivation.series.id)}">${esc(seriesLabel(derivation.series))}</a> (${derivation.points.length})</li>`,
	);
	const unreadable =
		file.unreadable.length === 0
			? ""
			: `<h2>Run files that do not validate (${file.unreadable.length})</h2><ul>${file.unreadable
					.map((run) => `<li><a href="${esc(options.runUrlBase + run.path)}">${esc(run.path)}</a>: ${esc(run.reason)}</li>`)
					.join("")}</ul>`;
	const definitions = Object.entries(file.definitions)
		.map(([name, text]) => `<dt>${esc(name.replaceAll("_", " "))}</dt><dd>${esc(text)}</dd>`)
		.join("");
	const facts = (list: DerivationsFile["split_on"]): string =>
		list.map(({ fact, what }) => `<li><b>${esc(fact)}</b>: ${esc(what)}</li>`).join("");

	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>LedgerMath: every Series (Method ${esc(file.method.name)} v${file.method.version})</title>`,
		`<style>${STYLE}</style>`,
		"</head>",
		"<body>",
		"<h1>LedgerMath: every Series</h1>",
		`<p class="meta">Derived by <b>Method ${esc(file.method.name)}, version ${file.method.version}</b>, from ${file.runs_read} Run file${file.runs_read === 1 ? "" : "s"}: ${counted} counted, ${runs.length - counted} failed, ${file.unreadable.length} that do not validate. Newest Run started ${newest === null ? "never" : esc(time(Date.parse(newest)))}. Every point, and every time below, links to its Run file.</p>`,
		`<nav><h2>${file.derivations.length} Series</h2><ol>${toc.join("")}</ol></nav>`,
		...(options.requests === undefined ? [] : [requestsLink(options.requests)]),
		`<details><summary>How the numbers are made (Method ${esc(file.method.name)} v${file.method.version})</summary><dl>${definitions}</dl>`,
		`<h3>Split on</h3><ul>${facts(file.split_on)}</ul>`,
		`<h3>Left out of the split</h3><ul>${file.left_out
			.map(({ section, what, why }) => `<li><b>${esc(section)}</b>: ${esc(what)}: ${esc(why)}.</li>`)
			.join("")}</ul>`,
		`<h3>Not split on</h3><ul>${facts(file.not_split_on)}</ul>`,
		`<h3>How often each dump section changed, over every Run</h3>${evidenceTable(file)}</details>`,
		unreadable,
		...file.derivations.map((derivation) => seriesSection(derivation, file, options)),
		...(options.requests === undefined ? [] : [renderRequestsPart(options.requests, { runUrlBase: options.runUrlBase, label: seriesLabel })]),
		"</body>",
		"</html>",
		"",
	].join("\n");
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({ options: { "run-url-base": { type: "string" }, requests: { type: "string" } }, allowPositionals: true });
	const [input, output] = positionals;
	if (!input || !output || positionals.length !== 2) {
		console.error("usage: bun scripts/build-page.ts DERIVATIONS OUT.html [--requests REQUESTS_DERIVATIONS] [--run-url-base URL]");
		process.exit(2);
	}
	const file = JSON.parse(readFileSync(input, "utf8")) as DerivationsFile;
	const requests = values.requests === undefined ? undefined : (JSON.parse(readFileSync(values.requests, "utf8")) as RequestsDerivationsFile);
	const html = renderPage(file, { runUrlBase: values["run-url-base"] ?? RUNS_REPOSITORY_BLOB_URL, ...(requests === undefined ? {} : { requests }) });
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, html);
	console.log(`${file.derivations.length} Series${requests === undefined ? "" : `, ${requests.derivations.length} of requests`} -> ${output} (${Buffer.byteLength(html)} bytes)`);
}
