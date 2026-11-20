import type { JSX } from "@solidjs/web";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts) to <head>. The font is served from public/ unchanged, at its own name, and loaded
// from this inline rule so its address is relative to the page wherever the page is served.
const FONT_FACE = `@font-face{font-family:"Datatype";src:url("Datatype.woff2") format("woff2");font-weight:100 900;font-stretch:50% 150%;font-display:swap}`;

export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="dark" />
				<meta name="theme-color" content="#061633" />
				<title>LedgerMath: The Opening Boot</title>
				<meta
					name="description"
					content="14 benchmarks on 5 AWS machine types, booted fresh four times a day. Every Run kept with its evidence; the figures a static JSON API for agents, at api.ledgermath.com."
				/>
				<link rel="preload" href="Datatype.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
				<style innerHTML={FONT_FACE} />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
