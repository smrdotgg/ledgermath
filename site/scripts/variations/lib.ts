/**
 * Building one page of the home-page variations: a design (src/variations/v<n>/) or the
 * picker (src/picker/), each on its own, into a directory of static files served at a base
 * path. Used by build-one.ts, build-all.ts, shots.ts, check.ts and the publish script.
 *
 * A page is rendered once, at build time, with Solid's server renderer
 * (src/variations/entry-server.tsx renders the slot's Document around its Page). The result
 * is plain HTML and CSS: nothing hydrates, so the snapshot the page reads never reaches the
 * browser and the page reads the same with JavaScript off. A design that wants a little
 * behaviour in the browser adds a client.ts to its directory; it is bundled on its own and
 * loaded as a module script, and must not import the data module.
 *
 * What one build writes to OUT (served at BASE, e.g. /v3/):
 *   index.html                 the page, with <link>s to its CSS and its client.ts, if any
 *   assets/…                   the CSS, fonts and images the page imports, hashed
 *   …                          the slot's public/ directory, copied as it is
 *   third-party-notices.txt    the slot's own, if it has one
 *
 * A slot may import only from its own directory, from src/data/ (and the snapshot it reads)
 * and from installed packages. Anything else, another design's directory above all, fails
 * the build.
 */

import solid from "@solidjs/vite-plugin";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "vite";

// Real paths: Vite loads modules by their real path, and the publish script builds checkpoints in a
// temporary worktree whose node_modules is a link to this one's.
export const SITE = realpathSync(resolve(import.meta.dir, "..", ".."));
export const SLOTS = ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"] as const;
export type Slot = (typeof SLOTS)[number];
export type Page = Slot | "picker";

export const VARIATIONS = join(SITE, "src", "variations");
const DATA = join(SITE, "src", "data");
const SNAPSHOT = join(SITE, "data", "snapshot");
const ENTRY = join(VARIATIONS, "entry-server.tsx");
const NODE_MODULES = existsSync(join(SITE, "node_modules")) ? realpathSync(join(SITE, "node_modules")) : join(SITE, "node_modules");

export function isSlot(name: string): name is Slot {
	return (SLOTS as readonly string[]).includes(name);
}

/** The slot named on a command line, or exit 2 with how to name one. */
export function slotArgument(name: string | undefined, usage: string): Slot {
	if (name && isSlot(name)) return name;
	console.error(`${name === undefined ? "no design named" : `not a design: ${name}`}; name one of ${SLOTS.join(", ")}\n${usage}`);
	process.exit(2);
}

export function pageDir(page: Page): string {
	return page === "picker" ? join(SITE, "src", "picker") : join(VARIATIONS, page);
}

/** The flags of a command line (--name value, --name=value, or a bare --name for one of BOOLEANS) and the words that are not flags. */
export function parseArgs(argv: string[], booleans: readonly string[] = []): { words: string[]; flags: Map<string, string | true> } {
	const words: string[] = [];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) {
			words.push(arg);
			continue;
		}
		const [name, value] = arg.slice(2).split(/=(.*)/s, 2);
		if (value !== undefined) flags.set(name!, value);
		else if (!booleans.includes(name!) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) flags.set(name!, argv[++i]!);
		else flags.set(name!, true);
	}
	return { words, flags };
}

function within(file: string, dir: string): boolean {
	return file === dir || file.startsWith(dir + sep);
}

/** Fails the build when the page loads a module from outside what it may use. */
function fence(page: Page, environment: "server" | "client"): Plugin {
	const own = pageDir(page);
	const allowed = environment === "server" ? [own, DATA, SNAPSHOT, NODE_MODULES, ENTRY, join(VARIATIONS, "slot.d.ts")] : [own, NODE_MODULES];
	return {
		name: "ledgermath-variation-fence",
		enforce: "pre",
		load(id) {
			const file = id.split("?")[0]!;
			if (file.startsWith("\0") || !file.startsWith("/")) return null;
			if (allowed.some((dir) => within(file, dir))) return null;
			const where = relative(SITE, file);
			const hint =
				environment === "client" && (within(file, DATA) || within(file, SNAPSHOT))
					? "client.ts runs in the browser and may not import the data module (it would ship the snapshot); put what it needs in the HTML"
					: `a page may import only from its own directory (${relative(SITE, own)}/), src/data/ and installed packages`;
			this.error(`${relative(SITE, own)} imports ${where}: ${hint}`);
		},
	};
}

function filesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(path) : [path];
	});
}

type Manifest = Record<string, { file: string; isEntry?: boolean; css?: string[] }>;

function readManifest(dir: string): Manifest {
	const path = join(dir, ".vite", "manifest.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Manifest) : {};
}

export type BuildResult = { out: string; base: string; files: string[]; css: string[]; client: string | null };

/**
 * Builds PAGE into OUT, served at BASE (which starts and ends with "/"). OUT is emptied first.
 * Throws with the build's or the render's error when the page does not build.
 */
export async function buildPage(page: Page, options: { out: string; base: string; quiet?: boolean }): Promise<BuildResult> {
	const own = pageDir(page);
	const out = resolve(options.out);
	const base = options.base;
	if (!/^\/(.*\/)?$/.test(base)) throw new Error(`the base must start and end with "/": ${base}`);
	for (const file of ["Page.tsx", "Document.tsx"]) {
		if (!existsSync(join(own, file))) throw new Error(`${relative(SITE, own)}/${file} is missing`);
	}
	const work = `${out}.building`;
	rmSync(work, { recursive: true, force: true });
	const logLevel = options.quiet ? "error" : "warn";

	// The page, rendered on the server: its CSS and assets come out beside the server bundle.
	await build({
		configFile: false,
		root: SITE,
		base,
		logLevel,
		publicDir: false,
		plugins: [fence(page, "server"), solid({ ssr: false })],
		resolve: { alias: { "@slot": own } },
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

	// The slot's own browser script, if it has one.
	const clientEntry = ["client.ts", "client.js"].map((name) => join(own, name)).find((path) => existsSync(path));
	if (clientEntry) {
		await build({
			configFile: false,
			root: SITE,
			base,
			logLevel,
			publicDir: false,
			plugins: [fence(page, "client")],
			build: {
				outDir: join(work, "client"),
				emptyOutDir: true,
				manifest: true,
				copyPublicDir: false,
				modulePreload: false,
				rollupOptions: { input: clientEntry, output: { entryFileNames: "assets/client-[hash].js" } },
			},
		});
	}

	const serverManifest = readManifest(join(work, "server"));
	const css = Object.values(serverManifest)
		.map((entry) => entry.file)
		.filter((file) => file.endsWith(".css"));
	const clientManifest = readManifest(join(work, "client"));
	const clientFile = Object.values(clientManifest).find((entry) => entry.isEntry)?.file ?? null;
	const clientCss = Object.values(clientManifest).flatMap((entry) => entry.css ?? []);

	const module = (await import(`${pathToFileURL(join(work, "server", "render.mjs")).href}?t=${Date.now()}`)) as { render(): string };
	let html = module.render();
	if (!/<\/head>/i.test(html)) throw new Error(`${relative(SITE, own)}/Document.tsx renders no <head>: it must render the whole <html> document`);
	const head = [
		...[...css, ...clientCss].map((file) => `<link rel="stylesheet" href="${base}${file}">`),
		...(clientFile ? [`<script type="module" src="${base}${clientFile}"></script>`] : []),
	].join("");
	html = html.replace(/<\/head>/i, `${head}</head>`);
	if (!/^\s*<!doctype/i.test(html)) html = `<!DOCTYPE html>${html}`;

	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	// The slot's public/ first, so a built file of the same name wins.
	if (existsSync(join(own, "public"))) cpSync(join(own, "public"), out, { recursive: true });
	for (const [from, keep] of [
		[join(work, "server"), (file: string) => !file.endsWith(".js") && !file.endsWith(".mjs") && !file.includes(`${sep}.vite${sep}`)],
		[join(work, "client"), (file: string) => !file.includes(`${sep}.vite${sep}`)],
	] as const) {
		for (const file of filesUnder(from)) {
			if (!keep(file)) continue;
			const to = join(out, relative(from, file));
			mkdirSync(dirname(to), { recursive: true });
			cpSync(file, to);
		}
	}
	const notices = join(own, "third-party-notices.txt");
	if (existsSync(notices)) cpSync(notices, join(out, "third-party-notices.txt"));
	writeFileSync(join(out, "index.html"), html);
	rmSync(work, { recursive: true, force: true });

	return { out, base, files: filesUnder(out).map((file) => relative(out, file)), css, client: clientFile };
}

/** Serves ROOT as a static host would (a directory's index.html for the directory), on a free port unless PORT is given. */
export function serveDir(root: string, port = 0): { url: string; stop(): void } {
	const dir = resolve(root);
	const server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		fetch(request) {
			let path: string;
			try {
				path = decodeURIComponent(new URL(request.url).pathname);
			} catch {
				return new Response("Bad request", { status: 400 });
			}
			let file = resolve(dir, `.${path}`);
			if (!within(file, dir)) return new Response("Not found", { status: 404 });
			if (existsSync(file) && statSync(file).isDirectory()) {
				if (!path.endsWith("/")) return Response.redirect(`${path}/`, 308);
				file = join(file, "index.html");
			}
			if (!existsSync(file)) return new Response("Not found", { status: 404 });
			return new Response(Bun.file(file));
		},
	});
	return { url: server.url.href.replace(/\/$/, ""), stop: () => server.stop(true) };
}
