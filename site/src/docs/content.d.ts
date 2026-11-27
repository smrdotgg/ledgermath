// The two modules the build gives the application that are not files of src/.

/**
 * The documentation's pages, rendered from their Markdown at build time (scripts/docs.ts,
 * writeDocsModules; scripts/build.ts resolves the name to the module it wrote). DOC_PAGES' shape
 * is DocMeta's (./sections.ts), written out: an ambient module cannot import a relative one.
 */
declare module "virtual:ledgermath-docs" {
	import type { Component } from "solid-js";
	/** Every page's meta, in the navigation's order. */
	export const DOC_PAGES: readonly {
		address: string;
		file: string;
		section: "start" | "api" | "benchmarks" | "reference";
		title: string;
		documentTitle: string;
		description: string;
		markdown: string;
	}[];
	/** Each page's body by its address: a lazy() component, its HTML a chunk of its own. */
	export const DOC_BODIES: Readonly<Record<string, Component & { preload(): Promise<unknown> }>>;
	/** The addresses of the pages whose body has loaded in this tab, through DOC_BODIES. */
	export const LOADED: Set<string>;
}

/** The browser's build manifest, which Solid's Vite plugin gives the server's build: what the server renderer needs to say which chunks a page's lazy() components are. */
declare module "virtual:solid-manifest" {
	const manifest: import("@solidjs/web").AssetManifest;
	export default manifest;
}
