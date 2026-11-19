/**
 * The browser side of shots.ts and check.ts: Playwright's Chromium, the two sizes every
 * screenshot is taken at, a way to let a page settle before a screenshot, and a watch on what a
 * page logs and loads.
 *
 * Chromium is Playwright's, installed once with `bunx playwright install chromium` inside site/.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildPage, serveDir, SITE, type Slot } from "./lib";

export type Size = { name: "desktop" | "phone"; width: number; height: number; deviceScaleFactor: number; isMobile: boolean };

/** Desktop 1440×900 and phone 390×844, in CSS pixels; the phone at a device scale of 2, as a phone draws it. */
export const SIZES: readonly Size[] = [
	{ name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false },
	{ name: "phone", width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
];

export type Scheme = "light" | "dark";
export const SCHEMES: readonly Scheme[] = ["light", "dark"];

export async function launch(): Promise<Browser> {
	try {
		return await chromium.launch();
	} catch (error) {
		throw new Error(`Chromium did not start; install it once with \`bunx playwright install chromium\` in site/.\n${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function newContext(
	browser: Browser,
	size: Size,
	options: { colorScheme: Scheme | "no-preference"; javaScriptEnabled?: boolean },
): Promise<BrowserContext> {
	return browser.newContext({
		viewport: { width: size.width, height: size.height },
		deviceScaleFactor: size.deviceScaleFactor,
		isMobile: size.isMobile,
		hasTouch: size.isMobile,
		colorScheme: options.colorScheme,
		javaScriptEnabled: options.javaScriptEnabled ?? true,
		reducedMotion: "reduce",
	});
}

/** What went wrong while a page loaded: console errors, uncaught errors, failed or refused requests. */
export type Watch = { problems: string[]; responses: { url: string; status: number; contentType: string; body: Buffer | null }[] };

/**
 * Watches PAGE. With `origin`, every request to another origin is refused and counted as a
 * problem (data: and blob: URLs are the page's own). With `keepBodies`, keeps each response's
 * body, to weigh the page.
 */
export function watchPage(page: Page, options: { origin?: string; keepBodies?: boolean } = {}): Watch {
	const watch: Watch = { problems: [], responses: [] };
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		// A request refused below also logs this; it is counted once, as the refused request.
		if (options.origin && message.text().includes("net::ERR_BLOCKED_BY_CLIENT")) return;
		watch.problems.push(`console error: ${message.text()}`);
	});
	page.on("pageerror", (error) => watch.problems.push(`uncaught error: ${error.message}`));
	page.on("requestfailed", (request) => {
		if (options.origin && !sameOrigin(request.url(), options.origin)) return; // refused below, counted there
		watch.problems.push(`request failed: ${request.url()} (${request.failure()?.errorText ?? "no reason given"})`);
	});
	page.on("response", async (response) => {
		const url = response.url();
		if (response.status() >= 400) watch.problems.push(`HTTP ${response.status()}: ${url}`);
		if (!options.keepBodies || url.startsWith("data:")) return;
		let body: Buffer | null = null;
		try {
			body = await response.body();
		} catch {}
		watch.responses.push({ url, status: response.status(), contentType: response.headers()["content-type"] ?? "", body });
	});
	if (options.origin) {
		const origin = options.origin;
		void page.route("**/*", (route) => {
			const url = route.request().url();
			if (sameOrigin(url, origin)) return route.continue();
			watch.problems.push(`request to another origin, refused: ${url}`);
			return route.abort("blockedbyclient");
		});
	}
	return watch;
}

function sameOrigin(url: string, origin: string): boolean {
	if (/^(data|blob|about):/i.test(url)) return true;
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

/**
 * Lets the page settle before a screenshot: the network idle (up to 10 s), a scroll to the end
 * and back so lazy content loads, fonts loaded, images decoded, and the page's height unchanged
 * over two checks 250 ms apart (up to 5 s).
 */
export async function settle(page: Page): Promise<void> {
	await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
	await page
		.evaluate(async () => {
			const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
			for (let y = 0; y < document.documentElement.scrollHeight; y += Math.max(200, window.innerHeight * 0.8)) {
				window.scrollTo(0, y);
				await pause(60);
			}
			window.scrollTo(0, 0);
		})
		.catch(() => {});
	await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
	await page
		.evaluate(async () => {
			await document.fonts.ready;
			await Promise.all(
				[...document.images].map((image) =>
					image.complete ? image.decode().catch(() => {}) : new Promise((resolve) => image.addEventListener("loadend", resolve, { once: true })),
				),
			);
			const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
			let last = -1;
			for (let i = 0; i < 20; i++) {
				await frame();
				await frame();
				await new Promise((resolve) => setTimeout(resolve, 250));
				const height = document.documentElement.scrollHeight;
				if (height === last) break;
				last = height;
			}
		})
		.catch(() => {});
}

/** Chromium cannot capture an image taller than this many device pixels in one piece. */
const TALLEST_CAPTURE = 16_384;

/**
 * Takes a screenshot of the first screen, or of the full page. A page too tall for Chromium to
 * capture whole is captured from the top down to the limit; the note returned says so.
 */
export async function screenshot(page: Page, path: string, fullPage: boolean): Promise<string | null> {
	try {
		await page.screenshot({ path, fullPage, animations: "disabled", caret: "hide" });
		return null;
	} catch (error) {
		if (!fullPage) throw error;
		const { width, height, scale } = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, scale: window.devicePixelRatio }));
		const tallest = Math.floor(TALLEST_CAPTURE / scale);
		await page.screenshot({ path, fullPage: true, clip: { x: 0, y: 0, width, height: Math.min(height, tallest) }, animations: "disabled", caret: "hide" });
		return `${path.split("/").pop()}: the page is ${height} px tall, more than Chromium captures at once; cut at ${tallest} px`;
	}
}

/** Builds SLOT into a temporary directory and serves it; `url` is the design's page, `origin` the server's. */
export async function buildAndServe(slot: Slot): Promise<{ url: string; origin: string; out: string; stop(): void }> {
	mkdirSync(join(SITE, "dist"), { recursive: true });
	const root = mkdtempSync(join(SITE, "dist", `.serve-${slot}-`));
	const out = join(root, slot);
	try {
		await buildPage(slot, { out, base: `/${slot}/`, quiet: true });
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	const server = serveDir(root);
	return {
		url: `${server.url}/${slot}/`,
		origin: server.url,
		out,
		stop() {
			server.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
