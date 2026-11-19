import type { JSX } from "@solidjs/web";
import geist from "./fonts/geist.woff2";
import geistMono from "./fonts/geist-mono.woff2";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts) to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<title>LedgerMath: AWS server benchmarks, measured four times a day</title>
				<meta
					name="description"
					content="Fourteen benchmarks on five AWS machine types in us-east-2, run four times a day on freshly booted machines. Every figure drawn to scale, with its Runs, its evidence and its Method, and a static JSON API for agents."
				/>
				<link rel="preload" href={geist} as="font" type="font/woff2" crossorigin="" />
				<link rel="preload" href={geistMono} as="font" type="font/woff2" crossorigin="" />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
