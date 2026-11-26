/**
 * Measures, in real browsers, what a click inside the site costs and what the first load costs:
 * run by hand, to answer "is navigation instant?" with numbers and their spread. Nothing here is
 * a check: it asserts nothing and fails on no figure (ADR-0036).
 *
 *     bun scripts/measure-navigation.ts [--clicks N] [--browsers chromium,firefox,webkit] [--cpu N] TARGET...
 *
 * A TARGET is a built site's directory (served here, as a static host would, uncompressed) or a
 * site's address (https://ledgermath.com, a preview's). For each target and browser:
 *
 *  - The first load of / in a new browser context (empty cache): the bytes each response brought
 *    (HTML, CSS, fonts, JavaScript, as the server sent them: compressed from a host that
 *    compresses, not from the directory server here), the first paint (Paint Timing's
 *    first-contentful-paint), and DOMContentLoaded, by which a page's module script has run:
 *    with the application, Solid has hydrated the page and the router is in place by then, so a
 *    click before it is an ordinary navigation.
 *  - N clicks (default 30), alternating between the header's "Docs" on / and its "LedgerMath" on
 *    /docs/, each with the mouse, as Playwright gives it. For each: the time from the click event
 *    (its timeStamp) to the first change of the document's body, and to the next frame after it
 *    (a requestAnimationFrame callback, then a message posted from it: the frame has been
 *    produced by then); and the requests the click caused. When the click loads a new document
 *    (an ordinary navigation, as on a site without the application), the times are taken from
 *    the new document instead: to its first byte (responseStart), to DOMContentLoaded, and to its
 *    first paint, measured from the click on the same clock (performance.timeOrigin).
 *
 * --cpu N slows Chromium's CPU N times (DevTools' throttling), as a slower phone would be.
 * Each figure is given as min, median, 90th percentile and max over the clicks.
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

type FirstLoad = { bytes: Record<string, number>; fcp: number | null; dcl: number; load: number };

async function firstLoad(browser: Browser, origin: string, cpu: number): Promise<FirstLoad> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	await throttle(page, cpu);
	const responses: Promise<{ type: string; bytes: number }>[] = [];
	page.on("requestfinished", (request) => {
		responses.push(
			request.sizes().then((sizes) => {
				const url = new URL(request.url()).pathname;
				const type = /\.css$/.test(url) ? "css" : /\.woff2$/.test(url) ? "fonts" : /\.m?js$/.test(url) ? "javascript" : request.resourceType() === "document" ? "html" : "other";
				return { type, bytes: sizes.responseBodySize + sizes.responseHeadersSize };
			}),
		);
	});
	await page.goto(`${origin}/`, { waitUntil: "load" });
	await page.waitForLoadState("networkidle").catch(() => {});
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
		return { fcp, dcl: nav.domContentLoadedEventStart, load: nav.loadEventStart };
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

async function clicks(browser: Browser, origin: string, count: number, cpu: number): Promise<Click[]> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	await throttle(page, cpu);
	let requests = 0;
	page.on("request", () => requests++);
	await page.goto(`${origin}/`, { waitUntil: "load" });
	await page.waitForLoadState("networkidle").catch(() => {});
	await page.waitForTimeout(300);
	const out: Click[] = [];
	for (let i = 0; i < count; i++) {
		const onHome = new URL(page.url()).pathname === "/";
		const selector = onHome ? 'header a[href="/docs/"]' : "header a.mark";
		const destination = onHome ? "/docs/" : "/";
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
		requests = 0;
		await page.click(selector);
		await page.waitForURL((url) => url.pathname === destination);
		await page.waitForFunction(() => {
			const w = window as unknown as { __m?: Record<string, number> };
			return document.readyState === "complete" && (!w.__m || w.__m.frame !== undefined);
		});
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
	for (const target of argv) {
		const local = !/^https?:/.test(target);
		const server = local ? serve(target) : null;
		const origin = server ? server.origin : target.replace(/\/$/, "");
		for (const name of engines) {
			const engine = ENGINES[name];
			if (!engine) throw new Error(`no browser ${name}: chromium, firefox or webkit`);
			if (cpu > 1 && name !== "chromium") continue;
			const browser = await engine.launch();
			try {
				const load = await firstLoad(browser, origin, cpu);
				const measured = await clicks(browser, origin, count, cpu);
				console.log(`\n${target} in ${name}${cpu > 1 ? ` (CPU slowed ${cpu}x)` : ""}${local ? " (served uncompressed from the directory)" : ""}`);
				console.log(`  first load of /: ${Object.entries(load.bytes).map(([k, v]) => `${k} ${v.toLocaleString("en")}`).join(", ")} bytes as sent; first paint ${load.fcp?.toFixed(1) ?? "n/a"} ms, DOMContentLoaded ${load.dcl.toFixed(1)} ms, load ${load.load.toFixed(1)} ms`);
				for (const kind of ["in-page", "new document"] as const) {
					for (const to of ["/docs/", "/"]) {
						const of = measured.filter((c) => c.kind === kind && c.to === to);
						if (of.length === 0) continue;
						console.log(`  ${of.length} clicks to ${to}, ${kind === "in-page" ? "the page changed in place (no new document)" : "each loaded a new document"}; requests per click: ${[...new Set(of.map((c) => c.requests))].sort().join(" or ")}`);
						if (kind === "new document") console.log(`    click to first byte:       ${stats(of.map((c) => c.toFirstByte!))}`);
						console.log(`    click to ${kind === "in-page" ? "body changed:      " : "DOMContentLoaded:  "} ${stats(of.map((c) => c.toChange))}`);
						console.log(`    click to ${kind === "in-page" ? "next frame:        " : "first paint:       "} ${stats(of.map((c) => c.toFrame))}`);
					}
				}
			} finally {
				await browser.close();
			}
		}
		server?.stop();
	}
}
