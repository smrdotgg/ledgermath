/**
 * The checks a browser makes of the built site: run by hand before a change to the design, not
 * by `bun run check` or the workflow (the six-hourly rebuild needs no browser).
 *
 *     bun run check:browser [DIR] [--shots OUT]     (DIR defaults to dist/client)
 *
 * It serves DIR as a static host would and loads each page (src/pages.text.ts) in Playwright's
 * Chromium at desktop size (1440×900) and phone size (390×844, at a device scale of 2), each in
 * light and in dark, with reduced motion:
 *
 *  1. No console error, no uncaught error, no request that fails or answers 400 or more, and
 *     no request to another origin (each is refused, and counted).
 *  2. No horizontal scroll at 390 px wide (a wide table may scroll inside its own box).
 *  3. axe-core finds no violation of its WCAG 2.0 and 2.1 A and AA rules (colour contrast among
 *     them) or of its structure rules (one main landmark, one h1, headings in order, all content
 *     in landmarks, unique landmarks).
 *  4. What the page transfers at desktop size (HTML, CSS, fonts, anything else) is under
 *     BUDGET_BYTES compressed: text files weighed gzipped at level 9, others as they are.
 *  5. With JavaScript off the page reads the same: every line of text holding a digit that it
 *     shows with JavaScript on, it shows with JavaScript off.
 *
 * With --shots OUT it also writes, for each page, size and scheme, the first screen and the whole
 * page as PNG files in OUT: <page>-<size>-<scheme>-{first,full}.png.
 *
 * Chromium is Playwright's, installed once with `bunx playwright install chromium` in site/.
 * Exit 0 when every check passes, 1 when one fails (each failure listed).
 */

import { mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import axe from "axe-core";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PAGES } from "../src/pages.text";
import { BUDGET_BYTES } from "./check-output";

type Size = { name: "desktop" | "phone"; width: number; height: number; deviceScaleFactor: number; isMobile: boolean };
const SIZES: readonly Size[] = [
	{ name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false },
	{ name: "phone", width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
];
const SCHEMES = ["light", "dark"] as const;
const STRUCTURE_RULES = ["landmark-one-main", "page-has-heading-one", "heading-order", "region", "landmark-unique", "landmark-no-duplicate-main"];
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** Serves ROOT as a static host would: a directory's index.html for the directory, 404 for anything else. */
function serve(root: string): { origin: string; stop(): void } {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			let path: string;
			try {
				path = decodeURIComponent(new URL(request.url).pathname);
			} catch {
				return new Response("Bad request", { status: 400 });
			}
			let file = resolve(root, `.${path}`);
			if (file !== root && !file.startsWith(`${root}/`)) return new Response("Not found", { status: 404 });
			if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
			if (!existsSync(file)) return new Response("Not found", { status: 404 });
			return new Response(Bun.file(file));
		},
	});
	return { origin: server.url.href.replace(/\/$/, ""), stop: () => server.stop(true) };
}

function sameOrigin(url: string, origin: string): boolean {
	if (/^(data|blob|about):/i.test(url)) return true;
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

type Watch = { problems: string[]; responses: { url: string; contentType: string; body: Buffer | null }[] };

/** Watches PAGE: console errors, uncaught errors, failed requests, and requests to another origin, which it refuses. */
function watch(page: Page, origin: string, keepBodies: boolean): Watch {
	const seen: Watch = { problems: [], responses: [] };
	page.on("console", (message) => {
		if (message.type() === "error" && !message.text().includes("net::ERR_BLOCKED_BY_CLIENT")) seen.problems.push(`console error: ${message.text()}`);
	});
	page.on("pageerror", (error) => seen.problems.push(`uncaught error: ${error.message}`));
	page.on("requestfailed", (request) => {
		if (sameOrigin(request.url(), origin)) seen.problems.push(`request failed: ${request.url()} (${request.failure()?.errorText ?? "no reason given"})`);
	});
	page.on("response", async (response) => {
		const url = response.url();
		if (response.status() >= 400) seen.problems.push(`HTTP ${response.status()}: ${url}`);
		if (!keepBodies || url.startsWith("data:")) return;
		let body: Buffer | null = null;
		try {
			body = await response.body();
		} catch {}
		seen.responses.push({ url, contentType: response.headers()["content-type"] ?? "", body });
	});
	void page.route("**/*", (route) => {
		const url = route.request().url();
		if (sameOrigin(url, origin)) return route.continue();
		seen.problems.push(`request to another origin, refused: ${url}`);
		return route.abort("blockedbyclient");
	});
	return seen;
}

/** Lets the page settle: the network idle, a scroll to the end and back, fonts loaded, the height steady. */
async function settle(page: Page): Promise<void> {
	await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
	await page
		.evaluate(async () => {
			const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
			for (let y = 0, step = 0; y < document.documentElement.scrollHeight && step < 150; y += Math.max(200, window.innerHeight * 0.8), step++) {
				window.scrollTo(0, y);
				await pause(40);
			}
			window.scrollTo(0, 0);
			await Promise.race([document.fonts.ready, pause(5_000)]);
			let last = -1;
			for (let i = 0; i < 12; i++) {
				await pause(200);
				const height = document.documentElement.scrollHeight;
				if (height === last) break;
				last = height;
			}
		})
		.catch(() => {});
}

function context(browser: Browser, size: Size, colorScheme: "light" | "dark", javaScriptEnabled = true): Promise<BrowserContext> {
	return browser.newContext({
		viewport: { width: size.width, height: size.height },
		deviceScaleFactor: size.deviceScaleFactor,
		isMobile: size.isMobile,
		hasTouch: size.isMobile,
		colorScheme,
		javaScriptEnabled,
		reducedMotion: "reduce",
	});
}

const digitLines = (text: string) =>
	text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => /\d/.test(line));

type Result = { name: string; problems: string[]; passed: string };

export async function checkBrowser(dir: string, shots?: string): Promise<Result[]> {
	const root = resolve(dir);
	if (!existsSync(join(root, "index.html"))) throw new Error(`${dir}/index.html is missing: run \`bun run build\` first`);
	if (shots) mkdirSync(shots, { recursive: true });
	const server = serve(root);
	let browser: Browser;
	try {
		browser = await chromium.launch();
	} catch (error) {
		server.stop();
		throw new Error(`Chromium did not start; install it once with \`bunx playwright install chromium\` in site/.\n${error instanceof Error ? error.message : String(error)}`);
	}
	const load: string[] = [];
	const scroll: string[] = [];
	const access: string[] = [];
	const undecided = new Set<string>();
	const weight: string[] = [];
	const weights: string[] = [];
	const scriptless: string[] = [];
	try {
		for (const meta of PAGES) {
			const url = `${server.origin}${meta.path}`;
			const name = meta.path === "/" ? "home" : meta.path.replace(/^\/|\/$/g, "").replaceAll("/", "-");
			let withScripts = "";
			for (const size of SIZES) {
				for (const scheme of SCHEMES) {
					const where = `${meta.path} ${size.name} ${scheme}`;
					const ctx = await context(browser, size, scheme);
					const page = await ctx.newPage();
					const weigh = size.name === "desktop" && scheme === "light";
					const seen = watch(page, server.origin, weigh);
					const response = await page.goto(url, { waitUntil: "load" });
					if (!response || response.status() !== 200) load.push(`${where}: the page answered ${response?.status() ?? "nothing"}`);
					await settle(page);
					load.push(...[...new Set(seen.problems)].map((p) => `${where}: ${p}`));

					if (size.name === "phone") {
						const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, body: document.body.scrollWidth, visual: window.innerWidth }));
						const widest = Math.max(widths.document, widths.body, widths.visual);
						if (widest > size.width) scroll.push(`${where}: the page is ${widest} px wide in a ${size.width} px viewport`);
					}

					await page.addScriptTag({ content: axe.source });
					const found = await page.evaluate(
						async ({ tags, structure }) => {
							const a = (window as unknown as { axe: typeof import("axe-core") }).axe;
							const rules = [...new Set([...a.getRules(tags).map((rule) => rule.ruleId), ...structure])];
							const result = await a.run(document, { runOnly: { type: "rule", values: rules }, resultTypes: ["violations", "incomplete"] });
							return {
								violations: result.violations.map((v) => `${v.id} (${v.impact ?? "?"}): ${v.help}; ${v.nodes.length} element(s), e.g. ${v.nodes[0]?.target.join(" ") ?? "?"}`),
								incomplete: result.incomplete.map((v) => `${v.id}: ${v.nodes.length} element(s) axe could not decide, e.g. ${v.nodes[0]?.target.join(" ") ?? "?"}`),
							};
						},
						{ tags: WCAG_TAGS, structure: STRUCTURE_RULES },
					);
					access.push(...found.violations.map((v) => `${where}: ${v}`));
					for (const note of found.incomplete) undecided.add(`${where}: ${note}`);

					if (weigh) {
						withScripts = await page.locator("body").innerText();
						let total = 0;
						const parts: string[] = [];
						for (const r of seen.responses) {
							if (!r.body) continue;
							const textual = /^(text\/|application\/(javascript|json|xml)|image\/svg\+xml)/.test(r.contentType) || /\.(html|css|js|mjs|json|svg|txt)(\?|$)/.test(r.url);
							const bytes = textual ? Bun.gzipSync(new Uint8Array(r.body), { level: 9 }).byteLength : r.body.byteLength;
							total += bytes;
							parts.push(`${new URL(r.url).pathname} ${bytes}${textual ? " gzipped" : ""}`);
						}
						const line = `${meta.path}: ${total.toLocaleString("en")} bytes (${parts.join(", ")})`;
						weights.push(line);
						if (total >= BUDGET_BYTES) weight.push(line);
					}

					if (shots) {
						for (const full of [false, true]) {
							await page.screenshot({ path: join(shots, `${name}-${size.name}-${scheme}-${full ? "full" : "first"}.png`), fullPage: full, animations: "disabled", caret: "hide" });
						}
					}
					await ctx.close();
				}
			}

			const ctx = await context(browser, SIZES[0]!, "light", false);
			const page = await ctx.newPage();
			const seen = watch(page, server.origin, false);
			await page.goto(url, { waitUntil: "load" });
			await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
			const without = await page.locator("body").innerText();
			const have = new Set(without.split("\n").map((line) => line.replace(/\s+/g, " ").trim()));
			const missing = digitLines(withScripts).filter((line) => !have.has(line));
			if (without.replace(/\s+/g, " ").trim().length < 20) scriptless.push(`${meta.path}: with JavaScript off the page shows almost no text`);
			scriptless.push(...missing.slice(0, 10).map((line) => `${meta.path}: shown only with JavaScript on: ${JSON.stringify(line)}`));
			scriptless.push(...[...new Set(seen.problems)].map((p) => `${meta.path} with JavaScript off: ${p}`));
			await ctx.close();
		}
	} finally {
		await browser.close();
		server.stop();
	}
	const pages = PAGES.map((p) => p.path).join(" and ");
	return [
		{ name: "loads cleanly, from its own origin only", problems: load, passed: `${pages}: no console error, failed request or request to another origin, at either size, in light or dark` },
		{ name: "no horizontal scroll at 390 px", problems: scroll, passed: `${pages}: none, in light or dark` },
		{
			name: "axe-core: contrast and structure",
			problems: access,
			passed: `${pages}: no violation, at either size, in light or dark${undecided.size ? `; axe could not decide on some elements (look at them): ${[...undecided].join("; ")}` : ""}`,
		},
		{ name: `transfers under ${BUDGET_BYTES.toLocaleString("en")} bytes compressed`, problems: weight, passed: weights.join("; ") },
		{ name: "reads the same with JavaScript off", problems: scriptless, passed: `${pages}: every line with a figure is in the HTML` },
	];
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let shots: string | undefined;
	const words: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--shots") shots = args[++i];
		else if (args[i]!.startsWith("--shots=")) shots = args[i]!.slice("--shots=".length);
		else words.push(args[i]!);
	}
	const dir = words[0] ?? join(import.meta.dir, "..", "dist", "client");
	const results = await checkBrowser(dir, shots ? resolve(shots) : undefined);
	for (const r of results) {
		console.log(`${r.problems.length ? "FAIL" : "PASS"}  ${r.name}`);
		for (const line of r.problems.length ? r.problems : [r.passed]) console.log(`      ${line}`);
	}
	if (shots) console.log(`screenshots in ${resolve(shots)}`);
	const failed = results.filter((r) => r.problems.length > 0).length;
	console.log(failed ? `${failed} check${failed === 1 ? "" : "s"} failed` : "every check passed");
	process.exit(failed ? 1 : 0);
}
