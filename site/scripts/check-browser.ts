/**
 * The checks a browser makes of the built site: by the `site` workflow's build job on every pull
 * request and push to main, and by hand (the six-hourly rebuild runs no browser).
 *
 *     bun run check:browser [DIR] [--shots OUT]     (DIR defaults to dist/client)
 *
 * It serves DIR as a static host would and loads each page (src/pages.text.ts) in Playwright's
 * Chromium at desktop size (1440×900) and phone size (390×844, at a device scale of 2), each in
 * light and in dark, with reduced motion. A page with feature flags is loaded again with each
 * flag on (as /?napkin), which must set the flag on <html>, for checks 1 to 3 and 6:
 *
 *  1. No console error, no uncaught error, no request that fails or answers 400 or more, and
 *     no request to another origin (each is refused, and counted).
 *  2. No horizontal scroll at 390 px wide (a wide table may scroll inside its own box).
 *  3. axe-core finds no violation of its WCAG 2.0 and 2.1 A and AA rules (colour contrast among
 *     them) or of its structure rules (one main landmark, one h1, headings in order, all content
 *     in landmarks, unique landmarks).
 *  4. What the page transfers at desktop size (HTML, CSS, fonts, JavaScript, anything else) is
 *     under BUDGET_BYTES compressed: text files weighed gzipped at level 9, others as they are.
 *  5. With JavaScript off the page reads the same: every line of text holding a digit that it
 *     shows with JavaScript on, it shows with JavaScript off.
 *  6. Hydration changes nothing on the page: once the HTML is parsed, no element or text of the
 *     body is added, removed or changed while the application takes over (a structural mismatch
 *     would replace or patch them), but for the attributes the router derives from the address,
 *     which the build cannot know (aria-current, data-active, target: ADR-0036). Words that
 *     differ are not changed by hydration, so check 7 compares them.
 *  7. Navigation, at desktop size in light (ADR-0036). From each page a click on a link to the
 *     next (the last to the first) changes the page in place: no request, no new document, the
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
 *     left. With JavaScript
 *     off the same links are ordinary links, each loading its page as a new document. The time
 *     from each click to the next frame is printed, not judged: a slow runner is slow.
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
import { BUDGET_BYTES, missingText } from "./check-output";

/** The attributes the router sets from the browser's address, which hydration may change (check 6). */
const ADDRESS_ATTRIBUTES = new Set(["aria-current", "data-active", "target"]);

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
	const hydration: string[] = [];
	let moves: { problems: string[]; timings: string[] } = { problems: [], timings: [] };
	try {
		for (const meta of PAGES) {
			const url = `${server.origin}${meta.path}`;
			const name = meta.path === "/" ? "home" : meta.path.replace(/^\/|\/$/g, "").replaceAll("/", "-");
			let withScripts = "";
			// The page as everyone gets it, then once with each of its flags on.
			const addresses: { path: string; name: string; flag?: string }[] = [
				{ path: meta.path, name },
				...(meta.flags ?? []).map((flag) => ({ path: `${meta.path}?${flag}`, name: `${name}-${flag}`, flag })),
			];
			for (const { address, size } of addresses.flatMap((address) => SIZES.map((size) => ({ address, size })))) {
				for (const scheme of SCHEMES) {
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
					hydration.push(...(await hydrationChanges(page)).map((p) => `${where}: ${p}`));

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
							await page.screenshot({ path: join(shots, `${address.name}-${size.name}-${scheme}-${full ? "full" : "first"}.png`), fullPage: full, animations: "disabled", caret: "hide" });
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
		moves = await navigation(browser, server.origin, root);
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
		{ name: "hydration changes nothing on the page", problems: hydration, passed: `${pages}: no element or text of the body added, removed or changed, at either size, in light or dark, with each flag` },
		{
			name: "navigation inside the site: in place, with no request",
			problems: moves.problems,
			passed: `each click changed the page in place, with no request and no new document, to the page the build wrote for the address, at its top, its title and words, the focus at the top and the title announced, with no axe violation; back and forward the same, each page scrolled to where it was left; with JavaScript off each link loaded its page. From the click to the next frame (not judged): ${moves.timings.join("; ")}`,
		},
	];
}

/** Check 7: navigation inside the site, with JavaScript on and then off (see the comment at the top). */
async function navigation(browser: Browser, origin: string, root: string): Promise<{ problems: string[]; timings: string[] }> {
	const problems: string[] = [];
	const timings: string[] = [];
	const first = PAGES[0]!;
	// From each page to the next, the last back to the first.
	const order = [...PAGES.slice(1), first];
	const linkTo = (page: Page, meta: SitePage) => page.locator(`a[href="${meta.path}"]:not([target])`).first();

	// Short, so that every page scrolls and back and forward have positions to restore.
	const ctx = await context(browser, { ...SIZES[0]!, height: 400 }, "light");
	const page = await ctx.newPage();
	const seen = watch(page, origin, false);
	const requests: string[] = [];
	page.on("request", (request) => requests.push(request.url().replace(origin, "")));
	await page.goto(`${origin}${first.path}`, { waitUntil: "load" });
	await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
	await page.evaluate(() => ((window as unknown as { __document: boolean }).__document = true));
	const sameDocument = () => page.evaluate(() => (window as unknown as { __document?: boolean }).__document === true).catch(() => false);

	/** What must hold of the page on screen once a click, or a step back or forward, has brought META. */
	const shows = async (where: string, meta: SitePage, clicked: boolean) => {
		if (!(await sameDocument())) return void problems.push(`${where}: a new document was loaded`);
		if (requests.length > 0) problems.push(`${where}: ${requests.length} request(s): ${requests.join(", ")}`);
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
	return { problems, timings };
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
