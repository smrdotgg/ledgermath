/**
 * The documentation, from Markdown to pages: run by the build (scripts/build.ts), never in the
 * browser. Every page has one source, a Markdown file, and the site serves both the HTML rendered
 * from it and the Markdown itself, so the two cannot differ (ADR-0037).
 *
 * The pages, by section (SECTIONS):
 *
 *  - /docs/: site/content/docs/index.md, followed by the contents of every section; until that
 *    file exists, the contents alone (contentsMarkdown).
 *  - the API reference: the Markdown scripts/api-reference.ts writes from the schemas, built
 *    afresh at every build and never kept in the repository (docs/api/*.md), and the machines
 *    page it writes from schedule.json (docs/machines.md);
 *  - each benchmark the schedule runs: benchmarks/<name>/README.md, at /docs/benchmarks/<name>;
 *  - every other site/content/docs/**.md, at the address its path gives.
 *
 * Each source keeps one contract (CONTRIBUTING.md; the tests of the generator and of the
 * benchmark pages hold theirs): GitHub-flavoured Markdown with no front matter and no image, no
 * HTML but <details> and <summary>, the first line `# Title` and the first block after it a
 * paragraph, the page's description. A source that breaks it fails the build, with the file and
 * the reason, as does every link with no target (checkLinks): a /docs/… address that is no page,
 * a #fragment that is no heading of its page, a file of the repository that is not there, or an
 * address outside the site the site does not link to.
 *
 * Links are made into the site's own: /docs/… and https://ledgermath.com/docs/… become /docs/…
 * (the router's), a #fragment on the same page carries target="_self" (the browser's own jump), a
 * file of the repository, linked relatively from its README, becomes its address on GitHub (in the
 * served Markdown too, where the relative link would lead nowhere), and links to the API stay.
 * Headings get GitHub's anchors (headingSlug), which the generated pages link to.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { Marked, type Token, type Tokens } from "marked";
import { DOCS_ADDRESSES, isDocsAddress } from "../../scripts/lib/docs-addresses";
import { HEADLINE_CHOICES } from "../src/data/headline";
import { type DocMeta, DOCS_HOME, documentTitle, SECTIONS, type SectionId } from "../src/docs/sections";
import { API_ORIGIN, HOME, REPOSITORY_FILES } from "../src/pages.text";

export { DOCS_HOME, SECTIONS, type SectionId };

/** The site's address: absolute links in the served Markdown and llms.txt are under it. */
export const SITE_ORIGIN = "https://ledgermath.com";

/** The order of the last section's pages that are known; any other hand-written page follows them, by address. */
const REFERENCE_ORDER = ["/docs/machines", "/docs/methods", "/docs/prices", "/docs/glossary"];

/** The title and description of /docs/ until site/content/docs/index.md exists. */
export const CONTENTS_TITLE = "Documentation";
export const CONTENTS_DESCRIPTION =
	"Every page of LedgerMath's documentation, by section. Each is also served as plain Markdown, and `/llms.txt` lists them for agents.";
/** The heading the contents take on /docs/ below site/content/docs/index.md, once it exists. */
export const CONTENTS_HEADING = "All pages";

/** One page's source, before it is rendered. */
export type DocsSource = {
	address: string;
	section: SectionId;
	/** Where it comes from, for messages: a file of the repository, or what generated it. */
	source: string;
	/** The directory of the repository its relative links are read from, or null for a generated page. */
	directory: string | null;
	markdown: string;
};

/** One page, rendered. */
export type DocsPage = {
	address: string;
	section: SectionId;
	source: string;
	/** Its HTML file in the built site: docs/glossary/index.html, docs/index.html. */
	file: string;
	/** Its Markdown file, and the address it is served at: docs/glossary.md, /docs/glossary.md; docs/index.md for /docs/. */
	markdownFile: string;
	markdownAddress: string;
	/** The `# Title`, as text. */
	title: string;
	/** The first paragraph, as text: the page's description. */
	description: string;
	/** The first paragraph as Markdown, on one line. */
	summary: string;
	/** The Markdown the site serves for the page. */
	markdown: string;
	/** The page's body, rendered from that Markdown. */
	html: string;
	/** The ids of its headings, in order. */
	ids: string[];
};

/** The error the documentation's build fails with: every problem, one a line. */
export class DocsError extends Error {
	constructor(readonly problems: readonly string[]) {
		super(`the documentation does not build:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
	}
}

// ---------------------------------------------------------------- addresses

/** A page's HTML file: docs/glossary/index.html for /docs/glossary, docs/api/index.html for /docs/api/. */
export const pageFile = (address: string): string => (address.endsWith("/") ? `${address.slice(1)}index.html` : `${address.slice(1)}/index.html`);

/**
 * A page's Markdown file, as llms.txt's convention has it: the address with .md added, or, for an
 * address that ends in a slash (no file name), index.md in it. docs/glossary.md, docs/index.md.
 */
export const markdownFile = (address: string): string => (address.endsWith("/") ? `${address.slice(1)}index.md` : `${address.slice(1)}.md`);

/** The address a hand-written file is served at: site/content/docs/glossary.md is /docs/glossary, an index.md its directory's. */
export function addressOf(relativePath: string): string {
	const path = relativePath.split(sep).join("/").replace(/\.md$/, "");
	if (path === "index") return DOCS_HOME;
	if (path.endsWith("/index")) return `${DOCS_HOME}${path.slice(0, -"index".length)}`;
	return `${DOCS_HOME}${path}`;
}

// ---------------------------------------------------------------- text

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (text: string): string =>
	text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] === "#") {
			const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
/** TEXT for HTML, in text or in a quoted attribute. */
export const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Inline tokens as the text a reader sees: code as it is, emphasis and links as their words, HTML left out. */
function plain(tokens: readonly Token[] | undefined): string {
	let out = "";
	for (const token of tokens ?? []) {
		switch (token.type) {
			case "text":
				out += token.tokens ? plain(token.tokens) : decode(token.text as string);
				break;
			case "escape":
			case "codespan":
				out += token.text;
				break;
			case "br":
				out += " ";
				break;
			case "html":
			case "image":
				break;
			default: {
				const other = token as Tokens.Generic;
				out += other.tokens ? plain(other.tokens) : decode(String(other.text ?? ""));
			}
		}
	}
	return out;
}

/**
 * A heading's anchor as GitHub makes it from its text: lower case, every character but letters,
 * marks, digits, spaces, - and _ dropped, each space a -. The same rule as the generator's
 * (scripts/lib/api-reference.ts, headingSlug), whose pages link to it.
 */
export function headingSlug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N} _-]/gu, "")
		.replaceAll(" ", "-");
}

// ---------------------------------------------------------------- reading one page

/** Every token, depth first, the inline tokens of tables and lists included. */
function* allTokens(tokens: readonly Token[]): Generator<Token> {
	for (const token of tokens) {
		yield token;
		if (token.type === "table") {
			const table = token as Tokens.Table;
			for (const cell of [...table.header, ...table.rows.flat()]) yield* allTokens(cell.tokens);
		} else if (token.type === "list") {
			for (const item of (token as Tokens.List).items) yield* allTokens([item]);
		} else if ((token as Tokens.Generic).tokens) yield* allTokens((token as Tokens.Generic).tokens!);
	}
}

const HTML_TAG = /<!--[\s\S]*?-->|<\/?([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

type Lexed = {
	source: DocsSource;
	tokens: Token[];
	title: string;
	description: string;
	summary: string;
	/** Each heading token's id. */
	ids: Map<Token, string>;
	problems: string[];
};

const lexer = new Marked({ gfm: true });

/** Reads one source: its tokens, its title and description, its headings' ids, and what breaks the contract. */
function lex(source: DocsSource): Lexed {
	const problems: string[] = [];
	const say = (what: string) => problems.push(`${source.source}: ${what}`);
	const { markdown } = source;
	if (markdown.startsWith("---")) say("starts with front matter, which the documentation has none of");
	if (!/^# \S/.test(markdown)) say("its first line is not a title (`# Title`)");
	const tokens = lexer.lexer(markdown) as Token[];
	const blocks = tokens.filter((token) => token.type !== "space");
	const first = blocks[0];
	const title = first?.type === "heading" && (first as Tokens.Heading).depth === 1 ? plain((first as Tokens.Heading).tokens).trim() : "";
	const opening = blocks[1];
	let description = "";
	let summary = "";
	if (opening?.type === "paragraph") {
		const paragraph = opening as Tokens.Paragraph;
		description = plain(paragraph.tokens).replace(/\s+/g, " ").trim();
		// As Markdown, with each link left as its words: it is shown on other pages (/docs/'s
		// contents), where a link's target, a relative one above all, would not be this page's.
		let text = paragraph.text;
		for (const token of allTokens(paragraph.tokens)) if (token.type === "link") text = text.split(token.raw).join((token as Tokens.Link).text);
		summary = text.replace(/\s+/g, " ").trim();
	} else say("the block after the title is not a paragraph, the page's description");
	if (blocks.filter((token) => token.type === "heading" && (token as Tokens.Heading).depth === 1).length > 1) say("has more than one title (`# …`)");

	const ids = new Map<Token, string>();
	const seen = new Map<string, number>();
	for (const token of allTokens(tokens)) {
		if (token.type === "heading") {
			// GitHub's anchors: a repeated one gets -1, -2, … in the order they come.
			const base = headingSlug(plain((token as Tokens.Heading).tokens));
			const count = seen.get(base) ?? 0;
			seen.set(base, count + 1);
			ids.set(token, count === 0 ? base : `${base}-${count}`);
		} else if (token.type === "image") {
			say(`has an image (${JSON.stringify((token as Tokens.Image).href)}): the documentation has none`);
		} else if (token.type === "html") {
			for (const match of (token as Tokens.HTML).text.matchAll(HTML_TAG)) {
				const name = match[1]?.toLowerCase();
				if (name === undefined) continue; // a comment
				if (name !== "details" && name !== "summary") say(`holds HTML other than <details> and <summary>: ${JSON.stringify(match[0])}`);
				else if ((match[2] ?? "").trim() !== "" && (match[2] ?? "").trim() !== "open") say(`gives <${name}> attributes: ${JSON.stringify(match[0])}`);
			}
		}
	}
	return { source, tokens, title, description, summary, ids, problems };
}

/** A page's title and description, read from its Markdown as the build reads them; and what breaks the contract, if anything. */
export function describeMarkdown(markdown: string, source = "the page"): { title: string; description: string; problems: string[] } {
	const { title, description, problems } = lex({ address: "", section: "reference", source, directory: null, markdown });
	return { title, description, problems };
}

// ---------------------------------------------------------------- links

/** What the site may link to outside itself: the API, and the repository's files on GitHub. */
export function linkOutAllowed(href: string): boolean {
	return href.startsWith(API_ORIGIN) || REPOSITORY_FILES.some((prefix) => href.startsWith(prefix) && href.length > prefix.length);
}

/** The page an address inside the site names, with its fragment, or null: /docs/api, /docs/api/ and /docs/api/index.html all name /docs/api/. */
function pageAt(path: string, pages: ReadonlyMap<string, Lexed>): string | null {
	const bare = path.replace(/\/index\.html$/, "/");
	for (const candidate of [bare, bare.endsWith("/") ? bare.slice(0, -1) : `${bare}/`]) if (pages.has(candidate)) return candidate;
	return null;
}

type Rewritten = { href: string; target?: "_self" };

/**
 * Where a link of PAGE goes in the site, or the problem with it. HREF as written; REPOSITORY the
 * checkout the relative links are read from.
 */
function rewrite(href: string, page: Lexed, pages: ReadonlyMap<string, Lexed>, repository: string): Rewritten | string {
	const ids = (address: string) => new Set(pages.get(address)!.ids.values());
	const hash = href.indexOf("#");
	const [before, fragment] = hash < 0 ? [href, null] : [href.slice(0, hash), href.slice(hash + 1)];
	const named = (address: string): string | null => {
		if (fragment === null || fragment === "") return null;
		let id: string;
		try {
			id = decodeURIComponent(fragment);
		} catch {
			return `${href}: its fragment does not decode`;
		}
		return ids(address).has(id) ? null : `${href}: ${address === page.source.address ? "this page" : address} has no heading #${id}`;
	};
	if (before === "") {
		const problem = named(page.source.address);
		return problem ?? { href, target: "_self" };
	}
	let path: string | null = null;
	if (before.startsWith(`${SITE_ORIGIN}/`)) path = before.slice(SITE_ORIGIN.length);
	else if (before.startsWith("/") && !before.startsWith("//")) path = before;
	if (path !== null) {
		if (/[?]/.test(path)) return `${href}: a link inside the site with a query`;
		const address = path === "/" ? "/" : pageAt(path, pages);
		if (address === null) return `${href}: no page of the site is at ${path}`;
		if (address === "/") return fragment === null ? { href: "/" } : `${href}: a link to a place on the home page`;
		const problem = named(address);
		if (problem) return problem;
		const to = `${address}${fragment === null ? "" : `#${fragment}`}`;
		return address === page.source.address && fragment !== null ? { href: to, target: "_self" } : { href: to };
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(before) || before.startsWith("//")) {
		return linkOutAllowed(href) ? { href } : `${href}: the site links outside itself only to ${API_ORIGIN} and to the repository's files (${REPOSITORY_FILES.join(", ")})`;
	}
	// A relative link: a file or directory of the repository, from the source's own directory.
	if (page.source.directory === null) return `${href}: a relative link in a generated page`;
	let decoded: string;
	try {
		decoded = decodeURIComponent(before);
	} catch {
		return `${href}: does not decode`;
	}
	const target = resolve(repository, page.source.directory, decoded);
	const inside = relative(repository, target);
	if (inside === "" || inside.startsWith("..") || inside.split(sep).includes(".git")) return `${href}: not a file of the repository`;
	if (!existsSync(target)) return `${href}: the repository has no ${inside.split(sep).join("/")}`;
	const kind = statSync(target).isDirectory() ? REPOSITORY_FILES[1]! : REPOSITORY_FILES[0]!;
	return { href: `${kind}${inside.split(sep).map(encodeURIComponent).join("/")}${fragment === null ? "" : `#${fragment}`}` };
}

// ---------------------------------------------------------------- rendering

/** The text of a table's header, for the name of the box that scrolls it: its column headings, or its first column's when it has none. */
const tableWords = (table: Tokens.Table): string => {
	const heads = table.header.map((cell) => plain(cell.tokens).trim()).filter(Boolean);
	const words = (heads.length > 0 ? heads : table.rows.map((row) => plain(row[0]?.tokens).trim()).filter(Boolean)).join(", ");
	return words.length > 100 ? `${words.slice(0, 99)}…` : words;
};

/** Renders PAGE's tokens to HTML, with its links rewritten (LINKS) and its headings' ids. */
function render(page: Lexed, links: ReadonlyMap<Token, Rewritten>): string {
	const marked = new Marked({ gfm: true });
	const align = (value: Tokens.TableCell["align"]) => (value ? ` class="align-${value}"` : "");
	// Each table's box is a region a screen reader lists by name, so no two on a page share one.
	const named = new Map<string, number>();
	const tableName = (table: Tokens.Table) => {
		const words = tableWords(table);
		const count = (named.get(words) ?? 0) + 1;
		named.set(words, count);
		return `Table: ${words}${count > 1 ? ` (${count})` : ""}`;
	};
	marked.use({
		renderer: {
			heading(token) {
				const id = page.ids.get(token as Token);
				return `<h${token.depth}${id ? ` id="${escapeHtml(id)}"` : ""}>${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
			},
			link(token) {
				const to = links.get(token as Token) ?? { href: token.href };
				const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
				return `<a href="${escapeHtml(to.href)}"${to.target ? ` target="${to.target}"` : ""}${title}>${this.parser.parseInline(token.tokens)}</a>`;
			},
			code(token) {
				const lang = token.lang?.match(/^\S+/)?.[0];
				// Focusable, so that the keyboard can scroll a long line into view.
				return `<pre tabindex="0"><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(token.text)}</code></pre>\n`;
			},
			table(token) {
				const cell = (c: Tokens.TableCell, tag: "th" | "td", scope = "") => `<${tag}${scope}${align(c.align)}>${this.parser.parseInline(c.tokens)}</${tag}>`;
				// A table whose header row starts with an empty cell names its rows by its first column
				// (row headers); one whose header row is empty throughout has no header row at all.
				const empty = token.header.map((c) => c.text.trim() === "");
				const rowHeads = empty[0] === true;
				const head = empty.every(Boolean) ? "" : `<thead><tr>${token.header.map((c, i) => (i === 0 && rowHeads ? "<td></td>" : cell(c, "th", ' scope="col"'))).join("")}</tr></thead>\n`;
				const body = token.rows.map((row) => `<tr>${row.map((c, i) => (i === 0 && rowHeads ? cell(c, "th", ' scope="row"') : cell(c, "td"))).join("")}</tr>`).join("\n");
				// A wide table scrolls inside its own box, which the keyboard can reach and a screen reader names.
				return `<div class="table" role="region" tabindex="0" aria-label="${escapeHtml(tableName(token))}"><table>\n${head}${body ? `<tbody>\n${body}\n</tbody>\n` : ""}</table></div>\n`;
			},
		},
	});
	return marked.parser(page.tokens as Parameters<typeof marked.parser>[0]);
}

/**
 * The Markdown the site serves for a page: its source, with each relative link to a file of the
 * repository made its address on GitHub, since from https://ledgermath.com it would lead nowhere.
 */
function servedMarkdown(page: Lexed, links: ReadonlyMap<Token, Rewritten>): string {
	const source = page.source.markdown;
	if (page.source.directory === null) return source;
	const isRelative = (href: string) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("/") && !href.startsWith("#");
	// Each relative address as written, and where it goes: a reference definition's links share its address.
	const absolute = new Map<string, string>();
	for (const token of allTokens(page.tokens)) {
		const to = token.type === "link" ? links.get(token) : undefined;
		if (to && isRelative((token as Tokens.Link).href)) absolute.set((token as Tokens.Link).href, to.href);
	}
	if (absolute.size === 0) return source;
	// Each link is rewritten where it stands in the source, never text that only looks like one in
	// code: the tokens come in the source's order, so a cursor walks the source past each code span,
	// code block and link in turn, and a fenced block (which in a list the lexer holds de-indented,
	// unlike the source) is skipped whole.
	const fenced = fencedBlocks(source);
	const find = (raw: string, from: number): number => {
		let at = source.indexOf(raw, from);
		for (let block = fenced.find(([start, end]) => at >= start && at < end); at >= 0 && block; block = fenced.find(([start, end]) => at >= start && at < end)) at = source.indexOf(raw, block[1]);
		return at;
	};
	let out = "";
	let cursor = 0;
	for (const token of allTokens(page.tokens)) {
		if (token.type === "code" || token.type === "codespan") {
			const at = source.indexOf(token.raw, cursor);
			if (at >= 0) {
				out += source.slice(cursor, at + token.raw.length);
				cursor = at + token.raw.length;
			}
			continue;
		}
		if (token.type !== "link" && token.type !== "def") continue;
		const href = (token as Tokens.Link).href;
		const to = absolute.get(href);
		const at = find(token.raw, cursor);
		if (at < 0) continue;
		const changed = !to ? token.raw : token.type === "link" ? token.raw.replace(`](${href}`, `](${to}`) : token.raw.replace(`]: ${href}`, `]: ${to}`);
		out += source.slice(cursor, at) + changed;
		cursor = at + token.raw.length;
	}
	return out + source.slice(cursor);
}

/** Where SOURCE's fenced code blocks are, as [start, end) offsets: from a line opening with ``` or ~~~ (indented or not) to the line that closes it. */
function fencedBlocks(source: string): [number, number][] {
	const blocks: [number, number][] = [];
	let open: { fence: string; start: number } | null = null;
	let at = 0;
	for (const line of source.split("\n")) {
		const end = at + line.length + 1;
		if (open === null) {
			const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
			if (fence) open = { fence, start: at };
		} else if (new RegExp(`^\\s*${open.fence[0] === "`" ? "`" : "~"}{${open.fence.length},}\\s*$`).test(line)) {
			blocks.push([open.start, end]);
			open = null;
		}
		at = end;
	}
	if (open !== null) blocks.push([open.start, source.length]);
	return blocks;
}

// ---------------------------------------------------------------- the sources

/** Every *.md under DIR, as paths relative to it, sorted. */
function markdownFiles(dir: string, under = ""): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(join(dir, under), { withFileTypes: true })
		.flatMap((entry) => {
			const path = under ? `${under}/${entry.name}` : entry.name;
			if (entry.isDirectory()) return markdownFiles(dir, path);
			return entry.name.endsWith(".md") ? [path] : [];
		})
		.sort();
}

/** The API reference's Markdown, written by scripts/api-reference.ts into a new directory under WORK: its files, by path (docs/api/index.md, …). */
export function generateApiReference(repository: string, work: string): Map<string, string> {
	const out = mkdtempSync(join(work, ".api-reference-"));
	const run = Bun.spawnSync([process.execPath, join(repository, "scripts", "api-reference.ts"), "--out", out], { cwd: repository, stdout: "pipe", stderr: "pipe", env: process.env });
	if (run.exitCode !== 0) {
		const said = `${run.stderr.toString()}${run.stdout.toString()}`.trim();
		const packages = /Cannot find (package|module)|ResolveMessage/.test(said) ? " (it needs the repository's packages: run `bun install --frozen-lockfile` at the repository's root)" : "";
		throw new DocsError([`scripts/api-reference.ts failed${packages}: ${said}`]);
	}
	const files = new Map<string, string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.set(relative(out, path).split(sep).join("/"), readFileSync(path, "utf8"));
		}
	};
	walk(out);
	return files;
}

/** The benchmarks the schedule runs, in the home table's order, then any other by name. */
export function scheduledBenchmarks(repository: string): string[] {
	const schedule = JSON.parse(readFileSync(join(repository, "schedule.json"), "utf8")) as { benchmarks: { name: string }[] };
	const names = [...new Set(schedule.benchmarks.map((entry) => entry.name))];
	const order = HEADLINE_CHOICES.map((choice) => choice.benchmark);
	const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
	return names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Every page's source but /docs/'s contents, in the order of the navigation: REPOSITORY the
 * checkout, GENERATED the API reference's files (generateApiReference).
 */
export function docsSources(repository: string, generated: ReadonlyMap<string, string>): { sources: DocsSource[]; start: DocsSource | null; problems: string[] } {
	const problems: string[] = [];
	const api: DocsSource[] = [];
	const reference: DocsSource[] = [];
	const known = new Set<string>(DOCS_ADDRESSES);
	for (const [file, markdown] of generated) {
		const match = /^docs\/(.+)\.md$/.exec(file);
		const address = match ? addressOf(match[1]!) : null;
		if (!address || !known.has(address)) {
			problems.push(`scripts/api-reference.ts wrote ${file}, whose address scripts/lib/docs-addresses.ts does not list`);
			continue;
		}
		const source = { address, section: address.startsWith("/docs/api/") ? "api" : "reference", source: `${file}, written by scripts/api-reference.ts`, directory: null, markdown } as const;
		(source.section === "api" ? api : reference).push(source);
	}
	api.sort((a, b) => DOCS_ADDRESSES.indexOf(a.address as never) - DOCS_ADDRESSES.indexOf(b.address as never));

	const benchmarks: DocsSource[] = scheduledBenchmarks(repository).map((name) => {
		const file = join("benchmarks", name, "README.md");
		const path = join(repository, file);
		if (!existsSync(path)) problems.push(`${file} is missing: every benchmark the schedule runs has a page`);
		return { address: `${DOCS_HOME}benchmarks/${name}`, section: "benchmarks", source: file.split(sep).join("/"), directory: dirname(file), markdown: existsSync(path) ? readFileSync(path, "utf8") : `# ${name}\n` };
	});

	const content = join(repository, "site", "content", "docs");
	let start: DocsSource | null = null;
	for (const path of markdownFiles(content)) {
		const address = addressOf(path);
		const file = posix.join("site/content/docs", path);
		const source: DocsSource = { address, section: address === DOCS_HOME ? "start" : "reference", source: file, directory: dirname(file), markdown: readFileSync(join(content, path), "utf8") };
		if (address === DOCS_HOME) start = source;
		else reference.push(source);
	}
	const rank = (address: string) => (REFERENCE_ORDER.includes(address) ? REFERENCE_ORDER.indexOf(address) : REFERENCE_ORDER.length);
	reference.sort((a, b) => rank(a.address) - rank(b.address) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

	const sources = [...api, ...benchmarks, ...reference];
	const at = new Map<string, string>();
	for (const source of start ? [start, ...sources] : sources) {
		const there = at.get(source.address);
		if (there) problems.push(`${source.source} and ${there} are both at ${source.address}`);
		at.set(source.address, source.source);
	}
	return { sources, start, problems };
}

/** One line of a list of pages: its title, linking to HREF, and its description. */
const listLine = (title: string, href: string, description: string) => `- [${title.replace(/([\\[\]])/g, "\\$1")}](${href}): ${description}`;

/**
 * /docs/'s contents, as Markdown: every page but /docs/ itself, by section, each its title linking
 * to its page and its description (the first paragraph, as written). Under START (the start-here
 * page, site/content/docs/index.md) when there is one, under the heading CONTENTS_HEADING;
 * otherwise a page of its own, with CONTENTS_TITLE and CONTENTS_DESCRIPTION.
 */
export function contentsMarkdown(pages: readonly { address: string; section: SectionId; title: string; summary: string }[], start: string | null): string {
	const level = start === null ? "##" : "###";
	const blocks: string[] = start === null ? [`# ${CONTENTS_TITLE}`, CONTENTS_DESCRIPTION] : [start.trimEnd(), `## ${CONTENTS_HEADING}`];
	for (const section of SECTIONS) {
		const these = pages.filter((page) => page.section === section.id && page.address !== DOCS_HOME);
		if (these.length === 0) continue;
		blocks.push(`${level} ${section.title}`, these.map((page) => listLine(page.title, page.address, page.summary)).join("\n"));
	}
	return `${blocks.join("\n\n")}\n`;
}

/**
 * llms.txt, as its convention has it (https://llmstxt.org): the site's name as the title, what
 * LedgerMath is as a quote (the home page's description), a line on where the numbers are, then
 * each section's pages, each a link to its Markdown with its description. An index of the pages,
 * nothing of its own.
 */
export function llmsTxt(pages: readonly DocsPage[]): string {
	const blocks = [
		"# LedgerMath",
		`> ${HOME.description}`,
		`The numbers are a data API of static JSON files, starting at ${API_ORIGIN}v1/index.json. Each page below is plain Markdown; the same page as HTML is at its address without \`.md\` (without \`index.md\` for an address that ends in a slash).`,
	];
	for (const section of SECTIONS) {
		const these = pages.filter((page) => page.section === section.id);
		if (these.length === 0) continue;
		blocks.push(`## ${section.title}`, these.map((page) => listLine(page.title, `${SITE_ORIGIN}${page.markdownAddress}`, page.description)).join("\n"));
	}
	return `${blocks.join("\n\n")}\n`;
}

/** The pages llms.txt lists, as the checks read them back: each link's address and its title. */
export function readLlmsTxt(text: string): { title: string; url: string }[] {
	return [...text.matchAll(/^- \[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/gm)].map((match) => ({ title: match[1]!.replace(/\\(.)/g, "$1"), url: match[2]! }));
}

// ---------------------------------------------------------------- the application's modules

/** What the application holds of PAGE (src/docs/sections.ts). */
export const docMeta = (page: DocsPage): DocMeta => ({
	address: page.address,
	file: page.file,
	section: page.section,
	title: page.title,
	documentTitle: documentTitle(page.title),
	description: page.description,
	markdown: page.markdownAddress,
});

/** The name of a page's module and of its chunk: docs-api-series for /docs/api/series, docs for /docs/. */
export const chunkName = (address: string): string => address.replace(/^\/|\/$/g, "").replaceAll("/", "-");

/**
 * Writes the module the application imports as virtual:ledgermath-docs into DIR, and one module per
 * page beside it: DOC_PAGES, every page's meta, in the navigation's order; DOC_BODIES, each page's
 * body, a lazy() component whose module holds the page's HTML, so that each is a chunk of its own,
 * loaded when the router preloads a link to it or navigates there (src/app.tsx); and LOADED, the
 * pages whose body has loaded in this tab. Each lazy() is given its module's address under ROOT
 * (Vite's root), the key of the browser's build manifest that the server's render names the chunk
 * by, as Solid's Vite plugin would write it for a plain `lazy(() => import(…))`. Returns the
 * module's path.
 */
export function writeDocsModules(pages: readonly DocsPage[], dir: string, root: string): string {
	mkdirSync(join(dir, "pages"), { recursive: true });
	const modules = new Map<string, string>();
	for (const page of pages) {
		const file = join(dir, "pages", `${chunkName(page.address)}.tsx`);
		modules.set(page.address, file);
		// The page's HTML, rendered from its Markdown: on the server inlined into the page, in the
		// browser set as the article's innerHTML, which hydration leaves as the server wrote it.
		writeFileSync(file, `// ${page.address}, from ${page.source}. Written by site/scripts/docs.ts at build time.\nconst html = ${JSON.stringify(page.html)};\n\nexport default function Body() {\n\treturn <article class="prose" innerHTML={html} />;\n}\n`);
	}
	const entry = join(dir, "docs.tsx");
	writeFileSync(
		entry,
		[
			"// The documentation's pages, for the application (src/docs/content.d.ts). Written by site/scripts/docs.ts at build time.",
			'import { type Component, lazy } from "solid-js";',
			"",
			`export const DOC_PAGES = ${JSON.stringify(pages.map(docMeta), null, "\t")};`,
			"",
			"/** The pages whose body has loaded in this tab: a chunk once loaded is never asked for again. */",
			"export const LOADED = new Set<string>();",
			"",
			"const body = (address: string, load: () => Promise<{ default: Component }>, moduleUrl: string) =>",
			"\tlazy(() => load().then((module) => (LOADED.add(address), module)), undefined, moduleUrl);",
			"",
			"export const DOC_BODIES = {",
			...pages.map((page) => {
				const file = modules.get(page.address)!;
				return `\t${JSON.stringify(page.address)}: body(${JSON.stringify(page.address)}, () => import(${JSON.stringify(`./${relative(dir, file).split(sep).join("/")}`)}), ${JSON.stringify(relative(root, file).split(sep).join("/"))}),`;
			}),
			"};",
			"",
		].join("\n"),
	);
	return entry;
}

// ---------------------------------------------------------------- the whole

/**
 * Every documentation page, rendered, in the navigation's order; or a DocsError naming every
 * problem. REPOSITORY is the checkout; GENERATED the API reference's files.
 */
export function buildDocs(repository: string, generated: ReadonlyMap<string, string>): DocsPage[] {
	const { sources, start, problems } = docsSources(repository, generated);
	// /docs/'s contents are made from the other pages' titles and descriptions, so those come first.
	const lexedOthers = sources.map(lex);
	const contents = contentsMarkdown(
		lexedOthers.map((page) => ({ address: page.source.address, section: page.source.section, title: page.title, summary: page.summary })),
		start?.markdown ?? null,
	);
	const home: DocsSource = start
		? { ...start, markdown: contents }
		: { address: DOCS_HOME, section: "start", source: "/docs/'s contents, generated from the pages (scripts/docs.ts)", directory: null, markdown: contents };
	const lexed = [lex(home), ...lexedOthers];
	for (const page of lexed) problems.push(...page.problems);
	const byAddress = new Map(lexed.map((page) => [page.source.address, page]));
	// The list the generated pages' links are held to (tests/api-reference.test.ts), held to the pages both ways.
	for (const address of DOCS_ADDRESSES) if (!byAddress.has(address)) problems.push(`${address} is listed in scripts/lib/docs-addresses.ts, and no page is there`);
	for (const page of lexed) if (!isDocsAddress(page.source.address)) problems.push(`${page.source.source} is at ${page.source.address}, which scripts/lib/docs-addresses.ts does not list: add it there`);

	const pages: DocsPage[] = [];
	for (const page of lexed) {
		const links = new Map<Token, Rewritten>();
		for (const token of allTokens(page.tokens)) {
			if (token.type !== "link") continue;
			const found = rewrite((token as Tokens.Link).href, page, byAddress, repository);
			if (typeof found === "string") problems.push(`${page.source.source}: a link with no target, ${found}`);
			else links.set(token, found);
		}
		pages.push({
			address: page.source.address,
			section: page.source.section,
			source: page.source.source,
			file: pageFile(page.source.address),
			markdownFile: markdownFile(page.source.address),
			markdownAddress: `/${markdownFile(page.source.address)}`,
			title: page.title,
			description: page.description,
			summary: page.summary,
			markdown: servedMarkdown(page, links),
			html: render(page, links),
			ids: [...page.ids.values()],
		});
	}
	if (problems.length > 0) throw new DocsError(problems);
	return pages;
}
