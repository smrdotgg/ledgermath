import type { JSX } from "@solidjs/web";
import datatype from "./fonts/Datatype.woff2";

// The whole <html> document around the page. The build adds the page's stylesheet to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<title>LedgerMath: five AWS machines under observation</title>
				<meta
					name="description"
					content="Five AWS machine types in us-east-2, booted four times a day and measured by 14 benchmarks. Every Run kept with its evidence; the figures and AWS's On-Demand prices as a static JSON API at api.ledgermath.com."
				/>
				<link rel="preload" href={datatype} as="font" type="font/woff2" crossorigin="anonymous" />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
