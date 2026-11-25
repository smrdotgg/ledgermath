/**
 * Builds the site from one tree of the data API into static files.
 *
 *     bun run build --tree DIR [--out DIR]          (or LEDGERMATH_TREE=DIR bun run build)
 *
 * TREE is a directory in the API's own layout: v1/index.json, the Series list and the newest
 * price file at the places the table of contents' links give (src/data/tree.ts). Get one with
 * `bun run fetch-tree DIR` (scripts/fetch-tree.ts); in the `runs` workflow it will be the tree
 * the run just built. With no tree given, the build fails and says so: it never builds from
 * numbers nobody chose.
 *
 * The tree is read and checked first (src/data/tree.ts). Then Vite, with Solid's plugin, bundles
 * src/entry-server.tsx for the server, writing the stylesheet and the font beside it; the bundle
 * renders each page (src/pages.text.ts) once with Solid's server renderer; and the pages, with a
 * <link> to the stylesheet in their <head>, are written to OUT with the assets and public/.
 * Nothing hydrates and no JavaScript file is written: the one script is inline in each page's
 * <head> (it waits for the font). Every line the tree gives the build (what the page leaves out,
 * and why) is printed.
 *
 * What OUT (default dist/client, emptied first) holds:
 *   index.html, docs/index.html   the pages (src/pages.text.ts)
 *   assets/…                      the stylesheet and the font, their names hashed
 *   third-party-notices.txt …     public/, copied as it is
 *
 * Exit 0 when it built, 1 when it did not (with why), 2 on a bad command line or no tree.
 */

import solid from "@solidjs/vite-plugin";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { readTree } from "../src/data/tree";
import type { RenderedSite } from "../src/entry-server";

// Real paths: Vite loads modules by their real path.
export const SITE = realpathSync(resolve(import.meta.dir, ".."));
const ENTRY = join(SITE, "src", "entry-server.tsx");
const PUBLIC = join(SITE, "public");

/** The tree a command names: --tree DIR (or --tree=DIR), else LEDGERMATH_TREE; null when neither is given. */
export function treeArgument(argv: readonly string[], env: Record<string, string | undefined> = process.env): string | null {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--tree") return argv[i + 1] ?? null;
		if (arg.startsWith("--tree=")) return arg.slice("--tree=".length) || null;
	}
	return env.LEDGERMATH_TREE?.trim() || null;
}

/** The value of --NAME VALUE or --NAME=VALUE, if given. */
function option(argv: readonly string[], name: string): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === `--${name}`) return argv[i + 1];
		if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
	}
	return undefined;
}

export const NO_TREE =
	"no tree given: name a directory in the data API's layout with --tree DIR or LEDGERMATH_TREE=DIR " +
	"(get one with `bun run fetch-tree DIR`). The site is never built from numbers nobody chose.";

function filesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(path) : [path];
	});
}

type Manifest = Record<string, { file: string; css?: string[] }>;

export type BuildResult = { out: string; files: string[]; notes: readonly string[]; newestRunStartedAt: string };

/** Builds the site from the tree in TREE into OUT. Throws with the reason when it cannot. */
export async function buildSite(options: { tree: string; out: string; quiet?: boolean }): Promise<BuildResult> {
	const tree = readTree(options.tree);
	const out = resolve(options.out);
	const work = `${out}.building`;
	rmSync(work, { recursive: true, force: true });

	await build({
		configFile: false,
		root: SITE,
		base: "/",
		logLevel: options.quiet ? "error" : "warn",
		publicDir: false,
		plugins: [solid({ ssr: false })],
		build: {
			ssr: ENTRY,
			ssrEmitAssets: true,
			cssCodeSplit: false,
			cssMinify: true,
			outDir: join(work, "server"),
			emptyOutDir: true,
			manifest: true,
			copyPublicDir: false,
			rollupOptions: { output: { entryFileNames: "render.mjs" } },
		},
	});

	const manifestPath = join(work, "server", ".vite", "manifest.json");
	const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest) : {};
	const css = [...new Set(Object.values(manifest).flatMap((entry) => [entry.file, ...(entry.css ?? [])]).filter((file) => file.endsWith(".css")))];
	if (css.length === 0) throw new Error("the server build wrote no stylesheet");

	const module = (await import(`${pathToFileURL(join(work, "server", "render.mjs")).href}?t=${Date.now()}`)) as { render(tree: unknown): RenderedSite };
	const site = module.render(tree);

	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	if (existsSync(PUBLIC)) cpSync(PUBLIC, out, { recursive: true });
	for (const file of filesUnder(join(work, "server"))) {
		if (file.endsWith(".js") || file.endsWith(".mjs") || file.includes(`${sep}.vite${sep}`)) continue;
		const to = join(out, relative(join(work, "server"), file));
		mkdirSync(dirname(to), { recursive: true });
		cpSync(file, to);
	}
	const head = css.map((file) => `<link rel="stylesheet" href="/${file}">`).join("");
	for (const { page, html } of site.pages) {
		if (!/<\/head>/i.test(html)) throw new Error(`${page.path} renders no <head>: Document.tsx must render the whole <html> document`);
		let text = html.replace(/<\/head>/i, `${head}</head>`);
		if (!/^\s*<!doctype/i.test(text)) text = `<!DOCTYPE html>${text}`;
		const file = join(out, page.file);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
	rmSync(work, { recursive: true, force: true });
	return { out, files: filesUnder(out).map((file) => relative(out, file)), notes: site.notes, newestRunStartedAt: tree.index.newest_run_started_at };
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const tree = treeArgument(argv);
	if (!tree) {
		console.error(NO_TREE);
		process.exit(2);
	}
	const out = option(argv, "out") ?? join(SITE, "dist", "client");
	const started = performance.now();
	try {
		const result = await buildSite({ tree, out });
		for (const note of result.notes) console.log(`note: ${note}`);
		console.log(
			`built the site from the tree at ${tree} (newest Run ${result.newestRunStartedAt}) in ${Math.round(performance.now() - started)} ms -> ${relative(process.cwd(), result.out) || "."}: ${result.files.join(", ")}`,
		);
	} catch (error) {
		console.error(`the site does not build from the tree at ${tree}:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		process.exit(1);
	}
}
