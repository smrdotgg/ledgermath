import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { derive, gather } from "../methods/v1";
import type { DerivationsFile } from "../methods/v1/output";
import { renderPage, seriesLabel } from "../scripts/build-page";
import { blobsFromDirectories } from "../scripts/lib/blobs";
import { esc } from "../scripts/lib/chart";
import { readRunFiles } from "../scripts/lib/run-files";
import { RUNS_REPOSITORY_BLOB_URL } from "../scripts/lib/runs-repository";
import { HandMade } from "./hand-made-runs";

const SAMPLES = join(import.meta.dir, "samples");
const BASE = RUNS_REPOSITORY_BLOB_URL;

async function samplesDerived(): Promise<DerivationsFile> {
	const directory = mkdtempSync(join(tmpdir(), "page-samples-"));
	try {
		const names = ["scheduled", "interrupted", "failures"];
		for (const name of names) cpSync(join(SAMPLES, name, "runs"), join(directory, "runs"), { recursive: true });
		const runs = readRunFiles(directory);
		return derive(runs, await gather(runs, blobsFromDirectories(names.map((name) => join(SAMPLES, name, "blobs")))));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Each Series' section of the page, by Series id. */
function sections(html: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const match of html.matchAll(/<section class="series" id="s-([0-9a-f]+)">([\s\S]*?)<\/section>/g)) {
		found.set(match[1] as string, match[2] as string);
	}
	return found;
}

/** The links of a chart's points, in drawing order. */
function chartLinks(section: string): string[] {
	const svg = /<svg class="chart"[\s\S]*?<\/svg>/.exec(section)?.[0] ?? "";
	return [...svg.matchAll(/<a href="([^"]*)">/g)].map((match) => (match[1] as string).replaceAll("&amp;", "&"));
}

function checkNoExternalReference(html: string, file: DerivationsFile): void {
	const runLinks = new Set([
		...file.derivations.flatMap((d) => d.points.map((point) => BASE + point.path)),
		...file.unreadable.map((run) => BASE + run.path),
	]);
	for (const match of html.matchAll(/\b(?:href|src|xlink:href|action|srcset|poster|data)\s*=\s*"([^"]*)"/gi)) {
		const target = (match[1] as string).replaceAll("&amp;", "&");
		if (!target.startsWith("#")) expect(runLinks.has(target)).toBe(true);
	}
	expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|@import|url\(|src=/i);
	// The only addresses inside a tag or the stylesheet are the Runs'. Text may
	// name one (a dump key such as http://169.254.169.254/…); text is never fetched.
	const tagsAndStyle = [...html.matchAll(/<[^>]*>/g)].map((match) => match[0]).join("\n") + (/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "");
	const addresses = [...tagsAndStyle.matchAll(/(?:https?:)?\/\/[^\s"'<>)]+/g)].map((match) => match[0]);
	for (const address of addresses) expect(address.startsWith(BASE)).toBe(true);
}

describe("the page", () => {
	test("has one chart per Series, and every point links to its Run file", async () => {
		const file = await samplesDerived();
		const html = renderPage(file, { runUrlBase: BASE });
		const bySeries = sections(html);
		expect(bySeries.size).toBe(file.derivations.length);
		for (const derivation of file.derivations) {
			const section = bySeries.get(derivation.series.id) as string;
			expect(section).toContain(`<h2>${seriesLabel(derivation.series).replaceAll("&", "&amp;")}</h2>`);
			expect((section.match(/<svg class="chart"/g) ?? []).length).toBe(1);
			expect(chartLinks(section)).toEqual(derivation.points.map((point) => BASE + point.path));
			// Each Series shows its percentiles and the number of Runs behind them.
			const counted = derivation.points.filter((point) => point.counted).length;
			expect(section).toContain(`<td class="n">${counted}</td>`);
		}
		expect(html).toContain("Method series, version 1");
	});

	test("marks failed Runs and lists why", async () => {
		const file = await samplesDerived();
		const html = renderPage(file, { runUrlBase: BASE });
		const failed = file.derivations.flatMap((d) => d.points).filter((point) => !point.counted);
		expect(failed.length).toBe(3);
		for (const point of failed) {
			expect(html).toContain(esc(`FAILED: ${point.failure}`));
			expect(html).toContain(`<li><a href="${BASE}${point.path}">`);
		}
		expect((html.match(/stroke="#B00020"/g) ?? []).length).toBe(3);
	});

	test("opens from disk: no script, stylesheet, font, image or address but the Runs'", async () => {
		const file = await samplesDerived();
		checkNoExternalReference(renderPage(file, { runUrlBase: BASE }), file);
	});

	test("the same Derivations give the same bytes", async () => {
		const file = await samplesDerived();
		expect(renderPage(file, { runUrlBase: BASE })).toBe(renderPage(structuredClone(file), { runUrlBase: BASE }));
	});

	test("stays whole with hundreds of Runs in interleaving groups, and failed ones", async () => {
		const made = new HandMade();
		for (let i = 0; i < 300; i++) {
			const day = new Date(Date.parse("2026-01-01T22:15:00Z") + i * 8 * 3_600_000).toISOString();
			const processor = i % 3 === 0 ? "Xeon 8259CL" : "Xeon 8375C";
			const ns = (processor === "Xeon 8375C" ? 100 : 130) + (i % 7);
			made.run({ startedAt: day, processor, samplesNs: [ns * 100, ns * 100 + 50], exit: i % 50 === 49 ? { code: 1 } : { code: 0 } });
		}
		const file = derive(made.files, await gather(made.files, made.fetch));
		const html = renderPage(file, { runUrlBase: BASE });
		const [derivation] = file.derivations;
		expect(derivation?.points.length).toBe(300);
		expect(derivation?.groups.map((group) => group.id)).toEqual(["A", "B"]);
		const section = sections(html).get(derivation?.series.id as string) as string;
		expect(chartLinks(section).length).toBe(300);
		expect(section).toContain('fill="#0072B2"');
		expect(section).toContain('fill="#D55E00"');
		expect((section.match(/stroke="#B00020"/g) ?? []).length).toBe(6);
		checkNoExternalReference(html, file);
	});

	test("refuses Derivations of a Method it does not know", async () => {
		const file = await samplesDerived();
		const other = { ...file, method: { name: "series", version: 2 } } as unknown as DerivationsFile;
		expect(() => renderPage(other, { runUrlBase: BASE })).toThrow("version 1");
	});
});
