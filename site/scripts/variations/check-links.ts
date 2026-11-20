/**
 * Checks that every page the picker links to works, as a browser would find it on the host
 * (run by `bun run check`, after `bun run build`):
 *
 *  - every same-origin <a href> on the picker (DIR/index.html) names a file in DIR: a page
 *    (an address ending in "/", or a directory) must have its index.html;
 *  - each such page holds at least 20 characters of text in its body outside its scripts;
 *  - every stylesheet, script, font, image and other file the page loads is in DIR at the address
 *    the page asks for. Addresses are resolved as a browser resolves them: against the page's
 *    <base href> if it has one, else against the page's own address; a stylesheet's url() and
 *    @import against the stylesheet's address; a module's imports against the module's.
 *    Stylesheets and modules are followed to what they load in turn.
 *
 * The host: a static host serves /x/index.html at /x/, and may also serve it at /x, without
 * redirecting to /x/. Vercel's default (no trailingSlash setting, as site/deploy/deploy.sh
 * deploys) is not to redirect, so each page is also checked as if loaded from its address
 * without the slash, where a relative address like "assets/a.css" resolves to /assets/a.css.
 * --host-redirects says the host redirects /x to /x/, and skips that.
 *
 *     bun scripts/variations/check-links.ts [DIR] [--host-redirects]     (DIR defaults to dist/client)
 *
 * What a page loads is read from: <link> with rel stylesheet, preload, modulepreload, prefetch,
 * icon, apple-touch-icon, mask-icon or manifest (href, imagesrcset); <script src> and module
 * imports in inline scripts; src and srcset on img, source, audio, video, track, iframe, embed,
 * input; poster on video; data on object; href and xlink:href on SVG image and use; url() in
 * <style> and style attributes. Links a reader follows (<a>, <area>) are not loads, nor are
 * other <link> rels (canonical, alternate, license). URLs that JavaScript builds are not read.
 *
 * Exit 0 when every link works, 1 when one does not (each problem listed).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { bodyText, cssReferences, decodeEntities, jsReferences, srcsetUrls } from "../check-output";

const ORIGIN = "https://host.invalid";
const MIN_TEXT = 20; // low on purpose: the forms with under 5 words hold little but a name and figures
const LOADING_RELS = new Set(["stylesheet", "preload", "modulepreload", "prefetch", "icon", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon", "manifest"]);
const SRC_ELEMENTS = new Set(["img", "source", "audio", "video", "track", "iframe", "embed", "input", "script"]);
const FONT = /\.(woff2?|ttf|otf|eot)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;

type Load = { url: string; kind: string };

function attributesOf(text: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const a of text.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
		const name = (a[1] ?? "").toLowerCase();
		if (!found.has(name)) found.set(name, decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
	}
	return found;
}

function kindOf(url: string, fallback: string): string {
	const path = url.split(/[?#]/)[0] ?? "";
	if (FONT.test(path)) return "font";
	if (IMAGE.test(path)) return "image";
	if (/\.css$/i.test(path)) return "stylesheet";
	if (/\.m?js$/i.test(path)) return "script";
	return fallback;
}

/** What an HTML page loads, and its <base href>, if any. */
export function pageLoads(html: string): { base: string | null; loads: Load[] } {
	const loads: Load[] = [];
	let base: string | null = null;
	let text = html.replace(/<!--[\s\S]*?-->/g, "");
	text = text.replace(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi, (_, attributes: string, body: string) => {
		for (const url of jsReferences(body)) loads.push({ url, kind: "script" });
		return `<script${attributes}>`;
	});
	text = text.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_, body: string) => {
		for (const url of cssReferences(body)) loads.push({ url, kind: kindOf(url, "file") });
		return "";
	});
	for (const tag of text.matchAll(/<([a-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
		const element = (tag[1] ?? "").toLowerCase();
		const attributes = attributesOf(tag[2] ?? "");
		const style = attributes.get("style");
		if (style) for (const url of cssReferences(style)) loads.push({ url, kind: kindOf(url, "file") });
		if (element === "base" && attributes.has("href") && base === null) base = attributes.get("href")!;
		if (element === "link") {
			const rels = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
			if (!rels.some((rel) => LOADING_RELS.has(rel))) continue;
			const as = attributes.get("as");
			const fallback = rels.includes("stylesheet") ? "stylesheet" : as === "font" ? "font" : as === "image" ? "image" : as === "script" || rels.includes("modulepreload") ? "script" : "file";
			if (attributes.get("href")) loads.push({ url: attributes.get("href")!, kind: kindOf(attributes.get("href")!, fallback) });
			for (const url of srcsetUrls(attributes.get("imagesrcset") ?? "")) loads.push({ url, kind: "image" });
			continue;
		}
		if (SRC_ELEMENTS.has(element) && attributes.get("src")) loads.push({ url: attributes.get("src")!, kind: element === "script" ? "script" : kindOf(attributes.get("src")!, element === "img" || element === "input" ? "image" : "file") });
		if ((element === "img" || element === "source") && attributes.get("srcset")) for (const url of srcsetUrls(attributes.get("srcset")!)) loads.push({ url, kind: "image" });
		if (element === "video" && attributes.get("poster")) loads.push({ url: attributes.get("poster")!, kind: "image" });
		if (element === "object" && attributes.get("data")) loads.push({ url: attributes.get("data")!, kind: "file" });
		if (element === "image" || element === "use") {
			const href = attributes.get("href") ?? attributes.get("xlink:href");
			if (href && !href.startsWith("#")) loads.push({ url: href, kind: element === "image" ? "image" : "file" });
		}
	}
	return { base, loads };
}

export type LinkReport = { pages: { address: string; loads: number; ok: boolean }[]; problems: string[] };

/** Checks the links of the picker in DIR; see the comment at the top. */
export function checkLinks(root: string, options: { hostRedirects?: boolean } = {}): LinkReport {
	const dir = resolve(root);
	const problems: string[] = [];
	const pages: LinkReport["pages"] = [];
	const picker = join(dir, "index.html");
	if (!existsSync(picker)) return { pages, problems: [`${relative(process.cwd(), picker)} is missing (run \`bun run build\` first)`] };

	/** The file a same-origin URL names in DIR, or why there is none. */
	const fileFor = (url: URL): { file: string } | { missing: string } => {
		let path = url.pathname;
		try {
			path = decodeURIComponent(path);
		} catch {}
		const target = join(dir, path);
		if (target !== dir && !target.startsWith(dir + sep)) return { missing: "outside the site" };
		if (path.endsWith("/")) return existsSync(join(target, "index.html")) ? { file: join(target, "index.html") } : { missing: "which the site lacks" };
		if (!existsSync(target)) return { missing: "which the site lacks" };
		if (statSync(target).isDirectory()) return { missing: "a directory, not a file" };
		return { file: target };
	};

	// Same-origin links on the picker, by address.
	const links = new Set<string>(["/"]);
	const pickerHtml = readFileSync(picker, "utf8").replace(/<!--[\s\S]*?-->/g, "");
	for (const tag of pickerHtml.matchAll(/<(?:a|area)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
		const href = attributesOf(tag[1] ?? "").get("href")?.trim();
		if (!href || href.startsWith("#")) continue;
		const url = new URL(href, `${ORIGIN}/`);
		if (url.origin !== ORIGIN) continue;
		links.add(url.pathname);
	}

	for (const link of [...links].sort()) {
		const url = new URL(link, ORIGIN);
		const isPage = link.endsWith("/") || (existsSync(join(dir, decodeURI(link))) && statSync(join(dir, decodeURI(link))).isDirectory());
		if (!isPage) {
			const found = fileFor(url);
			if ("missing" in found) problems.push(`the picker links to ${link}: ${found.missing}`);
			continue;
		}
		const address = link.endsWith("/") ? link : `${link}/`;
		const found = fileFor(new URL(address, ORIGIN));
		if ("missing" in found) {
			problems.push(`the picker links to ${link}, but ${address}index.html is missing`);
			pages.push({ address, loads: 0, ok: false });
			continue;
		}
		const before = problems.length;
		const html = readFileSync(found.file, "utf8");
		if (bodyText(html).trim().length < MIN_TEXT) problems.push(`${address} is empty: under ${MIN_TEXT} characters of text in its body outside its scripts`);
		const { base, loads } = pageLoads(html);
		// The addresses the page is reached at: its own, and without the slash unless the host redirects that.
		const reachedAt = [address, ...(options.hostRedirects || address === "/" ? [] : [address.slice(0, -1)])];
		const seen = new Map<string, string | null>(); // resolved path -> its problem, if any, for one address
		const reported = new Set<string>(); // resolved paths found missing, from any address: one problem each
		let count = 0;
		const missing = (reached: string, load: Load, ref: string, via: string, target: URL, why: string) => {
			if (reported.has(target.pathname)) return;
			reported.add(target.pathname);
			problems.push(`${reached}: ${load.kind} ${JSON.stringify(ref)}${via} -> ${target.pathname}: ${why}`);
		};
		const follow = (load: Load, from: URL, reached: string, chain: string[]): void => {
			const ref = load.url.trim();
			if (ref === "" || ref.startsWith("#") || /^(data|about|blob|javascript|mailto|tel):/i.test(ref)) return;
			let target: URL;
			try {
				target = new URL(ref, from);
			} catch {
				problems.push(`${reached}: ${load.kind} ${JSON.stringify(ref)} is not a valid address`);
				return;
			}
			if (target.origin !== ORIGIN) {
				problems.push(`${reached}: loads a ${load.kind} from another origin: ${ref}`);
				return;
			}
			const key = `${target.pathname}`;
			const via = chain.length ? ` (from ${chain.join(" -> ")})` : "";
			if (seen.has(key)) {
				const problem = seen.get(key);
				if (problem) missing(reached, load, ref, via, target, problem);
				return;
			}
			if (reached === address) count += 1;
			const file = fileFor(target);
			seen.set(key, "missing" in file ? file.missing : null);
			if ("missing" in file) {
				missing(reached, load, ref, via, target, file.missing);
				return;
			}
			const ext = extname(file.file).toLowerCase();
			if (ext === ".css") for (const url of cssReferences(readFileSync(file.file, "utf8"))) follow({ url, kind: kindOf(url, "file") }, target, reached, [...chain, target.pathname]);
			else if (ext === ".js" || ext === ".mjs") for (const url of jsReferences(readFileSync(file.file, "utf8"))) follow({ url, kind: "script" }, target, reached, [...chain, target.pathname]);
		};
		for (const reached of reachedAt) {
			seen.clear();
			const pageUrl = new URL(reached, ORIGIN);
			const from = base ? new URL(base, pageUrl) : pageUrl;
			for (const load of loads) follow(load, from, reached, []);
		}
		pages.push({ address, loads: count, ok: problems.length === before });
	}
	return { pages, problems: [...new Set(problems)] };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const root = args.find((arg) => !arg.startsWith("--")) ?? join(import.meta.dir, "..", "..", "dist", "client");
	const hostRedirects = args.includes("--host-redirects");
	const { pages, problems } = checkLinks(root, { hostRedirects });
	if (problems.length > 0) {
		for (const problem of problems) console.error(problem);
		console.error(`${problems.length} problem${problems.length === 1 ? "" : "s"} in the ${pages.length} pages the picker links to`);
		process.exit(1);
	}
	const loads = pages.reduce((sum, page) => sum + page.loads, 0);
	console.log(`the picker links to ${pages.length} pages; each is there, holds text, and every one of the ${loads} files they load is there${hostRedirects ? "" : ", from each page's address with and without its trailing slash"}`);
}
