/**
 * Checks what `bun run build` wrote for the variations (run by `bun run check`, after
 * check-output.ts has checked the picker and every reference in DIR): that each design either
 * built, and then DIR/v<n>/index.html holds text in its body outside any script, so it reads with
 * JavaScript off; or did not, and then the picker says so and DIR/v<n>/ does not exist.
 * A design that does not build does not fail this check: that is the point of building each
 * one on its own.
 *
 *     bun scripts/variations/check-built.ts [DIR]     (DIR defaults to dist/client)
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DesignStatus } from "../../src/picker/input";
import { SITE, SLOTS } from "./lib";

function bodyText(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<head\b[\s\S]*?<\/head\s*>/i, " ")
		.replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const dir = resolve(process.argv[2] ?? join(SITE, "dist", "client"));
const problems: string[] = [];
const statusPath = join(dir, "variations.json");
if (!existsSync(statusPath)) {
	console.error(`${statusPath} is missing (run \`bun run build\` first)`);
	process.exit(1);
}
const { designs } = JSON.parse(readFileSync(statusPath, "utf8")) as { designs: DesignStatus[] };
const picker = readFileSync(join(dir, "index.html"), "utf8");
const lines: string[] = [];
for (const slot of SLOTS) {
	const design = designs.find((d) => d.slot === slot);
	const page = join(dir, slot, "index.html");
	if (!design) {
		problems.push(`variations.json has no entry for ${slot}`);
	} else if (design.builds) {
		if (!existsSync(page)) problems.push(`${slot} built, but ${slot}/index.html is missing`);
		else if (bodyText(readFileSync(page, "utf8")).length < 40) problems.push(`${slot}/index.html holds almost no text outside its scripts: it would not read with JavaScript off`);
		else lines.push(`${slot} built`);
	} else {
		if (existsSync(join(dir, slot))) problems.push(`${slot} did not build, yet ${slot}/ is in the output`);
		const item = [...picker.matchAll(/<li\b[\s\S]*?<\/li>/gi)].map((m) => bodyText(m[0])).find((text) => text.startsWith(`${slot}: ${design.name}`));
		if (!item?.includes("Does not build")) problems.push(`the picker does not show ${slot} as not building`);
		lines.push(`${slot} does not build, and the picker says so`);
	}
}
if (problems.length > 0) {
	for (const problem of problems) console.error(problem);
	process.exit(1);
}
console.log(lines.join("; "));
