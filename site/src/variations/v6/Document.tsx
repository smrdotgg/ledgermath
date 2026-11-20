import type { JSX } from "@solidjs/web";
import datatype from "./fonts/Datatype.woff2";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts) to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<title>LedgerMath: your receipt for AWS server benchmarks</title>
				<meta
					name="description"
					content="Fourteen benchmarks on five AWS machine types in us-east-2, run four times a day on freshly booted machines, itemised like a till receipt. Every figure measured, with its Runs and evidence, as a static JSON API."
				/>
				<link rel="preload" href={datatype} as="font" type="font/woff2" crossorigin="" />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
