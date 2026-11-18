/**
 * Checks a built site: that DIR/index.html exists and holds each line of the
 * page's text (src/App.text.ts) in its body, outside any script or style (so
 * the page reads with JavaScript off, which proves the prerender), and that no
 * HTML, CSS or JavaScript file in DIR refers to a file DIR lacks, or loads
 * anything from another origin.
 *
 *     bun scripts/check-output.ts [DIR]     (DIR defaults to dist/client)
 *
 * References read:
 * - HTML: src, href, srcset, imagesrcset, poster and xlink:href on any element
 *   (comments skipped); url() in <style> blocks and style attributes; the
 *   JavaScript rules below in inline <script> blocks.
 * - CSS: url() and @import.
 * - JavaScript: import, export ... from and import() of a quoted path.
 * A path starting with / is resolved against DIR, any other against the
 * referring file's directory; a query or fragment is dropped and %-escapes are
 * decoded. Fragment-only references and data:, about:, mailto: and tel: URLs
 * are self-contained and skipped. href on <a> and <area> is a link a reader
 * follows, not something the page loads, so it may go to another origin; if
 * it is a path, the file must still exist.
 *
 * Not read: other file types (SVG, JSON, web manifests), image-set() with bare
 * strings, URLs JavaScript builds at run time, and whether the HTML renders as
 * it reads (text inside a <template>, say, passes).
 *
 * Exit 0 when there is no problem, 1 when there is.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { PAGE_TEXT } from "../src/App.text";

export type Result = { problems: string[]; checked: number };

/** A reference found in a file; `link` when a reader follows it rather than the page loading it. */
type Reference = { url: string; link: boolean };

const SELF_CONTAINED = /^(data|about|mailto|tel):/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const REFERENCE_ATTRIBUTES = new Set(["src", "href", "poster", "xlink:href"]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);
const LINK_ELEMENTS = new Set(["a", "area"]);

function files(at: string): string[] {
	return readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
		const path = join(at, entry.name);
		return entry.isDirectory() ? files(path) : [path];
	});
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes the character references an attribute value or text is likely to hold. */
function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] === "#") {
			const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

/** The URLs of a srcset, as the HTML standard splits it: a URL may hold commas (a data: URL does), descriptors may not. */
function srcsetUrls(value: string): string[] {
	const urls: string[] = [];
	let at = 0;
	while (at < value.length) {
		while (at < value.length && /[\s,]/.test(value[at] ?? "")) at++;
		if (at >= value.length) break;
		let end = at;
		while (end < value.length && !/\s/.test(value[end] ?? "")) end++;
		let url = value.slice(at, end);
		at = end;
		if (url.endsWith(",")) {
			url = url.replace(/,+$/, "");
		} else {
			let depth = 0;
			while (at < value.length && (value[at] !== "," || depth > 0)) {
				if (value[at] === "(") depth++;
				else if (value[at] === ")") depth = Math.max(0, depth - 1);
				at++;
			}
		}
		if (url) urls.push(url);
	}
	return urls;
}

function all(text: string, pattern: RegExp): string[] {
	return [...text.matchAll(pattern)].map((match) => match.slice(1).find((group) => group !== undefined) ?? "");
}

function cssReferences(css: string): string[] {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
	return [
		...all(text, /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi),
		...all(text, /@import\s+(?:"([^"]*)"|'([^']*)')/gi),
	];
}

function jsReferences(js: string): string[] {
	return [
		...all(js, /\bimport\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g),
		...all(js, /\b(?:import|export)\b[^"';]*?\bfrom\s*(?:"([^"]+)"|'([^']+)')/g),
		...all(js, /\bimport\s*(?:"([^"]+)"|'([^']+)')/g),
	];
}

function htmlReferences(html: string): Reference[] {
	const found: Reference[] = [];
	const loads = (urls: string[]) => found.push(...urls.map((url) => ({ url, link: false })));
	let text = html.replace(/<!--[\s\S]*?-->/g, "");
	text = text.replace(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi, (_, attributes: string, body: string) => {
		loads(jsReferences(body));
		return `<script${attributes}>`;
	});
	text = text.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_, body: string) => {
		loads(cssReferences(body));
		return "";
	});
	for (const tag of text.matchAll(/<([a-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
		const element = (tag[1] ?? "").toLowerCase();
		for (const attribute of (tag[2] ?? "").matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
			const name = (attribute[1] ?? "").toLowerCase();
			const value = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
			if (REFERENCE_ATTRIBUTES.has(name)) found.push({ url: value, link: name === "href" && LINK_ELEMENTS.has(element) });
			else if (SRCSET_ATTRIBUTES.has(name)) loads(srcsetUrls(value));
			else if (name === "style") loads(cssReferences(value));
		}
	}
	return found;
}

function references(path: string, text: string): Reference[] {
	switch (extname(path)) {
		case ".html":
			return htmlReferences(text);
		case ".css":
			return cssReferences(text).map((url) => ({ url, link: false }));
		case ".js":
		case ".mjs":
			return jsReferences(text).map((url) => ({ url, link: false }));
		default:
			return [];
	}
}

/** The text of an HTML page's body as a reader sees it with JavaScript off, near enough. */
function bodyText(html: string): string {
	return decodeEntities(
		html
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/<head\b[\s\S]*?<\/head\s*>/i, " ")
			.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
			.replace(/<[^>]*>/g, " "),
	).replace(/\s+/g, " ");
}

/** The lines of TEXTS that HTML does not hold in its body outside any script or style; scripts/check-live.ts uses it too. */
export function missingText(html: string, texts: readonly string[]): string[] {
	const visible = bodyText(html);
	return texts.filter((text) => !visible.includes(text));
}

/** Checks the built site in DIR against the page's TEXTS; see the comment at the top. */
export function checkOutput(root: string, texts: readonly string[]): Result {
	const dir = resolve(root);
	const problems: string[] = [];
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return { problems: [`${root} is not a directory (run \`bun run build\` first)`], checked: 0 };

	const index = join(dir, "index.html");
	if (!existsSync(index)) {
		problems.push("index.html is missing");
	} else {
		for (const text of missingText(readFileSync(index, "utf8"), texts)) {
			problems.push(`index.html does not hold, in its body outside any script: ${JSON.stringify(text)}`);
		}
	}

	let checked = 0;
	for (const path of files(dir)) {
		const name = relative(dir, path);
		for (const { url, link } of references(path, readFileSync(path, "utf8"))) {
			const reference = url.trim();
			if (reference === "" || reference.startsWith("#") || SELF_CONTAINED.test(reference)) continue;
			if (SCHEME.test(reference) || reference.startsWith("//")) {
				if (!link) problems.push(`${name} loads from another origin: ${reference}`);
				continue;
			}
			const raw = reference.split(/[?#]/)[0] ?? "";
			if (raw === "") continue; // "?query": the referring file itself
			let bare = raw;
			try {
				bare = decodeURIComponent(raw);
			} catch {}
			const target = bare.startsWith("/") ? join(dir, bare) : resolve(dirname(path), bare);
			const file = existsSync(target) && statSync(target).isDirectory() ? join(target, "index.html") : target;
			checked += 1;
			if (!file.startsWith(dir + sep)) problems.push(`${name} refers outside the site: ${reference}`);
			else if (!existsSync(file)) problems.push(`${name} refers to ${reference}, which the site lacks`);
		}
	}
	return { problems, checked };
}

if (import.meta.main) {
	const root = process.argv[2] ?? join(import.meta.dir, "..", "dist", "client");
	const { problems, checked } = checkOutput(root, PAGE_TEXT);
	if (problems.length > 0) {
		for (const problem of problems) console.error(problem);
		if (problems.some((problem) => problem.startsWith("index.html does not hold"))) {
			console.error("The page's text is listed in site/src/App.text.ts; change it there with the page (site/src/App.tsx).");
		}
		process.exit(1);
	}
	console.log(`${relative(process.cwd(), resolve(root)) || "."}: index.html holds all ${PAGE_TEXT.length} lines of the page's text; ${checked} references, every one to a file the site has`);
}
