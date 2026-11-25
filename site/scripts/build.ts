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
 * <link> to the stylesheet in their <head>, are written with the assets and public/. Nothing
 * hydrates and no JavaScript file is written: the one script is inline in each page's <head>
 * (it waits for the font). Every line the tree gives the build (what the page leaves out, and
 * why) is printed.
 *
 * What OUT (default dist/client) holds:
 *   index.html, docs/index.html   the pages (src/pages.text.ts)
 *   assets/…                      the stylesheet and the font, their names hashed
 *   third-party-notices.txt …     public/, copied as it is
 *   .ledgermath-site-build        BUILD_MARK: says a build of this script wrote the directory
 *
 * OUT is replaced whole, so the build guards it (outputProblem): it refuses an empty --out, an
 * output that is or holds the repository, one inside the repository anywhere but under
 * site/dist/ (where the sources are, it could overwrite them), and one that is, holds or is
 * inside the tree it reads. It builds into a new directory of its own, with a unique name, beside
 * OUT, and only then puts it in OUT's place, and only when OUT is absent, empty, or a directory
 * this script wrote (it holds BUILD_MARK). Anything else at OUT is left as it is, and the build
 * fails before writing anything.
 *
 * Exit 0 when it built, 1 when it did not (with why), 2 on a bad command line or no tree.
 */

import solid from "@solidjs/vite-plugin";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { readTree } from "../src/data/tree";
import type { RenderedSite } from "../src/entry-server";

// Real paths: Vite loads modules by their real path.
export const SITE = realpathSync(resolve(import.meta.dir, ".."));
/** The repository's root, which site/ is directly inside. */
export const REPOSITORY = dirname(SITE);
/** Where inside the repository a build may write: site/dist/, which git ignores. */
export const BUILD_AREA = join(SITE, "dist");
const ENTRY = join(SITE, "src", "entry-server.tsx");
const PUBLIC = join(SITE, "public");

/**
 * The file a build leaves in its output, so that the next build can tell the directory is one
 * it may replace. It is served with the rest of the site, so its words name nothing private.
 */
export const BUILD_MARK = ".ledgermath-site-build";
const BUILD_MARK_TEXT = "This directory was written by the LedgerMath site's build, which replaces it whole when it builds again.\n";

/** The tree a command names: --tree DIR (or --tree=DIR), else LEDGERMATH_TREE; null when neither is given. */
export function treeArgument(argv: readonly string[], env: Record<string, string | undefined> = process.env): string | null {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--tree") return argv[i + 1] ?? null;
		if (arg.startsWith("--tree=")) return arg.slice("--tree=".length) || null;
	}
	return env.LEDGERMATH_TREE?.trim() || null;
}

/** The value of --NAME VALUE or --NAME=VALUE: undefined when not given, "" when given without a value. */
export function option(argv: readonly string[], name: string): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === `--${name}`) return argv[i + 1] === undefined || argv[i + 1]!.startsWith("--") ? "" : argv[i + 1];
		if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
	}
	return undefined;
}

export const NO_TREE =
	"no tree given: name a directory in the data API's layout with --tree DIR or LEDGERMATH_TREE=DIR " +
	"(get one with `bun run fetch-tree DIR`). The site is never built from numbers nobody chose.";

/** PATH as the file system resolves it, symbolic links followed, though its last parts may not exist yet. */
function realPath(path: string): string {
	const absolute = resolve(path);
	let existing = absolute;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	return join(realpathSync(existing), relative(existing, absolute));
}

/** True when A is B or inside it. */
const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);

/** Why OUT may not be the output of a build that reads the tree at TREE, or null when it may; see the comment at the top. */
export function outputProblem(out: string, tree: string): string | null {
	if (out.trim() === "") return "the output directory is empty: name one with --out DIR, or leave --out out for dist/client";
	const o = realPath(out);
	const t = realPath(tree);
	if (within(REPOSITORY, o)) return `${out} is or holds the repository (${REPOSITORY}), which the build would replace`;
	if (within(o, REPOSITORY) && !within(o, BUILD_AREA)) return `${out} is inside the repository but not under ${relative(REPOSITORY, BUILD_AREA)}/, where the build writes: it could overwrite the sources`;
	if (within(o, t) || within(t, o)) return `${out} is, holds or is inside the tree the site is built from (${t})`;
	if (existsSync(o)) {
		if (!statSync(o).isDirectory()) return `${out} exists and is not a directory`;
		const entries = readdirSync(o);
		if (entries.length > 0 && !entries.includes(BUILD_MARK)) {
			return `${out} exists, holds files, and was not written by this build (it has no ${BUILD_MARK}): give a new or empty directory, or one this build wrote`;
		}
	}
	return null;
}

function filesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(path) : [path];
	});
}

type Manifest = Record<string, { file: string; css?: string[] }>;

export type BuildResult = { out: string; files: string[]; notes: readonly string[]; newestRunStartedAt: string | null };

/** Builds the site from the tree in TREE into OUT. Throws with the reason when it cannot, leaving OUT as it was. */
export async function buildSite(options: { tree: string; out: string; quiet?: boolean }): Promise<BuildResult> {
	const tree = readTree(options.tree);
	const problem = outputProblem(options.out, options.tree);
	if (problem) throw new Error(problem);
	const out = realPath(options.out);
	mkdirSync(dirname(out), { recursive: true });
	mkdirSync(BUILD_AREA, { recursive: true });
	// The build's own directories, new and named uniquely: the server bundle under site/dist/ (it
	// imports Solid from site/node_modules), and the site beside OUT (so on the same file system),
	// which then takes OUT's place.
	const server = mkdtempSync(join(BUILD_AREA, ".server-"));
	const work = mkdtempSync(join(dirname(out), `.${basename(out)}.building-`));
	try {
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
				outDir: server,
				emptyOutDir: true,
				manifest: true,
				copyPublicDir: false,
				rollupOptions: { output: { entryFileNames: "render.mjs" } },
			},
		});

		const manifestPath = join(server, ".vite", "manifest.json");
		const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest) : {};
		const css = [...new Set(Object.values(manifest).flatMap((entry) => [entry.file, ...(entry.css ?? [])]).filter((file) => file.endsWith(".css")))];
		if (css.length === 0) throw new Error("the server build wrote no stylesheet");

		const module = (await import(`${pathToFileURL(join(server, "render.mjs")).href}?t=${Date.now()}`)) as { render(tree: unknown): RenderedSite };
		const site = module.render(tree);

		const built = join(work, "site");
		mkdirSync(built);
		if (existsSync(PUBLIC)) cpSync(PUBLIC, built, { recursive: true });
		for (const file of filesUnder(server)) {
			if (file.endsWith(".js") || file.endsWith(".mjs") || file.includes(`${sep}.vite${sep}`)) continue;
			const to = join(built, relative(server, file));
			mkdirSync(dirname(to), { recursive: true });
			cpSync(file, to);
		}
		const head = css.map((file) => `<link rel="stylesheet" href="/${file}">`).join("");
		for (const { page, html } of site.pages) {
			if (!/<\/head>/i.test(html)) throw new Error(`${page.path} renders no <head>: Document.tsx must render the whole <html> document`);
			let text = html.replace(/<\/head>/i, `${head}</head>`);
			if (!/^\s*<!doctype/i.test(text)) text = `<!DOCTYPE html>${text}`;
			const file = join(built, page.file);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, text);
		}
		writeFileSync(join(built, BUILD_MARK), BUILD_MARK_TEXT);

		// Into OUT's place: asked again now, since OUT may have changed while the site was built.
		const late = outputProblem(options.out, options.tree);
		if (late) throw new Error(late);
		if (existsSync(out)) {
			const previous = join(work, "previous");
			renameSync(out, previous);
			try {
				renameSync(built, out);
			} catch (error) {
				renameSync(previous, out);
				throw error;
			}
		} else {
			renameSync(built, out);
		}
		return { out, files: filesUnder(out).map((file) => relative(out, file)), notes: site.notes, newestRunStartedAt: tree.index.newest_run_started_at };
	} finally {
		// Only the build's own directories: the server bundle, and the site's, with the previous output it replaced.
		rmSync(server, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const tree = treeArgument(argv);
	if (!tree) {
		console.error(NO_TREE);
		process.exit(2);
	}
	const given = option(argv, "out");
	if (given !== undefined && given.trim() === "") {
		console.error("--out was given without a directory: name one, or leave --out out for dist/client");
		process.exit(2);
	}
	const out = given ?? join(SITE, "dist", "client");
	const started = performance.now();
	try {
		const result = await buildSite({ tree, out });
		for (const note of result.notes) console.log(`note: ${note}`);
		console.log(
			`built the site from the tree at ${tree} (newest Run ${result.newestRunStartedAt ?? "none"}) in ${Math.round(performance.now() - started)} ms -> ${relative(process.cwd(), result.out) || "."}: ${result.files.join(", ")}`,
		);
	} catch (error) {
		console.error(`the site does not build from the tree at ${tree}:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		process.exit(1);
	}
}
