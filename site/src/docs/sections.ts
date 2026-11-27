// The documentation's sections and what the application knows of each page. Plain TypeScript with
// no JSX, shared by the build (scripts/docs.ts, which renders the pages from Markdown) and the
// application (src/app.tsx and the navigation in ./Page.tsx, which the build hands each page's
// meta as a generated module: virtual:ledgermath-docs, see ./content.d.ts).

export type SectionId = "start" | "api" | "benchmarks" | "reference";

/** The sections, in order: of the navigation on every documentation page, of /docs/'s contents and of llms.txt. */
export const SECTIONS: readonly { id: SectionId; title: string }[] = [
	{ id: "start", title: "Start here" },
	{ id: "api", title: "API reference" },
	{ id: "benchmarks", title: "Benchmarks" },
	{ id: "reference", title: "Machines, Methods, prices and the glossary" },
];

/** The documentation's first page. */
export const DOCS_HOME = "/docs/";

/** What the application holds of a documentation page; its body is a chunk of its own, loaded ahead (src/app.tsx). */
export type DocMeta = {
	/** Its address: /docs/glossary, /docs/api/. */
	address: string;
	/** Its HTML file in the built site, which the host serves at its own address too. */
	file: string;
	section: SectionId;
	/** The page's `# Title`, as text. */
	title: string;
	/** Its <title>. */
	documentTitle: string;
	/** Its first paragraph, as text: the description in <head>. */
	description: string;
	/** The address of its Markdown: /docs/glossary.md, /docs/index.md. */
	markdown: string;
};

/** A documentation page's <title>. */
export const documentTitle = (title: string): string => `LedgerMath: ${title}`;
