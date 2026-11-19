/**
 * Builds one design of the home-page variations, alone, so that nothing in another design's
 * directory can break it (scripts/variations/lib.ts says what the build writes).
 *
 *     bun run build:variation v3                       -> dist/variations/v3/, served at /v3/
 *     bun run build:variation v3 --out DIR --base /checkpoints/v3/cp-7/
 *     bun run build:variation picker --out DIR         (the picker page; build-all.ts gives it its input)
 *
 * To look at it: `bun run serve:variation v3` builds it the same way and serves it.
 * Exit 0 when it built, 1 when it did not (with the error), 2 on a bad command line.
 */

import { join, relative } from "node:path";
import { buildPage, isSlot, parseArgs, SITE, SLOTS, type Page } from "./lib";

const USAGE = "usage: bun run build:variation v<1-8> [--out DIR] [--base /PATH/]";
const { words, flags } = parseArgs(process.argv.slice(2), ["quiet"]);
const name = words[0];
if (!name || !(isSlot(name) || name === "picker")) {
	console.error(`${name ? `not a design: ${name}` : "no design named"}; name one of ${SLOTS.join(", ")}\n${USAGE}`);
	process.exit(2);
}
const page = name as Page;
const out = typeof flags.get("out") === "string" ? (flags.get("out") as string) : join(SITE, "dist", "variations", page);
const base = typeof flags.get("base") === "string" ? (flags.get("base") as string) : page === "picker" ? "/" : `/${page}/`;

const started = performance.now();
try {
	const result = await buildPage(page, { out, base, quiet: flags.has("quiet") });
	console.log(`built ${page} in ${Math.round(performance.now() - started)} ms -> ${relative(process.cwd(), result.out) || "."} (served at ${base}): ${result.files.length} files`);
} catch (error) {
	console.error(`${page} does not build:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exit(1);
}
