import type { JSX } from "@solidjs/web";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts, if it has one) to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<title>LedgerMath: measured AWS benchmarks your agent can cite</title>
				<meta name="description" content="LedgerMath runs 14 benchmarks on five AWS machine types four times a day and publishes every figure, with its evidence and hourly prices, as a JSON API for AI agents." />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
