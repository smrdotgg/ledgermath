/**
 * Method requests v1's part of the page (scripts/build-page.ts): for each
 * Series whose samples are requests, the pooled figures of every phase, a
 * chart over time of each Run's median, 95th and 99th percentile of the whole
 * request and of the wait for the first byte, the pooled distribution of
 * every phase, the breakdown by what the requests recorded, the failed
 * requests as counts, and every Run, each a link to its Run file.
 */

import type { Stats } from "../../methods/requests/v1/numbers";
import type { DerivationsFile, FailureCount, Point, Pool, SeriesDerivation } from "../../methods/requests/v1/output";
import { PHASES, type Phase } from "../../methods/requests/v1/requests";
import { esc } from "./chart";
import { type Curve, colourSwatch, PHASE_COLOURS, renderDistributionChart, renderTimeChart, shortTime, statColour, type TimeRun } from "./request-charts";

export interface RequestPageOptions {
	/** Prefixed to a Run's path to link to it. */
	runUrlBase: string;
	/** The label of a Series, as version 1's part writes it. */
	label: (series: SeriesDerivation["series"]) => string;
}

const time = (iso: string): string => `${iso.slice(0, 19).replace("T", " ")} UTC`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const PCTS = ["p50", "p90", "p95", "p99", "p99.9"] as const;
const PCT_WORDS: Record<(typeof PCTS)[number], string> = { p50: "50th", p90: "90th", p95: "95th", p99: "99th", "p99.9": "99.9th" };

function phaseName(file: DerivationsFile, phase: Phase): string {
	return file.phases.find((p) => p.phase === phase)?.name ?? phase;
}

/** A cell holding a time, its exact value in the title. */
const timeCell = (ns: number | null | undefined, title = ""): string =>
	ns === null || ns === undefined ? '<td class="none">—</td>' : `<td class="v" title="${esc(`${ns} ns${title}`)}">${esc(shortTime(ns))}</td>`;

function poolTable(file: DerivationsFile, pool: Pool): string {
	const rows = PHASES.flatMap((phase) => {
		const stats = pool.phases[phase];
		if (stats === undefined) return [];
		const pctCells = PCTS.map((name) => {
			const value = stats[name];
			if (value === null) {
				const least = file.percentiles.find((p) => p.name === name)?.least_requests ?? 0;
				return `<td class="none" title="${esc(`not reported: ${stats.count} requests; a ${PCT_WORDS[name]} percentile needs at least ${least}`)}">—</td>`;
			}
			return timeCell(value, `; ${stats.at_or_above[name]} requests ranked at or above it`);
		});
		const tail = (["p99", "p99.9"] as const).map((name) => (stats[name] === null ? "—" : String(stats.at_or_above[name]))).join(" / ");
		return [
			`<tr><th scope="row" title="${esc(file.phases.find((p) => p.phase === phase)?.interval ?? "")}">${esc(phaseName(file, phase))}</th><td class="n">${stats.count}</td>${timeCell(stats.min)}${pctCells.join("")}${timeCell(stats.max)}<td class="n">${tail}</td></tr>`,
		];
	});
	return [
		'<table class="stats">',
		"<thead><tr><th>phase</th><th>requests</th><th>least</th><th>50th</th><th>90th</th><th>95th</th><th>99th</th><th>99.9th</th><th>greatest</th><th>requests at or above the 99th / 99.9th</th></tr></thead>",
		`<tbody>${rows.join("")}</tbody>`,
		"</table>",
	].join("\n");
}

function pointTitle(file: DerivationsFile, point: Point, phase: Phase): string {
	const lines = [`Run ${point.run}`, time(point.started_at), `group ${point.group}, boot ${point.boot}`];
	if (!point.counted) {
		lines.push(`FAILED: ${point.failure ?? ""}`);
		return lines.join("\n");
	}
	lines.push(`${point.succeeded} requests succeeded, ${point.failed} failed`);
	const stats = point.phases[phase];
	if (stats !== undefined) {
		lines.push(`${phaseName(file, phase)}:`);
		for (const name of ["p50", "p95", "p99"] as const) {
			const value = stats[name];
			lines.push(`  ${PCT_WORDS[name]}: ${value === null ? `not reported (${stats.count} requests)` : `${shortTime(value)} (${value} ns), ${stats.at_or_above[name]} at or above`}`);
		}
		lines.push(`  greatest: ${shortTime(stats.max)}`);
	}
	return lines.join("\n");
}

function timeChart(file: DerivationsFile, derivation: SeriesDerivation, phase: Phase, options: RequestPageOptions): string {
	const runs: TimeRun[] = derivation.points.map((point) => {
		const stats = point.phases[phase];
		return {
			x: Date.parse(point.started_at),
			values: [stats?.p50 ?? null, stats?.p95 ?? null, stats?.p99 ?? null],
			failed: !point.counted,
			failedRequests: point.failed,
			href: options.runUrlBase + point.path,
			title: pointTitle(file, point, phase),
		};
	});
	const legend = ["50th", "95th", "99th"].map((name, index) => `<li>${colourSwatch(statColour(index))} ${name} percentile of each Run's requests</li>`);
	legend.push('<li><span class="cross">×</span> failed Run, in no figure</li>', '<li><span class="cross">3</span> failed requests of a counted Run</li>');
	return [
		`<h3>${esc(phaseName(file, phase))}, per Run</h3>`,
		renderTimeChart({ runs, stats: ["p50", "p95", "p99"], label: `${phaseName(file, phase)}: each Run's 50th, 95th and 99th percentile, ${options.label(derivation.series)}` }),
		`<ul class="legend">${legend.join("")}</ul>`,
	].join("\n");
}

function distribution(file: DerivationsFile, derivation: SeriesDerivation, options: RequestPageOptions): string {
	const phases = PHASES.filter((phase) => derivation.pool.phases[phase] !== undefined);
	if (phases.length === 0) return "<h3>Distribution</h3><p>No succeeded request: nothing to draw.</p>";
	const curves: Curve[] = phases.map((phase) => {
		const stats = derivation.pool.phases[phase] as NonNullable<Pool["phases"][Phase]>;
		return { name: phaseName(file, phase), colour: PHASE_COLOURS[phase] as string, bold: phase === "total", count: stats.count, min: stats.min, max: stats.max, bins: stats.histogram };
	});
	const legend = curves.map((curve) => `<li>${colourSwatch(curve.colour)} ${esc(curve.name)}</li>`).join("");
	const total = derivation.pool.phases.total;
	const tail =
		total === undefined
			? ""
			: `<p>Of the ${total.count} whole requests, ${(["p99", "p99.9"] as const)
					.map((name) =>
						total[name] === null
							? `the ${PCT_WORDS[name]} percentile is not reported (it needs ${file.percentiles.find((p) => p.name === name)?.least_requests} requests)`
							: `${plural(total.at_or_above[name] as number, "request is", "requests are")} ranked at or above the ${PCT_WORDS[name]} percentile, ${shortTime(total[name] as number)}`,
					)
					.join("; ")}; the slowest took ${shortTime(total.max)}.</p>`;
	return [
		"<h3>Distribution of every phase, pooled across the counted Runs</h3>",
		renderDistributionChart({ curves, label: `cumulative distribution of each phase, ${options.label(derivation.series)}` }),
		`<ul class="legend">${legend}</ul>`,
		`<p class="meta">Each curve is a phase's requests from its fastest to its slowest (the dot); up is the share of them at or below a time, spaced so that each step from 50% to 90%, 99% and 99.9% gets the same room. Read from the pooled histogram (64 bins per doubling of time).</p>`,
		tail,
	].join("\n");
}

function breakdownTables(file: DerivationsFile, pool: Pool): string {
	if (pool.by.length === 0) return "<p>Every succeeded request had the same address block, cipher, TLS version and group.</p>";
	const shown: Phase[] = ["total", "first_byte", "connect", "tls"];
	return pool.by
		.map((breakdown) => {
			const what = file.request_facts.find((fact) => fact.fact === breakdown.fact)?.what ?? breakdown.fact;
			const phases = shown.filter((phase) => breakdown.values.some((value) => value.phases[phase] !== undefined));
			const head = phases.map((phase) => `<th colspan="3">${esc(phaseName(file, phase))}: 50th, 95th, 99th</th>`).join("");
			const rows = breakdown.values.map((value) => {
				const cells = phases.map((phase) => {
					const stats: Stats | undefined = value.phases[phase];
					return (["p50", "p95", "p99"] as const).map((name) => timeCell(stats?.[name] ?? null, stats?.[name] == null ? "" : `; ${stats.at_or_above[name]} requests ranked at or above it`)).join("");
				});
				return `<tr><th scope="row">${esc(value.value)}</th><td class="n">${value.runs}</td><td class="n">${value.requests}</td>${cells.join("")}</tr>`;
			});
			return `<h4 title="${esc(what)}">By ${esc(breakdown.fact.replaceAll("_", " "))}</h4><table class="stats"><thead><tr><th>${esc(breakdown.fact)}</th><th>Runs</th><th>requests</th>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
		})
		.join("\n");
}

function failureRows(list: readonly FailureCount[]): string {
	return list.map((f) => `<tr><td>${esc(f.phase)}</td><td>${esc(f.kind)}</td><td class="n">${f.count}</td></tr>`).join("");
}

function failedRequests(derivation: SeriesDerivation): string {
	const { pool } = derivation;
	const warmups = derivation.points.filter((point) => point.warmup_failure !== null).length;
	const lines = [
		`<p>${plural(pool.failed, "counted request")} failed in the ${plural(pool.runs, "counted Run")}${pool.failed === 0 ? "" : ", in no time"}; ${plural(pool.requests, "request")} succeeded.${warmups === 0 ? "" : ` The warmup request failed in ${plural(warmups, "Run")}.`}</p>`,
	];
	if (pool.failures.length > 0) lines.push(`<table class="stats"><thead><tr><th>phase</th><th>kind</th><th>requests</th></tr></thead><tbody>${failureRows(pool.failures)}</tbody></table>`);
	if (pool.setups_failed.length > 0) {
		lines.push(`<p>Reused-connection setups that failed outside any request:</p><table class="stats"><thead><tr><th>phase</th><th>kind</th><th>setups</th></tr></thead><tbody>${failureRows(pool.setups_failed)}</tbody></table>`);
	}
	return `<h3>Failed requests</h3>${lines.join("\n")}`;
}

function groupsTable(file: DerivationsFile, derivation: SeriesDerivation): string {
	if (derivation.groups.length < 2) return "";
	const rows = derivation.groups.map((group) => {
		const total = group.pool.phases.total;
		const first = group.pool.phases.first_byte;
		const changed = file.split_on.filter(({ fact }) => (group.facts[fact] ?? null) !== ((derivation.groups[0] as (typeof derivation.groups)[number]).facts[fact] ?? null)).map(({ fact }) => fact);
		return `<tr><th scope="row">${esc(group.id)}</th><td class="n">${group.runs.length}</td><td class="n">${group.pool.runs}</td><td class="n">${group.pool.requests}</td>${timeCell(total?.p50)}${timeCell(total?.p95)}${timeCell(total?.p99)}${timeCell(first?.p50)}${timeCell(first?.p99)}<td>${changed.length === 0 ? "" : `differs from A in ${esc(changed.join(", "))}`}</td></tr>`;
	});
	return `<h3>Groups (series v1's split facts)</h3><table class="stats"><thead><tr><th>group</th><th>Runs</th><th>counted</th><th>requests</th><th>whole request 50th</th><th>95th</th><th>99th</th><th>first byte 50th</th><th>99th</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function runsTable(derivation: SeriesDerivation, options: RequestPageOptions): string {
	const rows = derivation.points.map((point) => {
		const total = point.phases.total;
		const first = point.phases.first_byte;
		return [
			"<tr>",
			`<td><a href="${esc(options.runUrlBase + point.path)}">${esc(time(point.started_at))}</a></td>`,
			`<td>${esc(point.group)}</td>`,
			`<td>${point.counted ? `counted${point.exit_code === 4 ? " (exit 4)" : ""}` : `failed: ${esc(point.failure ?? "")}`}</td>`,
			`<td class="n">${point.succeeded}</td><td class="n">${point.failed}</td>`,
			timeCell(total?.p50),
			timeCell(total?.p95),
			timeCell(total?.p99),
			timeCell(first?.p50),
			timeCell(first?.p99),
			"</tr>",
		].join("");
	});
	return `<details><summary>Every Run (${derivation.points.length})</summary><table class="runs"><thead><tr><th>started</th><th>group</th><th></th><th>succeeded</th><th>failed</th><th>whole request 50th</th><th>95th</th><th>99th</th><th>first byte 50th</th><th>99th</th></tr></thead><tbody>${rows.join("")}</tbody></table></details>`;
}

function seriesSection(file: DerivationsFile, derivation: SeriesDerivation, options: RequestPageOptions): string {
	const counted = derivation.points.filter((point) => point.counted).length;
	const failedRuns = derivation.points.filter((point) => !point.counted);
	const { pool } = derivation;
	return [
		`<section class="series requests" id="r-${esc(derivation.series.id)}">`,
		`<h2>${esc(options.label(derivation.series))}: per request</h2>`,
		`<p class="meta">${plural(derivation.points.length, "Run")}: ${counted} counted, ${failedRuns.length} failed. Pooled across the counted Runs: ${plural(pool.requests, "succeeded request")}, ${pool.failed} failed. Percentiles are across requests, each request one sample; a percentile is shown only when the requests support it, and pooled ones are read from the histograms, within ${(file.histogram.precision * 100).toFixed(2)}%. <a href="#s-${esc(derivation.series.id)}">One number per Run (Method series v1)</a>.</p>`,
		poolTable(file, pool),
		timeChart(file, derivation, "total", options),
		pool.phases.first_byte === undefined ? "" : timeChart(file, derivation, "first_byte", options),
		distribution(file, derivation, options),
		"<h3>What the requests showed differed</h3>",
		breakdownTables(file, pool),
		groupsTable(file, derivation),
		failedRequests(derivation),
		failedRuns.length === 0
			? ""
			: `<h3>Failed Runs (${failedRuns.length})</h3><ul class="failed">${failedRuns.map((point) => `<li><a href="${esc(options.runUrlBase + point.path)}">${esc(time(point.started_at))}</a>, group ${esc(point.group)}: ${esc(point.failure ?? "")}</li>`).join("")}</ul>`,
		runsTable(derivation, options),
		"</section>",
	].join("\n");
}

/** The part: a heading, how the numbers are made, a list of the Series, and a section for each. */
export function renderRequestsPart(file: DerivationsFile, options: RequestPageOptions): string {
	if (file.schema !== "ledgermath.derivations/1" || file.method.name !== "requests" || file.method.version !== 1) {
		throw new Error(`this page knows Method requests version 1, not ${JSON.stringify(file.method)}`);
	}
	const points = file.derivations.flatMap((derivation) => derivation.points);
	const counted = points.filter((point) => point.counted);
	const requests = counted.reduce((sum, point) => sum + point.succeeded, 0);
	const toc = file.derivations.map((derivation) => `<li><a href="#r-${esc(derivation.series.id)}">${esc(options.label(derivation.series))}</a> (${derivation.points.length})</li>`);
	const definitions = Object.entries(file.definitions)
		.map(([name, words]) => `<dt>${esc(name.replaceAll("_", " "))}</dt><dd>${esc(words)}</dd>`)
		.join("");
	const phases = file.phases.map(({ phase, name, interval }) => `<li><b>${esc(name)}</b> (${esc(phase)}): ${esc(interval)}</li>`).join("");
	const facts = file.request_facts.map(({ fact, what }) => `<li><b>${esc(fact)}</b>: ${esc(what)}</li>`).join("");
	return [
		`<section class="requests-part" id="requests">`,
		`<h1>Per request: Method ${esc(file.method.name)}, version ${file.method.version}</h1>`,
		`<p class="meta">The Series whose samples are requests, from the same ${file.runs_read} Run files: ${plural(points.length, "Run")}, ${counted.length} counted, ${plural(requests, "succeeded request")}. Every point, and every time below, links to its Run file.</p>`,
		`<nav><h2>${plural(file.derivations.length, "Series")} of requests</h2><ol>${toc.join("")}</ol></nav>`,
		`<details><summary>How the numbers are made (Method ${esc(file.method.name)} v${file.method.version})</summary><dl>${definitions}</dl><h3>Phases</h3><ul>${phases}</ul><h3>What each request records, which the figures are broken down by</h3><ul>${facts}</ul></details>`,
		...file.derivations.map((derivation) => seriesSection(file, derivation, options)),
		"</section>",
	].join("\n");
}
