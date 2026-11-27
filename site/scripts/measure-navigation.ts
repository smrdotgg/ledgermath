/**
 * Measures, in real browsers, what a click inside the site costs and what the first load costs:
 * run by hand, to answer "is navigation instant?" with numbers and their spread. Nothing here is
 * a check: it asserts nothing and fails on no figure (ADR-0036).
 *
 *     bun scripts/measure-navigation.ts [--loads N] [--clicks N] [--browsers chromium,firefox,webkit] [--cpu N] [--first PATH] [--cycle PATH,PATH,…] TARGET...
 *
 * A TARGET is a built site's directory (served here, as a static host would, uncompressed) or a
 * site's address (https://ledgermath.com, a preview's), and may end in @PATH, the page its first
 * loads are of instead of --first's (dist/client@/docs/api/series). For each browser:
 *
 *  - N first loads of PATH (--first, default /) per target (default 1), each in a new browser
 *    context (empty cache), taking turns between the targets, so that the machine's own drift
 *    falls on all of them alike: the bytes each response brought (HTML, CSS, fonts, JavaScript,
 *    the page's own chunk, and apart, the chunks of other documentation pages that the router
 *    loads ahead, as the server sent them: compressed from a host that compresses, not from the
 *    directory server here; Firefox and WebKit report them decompressed), the first paint (Paint
 *    Timing's first-contentful-paint), DOMContentLoaded, and, with the application, when it had
 *    taken over (src/app.tsx's mark "hydrated"; a click before then is an ordinary navigation),
 *    and so how long after the first paint that was.
 *  - N clicks (default 30) through the pages of --cycle (default /,/docs/), round and round, each
 *    on the first link on the page to the next that the router takes (no target), with the
 *    mouse, as Playwright gives it, after what the router loads ahead has come. For each: the time
 *    from the click event (its timeStamp) to the first change of the document's body, and to the
 *    next frame after it (a requestAnimationFrame callback, then a message posted from it: the
 *    frame has been produced by then); and the requests the click caused for the page it shows
 *    (the chunks the router then loads ahead for the new page's links are counted apart). When the
 *    click loads a new document (an ordinary navigation, as on a site without the application),
 *    the times are taken from the new document instead: to its first byte (responseStart), to
 *    DOMContentLoaded, and to its first paint, measured from the click on the same clock
 *    (performance.timeOrigin).
 *
 * --cpu N slows Chromium's CPU N times (DevTools' throttling), as a slower phone would be.
 * --clicks 0 measures the first loads alone. Each figure is given as min, median, 90th
 * percentile and max over the loads or the clicks.
 *
 * Firefox and WebKit are Playwright's (bunx playwright install firefox webkit).
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };

function option(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const value = argv[i + 1];
	argv.splice(i, 2);
	return value;
}

/** Serves DIR as a static host would: a directory's index.html for the directory, 404 for anything else. */
function serve(dir: string): { origin: string; stop(): void } {
	const root = resolve(dir);
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const path = decodeURIComponent(new URL(request.url).pathname);
			let file = resolve(root, `.${path}`);
			if (file !== root && !file.startsWith(`${root}/`)) return new Response("Not found", { status: 404 });
			if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
			if (!existsSync(file)) return new Response("Not found", { status: 404 });
			return new Response(Bun.file(file));
		},
	});
	return { origin: server.url.href.replace(/\/$/, ""), stop: () => server.stop(true) };
}

const stats = (all: number[]) => {
	const values = all.filter((v) => Number.isFinite(v));
	if (values.length === 0) return "n/a";
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	const f = (v: number) => v.toFixed(1);
	return `min ${f(sorted[0]!)}  median ${f(at(0.5))}  p90 ${f(at(0.9))}  max ${f(sorted[sorted.length - 1]!)} ms  (n=${values.length})`;
};

type FirstLoad = { bytes: Record<string, number>; fcp: number | null; dcl: number; load: number; hydrated: number | null };

/** The documentation page a chunk holds, by the chunk's name (scripts/docs.ts, chunkName), or null for any other file. */
const chunkOf = (path: string): string | null => /\/assets\/(docs[\w.-]*?)-[\w-]{8}\.js$/.exec(path)?.[1] ?? null;
/** A documentation page's chunk name, as scripts/docs.ts makes it. */
const chunkName = (address: string): string => address.replace(/^\/|\/$/g, "").replaceAll("/", "-");

async function firstLoad(browser: Browser, origin: string, cpu: number, path: string): Promise<FirstLoad> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	await throttle(page, cpu);
	const responses: Promise<{ type: string; bytes: number }>[] = [];
	const mine = chunkName(path);
	page.on("requestfinished", (request) => {
		responses.push(
			request.sizes().then((sizes) => {
				const url = new URL(request.url()).pathname;
				const chunk = chunkOf(url);
				const type = /\.css$/.test(url) ? "css" : /\.woff2$/.test(url) ? "fonts" : chunk !== null && chunk !== mine ? "loaded ahead" : /\.m?js$/.test(url) ? "javascript" : request.resourceType() === "document" ? "html" : "other";
				return { type, bytes: sizes.responseBodySize + sizes.responseHeadersSize };
			}),
		);
	});
	await page.goto(`${origin}${path}`, { waitUntil: "load" });
	await page.waitForLoadState("networkidle").catch(() => {});
	// With the application (a module script), wait until it has taken over.
	if (await page.evaluate(() => document.querySelector('script[type="module"]') !== null)) {
		await page.waitForFunction(() => performance.getEntriesByName("hydrated").length > 0, null, { timeout: 10_000 }).catch(() => {});
	}
	const timing = await page.evaluate(async () => {
		const fcp = await new Promise<number | null>((done) => {
			const found = performance.getEntriesByName("first-contentful-paint")[0];
			if (found) return done(found.startTime);
			try {
				new PerformanceObserver((list) => done(list.getEntries()[0]?.startTime ?? null)).observe({ type: "paint", buffered: true });
			} catch {
				done(null);
			}
			setTimeout(() => done(null), 3000);
		});
		const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
		const hydrated = performance.getEntriesByName("hydrated")[0]?.startTime ?? null;
		return { fcp, dcl: nav.domContentLoadedEventStart, load: nav.loadEventStart, hydrated };
	});
	const bytes: Record<string, number> = {};
	for (const r of await Promise.all(responses)) bytes[r.type] = (bytes[r.type] ?? 0) + r.bytes;
	await context.close();
	return { bytes, ...timing };
}

/** Slows Chromium's CPU N times; the other engines have no such switch. */
async function throttle(page: Page, cpu: number): Promise<void> {
	if (cpu <= 1) return;
	const session = await page.context().newCDPSession(page);
	await session.send("Emulation.setCPUThrottlingRate", { rate: cpu });
}

type Click = { kind: "in-page" | "new document"; to: string; requests: number; toChange: number; toFrame: number; toFirstByte?: number };

async function clicks(browser: Browser, origin: string, count: number, cpu: number, cycle: readonly string[]): Promise<Click[]> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	await throttle(page, cpu);
	let made: string[] = [];
	let inflight = 0;
	page.on("request", (request) => {
		made.push(new URL(request.url()).pathname);
		inflight++;
	});
	page.on("requestfinished", () => inflight--);
	page.on("requestfailed", () => inflight--);
	/** Until no request has been under way for 300 ms: what the router loads ahead has come. */
	const idle = async () => {
		for (let quiet = 0, step = 0; quiet < 3 && step < 100; step++) {
			await page.waitForTimeout(100);
			quiet = inflight === 0 ? quiet + 1 : 0;
		}
	};
	await page.goto(`${origin}${cycle[0]}`, { waitUntil: "load" });
	await page.waitForLoadState("networkidle").catch(() => {});
	await page.waitForTimeout(300);
	const out: Click[] = [];
	for (let i = 0; i < count; i++) {
		const destination = cycle[(i + 1) % cycle.length]!;
		const selector = `a[href="${destination}"]:not([target])`;
		await idle();
		await page.evaluate(() => {
			const w = window as unknown as { __m: Record<string, number> | undefined; __document: number | undefined };
			w.__document = w.__document ?? Math.random();
			const m: Record<string, number> = {};
			w.__m = m;
			document.addEventListener(
				"click",
				(e) => {
					m.click = e.timeStamp;
					sessionStorage.setItem("clickAt", String(performance.timeOrigin + e.timeStamp));
				},
				{ capture: true, once: true },
			);
			const observer = new MutationObserver(() => {
				observer.disconnect();
				m.change = performance.now();
				requestAnimationFrame(() => {
					const channel = new MessageChannel();
					channel.port1.onmessage = () => (m.frame = performance.now());
					channel.port2.postMessage(0);
				});
			});
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });
		});
		const marker = await page.evaluate(() => (window as unknown as { __document: number }).__document);
		made = [];
		await page.locator(selector).first().click();
		await page.waitForURL((url) => url.pathname === destination);
		await page.waitForFunction(() => {
			const w = window as unknown as { __m?: Record<string, number> };
			return document.readyState === "complete" && (!w.__m || w.__m.frame !== undefined);
		});
		// The requests for the page shown: not the chunks of other pages, loaded ahead for its links.
		const requests = made.filter((path) => {
			const chunk = chunkOf(path);
			return chunk === null || chunk === chunkName(destination);
		}).length;
		const same = await page.evaluate((m) => (window as unknown as { __document?: number }).__document === m, marker).catch(() => false);
		if (same) {
			const m = await page.evaluate(() => (window as unknown as { __m: Record<string, number> }).__m);
			await page.waitForTimeout(150);
			out.push({ kind: "in-page", to: destination, requests, toChange: m.change! - m.click!, toFrame: m.frame! - m.click! });
		} else {
			// A new document: its own timings, on the click's clock.
			const t = await page.evaluate(async () => {
				const clickAt = Number(sessionStorage.getItem("clickAt"));
				const fcp = await new Promise<number>((done) => {
					const found = performance.getEntriesByName("first-contentful-paint")[0];
					if (found) return done(found.startTime);
					try {
						new PerformanceObserver((list) => done(list.getEntries()[0]!.startTime)).observe({ type: "paint", buffered: true });
					} catch {}
					setTimeout(() => done(Number.NaN), 3000);
				});
				const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
				const from = (t: number) => performance.timeOrigin + t - clickAt;
				return { toFirstByte: from(nav.responseStart), toChange: from(nav.domContentLoadedEventStart), toFrame: from(fcp) };
			});
			await page.waitForLoadState("networkidle").catch(() => {});
			await page.waitForTimeout(150);
			out.push({ kind: "new document", to: destination, requests, ...t });
		}
	}
	await context.close();
	return out;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const count = Number(option(argv, "clicks") ?? 30);
	const engines = (option(argv, "browsers") ?? "chromium,firefox,webkit").split(",");
	const cpu = Number(option(argv, "cpu") ?? 1);
	const loadCount = Number(option(argv, "loads") ?? 1);
	const first = option(argv, "first") ?? "/";
	const cycle = (option(argv, "cycle") ?? "/,/docs/").split(",");
	const targets = argv.map((given) => {
		const at = given.lastIndexOf("@/");
		const [target, path] = at < 0 ? [given, first] : [given.slice(0, at), given.slice(at + 1)];
		const local = !/^https?:/.test(target);
		const server = local ? serve(target) : null;
		return { target, path, local, server, origin: server ? server.origin : target.replace(/\/$/, "") };
	});
	for (const name of engines) {
		const engine = ENGINES[name];
		if (!engine) throw new Error(`no browser ${name}: chromium, firefox or webkit`);
		if (cpu > 1 && name !== "chromium") continue;
		const browser = await engine.launch();
		try {
			// The first loads, taking turns between the targets.
			const loads = targets.map(() => [] as FirstLoad[]);
			for (let i = 0; i < loadCount; i++) for (const [t, { origin, path }] of targets.entries()) loads[t]!.push(await firstLoad(browser, origin, cpu, path));
			for (const [t, { target, path, local, origin }] of targets.entries()) {
				const these = loads[t]!;
				const load = these[0]!;
				console.log(`\n${target} in ${name}${cpu > 1 ? ` (CPU slowed ${cpu}x)` : ""}${local ? " (served uncompressed from the directory)" : ""}`);
				console.log(`  first load of ${path}: ${Object.entries(load.bytes).map(([k, v]) => `${k} ${v.toLocaleString("en")}`).join(", ")} bytes as sent`);
				console.log(`    first paint:              ${stats(these.map((l) => l.fcp ?? Number.NaN))}`);
				console.log(`    DOMContentLoaded:         ${stats(these.map((l) => l.dcl))}`);
				if (these.some((l) => l.hydrated !== null)) {
					console.log(`    application took over:    ${stats(these.map((l) => l.hydrated ?? Number.NaN))}`);
					console.log(`    ... after the first paint: ${stats(these.map((l) => (l.hydrated ?? Number.NaN) - (l.fcp ?? Number.NaN)))}`);
				}
				if (count === 0) continue;
				const measured = await clicks(browser, origin, count, cpu, cycle);
				for (const kind of ["in-page", "new document"] as const) {
					for (const to of [...new Set(cycle)]) {
						const of = measured.filter((c) => c.kind === kind && c.to === to);
						if (of.length === 0) continue;
						console.log(`  ${of.length} clicks to ${to}, ${kind === "in-page" ? "the page changed in place (no new document)" : "each loaded a new document"}; requests per click: ${[...new Set(of.map((c) => c.requests))].sort().join(" or ")}`);
						if (kind === "new document") console.log(`    click to first byte:       ${stats(of.map((c) => c.toFirstByte!))}`);
						console.log(`    click to ${kind === "in-page" ? "body changed:      " : "DOMContentLoaded:  "} ${stats(of.map((c) => c.toChange))}`);
						console.log(`    click to ${kind === "in-page" ? "next frame:        " : "first paint:       "} ${stats(of.map((c) => c.toFrame))}`);
					}
				}
			}
		} finally {
			await browser.close();
		}
	}
	for (const { server } of targets) server?.stop();
}
