/**
 * Checks a built site: that DIR/index.html exists and holds each TEXT in its
 * HTML, outside any script (so the page reads with JavaScript off, which
 * proves the prerender), and that no HTML, CSS or JavaScript file in DIR refers
 * to a file DIR lacks, or to anything on another origin.
 *
 *     bun scripts/check-output.ts DIR TEXT...
 *
 * References read: src, href and srcset in HTML; url() and @import in CSS;
 * import and import() of a quoted path in JavaScript. A path starting with /
 * is resolved against DIR, any other against the referring file's directory.
 * Fragments, data: and mailto: are not files and are skipped.
 *
 * Exit 0 when there is no problem, 1 when there is, 2 on a usage error.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const [root, ...texts] = process.argv.slice(2);
if (root === undefined || texts.length === 0) {
	console.error("usage: bun scripts/check-output.ts DIR TEXT...");
	process.exit(2);
}
const dir = resolve(root);
const problems: string[] = [];

function files(at: string): string[] {
	return readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
		const path = join(at, entry.name);
		return entry.isDirectory() ? files(path) : [path];
	});
}

function references(path: string, text: string): string[] {
	const found: string[] = [];
	const add = (pattern: RegExp) => {
		for (const match of text.matchAll(pattern)) if (match[1] !== undefined) found.push(match[1]);
	};
	switch (extname(path)) {
		case ".html":
			add(/\s(?:src|href)\s*=\s*"([^"]*)"/gi);
			add(/\s(?:src|href)\s*=\s*'([^']*)'/gi);
			for (const match of text.matchAll(/\ssrcset\s*=\s*"([^"]*)"/gi)) {
				for (const candidate of (match[1] ?? "").split(",")) {
					const url = candidate.trim().split(/\s+/)[0];
					if (url) found.push(url);
				}
			}
			break;
		case ".css":
			add(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi);
			add(/@import\s+["']([^"']+)["']/gi);
			break;
		case ".js":
			add(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g);
			add(/\b(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']/g);
			add(/\bimport\s*["']([^"']+)["']/g);
			break;
	}
	return found;
}

const index = join(dir, "index.html");
if (!existsSync(index)) {
	problems.push("index.html is missing");
} else {
	const visible = readFileSync(index, "utf8")
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ");
	for (const text of texts) {
		if (!visible.includes(text)) problems.push(`index.html does not hold, outside its scripts: ${JSON.stringify(text)}`);
	}
}

let checked = 0;
for (const path of files(dir)) {
	if (![".html", ".css", ".js"].includes(extname(path))) continue;
	const name = relative(dir, path);
	for (const reference of references(path, readFileSync(path, "utf8"))) {
		if (reference === "" || reference.startsWith("#") || /^(data|mailto):/i.test(reference)) continue;
		if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("//")) {
			problems.push(`${name} refers to another origin: ${reference}`);
			continue;
		}
		const bare = reference.split(/[?#]/)[0] ?? "";
		const target = bare.startsWith("/") ? join(dir, bare) : resolve(dirname(path), bare);
		const file = existsSync(target) && statSync(target).isDirectory() ? join(target, "index.html") : target;
		checked += 1;
		if (!file.startsWith(dir + "/")) problems.push(`${name} refers outside the site: ${reference}`);
		else if (!existsSync(file)) problems.push(`${name} refers to ${reference}, which the site lacks`);
	}
}

if (problems.length > 0) {
	for (const problem of problems) console.error(problem);
	process.exit(1);
}
console.log(`${relative(process.cwd(), dir) || "."}: index.html holds all ${texts.length} texts; ${checked} references, every one to a file the site has`);
