/**
 * Screenshots of one design, the same way for every worker and every judge.
 *
 *     bun run shots v3 [--out DIR]                  (DIR defaults to dist/shots/v3)
 *
 * Builds the design on its own, serves it locally, and writes eight PNGs to DIR, always with
 * these names:
 *
 *     desktop-light-first.png   desktop-light-full.png   desktop-dark-first.png   desktop-dark-full.png
 *     phone-light-first.png     phone-light-full.png     phone-dark-first.png     phone-dark-full.png
 *
 * desktop is 1440×900 CSS pixels at a device scale of 1; phone is 390×844 at a scale of 2.
 * light and dark set prefers-color-scheme. first is the first screen, full the whole page.
 * Before each screenshot the page settles: network idle, a scroll to the end and back, fonts
 * loaded, images decoded, its height steady. Beside the PNGs, shots.json records the design,
 * the commit and whether the design's files had uncommitted changes, the files, and any problem.
 *
 * Exit 1 if the design does not build, or the page logs a console error, throws, fails to
 * load a resource, or asks for anything from another origin (the screenshots are still written
 * when it loads at all).
 *
 *     bun run shots --url https://example.com --out DIR
 *
 * The same sizes for any public page, in the page's own default colour scheme (no
 * prefers-color-scheme), first screen and full page: desktop-first.png, desktop-full.png,
 * phone-first.png, phone-full.png. What the page logs is reported, not judged; exit 1 only
 * if the page does not load.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildAndServe, launch, newContext, SCHEMES, screenshot, settle, SIZES, watchPage } from "./browser";
import { isSlot, parseArgs, SITE, SLOTS, type Slot } from "./lib";

const USAGE = "usage: bun run shots v<1-8> [--out DIR]\n       bun run shots --url URL --out DIR";

function git(args: string[]): string | null {
	const result = Bun.spawnSync(["git", ...args], { cwd: SITE, stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

async function shootDesign(slot: Slot, out: string): Promise<number> {
	mkdirSync(out, { recursive: true });
	const commit = git(["rev-parse", "HEAD"]);
	const dirty = (git(["status", "--porcelain", "--", `src/variations/${slot}`, "src/data", "data"]) ?? "") !== "";
	const problems: string[] = [];
	const files: string[] = [];
	let served: Awaited<ReturnType<typeof buildAndServe>>;
	try {
		served = await buildAndServe(slot);
	} catch (error) {
		console.error(`${slot} does not build:\n${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const browser = await launch();
	try {
		for (const size of SIZES) {
			for (const scheme of SCHEMES) {
				const context = await newContext(browser, size, { colorScheme: scheme });
				const page = await context.newPage();
				const watch = watchPage(page, { origin: served.origin });
				const response = await page.goto(served.url, { waitUntil: "load" });
				if (!response || response.status() !== 200) problems.push(`${size.name} ${scheme}: the page answered ${response?.status() ?? "nothing"}`);
				await settle(page);
				for (const [part, full] of [
					["first", false],
					["full", true],
				] as const) {
					const name = `${size.name}-${scheme}-${part}.png`;
					await screenshot(page, join(out, name), full);
					files.push(name);
				}
				problems.push(...[...new Set(watch.problems)].map((p) => `${size.name} ${scheme}: ${p}`));
				await context.close();
			}
		}
	} finally {
		await browser.close();
		served.stop();
	}
	writeFileSync(
		join(out, "shots.json"),
		`${JSON.stringify({ design: slot, commit, dirty, taken_at: new Date().toISOString(), sizes: SIZES, files, problems }, null, "\t")}\n`,
	);
	console.log(`${slot}: ${files.length} screenshots in ${relative(process.cwd(), out) || "."}${commit ? ` (commit ${commit.slice(0, 12)}${dirty ? ", with uncommitted changes to the design" : ""})` : ""}`);
	if (problems.length > 0) {
		console.error(`${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
		for (const problem of problems) console.error(`  ${problem}`);
		return 1;
	}
	return 0;
}

async function shootUrl(url: string, out: string): Promise<number> {
	mkdirSync(out, { recursive: true });
	const browser = await launch();
	const notes: string[] = [];
	const files: string[] = [];
	let failed = false;
	try {
		for (const size of SIZES) {
			const context = await newContext(browser, size, { colorScheme: "no-preference" });
			const page = await context.newPage();
			const watch = watchPage(page);
			try {
				const response = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
				if (!response || response.status() >= 400) {
					notes.push(`${size.name}: the page answered ${response?.status() ?? "nothing"}`);
					failed = true;
				}
				await settle(page);
				for (const [part, full] of [
					["first", false],
					["full", true],
				] as const) {
					const name = `${size.name}-${part}.png`;
					await screenshot(page, join(out, name), full);
					files.push(name);
				}
			} catch (error) {
				notes.push(`${size.name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
				failed = true;
			}
			notes.push(...[...new Set(watch.problems)].slice(0, 20).map((p) => `${size.name}: ${p}`));
			await context.close();
		}
	} finally {
		await browser.close();
	}
	writeFileSync(join(out, "shots.json"), `${JSON.stringify({ url, taken_at: new Date().toISOString(), sizes: SIZES, files, notes }, null, "\t")}\n`);
	console.log(`${url}: ${files.length} screenshots in ${relative(process.cwd(), out) || "."}`);
	for (const note of notes) console.log(`  ${note}`);
	return failed ? 1 : 0;
}

const { words, flags } = parseArgs(process.argv.slice(2));
const url = flags.get("url");
const outFlag = flags.get("out");
if (typeof url === "string") {
	if (typeof outFlag !== "string") {
		console.error(`--url needs --out\n${USAGE}`);
		process.exit(2);
	}
	process.exit(await shootUrl(url, resolve(outFlag)));
}
const name = words[0];
if (!name || !isSlot(name)) {
	console.error(`${name ? `not a design: ${name}` : "no design named"}; name one of ${SLOTS.join(", ")}\n${USAGE}`);
	process.exit(2);
}
process.exit(await shootDesign(name, resolve(typeof outFlag === "string" ? outFlag : join(SITE, "dist", "shots", name))));
