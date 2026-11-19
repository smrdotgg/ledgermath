import type { JSX } from "@solidjs/web";
import inter from "./fonts/inter-latin-wght.woff2";

// The whole <html> document around the page. The build adds the page's stylesheet to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<title>LedgerMath: AWS machines, measured four times a day</title>
				<meta
					name="description"
					content="Fourteen benchmarks on five AWS machine types in us-east-2, run four times a day. Every Run kept with its evidence; the figures and AWS's On-Demand prices as a static JSON API."
				/>
				<link rel="preload" href={inter} as="font" type="font/woff2" crossorigin="anonymous" />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
