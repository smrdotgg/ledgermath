/**
 * The checks every design must pass before it is judged, as one command:
 *
 *     bun run check:variation v3
 *
 *  1. It builds on its own, and it type-checks (its directory with src/data/, with the site's
 *     compiler options). It holds no test files.
 *  2. Fonts are system fonts or files the design serves itself: if the built page has a font
 *     file, the design's third-party-notices.txt names its licence.
 *  3. Loaded at desktop size in light and in dark, and at phone size in light and in dark: no
 *     console error, no uncaught error, no request that fails or answers 400 or more, and no
 *     request to another origin (each is refused, and counted).
 *  4. No horizontal scroll at 390 px wide, in light and in dark.
 *  5. axe-core finds no violation of its WCAG 2.0 and 2.1 A and AA rules (colour contrast among
 *     them) or of its structure rules (one main landmark, one h1, headings in order, all content
 *     in landmarks, unique landmarks), at both sizes, in light and in dark.
 *  6. What the page transfers at desktop size, scrolled to its end (HTML, CSS, JS, fonts,
 *     images), is under 300 KB (300,000 bytes) compressed: text files are weighed gzipped at
 *     level 9, as a host would send them, everything else as it is.
 *  7. With JavaScript off the page reads the same: every line of text holding a digit that the
 *     page shows with JavaScript on, it shows with JavaScript off, and it holds at least 20
 *     characters of text.
 *
 * It also prints, not as a check, the page's words that are not figures: those a visitor reads
 * without opening anything, and those folded in closed <details> (scripts/variations/words.ts;
 * the picker shows the same counts).
 *
 * Exit 0 when every check passes, 1 when one fails (each failure is listed), 2 on a bad command line.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import axe from "axe-core";
import type { Page } from "playwright";
import { buildAndServe, launch, newContext, SCHEMES, settle, SIZES, watchPage } from "./browser";
import { pageDir, SITE, slotArgument, type Slot } from "./lib";
import { countWords, type WordCount } from "./words";

const BUDGET_BYTES = 300_000;
const STRUCTURE_RULES = ["landmark-one-main", "page-has-heading-one", "heading-order", "region", "landmark-unique", "landmark-no-duplicate-main"];
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type Result = { name: string; ok: boolean; detail: string[] };
const results: Result[] = [];
function record(name: string, problems: string[], passed: string): void {
	results.push({ name, ok: problems.length === 0, detail: problems.length ? problems : [passed] });
}

function filesUnder(dir: string): string[] {
	return [...new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true })];
}

function typecheck(slot: Slot): string[] {
	const cache = join(SITE, "node_modules", ".cache", "ledgermath");
	mkdirSync(cache, { recursive: true });
	const config = join(cache, `tsconfig.${slot}.json`);
	const up = relative(cache, SITE);
	writeFileSync(
		config,
		JSON.stringify({
			extends: join(up, "tsconfig.json"),
			include: [join(up, "src", "variations", slot), join(up, "src", "data"), join(up, "src", "variations", "slot.d.ts")],
			exclude: [],
		}),
	);
	const result = Bun.spawnSync([join(SITE, "node_modules", ".bin", "tsc"), "--noEmit", "-p", config], { cwd: SITE, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return [];
	return `${result.stdout}${result.stderr}`
		.trim()
		.split("\n")
		.filter((line) => line.trim() !== "")
		.slice(0, 30);
}

async function visibleText(page: Page): Promise<string> {
	return page.locator("body").innerText();
}

const slot = slotArgument(process.argv[2], "usage: bun run check:variation v<1-8>");
const own = pageDir(slot);
let words: WordCount | null = null;

// 1. Build, types, no tests.
let served: Awaited<ReturnType<typeof buildAndServe>>;
try {
	served = await buildAndServe(slot);
	record("builds on its own", [], "built");
	words = countWords(readFileSync(join(served.out, "index.html"), "utf8"));
} catch (error) {
	record("builds on its own", [error instanceof Error ? error.message : String(error)], "");
	report();
}
record("type-checks", typecheck(slot), "no type error");
record(
	"holds no test files",
	filesUnder(own)
		.filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file))
		.map((file) => `${relative(SITE, join(own, file))}: tests do not belong in a design's directory`),
	"none",
);

// 2. Fonts and their notices.
{
	const fonts = filesUnder(served!.out).filter((file) => /\.(woff2?|ttf|otf|eot)$/i.test(file));
	const notices = join(own, "third-party-notices.txt");
	const problems =
		fonts.length > 0 && (!existsSync(notices) || readFileSync(notices, "utf8").trim().length < 40)
			? [`the page serves ${fonts.join(", ")}, but ${relative(SITE, notices)} does not give their licence`]
			: [];
	record("fonts are system fonts or served with their licence", problems, fonts.length ? `${fonts.length} font files, licence in third-party-notices.txt` : "system fonts only");
}

const browser = await launch();
try {
	const loadProblems: string[] = [];
	const scrollProblems: string[] = [];
	const axeProblems: string[] = [];
	const axeIncomplete = new Set<string>();
	let transferred = 0;
	const weighed: string[] = [];
	let textWithScripts = "";

	for (const size of SIZES) {
		for (const scheme of SCHEMES) {
			const where = `${size.name} ${scheme}`;
			const context = await newContext(browser, size, { colorScheme: scheme });
			const page = await context.newPage();
			const weigh = size.name === "desktop" && scheme === "light";
			const watch = watchPage(page, { origin: served!.origin, keepBodies: weigh });
			const response = await page.goto(served!.url, { waitUntil: "load" });
			if (!response || response.status() !== 200) loadProblems.push(`${where}: the page answered ${response?.status() ?? "nothing"}`);
			await settle(page);
			loadProblems.push(...[...new Set(watch.problems)].map((p) => `${where}: ${p}`));

			if (size.name === "phone") {
				// Against the viewport's set width: a phone zooms out to fit a page that overflows, which widens window.innerWidth.
				const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, body: document.body.scrollWidth, visual: window.innerWidth }));
				const widest = Math.max(widths.document, widths.body, widths.visual);
				if (widest > size.width) scrollProblems.push(`${where}: the page is ${widest} px wide in a ${size.width} px viewport`);
			}

			await page.addScriptTag({ content: axe.source });
			const found = await page.evaluate(
				async ({ tags, structure }) => {
					const a = (window as unknown as { axe: typeof import("axe-core") }).axe;
					const rules = [...new Set([...a.getRules(tags).map((rule) => rule.ruleId), ...structure])];
					const result = await a.run(document, { runOnly: { type: "rule", values: rules }, resultTypes: ["violations", "incomplete"] });
					const describe = (list: typeof result.violations) =>
						list.map((v) => `${v.id} (${v.impact ?? "?"}): ${v.help}; ${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"}, e.g. ${v.nodes[0]?.target.join(" ") ?? "?"}${v.nodes[0]?.failureSummary ? ` (${v.nodes[0].failureSummary.replace(/\s+/g, " ")})` : ""}`);
					return { violations: describe(result.violations), incomplete: result.incomplete.map((v) => `${v.id}: ${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"} axe could not decide`) };
				},
				{ tags: WCAG_TAGS, structure: STRUCTURE_RULES },
			);
			axeProblems.push(...found.violations.map((v) => `${where}: ${v}`));
			for (const note of found.incomplete) axeIncomplete.add(`${where}: ${note}`);

			if (weigh) {
				textWithScripts = await visibleText(page);
				for (const r of watch.responses) {
					if (!r.body) continue;
					const textual = /^(text\/|application\/(javascript|json|xml|manifest\+json)|image\/svg\+xml)/.test(r.contentType) || /\.(html|css|js|mjs|json|svg|txt)(\?|$)/.test(r.url);
					const size = textual ? Bun.gzipSync(new Uint8Array(r.body), { level: 9 }).byteLength : r.body.byteLength;
					transferred += size;
					weighed.push(`${new URL(r.url).pathname}: ${size} bytes${textual ? " gzipped" : ""}`);
				}
			}
			await context.close();
		}
	}

	record("loads cleanly, from its own origin only", loadProblems, "no console error, failed request or request to another origin, at either size, in light or dark");
	record("no horizontal scroll at 390 px", scrollProblems, "none, in light or dark");
	record("axe-core: contrast and structure", axeProblems, `no violation, at either size, in light or dark${axeIncomplete.size ? `; axe could not decide on some elements (look at them): ${[...axeIncomplete].join("; ")}` : ""}`);
	record(
		`transfers under ${BUDGET_BYTES.toLocaleString("en")} bytes compressed`,
		transferred < BUDGET_BYTES ? [] : [`${transferred.toLocaleString("en")} bytes: ${weighed.join(", ")}`],
		`${transferred.toLocaleString("en")} bytes (${weighed.join(", ")})`,
	);

	// 7. JavaScript off.
	{
		const context = await newContext(browser, SIZES[0]!, { colorScheme: "light", javaScriptEnabled: false });
		const page = await context.newPage();
		const watch = watchPage(page, { origin: served!.origin });
		await page.goto(served!.url, { waitUntil: "load" });
		await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
		const text = await visibleText(page);
		const have = new Set(text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()));
		const missing = textWithScripts
			.split("\n")
			.map((line) => line.replace(/\s+/g, " ").trim())
			.filter((line) => /\d/.test(line) && !have.has(line));
		const problems = [
			...(text.replace(/\s+/g, " ").trim().length < 20 ? [`with JavaScript off the page shows only ${text.trim().length} characters of text`] : []),
			...missing.slice(0, 10).map((line) => `shown only with JavaScript on: ${JSON.stringify(line)}`),
			...[...new Set(watch.problems)].map((p) => `with JavaScript off: ${p}`),
		];
		record("reads the same with JavaScript off", problems, "every figure is in the HTML");
		await context.close();
	}
} finally {
	await browser.close();
	served!.stop();
}
report();

function report(): never {
	for (const r of results) {
		console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
		for (const line of r.detail) console.log(`      ${line}`);
	}
	if (words) {
		console.log(`WORDS ${words.visible.toLocaleString("en")} visible words that are not figures, ${words.folded.toLocaleString("en")} more folded in closed <details>`);
		console.log(`      (${words.all.toLocaleString("en")} words in all, figures included; how they are counted: scripts/variations/words.ts)`);
	}
	const failed = results.filter((r) => !r.ok).length;
	console.log(failed ? `${slot}: ${failed} check${failed === 1 ? "" : "s"} failed` : `${slot}: every check passed`);
	process.exit(failed ? 1 : 0);
}
