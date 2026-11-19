// What entry-server.tsx imports from the slot being built: its Document (the whole <html>,
// rendered around the page) and its Page (the page's content).
declare module "@slot/Document" {
	import type { JSX } from "@solidjs/web";
	const Document: (props: { children?: JSX.Element }) => JSX.Element;
	export default Document;
}

declare module "@slot/Page" {
	import type { JSX } from "@solidjs/web";
	const Page: () => JSX.Element;
	export default Page;
}
