/**
 * Builds one design and serves it locally, as the preview will: at http://127.0.0.1:PORT/v<n>/.
 * With --watch (`bun run dev v3`), rebuilds whenever a file in the design's directory or in
 * src/data/ changes; reload the page to see it (there is no hot reload: the page is static).
 *
 *     bun run serve:variation v3 [--port 4174]
 *     bun run dev v3 [--port 4174]
 */

import { watch } from "node:fs";
import { join } from "node:path";
import { buildPage, pageDir, parseArgs, serveDir, SITE, slotArgument } from "./lib";

const { words, flags } = parseArgs(process.argv.slice(2), ["watch"]);
const slot = slotArgument(words[0], "usage: bun run serve:variation v<1-8> [--port N] [--watch]");
const port = Number(flags.get("port") ?? 4174);
const root = join(SITE, "dist", "serve");
const out = join(root, slot);

async function rebuild(): Promise<void> {
	const started = performance.now();
	try {
		await buildPage(slot, { out, base: `/${slot}/`, quiet: true });
		console.log(`built ${slot} in ${Math.round(performance.now() - started)} ms`);
	} catch (error) {
		console.error(`${slot} does not build:\n${error instanceof Error ? error.message : String(error)}`);
	}
}

await rebuild();
const server = serveDir(root, port);
console.log(`serving ${slot} at ${server.url}/${slot}/`);

if (flags.has("watch")) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running = Promise.resolve();
	const later = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			running = running.then(rebuild);
		}, 150);
	};
	for (const dir of [pageDir(slot), join(SITE, "src", "data")]) watch(dir, { recursive: true }, later);
	console.log(`watching ${pageDir(slot).slice(SITE.length + 1)}/ and src/data/`);
}
