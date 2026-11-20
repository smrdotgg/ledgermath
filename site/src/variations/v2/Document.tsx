import type { JSX } from "@solidjs/web";
import datatype from "./Datatype.woff2";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts) to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="dark" />
				<meta name="theme-color" content="#000000" />
				<title>LEDGERMATH TERMINAL: measured AWS machine figures, as JSON</title>
				<meta
					name="description"
					content="Fourteen benchmarks on five AWS machine types, run four times a day on freshly booted machines. Every Run kept with its evidence; served as static JSON at api.ledgermath.com."
				/>
				<link rel="preload" href={datatype} as="font" type="font/woff2" crossorigin="anonymous" />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
