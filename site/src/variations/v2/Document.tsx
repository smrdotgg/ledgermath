import type { JSX } from "@solidjs/web";
import regular from "./fonts/plex-mono-400-normal.woff2";
import semibold from "./fonts/plex-mono-600-normal.woff2";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts) to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="dark light" />
				<meta name="theme-color" content="#0f0f0d" media="(prefers-color-scheme: dark)" />
				<meta name="theme-color" content="#f3efe4" media="(prefers-color-scheme: light)" />
				<title>ledgermath(5): measured AWS machine figures, as JSON</title>
				<meta
					name="description"
					content="Fourteen benchmarks on five AWS machine types, run four times a day on freshly booted machines. Every Run kept with its evidence; every figure derived by a published Method; served as static JSON at api.ledgermath.com."
				/>
				<link rel="preload" href={regular} as="font" type="font/woff2" crossorigin="anonymous" />
				<link rel="preload" href={semibold} as="font" type="font/woff2" crossorigin="anonymous" />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
