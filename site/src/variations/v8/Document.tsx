import type { JSX } from "@solidjs/web";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts) to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<title>LedgerMath — we have your machines</title>
				<meta
					name="description"
					content="Five AWS machines, woken four times a day, timed by 14 benchmarks and put back. Every Run kept with its evidence; the figures are a static JSON API."
				/>
			</head>
			<body>{props.children}</body>
		</html>
	);
}
