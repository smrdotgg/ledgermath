/**
 * Checks a built site:
 *
 *  - each page (src/pages.text.ts) exists and holds each of its fixed words in its body,
 *    outside any script or style (so it reads with JavaScript off, which proves the prerender);
 *  - no HTML, CSS or JavaScript file in DIR refers to a file DIR lacks, or loads anything from
 *    another origin;
 *  - every link a reader follows (href on <a> and <area>) goes inside the built site, to a file
 *    it has (and, with a fragment, to an id that file has), or under https://api.ledgermath.com/,
 *    or is, character for character, one of the links out that src/pages.text.ts names
 *    (OUTSIDE_LINKS): nowhere else, so no link is dead and none leaves the site unnamed;
 *  - every link inside the site that is not a page change carries a target with a value (or
 *    download, or rel="external"), which is what the router reads to leave a link to the browser
 *    (src/app.tsx, ADR-0036; target="" leaves it to the router): a link to a file that is
 *    not a page (third-party-notices.txt), and a link to a place on its own page (#numbers on
 *    index.html, /#numbers there too). Without it the router would take the file for a page, and
 *    take the browser's in-page jump, which moves the keyboard focus, for a page change;
 *  - each page, with everything it loads (stylesheets, fonts, images, scripts), weighs under
 *    BUDGET_BYTES, text files weighed gzipped at level 9 as a host sends them, others as they are;
 *    and the JavaScript it loads, weighed the same way, under SCRIPT_BUDGET_BYTES.
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
 * decoded. Fragment-only loads and data:, about:, mailto: and tel: URLs are
 * self-contained and skipped as loads; as links, a fragment must name an id of
 * its page and any other scheme is outside the site.
 *
 * Not read: other file types (SVG, JSON, web manifests), image-set() with bare
 * strings, URLs JavaScript builds at run time, and whether the HTML renders as
 * it reads (text inside a <template>, say, passes).
 *
 * Exit 0 when there is no problem, 1 when there is.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { OUTSIDE_LINKS, PAGES } from "../src/pages.text";

export type Result = { problems: string[]; checked: number; weights: { file: string; bytes: number; script: number }[] };

/** The one origin, besides the site itself, that a link may go to. */
export const API_ORIGIN = "https://api.ledgermath.com/";
/** The most a page may weigh, with everything it loads, compressed as a host sends it. */
export const BUDGET_BYTES = 300_000;
/**
 * The most JavaScript a page may load, compressed as a host sends it. It is the application, every
 * page of the site in one file (ADR-0036): a click never fetches anything, so all of it comes with
 * the first load, which it never holds up (a module script runs once the HTML is parsed). About
 * 45,000 bytes in November 2026: some 38,000 of code (Solid, its router, the pages) and 7,000 of
 * figures. When the documentation brings it near this, split the application by route and
 * preload the parts (the ADR says how), rather than raise the budget.
 */
export const SCRIPT_BUDGET_BYTES = 60_000;

/**
 * A reference found in a file; `link` when a reader follows it rather than the page loading it,
 * and `browser` when the link carries what makes the router leave it to the browser.
 */
type Reference = { url: string; link: boolean; browser?: boolean };

const SELF_CONTAINED = /^(data|about|mailto|tel):/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const REFERENCE_ATTRIBUTES = new Set(["src", "href", "poster", "xlink:href"]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);
const LINK_ELEMENTS = new Set(["a", "area"]);
const TEXT_FILES = /\.(html|css|js|mjs|json|svg|txt|xml)$/i;

function files(at: string): string[] {
	return readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
		const path = join(at, entry.name);
		return entry.isDirectory() ? files(path) : [path];
	});
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes the character references an attribute value or text is likely to hold. */
export function decodeEntities(text: string): string {
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

/** Each tag of HTML outside comments, scripts and styles, with its element and attributes; and the references in its scripts and styles. */
function htmlTags(html: string): { tags: { element: string; attributes: [string, string][] }[]; inline: string[] } {
	const inline: string[] = [];
	let text = html.replace(/<!--[\s\S]*?-->/g, "");
	text = text.replace(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi, (_, attributes: string, body: string) => {
		inline.push(...jsReferences(body));
		return `<script${attributes}>`;
	});
	text = text.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_, body: string) => {
		inline.push(...cssReferences(body));
		return "";
	});
	const tags = [...text.matchAll(/<([a-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)].map((tag) => ({
		element: (tag[1] ?? "").toLowerCase(),
		attributes: [...(tag[2] ?? "").matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)].map(
			(attribute): [string, string] => [(attribute[1] ?? "").toLowerCase(), decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "")],
		),
	}));
	return { tags, inline };
}

function htmlReferences(html: string): Reference[] {
	const { tags, inline } = htmlTags(html);
	const found: Reference[] = inline.map((url) => ({ url, link: false }));
	for (const { element, attributes } of tags) {
		// As the router reads an anchor: a target with a value (target="" is none), download, or rel="external".
		const browser = attributes.some(
			([name, value]) => (name === "target" && value !== "") || name === "download" || (name === "rel" && value.split(/\s+/).includes("external")),
		);
		for (const [name, value] of attributes) {
			if (REFERENCE_ATTRIBUTES.has(name)) found.push(name === "href" && LINK_ELEMENTS.has(element) ? { url: value, link: true, browser } : { url: value, link: false });
			else if (SRCSET_ATTRIBUTES.has(name)) found.push(...srcsetUrls(value).map((url) => ({ url, link: false })));
			else if (name === "style") found.push(...cssReferences(value).map((url) => ({ url, link: false })));
		}
	}
	return found;
}

/** The ids an HTML page's elements carry: what a link's fragment may name. */
export function htmlIds(html: string): Set<string> {
	const ids = new Set<string>();
	for (const { attributes } of htmlTags(html).tags) for (const [name, value] of attributes) if (name === "id") ids.add(value);
	return ids;
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
export function bodyText(html: string): string {
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

/** The file a reference names, resolved as the comment at the top says, or null when it names nothing (a bare query). */
function target(dir: string, from: string, reference: string): { file: string; fragment: string | null } | null {
	const [beforeFragment = "", ...rest] = reference.split("#");
	const fragment = rest.length > 0 ? rest.join("#") : null;
	const raw = beforeFragment.split("?")[0] ?? "";
	if (raw === "") return null;
	let bare = raw;
	try {
		bare = decodeURIComponent(raw);
	} catch {}
	const path = bare.startsWith("/") ? join(dir, bare) : resolve(dirname(from), bare);
	const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "index.html") : path;
	return { file, fragment };
}

const gzipped = (bytes: Uint8Array) => Bun.gzipSync(new Uint8Array(bytes), { level: 9 }).byteLength;

/** What PAGE weighs with everything it loads (followed through stylesheets and scripts), each file counted once; and of that, its JavaScript. */
function weigh(dir: string, page: string): { bytes: number; script: number } {
	const seen = new Set<string>();
	let bytes = 0;
	let script = 0;
	const visit = (file: string) => {
		if (seen.has(file) || !existsSync(file) || !file.startsWith(dir + sep)) return;
		seen.add(file);
		const content = readFileSync(file);
		const weight = TEXT_FILES.test(file) ? gzipped(content) : content.byteLength;
		bytes += weight;
		if (/\.m?js$/i.test(file)) script += weight;
		for (const { url, link } of references(file, content.toString("utf8"))) {
			const reference = url.trim();
			if (link || reference === "" || reference.startsWith("#") || SELF_CONTAINED.test(reference) || SCHEME.test(reference) || reference.startsWith("//")) continue;
			const found = target(dir, file, reference);
			if (found) visit(found.file);
		}
	};
	visit(page);
	return { bytes, script };
}

/** Checks the built site in DIR against PAGES' words and the links out in OUTSIDE; see the comment at the top. */
export function checkOutput(
	root: string,
	pages: readonly { file: string; text: readonly string[] }[] = PAGES,
	outside: readonly string[] = OUTSIDE_LINKS,
): Result {
	const dir = resolve(root);
	const problems: string[] = [];
	const weights: Result["weights"] = [];
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return { problems: [`${root} is not a directory (run \`bun run build\` first)`], checked: 0, weights };

	for (const page of pages) {
		const path = join(dir, page.file);
		if (!existsSync(path)) {
			problems.push(`${page.file} is missing`);
			continue;
		}
		for (const text of missingText(readFileSync(path, "utf8"), page.text)) {
			problems.push(`${page.file} does not hold, in its body outside any script: ${JSON.stringify(text)}`);
		}
		const { bytes, script } = weigh(dir, path);
		weights.push({ file: page.file, bytes, script });
		if (bytes >= BUDGET_BYTES) problems.push(`${page.file} weighs ${bytes} bytes with what it loads, compressed: over the budget of ${BUDGET_BYTES}`);
		if (script >= SCRIPT_BUDGET_BYTES) problems.push(`${page.file} loads ${script} bytes of JavaScript, compressed: over the budget of ${SCRIPT_BUDGET_BYTES}`);
	}

	const ids = new Map<string, Set<string>>();
	const idsOf = (file: string) => {
		let found = ids.get(file);
		if (!found) ids.set(file, (found = htmlIds(readFileSync(file, "utf8"))));
		return found;
	};

	// The pages the router renders: a link to any other file of the site must carry target.
	const pageFiles = new Set(pages.map((page) => join(dir, page.file)));
	const IN_PAGE = "a place on its own page, without target: the router would take the browser's jump, which moves the keyboard focus to the place, for a page change; give it target=\"_self\"";
	const NOT_A_PAGE = "which is not one of the site's pages (src/pages.text.ts), without target: the router would take it for a page; give it target=\"_self\"";

	let checked = 0;
	for (const path of files(dir)) {
		const name = relative(dir, path);
		for (const { url, link, browser } of references(path, readFileSync(path, "utf8"))) {
			const reference = url.trim();
			if (reference === "") continue;
			if (link) {
				checked += 1;
				if (reference.startsWith("#")) {
					if (extname(path) !== ".html") continue;
					if (!idsOf(path).has(decodeURIComponent(reference.slice(1)))) problems.push(`${name} links to ${reference}, an id it lacks`);
					else if (!browser) problems.push(`${name} links to ${reference}, ${IN_PAGE}`);
					continue;
				}
				if (SCHEME.test(reference) || reference.startsWith("//")) {
					if (!reference.startsWith(API_ORIGIN) && !outside.includes(reference)) problems.push(`${name} links outside the site and the data API: ${reference}`);
					continue;
				}
				const found = target(dir, path, reference);
				if (!found) continue; // "?query": the page itself
				if (!found.file.startsWith(dir + sep)) problems.push(`${name} links outside the site: ${reference}`);
				else if (!existsSync(found.file)) problems.push(`${name} links to ${reference}, which the site lacks`);
				else if (found.fragment && extname(found.file) === ".html" && !idsOf(found.file).has(decodeURIComponent(found.fragment))) {
					problems.push(`${name} links to ${reference}, whose page has no id ${JSON.stringify(found.fragment)}`);
				} else if (browser || extname(path) !== ".html") {
					// left to the browser, or a link in a file the router never renders
				} else if (!pageFiles.has(found.file)) problems.push(`${name} links to ${reference}, ${NOT_A_PAGE}`);
				else if (found.file === path && found.fragment) problems.push(`${name} links to ${reference}, ${IN_PAGE}`);
				continue;
			}
			if (reference.startsWith("#") || SELF_CONTAINED.test(reference)) continue;
			if (SCHEME.test(reference) || reference.startsWith("//")) {
				problems.push(`${name} loads from another origin: ${reference}`);
				continue;
			}
			const found = target(dir, path, reference);
			if (!found) continue; // "?query": the referring file itself
			checked += 1;
			if (!found.file.startsWith(dir + sep)) problems.push(`${name} refers outside the site: ${reference}`);
			else if (!existsSync(found.file)) problems.push(`${name} refers to ${reference}, which the site lacks`);
		}
	}
	return { problems, checked, weights };
}

if (import.meta.main) {
	const root = process.argv[2] ?? join(import.meta.dir, "..", "dist", "client");
	const { problems, checked, weights } = checkOutput(root);
	if (problems.length > 0) {
		for (const problem of problems) console.error(problem);
		if (problems.some((problem) => problem.includes("does not hold"))) {
			console.error("Each page's fixed words are listed in site/src/pages.text.ts; change them there with the page.");
		}
		process.exit(1);
	}
	const words = PAGES.map((page) => `${page.file} holds its ${page.text.length} fixed words`).join(", ");
	const weighed = weights.map((w) => `${w.file} ${w.bytes.toLocaleString("en")} (JavaScript ${w.script.toLocaleString("en")})`).join(", ");
	console.log(
		`${relative(process.cwd(), resolve(root)) || "."}: ${words}; ${checked} references and links, each to a file the site has, under ${API_ORIGIN}, or a link out that src/pages.text.ts names (${OUTSIDE_LINKS.join(", ")}), and each that is not a page change left to the browser (target); weights with what each page loads, compressed: ${weighed} bytes (budgets ${BUDGET_BYTES.toLocaleString("en")}, JavaScript ${SCRIPT_BUDGET_BYTES.toLocaleString("en")})`,
	);
}
