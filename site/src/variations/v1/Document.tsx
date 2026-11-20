import type { JSX } from "@solidjs/web";
import datatype from "./fonts/Datatype.woff2";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts) to <head>. The font file is served unchanged; page.css loads it with @font-face,
// and both addresses come from the build, so they respect the page's base path.
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
				<link rel="preload" href={datatype} as="font" type="font/woff2" crossorigin="anonymous" />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
