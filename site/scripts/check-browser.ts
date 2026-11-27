/**
 * The checks a browser makes of the built site: by the `site` workflow's build job on every pull
 * request and push to main, and by hand (the six-hourly rebuild runs no browser).
 *
 *     bun run check:browser [DIR] [--shots OUT]     (DIR defaults to dist/client)
 *
 * It serves DIR as a static host would and loads each page in Playwright's Chromium, with reduced
 * motion: the home page (src/pages.text.ts) and FULL_PAGES of the documentation's at desktop size
 * (1440×900) and phone size (390×844, at a device scale of 2), each in light and in dark; every
 * other documentation page (read back from the site's llms.txt, scripts/site-pages.ts) at both
 * sizes in light. A page with feature flags is loaded again with each flag on (as /?napkin), which
 * must set the flag on <html>, for checks 1 to 3 and 6:
 *
 *  1. No console error, no uncaught error, no request that fails or answers 400 or more, and
 *     no request to another origin (each is refused, and counted).
 *  2. No horizontal scroll at 390 px wide (a wide table may scroll inside its own box).
 *  3. axe-core finds no violation of its WCAG 2.0 and 2.1 A and AA rules (colour contrast among
 *     them) or of its structure rules (one main landmark, one h1, headings in order, all content
 *     in landmarks, unique landmarks).
 *  4. What the page's first load transfers at desktop size (HTML, CSS, fonts, JavaScript, its own
 *     chunk, anything else) is under BUDGET_BYTES compressed: text files weighed gzipped at level
 *     9, others as they are. The chunks of other documentation pages, which the router loads
 *     ahead once the page has loaded, are weighed apart, under AHEAD_BUDGET_BYTES.
 *  5. With JavaScript off the page reads the same: every line of text holding a digit that it
 *     shows with JavaScript on, it shows with JavaScript off.
 *  6. Hydration changes nothing on the page: once the HTML is parsed, no element or text of the
 *     body is added, removed or changed while the application takes over (a structural mismatch
 *     would replace or patch them), but for the attributes the router derives from the address,
 *     which the build cannot know (aria-current, data-active, target: ADR-0036). Words that
 *     differ are not changed by hydration, so check 7 compares them. And hydration begins only
 *     after the page's first contentful paint, so it never puts off the frame the reader sees:
 *     the mark "hydrate" that src/entry-client.tsx sets comes after the paint entry. Once more
 *     at desktop size in light with Paint Timing hidden from the page, as in a browser without
 *     it, and the font 300 ms late, so that the paint comes after the page's script has run:
 *     the mark still comes after the first contentful frame was painted (its paintTime).
 *  7. Navigation, at desktop size in light (ADR-0036, ADR-0037), through ROUTE: from the home page
 *     to /docs/, a benchmark's page, two reference pages, the home page again and a benchmark's
 *     page by its name in the table, and back to the home page. From each page a click on a link to the
 *     next changes the page in place: no request for anything the page needs (the chunks of other
 *     pages, which the router loads ahead for the links the new page brings, are not the click's,
 *     and are counted apart), no new document, the
 *     next page's title and fixed words, the keyboard focus back at the top (on <body>), its
 *     title announced, and no axe violation (check 3's rules) on the page the click made. And
 *     that page is the one the build wrote for the address: its body and the built file's,
 *     both parsed by the browser, are the same, but for Solid's hydration markers and keys, the
 *     scripts and the attributes of check 6. Hydration keeps the HTML's words without comparing
 *     them, so this is where a page whose words or figures the application would render
 *     otherwise is caught. A page a click brings starts at the top. The first page is left where
 *     it loaded, never scrolled, and each other from its end, by its last link to the next (the
 *     viewport is 400 px tall, so that each page scrolls); back through them all and forward
 *     again each comes back, with no request and no new document, scrolled to where it was
 *     left. Then, with the keyboard, on each page: a link to a place on another page (/#numbers
 *     from /docs/) leaves the focus at the place, so that Tab goes on from there, not from the
 *     top, and from there a link to the same page without the fragment (LedgerMath) puts the
 *     focus back at the top, so that Tab starts from the first link; and the page's own link
 *     (the footer's "Docs" on /docs/), from the page's end, brings the page back to its top with
 *     the focus there and its title announced, as a document navigation would, with no request.
 *     And after a visit to an address whose fragment does not decode (/#%), clicks, back and
 *     clicks again still change the page, with no uncaught error. With JavaScript
 *     off the same links are ordinary links, each loading its page as a new document. The time
 *     from each click to the next frame is printed, not judged: a slow runner is slow.
 *  8. The documentation's own (ADR-0037). On a documentation page, Tab from the top reaches the
 *     breadcrumb, "View as Markdown", "Copy page" and the list of pages; "Copy page" puts the
 *     page's Markdown on the clipboard, byte for byte the file the site serves; a link to a
 *     heading of another page lands on the heading, in view at the top of the window with the
 *     keyboard focus on it; a click to a page whose chunk the host refuses (as after a deploy
 *     since the tab opened) loads that page as a new document, with no uncaught error; and with
 *     JavaScript off, "Copy page" is not shown, and "View as Markdown" is.
 *
 * With --shots OUT it also writes, for each page, size and scheme, the first screen and the whole
 * page as PNG files in OUT: <page>-<size>-<scheme>-{first,full}.png, and <page>-<flag>-… for a
 * page with a flag on.
 *
 * Chromium is Playwright's, installed once with `bunx playwright install chromium` in site/.
 * Exit 0 when every check passes, 1 when one fails (each failure listed).
 */

import { mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import axe from "axe-core";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PAGES, type SitePage } from "../src/pages.text";
import { AHEAD_BUDGET_BYTES, BUDGET_BYTES, missingText } from "./check-output";
import { chunkName } from "./docs";
import { docsPages } from "./site-pages";

/** The attributes the router sets from the browser's address, which hydration may change (check 6). */
const ADDRESS_ATTRIBUTES = new Set(["aria-current", "data-active", "target"]);

/** The documentation's pages loaded at both sizes in both schemes: its contents, the longest reference page, the longest README, the glossary. */
const FULL_PAGES = ["/docs/", "/docs/api/series", "/docs/benchmarks/http_get", "/docs/glossary"];
/**
 * The pages check 7 goes through, in order, each by a link on the one before, and back to the
 * first: the header's "Docs" (the home page never scrolled), a benchmark in /docs/'s list, two
 * pages of the documentation's list, the header's "LedgerMath", a benchmark's name in the home
 * page's table.
 */
const ROUTE = ["/", "/docs/", "/docs/benchmarks/memory_read", "/docs/api/series", "/docs/glossary", "/", "/docs/benchmarks/http_get"];
/** The pages whose keyboard paths check 7 follows. */
const KEYBOARD_PAGES = ["/", "/docs/glossary"];
/** The page check 8 tabs through: a short one, so that Tab reaches the list of pages soon. */
const TAB_PAGE = "/docs/benchmarks/sort";
/** Check 8's link to a heading of another page, from TAB_PAGE: to a heading of this one. */
const HEADING_LINK = { to: "/docs/api/series" };
/** The page whose chunk check 8 makes the host refuse, as a deploy since the tab opened would. */
const GONE_PAGE = "/docs/prices";

/** The documentation page whose body a chunk holds, by its name (scripts/docs.ts, chunkName), or null for any other file. */
const chunkOf = (url: string): string | null => {
	const name = /\/assets\/(docs[\w.-]*?)-[\w-]{8}\.js$/.exec(new URL(url, "http://x").pathname)?.[1];
	return name ?? null;
};

/**
 * Runs before the page's own scripts: from the moment the HTML is parsed (readyState
 * "interactive", which comes before a module script runs), records every change to the body
 * in window.__changes (check 6).
 */
const WATCH_HYDRATION = `document.addEventListener("readystatechange", () => {
	if (document.readyState !== "interactive" || !document.body) return;
	const changes = (window.__changes = []);
	new MutationObserver((list) => {
		for (const m of list) {
			const at = m.target.nodeName.toLowerCase();
			if (m.type === "attributes") changes.push({ kind: "attribute", name: m.attributeName, at, before: m.oldValue, after: m.target.getAttribute(m.attributeName) });
			else if (m.type === "characterData") changes.push({ kind: "text", at: m.target.parentNode ? m.target.parentNode.nodeName.toLowerCase() : at, before: m.oldValue, after: m.target.nodeValue });
			else changes.push({ kind: "elements", at, added: [...m.addedNodes].map((n) => n.nodeName.toLowerCase()), removed: [...m.removedNodes].map((n) => n.nodeName.toLowerCase()) });
		}
	}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
});`;

type Change = { kind: "attribute" | "text" | "elements"; at: string; name?: string; before?: string | null; after?: string | null; added?: string[]; removed?: string[] };

/**
 * Whether the application took over the page only after the reader saw it (check 6): the mark
 * "hydrate" (src/entry-client.tsx) after the paint entry first-contentful-paint, both on the
 * page's own clock. One line per problem.
 */
async function paintedFirst(page: Page): Promise<string[]> {
	await page.waitForFunction(() => performance.getEntriesByName("hydrated").length > 0, null, { timeout: 10_000 }).catch(() => {});
	const at = await page.evaluate(() => ({
		paint: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
		hydrate: performance.getEntriesByName("hydrate")[0]?.startTime ?? null,
		hydrated: performance.getEntriesByName("hydrated").length > 0,
	}));
	if (!at.hydrated || at.hydrate === null) return ["the application never took over the page (no mark \"hydrated\")"];
	if (at.paint === null) return ["the browser reported no first contentful paint"];
	return at.hydrate < at.paint ? [`hydration began at ${at.hydrate.toFixed(1)} ms, before the first contentful paint at ${at.paint.toFixed(1)} ms`] : [];
}

/**
 * Runs before the page's own scripts: hides Paint Timing from the page, as a browser without it
 * would be (no entry "first-contentful-paint", no entry type "paint"), and keeps the real lookup
 * in window.__paint for the check (check 6).
 */
const HIDE_PAINT_TIMING = `(() => {
	const real = performance.getEntriesByName.bind(performance);
	window.__paint = () => real("first-contentful-paint");
	performance.getEntriesByName = (name, type) => (name === "first-contentful-paint" ? [] : real(name, type));
	const types = PerformanceObserver.supportedEntryTypes.filter((type) => type !== "paint");
	Object.defineProperty(PerformanceObserver, "supportedEntryTypes", { get: () => types, configurable: true });
})();`;

/** How late the font comes in check 6's load without Paint Timing. */
const FONT_DELAY_MS = 300;

/**
 * Check 6 in a browser without Paint Timing: PAGE (with HIDE_PAINT_TIMING added, then loaded)
 * must take over only after the browser painted its first contentful frame, by its own record:
 * the end of that frame's paint (paintTime; else its start time). One line per problem.
 */
async function paintedFirstWithoutPaintTiming(page: Page): Promise<string[]> {
	const hydrated = await page.waitForFunction(() => performance.getEntriesByName("hydrated").length > 0, null, { timeout: 10_000 }).then(() => true, () => false);
	if (!hydrated) return ["without Paint Timing, the application never took over the page (no mark \"hydrated\")"];
	// The browser reports the paint a little after making it.
	await page.waitForFunction(() => (window as unknown as { __paint(): PerformanceEntry[] }).__paint().length > 0, null, { timeout: 10_000 }).catch(() => {});
	const at = await page.evaluate(() => {
		const entry = (window as unknown as { __paint(): (PerformanceEntry & { paintTime?: number })[] }).__paint()[0];
		return { paint: entry ? (entry.paintTime ?? entry.startTime) : null, hydrate: performance.getEntriesByName("hydrate")[0]!.startTime };
	});
	if (at.paint === null) return ["without Paint Timing, the browser reported no first contentful paint"];
	return at.hydrate < at.paint ? [`without Paint Timing, hydration began at ${at.hydrate.toFixed(1)} ms, before the first contentful frame was painted at ${at.paint.toFixed(1)} ms`] : [];
}

/** What hydration changed on the page that it must not have (check 6), one line each. */
async function hydrationChanges(page: Page): Promise<string[]> {
	const changes = await page.evaluate(() => (window as unknown as { __changes?: Change[] }).__changes ?? null);
	if (changes === null) return ["the watch on the body never started (the page's HTML did not parse?)"];
	return changes
		.filter((c) => !(c.kind === "attribute" && ADDRESS_ATTRIBUTES.has(c.name ?? "")))
		.map((c) =>
			c.kind === "attribute"
				? `hydration changed ${c.name} on <${c.at}>: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`
				: c.kind === "text"
					? `hydration changed text in <${c.at}>: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`
					: `hydration changed the elements in <${c.at}>: added ${c.added!.join(", ") || "none"}, removed ${c.removed!.join(", ") || "none"}`,
		);
}

/**
 * Where the body on screen differs from the body of BUILT (a page's HTML as the build wrote it),
 * both parsed by the browser and compared without Solid's hydration markers and keys, scripts,
 * the attributes of check 6 and the announcement's words; null when they are the same (check 7).
 */
function differsFromBuilt(page: Page, built: string): Promise<string | null> {
	return page.evaluate(
		({ built, attributes }) => {
			const clean = (body: HTMLElement) => {
				const copy = body.cloneNode(true) as HTMLElement;
				const walker = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
				const comments: Node[] = [];
				while (walker.nextNode()) comments.push(walker.currentNode);
				for (const comment of comments) comment.parentNode!.removeChild(comment);
				for (const script of [...copy.querySelectorAll("script")]) script.remove();
				for (const element of [...copy.querySelectorAll("*")]) for (const name of ["_hk", ...attributes]) element.removeAttribute(name);
				for (const element of [...copy.querySelectorAll("[aria-live]")]) element.textContent = "";
				copy.normalize();
				return copy.innerHTML;
			};
			const shown = clean(document.body);
			const written = clean(new DOMParser().parseFromString(built, "text/html").body);
			if (shown === written) return null;
			let i = 0;
			while (i < shown.length && shown[i] === written[i]) i++;
			return `the page differs from the one the build wrote, at character ${i}: shown ${JSON.stringify(shown.slice(Math.max(0, i - 40), i + 60))}, built ${JSON.stringify(written.slice(Math.max(0, i - 40), i + 60))}`;
		},
		{ built, attributes: [...ADDRESS_ATTRIBUTES] },
	);
}

/** axe-core's violations of check 3's rules on the page as it is now, one line each. */
async function axeViolations(page: Page): Promise<{ violations: string[]; incomplete: string[] }> {
	if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: axe.source });
	return page.evaluate(
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
}

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

/**
 * Watches PAGE: console errors, uncaught errors, failed requests, and requests to another origin,
 * which it refuses. With SCRIPTING off, the browser refusing a script a <link rel="modulepreload">
 * names (Chromium says "csp") is what JavaScript off means, not a failure.
 */
function watch(page: Page, origin: string, keepBodies: boolean, scripting = true): Watch {
	const seen: Watch = { problems: [], responses: [] };
	page.on("console", (message) => {
		if (message.type() === "error" && !message.text().includes("net::ERR_BLOCKED_BY_CLIENT")) seen.problems.push(`console error: ${message.text()}`);
	});
	page.on("pageerror", (error) => seen.problems.push(`uncaught error: ${error.message}`));
	page.on("requestfailed", (request) => {
		const why = request.failure()?.errorText ?? "no reason given";
		if (!scripting && why === "csp" && request.resourceType() === "script") return;
		if (sameOrigin(request.url(), origin)) seen.problems.push(`request failed: ${request.url()} (${why})`);
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
	const hydration: string[] = [];
	let moves: { problems: string[]; timings: string[]; ahead: string[] } = { problems: [], timings: [], ahead: [] };
	let own: { problems: string[]; passed: string[] } = { problems: [], passed: [] };
	const docs = docsPages(root);
	if (docs.problems.length > 0) throw new Error(`the documentation's pages cannot be read from ${dir}: ${docs.problems.join("; ")}`);
	const all: SitePage[] = [...PAGES, ...docs.pages];
	let aheadMost = 0;
	try {
		for (const meta of all) {
			const url = `${server.origin}${meta.path}`;
			const name = meta.path === "/" ? "home" : meta.path.replace(/^\/|\/$/g, "").replaceAll("/", "-");
			let withScripts = "";
			// The page as everyone gets it, then once with each of its flags on; a documentation page
			// not among FULL_PAGES in light only.
			const schemes = !meta.markdown || FULL_PAGES.includes(meta.path) ? SCHEMES : (["light"] as const);
			const addresses: { path: string; name: string; flag?: string }[] = [
				{ path: meta.path, name },
				...(meta.flags ?? []).map((flag) => ({ path: `${meta.path}?${flag}`, name: `${name}-${flag}`, flag })),
			];
			for (const { address, size } of addresses.flatMap((address) => SIZES.map((size) => ({ address, size })))) {
				for (const scheme of schemes) {
					const where = `${address.path} ${size.name} ${scheme}`;
					const ctx = await context(browser, size, scheme);
					const page = await ctx.newPage();
					const weigh = !address.flag && size.name === "desktop" && scheme === "light";
					const seen = watch(page, server.origin, weigh);
					await page.addInitScript(WATCH_HYDRATION);
					const response = await page.goto(`${server.origin}${address.path}`, { waitUntil: "load" });
					if (address.flag && !(await page.evaluate((flag) => flag in document.documentElement.dataset, address.flag))) {
						load.push(`${where}: the flag ${address.flag} is not set on <html>`);
					}
					if (!response || response.status() !== 200) load.push(`${where}: the page answered ${response?.status() ?? "nothing"}`);
					await settle(page);
					load.push(...[...new Set(seen.problems)].map((p) => `${where}: ${p}`));
					hydration.push(...(await paintedFirst(page)).map((p) => `${where}: ${p}`));
					hydration.push(...(await hydrationChanges(page)).map((p) => `${where}: ${p}`));
					if (weigh && schemes.length === SCHEMES.length) {
						const bare = await context(browser, size, scheme);
						const without = await bare.newPage();
						await without.addInitScript(HIDE_PAINT_TIMING);
						// A slow font (its text waits for it): the paint comes late, after the page's script runs.
						await without.route("**/*.woff2", (route) => Bun.sleep(FONT_DELAY_MS).then(() => route.continue()));
						await without.goto(`${server.origin}${address.path}`, { waitUntil: "load" });
						hydration.push(...(await paintedFirstWithoutPaintTiming(without)).map((p) => `${where}: ${p}`));
						await bare.close();
					}

					if (size.name === "phone") {
						const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, body: document.body.scrollWidth, visual: window.innerWidth }));
						const widest = Math.max(widths.document, widths.body, widths.visual);
						if (widest > size.width) scroll.push(`${where}: the page is ${widest} px wide in a ${size.width} px viewport`);
					}

					const found = await axeViolations(page);
					access.push(...found.violations.map((v) => `${where}: ${v}`));
					for (const note of found.incomplete) undecided.add(`${where}: ${note}`);

					if (weigh) {
						withScripts = await page.locator("body").innerText();
						let total = 0;
						let ahead = 0;
						let aheadCount = 0;
						const parts: string[] = [];
						const mine = meta.markdown ? chunkName(meta.path) : null;
						for (const r of seen.responses) {
							if (!r.body) continue;
							const textual = /^(text\/|application\/(javascript|json|xml)|image\/svg\+xml)/.test(r.contentType) || /\.(html|css|js|mjs|json|svg|txt)(\?|$)/.test(r.url);
							const bytes = textual ? Bun.gzipSync(new Uint8Array(r.body), { level: 9 }).byteLength : r.body.byteLength;
							// Another page's chunk: loaded ahead for its link, not for this page.
							const chunk = chunkOf(r.url);
							if (chunk !== null && chunk !== mine) {
								ahead += bytes;
								aheadCount += 1;
								continue;
							}
							total += bytes;
							parts.push(`${new URL(r.url).pathname} ${bytes}${textual ? " gzipped" : ""}`);
						}
						aheadMost = Math.max(aheadMost, ahead);
						const line = `${meta.path}: ${total.toLocaleString("en")} bytes (${parts.join(", ")}), and ${aheadCount} chunks loaded ahead, ${ahead.toLocaleString("en")} bytes`;
						weights.push(line);
						if (total >= BUDGET_BYTES) weight.push(line);
						if (ahead >= AHEAD_BUDGET_BYTES) weight.push(`${meta.path}: loaded ${ahead.toLocaleString("en")} bytes ahead, over the budget of ${AHEAD_BUDGET_BYTES.toLocaleString("en")}`);
					}

					if (shots) {
						for (const full of [false, true]) {
							await page.screenshot({ path: join(shots, `${address.name}-${size.name}-${scheme}-${full ? "full" : "first"}.png`), fullPage: full, animations: "disabled", caret: "hide" });
						}
					}
					await ctx.close();
				}
			}

			const ctx = await context(browser, SIZES[0]!, "light", false);
			const page = await ctx.newPage();
			const seen = watch(page, server.origin, false, false);
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
		moves = await navigation(browser, server.origin, root, all);
		own = await documentation(browser, server.origin, root, all);
	} finally {
		await browser.close();
		server.stop();
	}
	const pages = `the home page and the ${docs.pages.length} documentation pages (${FULL_PAGES.join(", ")} in light and dark, the others in light)`;
	return [
		{ name: "loads cleanly, from its own origin only", problems: load, passed: `${pages}: no console error, failed request or request to another origin, at either size` },
		{ name: "no horizontal scroll at 390 px", problems: scroll, passed: `${pages}: none` },
		{
			name: "axe-core: contrast and structure",
			problems: access,
			passed: `${pages}: no violation, at either size${undecided.size ? `; axe could not decide on some elements (look at them): ${[...undecided].join("; ")}` : ""}`,
		},
		{ name: `transfers under ${BUDGET_BYTES.toLocaleString("en")} bytes compressed, and under ${AHEAD_BUDGET_BYTES.toLocaleString("en")} loaded ahead`, problems: weight, passed: `at most ${aheadMost.toLocaleString("en")} bytes loaded ahead; ${weights.join("; ")}` },
		{ name: "reads the same with JavaScript off", problems: scriptless, passed: `${pages}: every line with a figure is in the HTML` },
		{
			name: "hydration waits for the first paint and changes nothing on the page",
			problems: hydration,
			passed: `${pages}: hydration began after the first contentful paint (and, with Paint Timing hidden, after the first contentful frame was painted, on the home page and ${FULL_PAGES.join(", ")}), and no element or text of the body was added, removed or changed, at either size, with each flag`,
		},
		{
			name: "navigation inside the site: in place, with no request",
			problems: moves.problems,
			passed: `through ${ROUTE.join(" -> ")} -> /, each click changed the page in place, with no request for it and no new document, to the page the build wrote for the address, at its top, its title and words, the focus at the top and the title announced, with no axe violation; back and forward the same, each page scrolled to where it was left; with the keyboard (${KEYBOARD_PAGES.join(", ")}), a link to a place on another page left the focus at the place, the same page without the fragment put it back at the top, and a page's own link brought the page back to its top; after an address whose fragment does not decode, navigation went on; with JavaScript off each link loaded its page. Loaded ahead after the clicks, for the links the new page brought: ${moves.ahead.join("; ") || "nothing"}. From the click to the next frame (not judged): ${moves.timings.join("; ")}`,
		},
		{ name: "the documentation's own: the keyboard, the two controls, a link to a heading", problems: own.problems, passed: own.passed.join("; ") },
	];
}

/** Check 7: navigation inside the site, with JavaScript on and then off (see the comment at the top). */
async function navigation(browser: Browser, origin: string, root: string, all: readonly SitePage[]): Promise<{ problems: string[]; timings: string[]; ahead: string[] }> {
	const problems: string[] = [];
	const timings: string[] = [];
	const aheadLoads: string[] = [];
	const at = (path: string) => {
		const found = all.find((meta) => meta.path === path);
		if (!found) throw new Error(`check 7 goes through ${path}, which is not a page of the site`);
		return found;
	};
	const route = ROUTE.map(at);
	const first = route[0]!;
	// From each page to the next, the last back to the first.
	const order = [...route.slice(1), first];
	const linkTo = (page: Page, meta: SitePage) => page.locator(`a[href="${meta.path}"]:not([target])`).first();
	/**
	 * The requests a step to META made that it should not have: anything but the chunks of other
	 * documentation pages, which the router loads ahead for the links the new page brings (counted
	 * in AHEAD, by the step's name).
	 */
	const forThePage = (requests: string[], meta: SitePage, where: string): string[] => {
		const ahead = requests.filter((url) => {
			const chunk = chunkOf(url);
			return chunk !== null && !(meta.markdown && chunk === chunkName(meta.path));
		});
		if (ahead.length > 0) aheadLoads.push(`${where}: ${ahead.length} chunk(s)`);
		return requests.filter((url) => !ahead.includes(url));
	};

	// Short, so that every page scrolls and back and forward have positions to restore.
	const ctx = await context(browser, { ...SIZES[0]!, height: 400 }, "light");
	const page = await ctx.newPage();
	const seen = watch(page, origin, false);
	const requests: string[] = [];
	let inflight = 0;
	page.on("request", (request) => {
		requests.push(request.url().replace(origin, ""));
		inflight += 1;
	});
	page.on("requestfinished", () => (inflight -= 1));
	page.on("requestfailed", () => (inflight -= 1));
	/** Waits until no request has been under way for 300 ms: what the router loads ahead has come. */
	const idle = async () => {
		for (let quiet = 0, step = 0; quiet < 3 && step < 100; step++) {
			await page.waitForTimeout(100);
			quiet = inflight === 0 ? quiet + 1 : 0;
		}
	};
	/** Loads META's page and waits until the application has taken it over (the mark "hydrated") and what it loads ahead has come. */
	const load = async (meta: SitePage) => {
		await page.goto(`${origin}${meta.path}`, { waitUntil: "load" });
		await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
		await page.waitForFunction(() => performance.getEntriesByName("hydrated").length > 0, null, { timeout: 10_000 }).catch(() => {});
		await idle();
		await page.evaluate(() => ((window as unknown as { __document: boolean }).__document = true));
	};
	await load(first);
	const sameDocument = () => page.evaluate(() => (window as unknown as { __document?: boolean }).__document === true).catch(() => false);

	/** What must hold of the page on screen once a click, or a step back or forward, has brought META. */
	const shows = async (where: string, meta: SitePage, clicked: boolean) => {
		if (!(await sameDocument())) return void problems.push(`${where}: a new document was loaded`);
		const made = forThePage(requests, meta, where);
		if (made.length > 0) problems.push(`${where}: ${made.length} request(s): ${made.join(", ")}`);
		await page.waitForFunction((title) => document.title === title, meta.title, { timeout: 2_000 }).catch(() => {});
		const now = await page.evaluate(() => ({
			html: document.documentElement.outerHTML,
			title: document.title,
			focus: document.activeElement === document.body,
			announced: document.querySelector("[aria-live]")?.textContent ?? null,
		}));
		if (now.title !== meta.title) problems.push(`${where}: the title is ${JSON.stringify(now.title)}, not ${JSON.stringify(meta.title)}`);
		for (const text of missingText(now.html, meta.text)) problems.push(`${where}: the page does not hold ${JSON.stringify(text)}`);
		if (!clicked) return;
		const differs = await differsFromBuilt(page, readFileSync(join(root, meta.file), "utf8"));
		if (differs) problems.push(`${where}: ${differs}`);
		if (!now.focus) problems.push(`${where}: the keyboard focus is not back at the top of the page (on <body>)`);
		if (now.announced !== meta.title) problems.push(`${where}: a screen reader is told ${JSON.stringify(now.announced)}, not the page's title`);
		const found = await axeViolations(page);
		problems.push(...found.violations.map((v) => `${where}: axe: ${v}`));
	};

	const visited: SitePage[] = [first];
	// Where each visited entry was left: the first where it loaded, never scrolled (its first link
	// to the next is in view); each other at its end, by its last link to the next.
	const left: number[] = [];
	const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
	const toEnd = () => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	const restored = async (where: string, at: number) => {
		await page.waitForFunction((y) => Math.abs(window.scrollY - y) <= 1, at, { timeout: 2_000 }).catch(() => {});
		const y = await page.evaluate(() => Math.round(window.scrollY));
		if (Math.abs(y - at) > 1) problems.push(`${where}: the page is scrolled to ${y}, not to ${at}, where it was left`);
	};
	let current = first;
	for (const [i, next] of order.entries()) {
		const where = `${current.path} -> ${next.path}`;
		const links = page.locator(`a[href="${next.path}"]:not([target])`);
		if ((await links.count()) === 0) {
			problems.push(`${where}: ${current.path} has no link to ${next.path} without a target`);
			break;
		}
		if (i > 0) await toEnd();
		const link = i === 0 ? links.first() : links.last();
		await link.scrollIntoViewIfNeeded();
		left[visited.length - 1] = await scrollY();
		await idle();
		// The click's time, the body's first change, and the next frame after it (a message posted from requestAnimationFrame).
		await page.evaluate(() => {
			const m: Record<string, number> = {};
			(window as unknown as { __click: Record<string, number> }).__click = m;
			document.addEventListener("click", (e) => (m.click = e.timeStamp), { capture: true, once: true });
			const observer = new MutationObserver(() => {
				observer.disconnect();
				requestAnimationFrame(() => {
					const channel = new MessageChannel();
					channel.port1.onmessage = () => (m.frame = performance.now());
					channel.port2.postMessage(0);
				});
			});
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });
		});
		requests.length = 0;
		await link.click();
		await page.waitForURL((url) => url.pathname === next.path, { timeout: 5_000 }).catch(() => {});
		await page.waitForFunction(() => (window as unknown as { __click?: Record<string, number> }).__click?.frame !== undefined, null, { timeout: 5_000 }).catch(() => {});
		const m = await page.evaluate(() => (window as unknown as { __click?: Record<string, number> }).__click).catch(() => undefined);
		if (m?.click !== undefined && m.frame !== undefined) timings.push(`${where} ${(m.frame - m.click).toFixed(1)} ms`);
		await shows(`click ${where}`, next, true);
		if (!(await sameDocument())) break;
		const top = await page.evaluate(() => Math.round(window.scrollY));
		if (top !== 0) problems.push(`click ${where}: the new page starts scrolled to ${top}, not at the top`);
		visited.push(next);
		current = next;
	}
	await toEnd();
	left[visited.length - 1] = await scrollY();
	for (let i = visited.length - 2; i >= 0; i--) {
		requests.length = 0;
		await page.goBack();
		await shows(`back to ${visited[i]!.path}`, visited[i]!, false);
		await restored(`back to ${visited[i]!.path}`, left[i]!);
	}
	for (let i = 1; i < visited.length; i++) {
		requests.length = 0;
		await page.goForward();
		await shows(`forward to ${visited[i]!.path}`, visited[i]!, false);
		await restored(`forward to ${visited[i]!.path}`, left[i]!);
	}

	// With the keyboard, on each page: a link to a place on another page, and a link to the page itself.
	const paths = all.map((meta) => meta.path);
	for (const meta of KEYBOARD_PAGES.map(at)) {
		await load(meta);
		const hrefs = await page.evaluate(() => [...document.querySelectorAll("a[href]:not([target])")].map((a) => a.getAttribute("href")!));
		const resolved = (href: string) => new URL(href, `${origin}${meta.path}`);

		// A place on another page (/#numbers from /docs/): the focus at the place, so that Tab goes
		// on from there, as after a document navigation to it.
		const away = hrefs.find((href) => resolved(href).hash.length > 1 && resolved(href).pathname !== meta.path && paths.includes(resolved(href).pathname));
		if (away) {
			const where = `keyboard on ${meta.path}, ${away}`;
			requests.length = 0;
			await page.focus(`a[href="${away}"]:not([target])`);
			await page.keyboard.press("Enter");
			await page.waitForURL((url) => url.href === resolved(away).href, { timeout: 5_000 }).catch(() => {});
			await page.waitForTimeout(100);
			if (!(await sameDocument())) problems.push(`${where}: a new document was loaded`);
			else {
				const made = forThePage(requests, at(resolved(away).pathname), where);
				if (made.length > 0) problems.push(`${where}: ${made.length} request(s): ${made.join(", ")}`);
				const id = decodeURIComponent(resolved(away).hash.slice(1));
				if (!(await page.evaluate((id) => document.activeElement === document.getElementById(id), id))) problems.push(`${where}: the focus is not at #${id}`);
				await page.keyboard.press("Tab");
				const after = await page.evaluate((id) => {
					const place = document.getElementById(id)!;
					return !!(place.compareDocumentPosition(document.activeElement!) & Node.DOCUMENT_POSITION_FOLLOWING);
				}, id);
				if (!after) problems.push(`${where}: Tab went to an element before #${id}, not on from it`);

				// Then, from the place, the same page without the fragment (LedgerMath on /#numbers):
				// only the fragment changes, and the focus goes back to the top, as loading the page
				// again would leave it, so that Tab starts from the page's first link.
				const there = resolved(away);
				const back = await page.evaluate(
					({ path }) => [...document.querySelectorAll("a[href]:not([target])")].map((a) => a.getAttribute("href")!).find((href) => { const u = new URL(href, location.href); return u.pathname === path && !u.hash && !u.search; }) ?? null,
					{ path: there.pathname },
				);
				if (back) {
					const from = `${where}, then ${back}`;
					requests.length = 0;
					await page.locator(`a[href="${back}"]:not([target])`).first().evaluate((a: HTMLElement) => a.focus({ preventScroll: true }));
					await page.keyboard.press("Enter");
					await page.waitForURL((url) => url.pathname === there.pathname && url.hash === "", { timeout: 5_000 }).catch(() => {});
					await page.waitForTimeout(100);
					if (!(await sameDocument())) problems.push(`${from}: a new document was loaded`);
					else {
						const made = forThePage(requests, at(there.pathname), from);
						if (made.length > 0) problems.push(`${from}: ${made.length} request(s): ${made.join(", ")}`);
						if (!(await page.evaluate(() => document.activeElement === document.body))) problems.push(`${from}: the keyboard focus is not back at the top of the page (on <body>)`);
						await page.keyboard.press("Tab");
						const first = await page.evaluate(() => {
							const focusable = [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")].find((element) => element.tabIndex >= 0);
							return document.activeElement === focusable;
						});
						if (!first) problems.push(`${from}: Tab did not start from the page's first link`);
					}
				}
			}
			await load(meta);
		}

		// The page itself (the footer's "Docs" on /docs/, "LedgerMath" on /), from its end: the page
		// again at its top, the focus there and its title announced, as a document navigation would.
		const self = hrefs.filter((href) => resolved(href).pathname === meta.path && resolved(href).hash === "" && resolved(href).search === "").at(-1);
		if (self) {
			const where = `keyboard on ${meta.path}, its own link ${self}, from the page's end`;
			await toEnd();
			await page.evaluate(() => (document.querySelector("[aria-live]")!.textContent = ""));
			requests.length = 0;
			// Focused without scrolling, as a reader who has scrolled down meets it.
			await page.locator(`a[href="${self}"]:not([target])`).last().evaluate((a: HTMLElement) => a.focus({ preventScroll: true }));
			await page.keyboard.press("Enter");
			await page.waitForTimeout(100);
			if (!(await sameDocument())) problems.push(`${where}: a new document was loaded`);
			else {
				const made = forThePage(requests, meta, where);
				if (made.length > 0) problems.push(`${where}: ${made.length} request(s): ${made.join(", ")}`);
				const now = await page.evaluate(() => ({ y: Math.round(window.scrollY), focus: document.activeElement === document.body, announced: document.querySelector("[aria-live]")?.textContent ?? null }));
				if (now.y !== 0) problems.push(`${where}: the page stays scrolled to ${now.y}, not back at its top`);
				if (!now.focus) problems.push(`${where}: the keyboard focus is not back at the top of the page (on <body>)`);
				if (now.announced !== meta.title) problems.push(`${where}: a screen reader is told ${JSON.stringify(now.announced)}, not the page's title`);
			}
		}
	}
	// An address whose fragment does not decode (/#%), as anyone may write one: the application
	// takes it as naming nothing, and navigation goes on, out, back to it, and out again.
	{
		const odd = `${first.path}#%`;
		await page.goto(`${origin}${odd}`, { waitUntil: "load" });
		await page.waitForFunction(() => performance.getEntriesByName("hydrated").length > 0, null, { timeout: 10_000 }).catch(() => {});
		await idle();
		await page.evaluate(() => ((window as unknown as { __document: boolean }).__document = true));
		const next = order[0]!;
		const step = async (where: string, to: SitePage, act: () => Promise<unknown>) => {
			requests.length = 0;
			await act();
			await page.waitForURL((url) => url.pathname === to.path, { timeout: 5_000 }).catch(() => {});
			await shows(`after ${odd}, ${where}`, to, false);
		};
		await step(`a click to ${next.path}`, next, () => linkTo(page, next).click());
		await step(`back to ${odd}`, first, () => page.goBack());
		await step(`a click to ${next.path} again`, next, () => linkTo(page, next).click());
		if (next !== first) await step(`a click to ${first.path}`, first, () => linkTo(page, first).click());
	}
	problems.push(...[...new Set(seen.problems)].map((p) => `navigation: ${p}`));
	await ctx.close();

	// JavaScript off: the same links are ordinary links, each loading its page.
	const off = await context(browser, SIZES[0]!, "light", false);
	const plain = await off.newPage();
	await plain.goto(`${origin}${first.path}`, { waitUntil: "load" });
	current = first;
	for (const next of order) {
		const where = `with JavaScript off, ${current.path} -> ${next.path}`;
		const link = linkTo(plain, next);
		if ((await link.count()) === 0) {
			problems.push(`${where}: no link`);
			break;
		}
		const [response] = await Promise.all([plain.waitForEvent("response", { predicate: (r) => r.request().isNavigationRequest() && new URL(r.url()).pathname === next.path, timeout: 5_000 }).catch(() => null), link.click()]);
		await plain.waitForLoadState("load");
		if (!response || response.status() !== 200) problems.push(`${where}: the link did not load ${next.path} as a new document (${response ? `it answered ${response.status()}` : "no document was requested"})`);
		else if ((await plain.title()) !== next.title) problems.push(`${where}: the title is ${JSON.stringify(await plain.title())}`);
		current = next;
	}
	await off.close();
	return { problems, timings, ahead: aheadLoads };
}

/** Check 8: the documentation's own (see the comment at the top). */
async function documentation(browser: Browser, origin: string, root: string, all: readonly SitePage[]): Promise<{ problems: string[]; passed: string[] }> {
	const problems: string[] = [];
	const passed: string[] = [];
	const meta = all.find((page) => page.path === TAB_PAGE);
	const target = all.find((page) => page.path === HEADING_LINK.to);
	if (!meta?.markdown || !target?.markdown) return { problems: [`check 8 reads ${TAB_PAGE} and ${HEADING_LINK.to}, which are not both documentation pages of the site`], passed };
	const ctx = await context(browser, SIZES[0]!, "light");
	await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
	const page = await ctx.newPage();
	const seen = watch(page, origin, false);
	const requests: string[] = [];
	page.on("request", (request) => requests.push(request.url().replace(origin, "")));
	await page.goto(`${origin}${meta.path}`, { waitUntil: "load" });
	await page.waitForFunction(() => performance.getEntriesByName("hydrated").length > 0, null, { timeout: 10_000 }).catch(() => problems.push(`${meta.path}: the application never took the page over`));
	await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

	// Tab from the top of the page, through to the footer.
	const reached = new Set<string>();
	for (let i = 0; i < 300 && !reached.has("the footer"); i++) {
		await page.keyboard.press("Tab");
		reached.add(
			await page.evaluate(() => {
				const at = document.activeElement as HTMLElement | null;
				if (!at || at === document.body) return "nothing";
				if (at.closest("nav.crumbs")) return "the breadcrumb";
				if (at.matches(".doc-actions a")) return "View as Markdown";
				if (at.matches("button.copy")) return "Copy page";
				if (at.closest("nav.pages")) return "the list of pages";
				if (at.closest("footer")) return "the footer";
				return "elsewhere";
			}),
		);
	}
	const wanted = ["the breadcrumb", "View as Markdown", "Copy page", "the list of pages"];
	const missed = wanted.filter((what) => !reached.has(what));
	if (missed.length > 0) problems.push(`Tab from the top of ${meta.path} never reached ${missed.join(", ")}`);
	else passed.push(`on ${meta.path}, Tab from the top reached ${wanted.join(", ")}`);

	// "Copy page": the page's Markdown, byte for byte the file the site serves.
	await page.locator("button.copy").click();
	await page.waitForFunction(() => (document.querySelector(".said")?.textContent ?? "") !== "", null, { timeout: 5_000 }).catch(() => {});
	const said = (await page.locator(".said").textContent()) ?? "";
	const copied = await page.evaluate(() => navigator.clipboard.readText()).catch((error: unknown) => `(the clipboard could not be read: ${String(error)})`);
	const markdown = readFileSync(join(root, meta.markdown.slice(1)), "utf8");
	if (copied !== markdown) problems.push(`"Copy page" on ${meta.path} put ${copied.length} characters on the clipboard, not its Markdown (${markdown.length}); it said ${JSON.stringify(said)}`);
	else passed.push(`"Copy page" put ${meta.markdown} on the clipboard, byte for byte, and said ${JSON.stringify(said)}`);

	// A link to a heading of another page (put on the page here; the generated pages link only to
	// their own headings): the heading in view at the top, the focus on it, no request for the page.
	const ids = [...readFileSync(join(root, target.file), "utf8").matchAll(/<h[23] id="([^"]+)"/g)].map((match) => match[1]!);
	const id = ids[Math.floor(ids.length * 0.6)];
	if (!id) problems.push(`${target.path} has no heading to link to`);
	else {
		const href = `${target.path}#${id}`;
		await page.evaluate((to) => {
			const a = document.createElement("a");
			a.href = to;
			a.textContent = "A heading of another page";
			a.className = "check-heading-link";
			document.querySelector("article")!.append(a);
		}, href);
		await page.evaluate(() => ((window as unknown as { __document: boolean }).__document = true));
		requests.length = 0;
		await page.locator("a.check-heading-link").click();
		await page.waitForURL((url) => url.pathname === target.path, { timeout: 5_000 }).catch(() => {});
		await page.waitForTimeout(200);
		const now = await page.evaluate((id) => {
			const heading = document.getElementById(id);
			return {
				same: (window as unknown as { __document?: boolean }).__document === true,
				top: heading ? Math.round(heading.getBoundingClientRect().top) : null,
				focus: !!heading && document.activeElement === heading,
			};
		}, id);
		const made = requests.filter((url) => chunkOf(url) === chunkName(target.path) || chunkOf(url) === null);
		if (!now.same) problems.push(`${href}: a new document was loaded`);
		else if (now.top === null || now.top < -2 || now.top > 40) problems.push(`${href}: the heading is at ${now.top} px from the top of the window, not at its top`);
		else if (!now.focus) problems.push(`${href}: the keyboard focus is not on the heading`);
		else if (made.length > 0) problems.push(`${href}: ${made.length} request(s): ${made.join(", ")}`);
		else passed.push(`a link from ${meta.path} to ${href} changed the page in place and left the heading at the top of the window, ${now.top} px, with the focus on it`);
	}
	problems.push(...[...new Set(seen.problems)].map((p) => `the documentation: ${p}`));
	await ctx.close();

	// A click to a page whose chunk the host no longer has (a deploy since the tab opened replaced
	// it): the browser loads the page whole, from the new deploy, with no uncaught error, rather than
	// the router stopping on the failed import. The host refuses the chunk until the page is asked
	// for as a document.
	const gone = all.find((page) => page.path === GONE_PAGE);
	if (!gone?.markdown) problems.push(`check 8 makes ${GONE_PAGE}'s chunk fail, and it is not a documentation page of the site`);
	else {
		const where = `a click from ${meta.path} to ${gone.path}, its chunk gone`;
		const later = await context(browser, SIZES[0]!, "light");
		const tab = await later.newPage();
		const errors: string[] = [];
		tab.on("pageerror", (error) => errors.push(error.message));
		const pattern = `**/assets/${chunkName(gone.path)}-*.js`;
		await tab.route(pattern, (route) => route.fulfill({ status: 404, body: "Not found" }));
		let asDocument = false;
		tab.on("request", (request) => {
			if (!request.isNavigationRequest() || new URL(request.url()).pathname !== gone.path) return;
			asDocument = true;
			void tab.unroute(pattern);
		});
		await tab.goto(`${origin}${meta.path}`, { waitUntil: "load" });
		await tab.waitForFunction(() => performance.getEntriesByName("hydrated").length > 0, null, { timeout: 10_000 }).catch(() => {});
		await tab.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
		await tab.locator(`nav.pages a[href="${gone.path}"]`).click();
		await tab.waitForURL((url) => url.pathname === gone.path, { timeout: 10_000 }).catch(() => {});
		await tab.waitForLoadState("load").catch(() => {});
		await tab.waitForFunction(() => performance.getEntriesByName("hydrated").length > 0, null, { timeout: 10_000 }).catch(() => {});
		const title = await tab.title();
		if (!asDocument) problems.push(`${where}: the page was not loaded as a new document`);
		else if (title !== gone.title) problems.push(`${where}: the title is ${JSON.stringify(title)}, not ${JSON.stringify(gone.title)}`);
		else if (errors.length > 0) problems.push(`${where}: uncaught error(s): ${[...new Set(errors)].join("; ")}`);
		else passed.push(`a click to ${gone.path}, whose chunk the host refused, loaded the page as a new document, with no uncaught error`);
		await later.close();
	}

	// With JavaScript off: "View as Markdown", and no "Copy page", which would do nothing.
	const off = await context(browser, SIZES[0]!, "light", false);
	const plain = await off.newPage();
	await plain.goto(`${origin}${meta.path}`, { waitUntil: "load" });
	const copyShown = await plain.locator("button.copy").isVisible();
	const viewShown = await plain.locator(".doc-actions a").isVisible();
	if (copyShown) problems.push(`with JavaScript off, ${meta.path} shows "Copy page", which needs JavaScript`);
	if (!viewShown) problems.push(`with JavaScript off, ${meta.path} does not show "View as Markdown"`);
	if (!copyShown && viewShown) passed.push(`with JavaScript off, ${meta.path} shows "View as Markdown" and not "Copy page"`);
	await off.close();
	return { problems, passed };
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
