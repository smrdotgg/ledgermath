/**
 * Checks a built site:
 *
 *  - each page exists and holds each of its fixed words in its body, outside any script or style
 *    (so it reads with JavaScript off, which proves the prerender): the pages of src/pages.text.ts,
 *    and the documentation's, read back from the site's llms.txt (scripts/site-pages.ts), whose
 *    fixed words are the header's and footer's, their title and their description;
 *  - the documentation hangs together (checkDocs): llms.txt lists every documentation page and
 *    nothing else, each by its Markdown, which the site has beside the page and whose title is the
 *    page's, and each page names that Markdown in its <head>;
 *  - no HTML, CSS or JavaScript file in DIR refers to a file DIR lacks, or loads anything from
 *    another origin;
 *  - every link a reader follows (href on <a> and <area>) goes inside the built site, to a file
 *    it has (and, with a fragment, to an id that file has); or under the data API
 *    (https://api.ledgermath.com/); or under the repository's files on GitHub (REPOSITORY_FILES:
 *    …/blob/main/ and …/tree/main/), to a file or directory the repository has; or is, character
 *    for character, one of the links out that src/pages.text.ts names (OUTSIDE_LINKS): nowhere
 *    else, so no link is dead and none leaves the site unnamed;
 *  - every link inside the site that is not a page change carries a target with a value (or
 *    download, or rel="external"), which is what the router reads to leave a link to the browser
 *    (src/app.tsx, ADR-0036; target="" leaves it to the router): a link to a file that is
 *    not a page (third-party-notices.txt, a page's Markdown), and a link to a place on its own
 *    page (#numbers on index.html, /#numbers there too). Without it the router would take the file
 *    for a page, and take the browser's in-page jump, which moves the keyboard focus, for a page
 *    change;
 *  - the weights, text files weighed gzipped at level 9 as a host sends them, others as they are:
 *    each page, with everything its first load brings (stylesheets, fonts, images, the application's
 *    script and what it imports, and the chunk of a documentation page's body, which its <head>
 *    asks for), under BUDGET_BYTES; the JavaScript of the application (its script and what that
 *    imports, every page alike) under SCRIPT_BUDGET_BYTES; each documentation page's chunk under
 *    CHUNK_BUDGET_BYTES; and every chunk the application may load ahead (each import() of it,
 *    with what that imports), together, under AHEAD_BUDGET_BYTES.
 *
 *     bun scripts/check-output.ts [DIR]     (DIR defaults to dist/client)
 *
 * References read:
 * - HTML: src, href, srcset, imagesrcset, poster and xlink:href on any element
 *   (comments skipped); url() in <style> blocks and style attributes; the
 *   JavaScript rules below in inline <script> blocks. A <link> whose rel is
 *   alternate or describedby names a file the site must have, which no browser
 *   loads, so it is not weighed.
 * - CSS: url() and @import.
 * - JavaScript: import, export ... from, and import() of a quoted path (a
 *   template literal with nothing in it to fill counts as quoted).
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
import { API_ORIGIN, OUTSIDE_LINKS, PAGES, REPOSITORY_FILES } from "../src/pages.text";
import { readLlmsTxt, SITE_ORIGIN } from "./docs";
import { docsPages, LLMS_TXT } from "./site-pages";

export { API_ORIGIN };

export type Weight = { file: string; bytes: number; script: number };
export type Result = { problems: string[]; checked: number; weights: Weight[]; application: number; chunks: { file: string; bytes: number }[]; ahead: number };

/** The repository's checkout, which a link to its files on GitHub must name a file of. */
const REPOSITORY = resolve(import.meta.dir, "..", "..");

/**
 * The most a page's first load may weigh, compressed as a host sends it: the page and everything
 * it loads to show itself and be taken over by the application. Measured in November 2026: about
 * 119 KB for the home page and up to 159 KB for a documentation page (its own chunk, the HTML of
 * its body again, among it), the check counting both fonts where a browser fetches one.
 */
export const BUDGET_BYTES = 300_000;
/**
 * The most JavaScript the application may be, compressed as a host sends it: its script and what
 * that imports, which every page loads alike, and which never holds up the first paint (a module
 * script runs once the HTML is parsed, and hydration waits for the paint). It holds Solid, its
 * router, the home page with its figures, and the documentation's layout with every page's
 * title and description; not the documentation's bodies, which are chunks of their own (below).
 * About 45,000 bytes before the documentation, 54,900 with it (November 2026).
 */
export const SCRIPT_BUDGET_BYTES = 60_000;
/** The most one documentation page's chunk may weigh: its body's HTML, which a click to the page needs. The longest, http_get's, was 21,200 bytes. */
export const CHUNK_BUDGET_BYTES = 40_000;
/**
 * The most the application may load ahead, every chunk together: what a reader's browser fetches
 * at most once a page has loaded (src/app.tsx's eagerPreload; it skips a reader who asks to save
 * data). 171,000 bytes for 28 pages in November 2026. Past this, preload fewer pages ahead (those
 * whose links are in view, or under the pointer) rather than raise the budget (ADR-0037).
 */
export const AHEAD_BUDGET_BYTES = 250_000;

/**
 * A reference found in a file; `link` when a reader follows it rather than the page loading it,
 * and `browser` when the link carries what makes the router leave it to the browser; `ahead` when
 * it is an import() the application makes later, if at all; `named` when the file is named but
 * never loaded (a <link rel="alternate">).
 */
type Reference = { url: string; link: boolean; browser?: boolean; ahead?: boolean; named?: boolean };

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

/** A script's references: its static imports, and each import() of a quoted path (`ahead`). */
function jsReferences(js: string): Reference[] {
	return [
		...all(js, /\bimport\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`$\\]+)`)\s*\)/g).map((url) => ({ url, link: false, ahead: true })),
		...all(js, /\b(?:import|export)\b[^"';`]*?\bfrom\s*(?:"([^"]+)"|'([^']+)')/g).map((url) => ({ url, link: false })),
		...all(js, /\bimport\s*(?:"([^"]+)"|'([^']+)')/g).map((url) => ({ url, link: false })),
	];
}

/** Each tag of HTML outside comments, scripts and styles, with its element and attributes; and the references in its scripts and styles. */
function htmlTags(html: string): { tags: { element: string; attributes: [string, string][] }[]; inline: Reference[] } {
	const inline: Reference[] = [];
	let text = html.replace(/<!--[\s\S]*?-->/g, "");
	text = text.replace(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi, (_, attributes: string, body: string) => {
		inline.push(...jsReferences(body));
		return `<script${attributes}>`;
	});
	text = text.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_, body: string) => {
		inline.push(...cssReferences(body).map((url) => ({ url, link: false })));
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
	const found: Reference[] = [...inline];
	for (const { element, attributes } of tags) {
		// As the router reads an anchor: a target with a value (target="" is none), download, or rel="external".
		const browser = attributes.some(
			([name, value]) => (name === "target" && value !== "") || name === "download" || (name === "rel" && value.split(/\s+/).includes("external")),
		);
		// A page's Markdown, or the llms.txt that covers it: named for an agent, loaded by no browser.
		const named = element === "link" && attributes.some(([name, value]) => name === "rel" && value.split(/\s+/).some((rel) => rel === "alternate" || rel === "describedby"));
		for (const [name, value] of attributes) {
			if (REFERENCE_ATTRIBUTES.has(name)) found.push(name === "href" && LINK_ELEMENTS.has(element) ? { url: value, link: true, browser } : { url: value, link: false, named });
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
			return jsReferences(text);
		default:
			return [];
	}
}

/** The elements that sit inside a line of text, which a reader sees no space around: `code` in a sentence, a link. */
const INLINE = "a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|i|ins|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var";

/**
 * The text of an HTML page's body as a reader sees it with JavaScript off, near enough: every tag a
 * space, but those of an element inside a line of text (INLINE), which are nothing, so that
 * "(<code>getpid</code>, …" reads "(getpid, …".
 */
export function bodyText(html: string): string {
	return decodeEntities(
		html
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/<head\b[\s\S]*?<\/head\s*>/i, " ")
			.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
			.replace(new RegExp(`</?(?:${INLINE})\\b[^>]*>`, "gi"), "")
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
const weightOf = (file: string) => {
	const content = readFileSync(file);
	return TEXT_FILES.test(file) ? gzipped(content) : content.byteLength;
};

/**
 * The files FROM loads (followed through stylesheets and scripts), each once: what a first load
 * brings (neither links, nor files only named, nor import()), or, with AHEAD, also what each
 * import() would bring.
 */
function loads(dir: string, from: string, ahead = false): string[] {
	const seen = new Set<string>();
	const visit = (file: string) => {
		if (seen.has(file) || !existsSync(file) || !file.startsWith(dir + sep)) return;
		seen.add(file);
		for (const reference of references(file, readFileSync(file, "utf8"))) {
			const url = reference.url.trim();
			if (reference.link || reference.named || (reference.ahead && !ahead)) continue;
			if (url === "" || url.startsWith("#") || SELF_CONTAINED.test(url) || SCHEME.test(url) || url.startsWith("//")) continue;
			const found = target(dir, file, url);
			if (found) visit(found.file);
		}
	};
	visit(from);
	return [...seen];
}

/** What PAGE's first load weighs, each file counted once; and of that, its JavaScript. */
function weigh(dir: string, page: string): { bytes: number; script: number } {
	let bytes = 0;
	let script = 0;
	for (const file of loads(dir, page)) {
		const weight = weightOf(file);
		bytes += weight;
		if (/\.m?js$/i.test(file)) script += weight;
	}
	return { bytes, script };
}

/** Whether HREF, a link under the repository's files on GitHub, names a file or directory the checkout has. */
function inRepository(href: string, repository: string): boolean {
	const prefix = REPOSITORY_FILES.find((p) => href.startsWith(p));
	if (!prefix) return false;
	const path = href.slice(prefix.length).split(/[?#]/)[0] ?? "";
	let decoded: string;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		return false;
	}
	const file = resolve(repository, decoded);
	return decoded !== "" && file.startsWith(repository + sep) && !relative(repository, file).split(sep).includes(".git") && existsSync(file);
}

/**
 * Checks the built site in DIR against PAGES' words and the links out (OUTSIDE, and the
 * repository's files in REPOSITORY's checkout); see the comment at the top. PAGES are, by default,
 * src/pages.text.ts's and the documentation's (scripts/site-pages.ts).
 */
export function checkOutput(
	root: string,
	pages?: readonly { file: string; text: readonly string[] }[],
	outside: readonly string[] = OUTSIDE_LINKS,
	repository: string = REPOSITORY,
): Result {
	const dir = resolve(root);
	const problems: string[] = [];
	const weights: Result["weights"] = [];
	const empty = { checked: 0, weights, application: 0, chunks: [], ahead: 0 };
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return { problems: [`${root} is not a directory (run \`bun run build\` first)`], ...empty };
	if (pages === undefined) {
		const docs = docsPages(dir);
		problems.push(...docs.problems);
		pages = [...PAGES, ...docs.pages];
	}

	let application = 0;
	const pageScripts = new Set<string>();
	for (const page of pages) {
		const path = join(dir, page.file);
		if (!existsSync(path)) {
			problems.push(`${page.file} is missing`);
			continue;
		}
		for (const text of missingText(readFileSync(path, "utf8"), page.text)) {
			problems.push(`${page.file} does not hold, in its body outside any script: ${JSON.stringify(text)}`);
		}
		const { bytes } = weigh(dir, path);
		// The application: the page's module scripts, and what they import, the same on every page.
		const html = readFileSync(path, "utf8");
		const entries = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/gi)].map((m) => target(dir, path, decodeEntities(m[1]!))?.file).filter((file): file is string => !!file);
		const app = [...new Set(entries.flatMap((entry) => loads(dir, entry)))];
		for (const file of app) pageScripts.add(file);
		const script = app.reduce((sum, file) => sum + weightOf(file), 0);
		application = Math.max(application, script);
		weights.push({ file: page.file, bytes, script });
		if (bytes >= BUDGET_BYTES) problems.push(`${page.file} weighs ${bytes} bytes with what it loads, compressed: over the budget of ${BUDGET_BYTES}`);
		if (script >= SCRIPT_BUDGET_BYTES) problems.push(`${page.file} loads ${script} bytes of JavaScript, compressed: over the budget of ${SCRIPT_BUDGET_BYTES}`);
	}

	// What the application may load ahead: each import() it makes, with what that imports.
	const scripts = [...pageScripts];
	const aheadFiles = new Set(scripts.flatMap((file) => loads(dir, file, true)).filter((file) => !pageScripts.has(file)));
	const chunks = [...aheadFiles].sort().map((file) => ({ file: relative(dir, file), bytes: weightOf(file) }));
	const ahead = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
	for (const chunk of chunks) if (chunk.bytes >= CHUNK_BUDGET_BYTES) problems.push(`${chunk.file} weighs ${chunk.bytes} bytes, compressed: over the budget of ${CHUNK_BUDGET_BYTES} for a chunk`);
	if (ahead >= AHEAD_BUDGET_BYTES) problems.push(`the application may load ${ahead} bytes ahead, compressed (${chunks.length} chunks): over the budget of ${AHEAD_BUDGET_BYTES}`);

	const ids = new Map<string, Set<string>>();
	const idsOf = (file: string) => {
		let found = ids.get(file);
		if (!found) ids.set(file, (found = htmlIds(readFileSync(file, "utf8"))));
		return found;
	};

	// The pages the router renders: a link to any other file of the site must carry target.
	const pageFiles = new Set(pages.map((page) => join(dir, page.file)));
	const IN_PAGE = "a place on its own page, without target: the router would take the browser's jump, which moves the keyboard focus to the place, for a page change; give it target=\"_self\"";
	const NOT_A_PAGE = "which is not one of the site's pages (src/pages.text.ts and the documentation's), without target: the router would take it for a page; give it target=\"_self\"";
	// The router decodes a fragment (decodeURIComponent) when it scrolls to it, and throws on one that does not decode.
	const UNDECODABLE = "whose fragment does not decode (a % not followed by two hex digits): the router would throw on it";
	const decoded = (text: string): string | null => {
		try {
			return decodeURIComponent(text);
		} catch {
			return null;
		}
	};

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
					const id = decoded(reference.slice(1));
					if (id === null) problems.push(`${name} links to ${reference}, ${UNDECODABLE}`);
					else if (!idsOf(path).has(id)) problems.push(`${name} links to ${reference}, an id it lacks`);
					else if (!browser) problems.push(`${name} links to ${reference}, ${IN_PAGE}`);
					continue;
				}
				if (SCHEME.test(reference) || reference.startsWith("//")) {
					if (REPOSITORY_FILES.some((prefix) => reference.startsWith(prefix))) {
						if (!inRepository(reference, repository)) problems.push(`${name} links to ${reference}, a file the repository lacks`);
					} else if (!reference.startsWith(API_ORIGIN) && !outside.includes(reference)) problems.push(`${name} links outside the site, the data API and the repository's files: ${reference}`);
					continue;
				}
				const found = target(dir, path, reference);
				if (!found) continue; // "?query": the page itself
				if (!found.file.startsWith(dir + sep)) problems.push(`${name} links outside the site: ${reference}`);
				else if (!existsSync(found.file)) problems.push(`${name} links to ${reference}, which the site lacks`);
				else if (found.fragment && decoded(found.fragment) === null) problems.push(`${name} links to ${reference}, ${UNDECODABLE}`);
				else if (found.fragment && extname(found.file) === ".html" && !idsOf(found.file).has(decoded(found.fragment)!)) {
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
	return { problems, checked, weights, application, chunks, ahead };
}

/**
 * The documentation hangs together: llms.txt lists every documentation page (each docs/…/index.html
 * of DIR) and nothing else, each by its Markdown, at the site's address; the site has that Markdown,
 * which starts with the page's title; and the page names it in <head> (a link rel="alternate" of
 * type text/markdown), as a host that answers Accept: text/markdown needs: a page without its
 * Markdown would answer such a request with 404 (site/deploy/vercel-config.ts). One line per problem.
 */
export function checkDocs(root: string): string[] {
	const dir = resolve(root);
	const problems: string[] = [];
	const llms = join(dir, LLMS_TXT);
	if (!existsSync(llms)) return [`${LLMS_TXT} is missing`];
	const listed = readLlmsTxt(readFileSync(llms, "utf8"));
	if (listed.length === 0) problems.push(`${LLMS_TXT} lists no page`);
	const { pages } = docsPages(dir);
	const htmlFiles = files(dir).map((file) => relative(dir, file).split(sep).join("/")).filter((file) => /^docs\/(.+\/)?index\.html$/.test(file));
	const known = new Set(pages.map((page) => page.file));
	for (const file of htmlFiles) if (!known.has(file)) problems.push(`${file} is a documentation page ${LLMS_TXT} does not list`);
	for (const { url } of listed) if (!url.startsWith(`${SITE_ORIGIN}/docs/`) || !url.endsWith(".md")) problems.push(`${LLMS_TXT} links to ${url}, not a documentation page's Markdown on ${SITE_ORIGIN}`);
	for (const page of pages) {
		const markdown = page.markdown!;
		const html = join(dir, page.file);
		if (!existsSync(html)) continue; // checkOutput says it is missing
		const head = readFileSync(html, "utf8").split(/<\/head>/i)[0] ?? "";
		const alternate = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((tag) => /\brel="alternate"/.test(tag) && /\btype="text\/markdown"/.test(tag));
		const href = alternate ? decodeEntities(/\bhref="([^"]*)"/.exec(alternate)?.[1] ?? "") : null;
		if (href !== markdown) problems.push(`${page.file} names ${href === null ? "no Markdown" : href} in its <head>, not its own, ${markdown}`);
	}
	return problems;
}

if (import.meta.main) {
	const root = process.argv[2] ?? join(import.meta.dir, "..", "dist", "client");
	const { pages, problems: listing } = docsPages(resolve(root));
	const { problems: found, checked, weights, application, chunks, ahead } = checkOutput(root);
	const problems = [...new Set([...listing, ...found, ...checkDocs(root)])];
	if (problems.length > 0) {
		for (const problem of problems) console.error(problem);
		if (problems.some((problem) => problem.includes("does not hold"))) {
			console.error("The home page's fixed words are listed in site/src/pages.text.ts; a documentation page's are its title and description, from its Markdown.");
		}
		process.exit(1);
	}
	const words = [...PAGES, ...pages].length;
	const heaviest = [...weights].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
	const largest = [...chunks].sort((a, b) => b.bytes - a.bytes)[0];
	console.log(
		`${relative(process.cwd(), resolve(root)) || "."}: ${words} pages, each holding its fixed words, ${pages.length} of them documentation, each listed in ${LLMS_TXT} with its Markdown beside it and named in its <head>; ${checked} references and links, each to a file the site has, under ${API_ORIGIN}, to a file of the repository (${REPOSITORY_FILES.join(", ")}), or a link out that src/pages.text.ts names (${OUTSIDE_LINKS.join(", ")}), and each that is not a page change left to the browser (target). Weights, compressed: first loads ${weights.map((w) => w.bytes).reduce((a, b) => Math.min(a, b), Infinity).toLocaleString("en")} to ${heaviest[0]?.bytes.toLocaleString("en")} bytes (heaviest ${heaviest.map((w) => `${w.file} ${w.bytes.toLocaleString("en")}`).join(", ")}; budget ${BUDGET_BYTES.toLocaleString("en")}); the application ${application.toLocaleString("en")} (budget ${SCRIPT_BUDGET_BYTES.toLocaleString("en")}); ${chunks.length} chunks loaded ahead, ${ahead.toLocaleString("en")} together (budget ${AHEAD_BUDGET_BYTES.toLocaleString("en")}), the largest ${largest ? `${largest.file} ${largest.bytes.toLocaleString("en")}` : "none"} (budget ${CHUNK_BUDGET_BYTES.toLocaleString("en")} each)`,
	);
}
